import { BaseCommand } from '@adonisjs/core/ace'
import db from '@adonisjs/lucid/services/db'
import { Client } from 'pg'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'

export default class SqlProbe extends BaseCommand {
  static commandName = 'spike:sql'
  static options = { startApp: true }
  async run() {
    const pg = db.connection('pg').getWriteClient()
    const sqlite = db.connection('sqlite').getWriteClient()
    const ro = db.connection('sqlite_ro').getWriteClient()
    const observer = new Client({ host: '127.0.0.1', port: 55441, user: 'postgres', database: 'postgres' })
    await observer.connect()
    const file = this.app.tmpPath('db.sqlite3')
    const observerSqlite = new Database(file)
    const emit = (kind: string, value: unknown) => console.log(JSON.stringify({ kind, ...value as object }))
    try {
      await pg.raw('CREATE TABLE probe (id integer primary key, value text); INSERT INTO probe VALUES (1, \'sentinel\'); CREATE SEQUENCE probe_seq; CREATE PROCEDURE probe_call() LANGUAGE SQL AS $$ DELETE FROM probe $$')
      await pg.raw('CREATE ROLE spike_reader LOGIN; GRANT CONNECT ON DATABASE postgres TO spike_reader; GRANT USAGE ON SCHEMA public TO spike_reader; GRANT SELECT ON probe TO spike_reader; ALTER ROLE spike_reader SET default_transaction_read_only = on')
      await sqlite.raw('DROP TABLE IF EXISTS probe')
      await sqlite.raw('PRAGMA journal_mode=DELETE')
      await sqlite.raw('CREATE TABLE probe (id integer primary key, value text)')
      await sqlite.raw("INSERT INTO probe VALUES (1, 'sentinel')")
      const corpusPg: [string,string][] = [
        ['select', 'SELECT * FROM probe'],
        ['comment-delete', '/* SELECT /* nested */ */ DELETE FROM probe'],
        ['multi-delete', 'SELECT 1; DELETE FROM probe'],
        ['mutating-cte', 'WITH d AS (DELETE FROM probe RETURNING *) SELECT * FROM d'],
        ['explain-analyze-delete', 'EXPLAIN ANALYZE DELETE FROM probe'],
        ['nextval', "SELECT nextval('probe_seq')"],
        ['setval', "SELECT setval('probe_seq', 99)"],
        ['advisory-lock', 'SELECT pg_advisory_lock(71120)'],
        ['set-config-session', "SELECT set_config('application_name', 'spike-leaked', false)"],
        ['disable-read-only', "SELECT set_config('transaction_read_only', 'off', true)"],
        ['disable-timeout', "SELECT set_config('statement_timeout', '0', true)"],
        ['do-delete', 'DO $$ BEGIN DELETE FROM probe; END $$'],
        ['call-delete', 'CALL probe_call()'],
        ['copy-program', "COPY (SELECT 1) TO PROGRAM 'true'"],
        ['copy-stdout', 'COPY (SELECT * FROM probe) TO STDOUT'],
        ['listen', 'LISTEN spike_event'],
        ['notify', "NOTIFY spike_event, 'hello'"],
        ['sleep', 'SELECT pg_sleep(1)'],
        ['insert-returning', "INSERT INTO probe VALUES (2, 'bad') RETURNING *"],
        ['transaction-escape', 'COMMIT; DELETE FROM probe'],
      ]
      const statePg = async () => (await observer.query("SELECT (SELECT count(*) FROM probe)::int AS rows, (SELECT last_value FROM probe_seq) AS sequence")).rows[0]
      for (const [name, sql] of corpusPg) {
        await observer.query("DELETE FROM probe; INSERT INTO probe VALUES (1, 'sentinel')")
        const before = await statePg()
        const trx = await pg.transaction()
        let rejected = false, error = '', sameConnection: unknown
        try {
          await trx.raw('SET TRANSACTION READ ONLY')
          await trx.raw("SET LOCAL statement_timeout = '150ms'")
          await trx.raw(sql)
          sameConnection = (await trx.raw("SELECT current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout, current_setting('application_name') AS application, (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()) AS advisory, ARRAY(SELECT pg_listening_channels()) AS listening")).rows[0]
        } catch (e) { rejected = true; error = (e as Error).message }
        finally { await trx.rollback() }
        const after = await statePg()
        const pooled = (await pg.raw("SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout, current_setting('application_name') AS application, (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()) AS advisory, ARRAY(SELECT pg_listening_channels()) AS listening")).rows[0]
        const independentLocks=(await observer.query("SELECT count(*)::int AS advisory FROM pg_locks WHERE locktype='advisory' AND pid=$1", [pooled.pid])).rows[0]
        emit('pg-corpus', { name, sql, rejected, error, before, after, sameConnection, pooled, independentLocks })
        await pg.raw("SELECT pg_advisory_unlock_all(); RESET application_name; RESET statement_timeout; RESET default_transaction_read_only; UNLISTEN *")
      }
      const out = this.app.tmpPath('vacuum-copy.sqlite3'), attached = this.app.tmpPath('attached.sqlite3')
      for (const path of [out, attached]) if (existsSync(path)) unlinkSync(path)
      const corpusSqlite: [string,string][] = [
        ['select', 'SELECT * FROM probe'], ['comment-delete', '/* SELECT */ DELETE FROM probe'],
        ['nested-comment', '/* SELECT /* nested */ */ DELETE FROM probe'], ['multi-delete', 'SELECT 1; DELETE FROM probe'],
        ['mutating-cte', 'WITH d AS (DELETE FROM probe RETURNING *) SELECT * FROM d'], ['explain-analyze-delete', 'EXPLAIN ANALYZE DELETE FROM probe'],
        ['user-version', 'PRAGMA user_version=5'], ['journal-mode', 'PRAGMA journal_mode=WAL'],
        ['attach', `ATTACH DATABASE '${attached}' AS other`], ['vacuum-into', `VACUUM INTO '${out}'`],
        ['load-extension', "SELECT load_extension('/missing/spike-extension')"], ['insert-returning', "INSERT INTO probe VALUES (2, 'bad') RETURNING *"],
        ['disable-query-only', 'PRAGMA query_only=OFF'],
      ]
      for (const mode of ['readonly', 'query_only']) {
        const client = mode === 'readonly' ? ro : sqlite
        for (const [name, sql] of corpusSqlite) {
          observerSqlite.pragma('user_version=0')
          if (existsSync(out)) unlinkSync(out)
          if (mode === 'query_only') await client.raw('PRAGMA query_only=ON')
          const before = { rows: observerSqlite.prepare('SELECT count(*) AS n FROM probe').get(), version: observerSqlite.pragma('user_version', { simple: true }), journal: observerSqlite.pragma('journal_mode', { simple: true }) }
          let rejected=false, error=''
          try { await client.raw(sql) } catch(e) { rejected=true; error=(e as Error).message }
          const after = { rows: observerSqlite.prepare('SELECT count(*) AS n FROM probe').get(), version: observerSqlite.pragma('user_version', { simple: true }), journal: observerSqlite.pragma('journal_mode', { simple: true }), outputExists: existsSync(out), attachedFileExists: existsSync(attached) }
          const connectionState = { queryOnly: await client.raw('PRAGMA query_only'), databases: await client.raw('PRAGMA database_list') }
          emit('sqlite-corpus', { mode, name, sql, rejected, error, before, after, connectionState })
          if (name === 'attach' && !rejected) {
            let attachedWrite=''
            try { await client.raw('CREATE TABLE other.side_effect (id integer)'); attachedWrite='ALLOWED' } catch(e) { attachedWrite=(e as Error).message }
            emit('sqlite-attached-write', { mode, attachedWrite })
            await client.raw('DETACH DATABASE other')
          }
        }
      }
      await sqlite.raw('PRAGMA query_only=OFF')
      await pg.raw('SET default_transaction_read_only=on; SET statement_timeout=321')
      emit('session-leak', { state: (await pg.raw("SELECT pg_backend_pid() AS pid, current_setting('default_transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout")).rows[0] })
      await pg.raw('RESET default_transaction_read_only; RESET statement_timeout')
      for (const mode of ['statement_timeout', 'knex_cancel', 'abort']) {
        const trx = await pg.transaction()
        const pid = (await trx.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
        let timer: NodeJS.Timeout | undefined
        const started=Date.now(); let error=''
        try {
          await trx.raw('SET TRANSACTION READ ONLY')
          await trx.raw("SET LOCAL statement_timeout='500ms'")
          if (mode==='statement_timeout') await trx.raw('SELECT pg_sleep(2)')
          if (mode==='knex_cancel') await trx.raw('SELECT pg_sleep(2)').timeout(80, {cancel:true})
          if (mode==='abort') {
            const controller=new AbortController()
            controller.signal.addEventListener('abort', () => { observer.query('SELECT pg_cancel_backend($1)', [pid]).catch(console.error) }, {once:true})
            timer=setTimeout(() => controller.abort(), 80)
            await trx.raw('SELECT pg_sleep(2)')
          }
        } catch(e) {error=(e as Error).message} finally {clearTimeout(timer); await trx.rollback()}
        const recovery=(await pg.raw("SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout, 42 AS healthy")).rows[0]
        const activity=(await observer.query('SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]
        emit('cancellation', {mode, pid, elapsedMs:Date.now()-started,error,recovery,activity,poolUsed:pg.client.pool.numUsed(),poolFree:pg.client.pool.numFree()})
      }
      const role=db.connection('pg_ro').getWriteClient()
      for (const sql of ['SELECT * FROM probe', 'SET default_transaction_read_only=off', 'DELETE FROM probe', 'SELECT pg_advisory_lock(71121)']) {
        let error=''; try {await role.raw(sql)} catch(e) {error=(e as Error).message}
        emit('read-only-role', {sql,error,state:await statePg()})
      }
      await role.raw('SELECT pg_advisory_unlock_all()')
      for (const bindings of [[], [1]]) {
        const sql=bindings.length ? 'SELECT ?::int; SELECT 2' : 'SELECT 1; SELECT 2'
        let error='', results=0
        try {const result=await pg.raw(sql,bindings); results=Array.isArray(result)?result.length:1} catch(e){error=(e as Error).message}
        emit('pg-protocol', {sql,bindings,results,error})
      }
      let sqliteCancel=''
      try {await sqlite.raw('SELECT 1').timeout(20,{cancel:true})} catch(e){sqliteCancel=(e as Error).message}
      emit('sqlite-cancel-support',{error:sqliteCancel})
      let sqliteError='', aborted=false
      const sqliteStarted=Date.now()
      const abortTimer=setTimeout(() => {aborted=true}, 10)
      try {await ro.raw('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT sum(x) FROM n').timeout(10)} catch(e) {sqliteError=(e as Error).message}
      const elapsedMs=Date.now()-sqliteStarted
      const abortedAtReturn=aborted
      const delay=Promise.withResolvers<void>()
      setTimeout(delay.resolve,20)
      await delay.promise
      clearTimeout(abortTimer)
      emit('sqlite-timeout', {elapsedMs,error:sqliteError,abortedAtReturn,abortedAfterYield:aborted,recovery:await ro.raw('SELECT 42 AS healthy'),poolUsed:ro.client.pool.numUsed(),poolFree:ro.client.pool.numFree()})
      await sqlite.raw('PRAGMA query_only=ON')
      emit('sqlite-session-leak', {nextBorrower:await sqlite.raw('PRAGMA query_only')})
      await sqlite.raw('PRAGMA query_only=OFF')
      await sqlite.raw("INSERT INTO probe VALUES (3, 'query-only-disabled')")
      emit('sqlite-query-only-bypass',{independentRows:observerSqlite.prepare('SELECT count(*) AS n FROM probe').get()})
    } finally {observerSqlite.close(); await observer.end(); await db.manager.closeAll()}
  }
}

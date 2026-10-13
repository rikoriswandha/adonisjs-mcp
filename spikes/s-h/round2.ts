import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { Client } from 'pg'
import { parse } from 'pgsql-ast-parser'
import { TenantService } from '@rikology/adonisjs-tenant'
import Post from '#models/probe_post'
import { evaluate } from '@sh/tenant-evaluator'

const tenants = [{ id: 'a', name: 'Tenant A', slug: 'a' }, { id: 'b', name: 'Tenant B', slug: 'b' }]
const corpus = [
  { name: 'plain', text: 'SELECT * FROM sh_posts ORDER BY id', values: [] },
  { name: 'filtered', text: 'SELECT * FROM sh_posts WHERE tenant_id = $1 ORDER BY id', values: ['a'] },
  { name: 'or-tautology', text: 'SELECT * FROM sh_posts WHERE tenant_id = $1 OR 1=1 ORDER BY id', values: ['a'] },
  { name: 'comment', text: "SELECT * FROM sh_posts /* WHERE tenant_id = 'a' */ ORDER BY id", values: [] },
  { name: 'union', text: 'SELECT * FROM sh_posts WHERE tenant_id = $1 UNION SELECT * FROM sh_posts ORDER BY id', values: ['a'] },
  { name: 'set-config', text: "SELECT set_config('app.tenant_id', 'b', true)", values: [] },
  { name: 'set-role', text: 'SET ROLE postgres', values: [] },
  { name: 'multi-statement', text: "SELECT * FROM sh_posts; SELECT set_config('app.tenant_id', 'b', true); SELECT * FROM sh_posts", values: [] },
  { name: 'other-function', text: 'SELECT pg_sleep(30)', values: [] },
]

// Deliberately small feasibility subset, not a production PostgreSQL validator.
// Unknown typed nodes, operators, relations, functions and multi-statements fail closed.
const policy = (text: string) => {
  try {
    const statements = parse(text)
    if (statements.length !== 1) return { decision: 'DENY', reason: 'exactly one statement required' }
    const root = statements[0].type
    if (root !== 'select' && root !== 'union') return { decision: 'DENY', reason: `root ${root} is not a read SELECT/UNION` }
    const allowed: Record<string, true> = { select: true, union: true, table: true, ref: true, binary: true, integer: true, string: true, parameter: true }
    const inspect = (node: unknown): string | null => {
      if (!node || typeof node !== 'object') return null
      if (Array.isArray(node)) {
        for (const item of node) { const denied = inspect(item); if (denied) return denied }
        return null
      }
      if ('type' in node && !Object.hasOwn(allowed, String(node.type))) return `unsupported AST node ${String(node.type)}`
      if ('type' in node && node.type === 'binary' && 'op' in node && !['=', 'OR', 'AND'].includes(String(node.op))) return `unsupported operator ${String(node.op)}`
      if ('type' in node && node.type === 'table') {
        if (!('name' in node) || !node.name || typeof node.name !== 'object' || !('name' in node.name) || node.name.name !== 'sh_posts' || 'schema' in node.name) return 'relation not trusted'
      }
      for (const value of Object.values(node)) { const denied = inspect(value); if (denied) return denied }
      return null
    }
    const denied = inspect(statements)
    return denied ? { decision: 'DENY', reason: denied } : { decision: 'ALLOW', reason: 'single known read AST, no functions' }
  } catch (error: unknown) {
    return { decision: 'DENY', reason: error instanceof Error ? error.message.split('\n')[0] : 'parse failed' }
  }
}

router.get('/round2', async () => {
  const appPool = db.connection('tenant_pg')
  // Read only observational snapshot of the real Lucid application connection.
  const snapshot = async () => (await appPool.rawQuery("SELECT pg_backend_pid() AS pid, current_setting('application_name') AS application, current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS readonly, nullif(current_setting('app.tenant_id', true), '') AS tenant")).rows[0]
  const appBefore = await snapshot()
  const config = { host: '127.0.0.1', port: 55442, database: 'postgres', user: 'sh_reader' }
  const control = new Client(config)
  await control.connect()
  try {
    const evalResults = await Promise.all(tenants.map((tenant) => TenantService.run(tenant, () => evaluate(app, Post, `
      // This test intentionally exercises natural dynamic import at the evaluator boundary.
      const { TenantService } = await import('@rikology/adonisjs-tenant');
      const { default: Model } = await import('#models/probe_post');
      const before = TenantService.currentId();
      const { setTimeout: delay } = await import('node:timers/promises');
      await delay(before === 'a' ? 25 : 1);
      await Promise.resolve();
      const rows = await Model.query().where('overlap', 7);
      return { before, after: TenantService.currentId(), sameModel: Model === appPost, tenants: rows.map(row => row.tenant_id) };
    `))))
    const readers = await Promise.all(tenants.map((tenant) => TenantService.run(tenant, async () => {
      const reader = new Client(config)
      await reader.connect()
      const readerPid = (await reader.query({ text: 'SELECT pg_backend_pid() AS pid', values: [], queryMode: 'extended' })).rows[0].pid
      const role = (await control.query({ text: 'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', values: ['sh_reader'], queryMode: 'extended' })).rows[0]
      const observations = []
      try {
        for (const item of corpus) {
          const classification = policy(item.text)
          const submitted: string[] = []
          let error: string | null = null
          let rows: unknown[] = []
          let cancelPromise: Promise<unknown> | undefined
          let timer: NodeJS.Timeout | undefined
          await reader.query({ text: 'BEGIN READ ONLY', values: [], queryMode: 'extended' })
          // Trusted adapter-owned statement, never passed through the user allowlist.
          await reader.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [TenantService.require().id], queryMode: 'extended' })
          const txState = (await reader.query({ text: "SELECT current_setting('transaction_read_only') AS readonly, current_setting('app.tenant_id') AS tenant", values: [], queryMode: 'extended' })).rows[0]
          try {
            if (classification.decision === 'ALLOW') {
              timer = setTimeout(() => { cancelPromise = control.query({ text: 'SELECT pg_cancel_backend($1) AS cancelled', values: [readerPid], queryMode: 'extended' }) }, 300)
              const values = item.values.length ? [tenant.id] : []
              submitted.push(item.text)
              rows = (await reader.query({ text: item.text, values, queryMode: 'extended' })).rows
            }
          } catch (failure: unknown) { error = failure instanceof Error ? failure.message : String(failure) }
          finally {
            clearTimeout(timer)
            if (cancelPromise) await cancelPromise
            await reader.query({ text: 'ROLLBACK', values: [], queryMode: 'extended' })
            await reader.query({ text: 'DISCARD ALL', values: [], queryMode: 'extended' })
          }
          const clean = (await reader.query({ text: "SELECT current_setting('transaction_read_only') AS readonly, nullif(current_setting('app.tenant_id', true), '') AS tenant, current_setting('application_name') AS application, current_setting('statement_timeout') AS timeout", values: [], queryMode: 'extended' })).rows[0]
          observations.push({ ...item, values: item.values.length ? [tenant.id] : [], ...classification, submitted, rows, error, txState, clean, queryMode: 'extended' })
        }
        // Trusted fault injection intentionally bypasses user policy to exercise the external
        // deadline under READ ONLY + tenant setting; never an allowed user statement.
        await reader.query({ text: 'BEGIN READ ONLY', values: [], queryMode: 'extended' })
        await reader.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant.id], queryMode: 'extended' })
        let cancellation: Promise<unknown> | undefined
        let deadlineError: string | null = null
        const started = Date.now()
        const timer = setTimeout(() => { cancellation = control.query({ text: 'SELECT pg_cancel_backend($1) AS cancelled', values: [readerPid], queryMode: 'extended' }) }, 100)
        try { await reader.query({ text: 'SELECT pg_sleep(30)', values: [], queryMode: 'extended' }) }
        catch (error: unknown) { deadlineError = error instanceof Error ? error.message : String(error) }
        finally {
          clearTimeout(timer)
          if (cancellation) await cancellation
          await reader.query({ text: 'ROLLBACK', values: [], queryMode: 'extended' })
          await reader.query({ text: 'DISCARD ALL', values: [], queryMode: 'extended' })
        }
        const activity = (await control.query({ text: 'SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1', values: [readerPid], queryMode: 'extended' })).rows[0]
        const healthy = (await reader.query({ text: 'SELECT 42 AS healthy', values: [], queryMode: 'extended' })).rows
        return { tenant: tenant.id, readerPid, role, observations, trustedDeadlineInjection: { elapsedMs: Date.now() - started, error: deadlineError, activity, healthy } }
      } finally { await reader.end() }
    })))
    const appAfter = await snapshot()
    return { evalResults, readers, appBefore, appAfter, outsideTenant: TenantService.currentId() ?? null, ownership: 'new pg.Client per tenant; control connection separate; app Lucid pool only snapshotted', executorReuse: false }
  } finally { await control.end() }
})

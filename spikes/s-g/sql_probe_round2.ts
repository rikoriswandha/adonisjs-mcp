import { BaseCommand } from '@adonisjs/core/ace'
import db from '@adonisjs/lucid/services/db'
import { Client } from 'pg'
import Database from 'better-sqlite3'
import { parse } from 'pgsql-ast-parser'
import { spawn } from 'node:child_process'
import sqliteParse from 'sqlite-parser'
import { writeFileSync, existsSync } from 'node:fs'
export default class Round2 extends BaseCommand {
 static commandName='spike:sql-round2'
 static options={startApp:true}
 async run() {
  const emit=(kind:string,value:object)=>console.log(JSON.stringify({kind,...value}))
  const config={host:'127.0.0.1',port:55441,database:'postgres'}
  const control=new Client({...config,user:'postgres'}), reader=new Client({...config,user:'sg2_reader'})
  await control.connect()
  await control.query("CREATE TABLE sg2_probe(id int); INSERT INTO sg2_probe VALUES(1); CREATE SEQUENCE sg2_seq; CREATE PROCEDURE sg2_call() LANGUAGE SQL AS $$ DELETE FROM sg2_probe $$; CREATE ROLE sg2_reader LOGIN; GRANT USAGE ON SCHEMA public TO sg2_reader; GRANT SELECT ON sg2_probe TO sg2_reader")
  await control.query('CREATE EXTENSION dblink')
  await reader.connect()
  const pid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const app=db.connection('pg').getWriteClient()
  const appBefore=(await app.raw("SELECT pg_backend_pid() AS pid,current_setting('application_name') AS application,current_setting('statement_timeout') AS timeout,current_setting('transaction_read_only') AS readonly")).rows[0]
  let serial=0
  const pgPolicy=(text:string)=>{
   try {
    const ast=parse(text)
    const forbidden=(node:unknown):boolean=>{
     if(!node||typeof node!=='object')return false
     const object=node as Record<string,unknown>
     if(['call','delete','insert','update','commit','rollback','set','do'].includes(String(object.type)))return true
     return Object.values(object).some(forbidden)
    }
    return ast.length===1&&['select','with'].includes(ast[0].type)&&!forbidden(ast)?'ALLOW':'DENY'
   }catch{return 'DENY'}
  }
  const pgCorpus=[
   ['select','SELECT * FROM sg2_probe'],['multi-escape','COMMIT; DELETE FROM sg2_probe'],['multi-delete','SELECT 1; DELETE FROM sg2_probe'],['multi-comments','SELECT 1; /* nested /* hidden */ */ DELETE FROM sg2_probe'],
   ['filtered','SELECT * FROM sg2_probe WHERE id=1'],['join','SELECT a.id FROM sg2_probe a JOIN sg2_probe b ON a.id=b.id'],['read-cte','WITH x AS (SELECT * FROM sg2_probe) SELECT * FROM x'],
   ['commit','COMMIT'],['rollback','ROLLBACK'],['set-read-write','SET TRANSACTION READ WRITE'],['comment-delete','/* SELECT /* nested */ */ DELETE FROM sg2_probe'],['cte','WITH d AS (DELETE FROM sg2_probe RETURNING *) SELECT * FROM d'],['explain','EXPLAIN ANALYZE DELETE FROM sg2_probe'],
   ['nextval',"SELECT nextval('sg2_seq')"],['setval',"SELECT setval('sg2_seq',99)"],['lock','SELECT pg_advisory_lock(71122)'],['config',"SELECT set_config('application_name','sg2-residue',false)"],['timeout-config',"SELECT set_config('statement_timeout','0',true)"],
   ['copy-program',"COPY (SELECT 1) TO PROGRAM 'true'"],['copy-stdout','COPY (SELECT * FROM sg2_probe) TO STDOUT'],['dblink',"SELECT dblink_exec('host=127.0.0.1 port=55441 dbname=postgres user=postgres','DELETE FROM sg2_probe')"],['terminate',`SELECT pg_terminate_backend(${appBefore.pid})`],['lo-import',"SELECT lo_import('/tmp/sg2-missing')"],['lo-export',"SELECT lo_export(123,'/tmp/adonisjs-mcp-m0/sg2-export')"],['do','DO $$ BEGIN DELETE FROM sg2_probe; END $$'],['call','CALL sg2_call()'],['listen','LISTEN sg2_event'],['notify',"NOTIFY sg2_event,'x'"],['sleep','SELECT pg_sleep(1)'],['insert','INSERT INTO sg2_probe VALUES(2) RETURNING *']
  ]
  try {
   emit('sg2-role',{rows:(await control.query("SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,pg_has_role(oid,'pg_signal_backend','member') AS signal,pg_has_role(oid,'pg_read_server_files','member') AS files,pg_has_role(oid,'pg_execute_server_program','member') AS program FROM pg_roles WHERE rolname='sg2_reader'")).rows})
   for(const [name,text] of pgCorpus) {
    let error='',timer:NodeJS.Timeout|undefined,parser:unknown
    try {parser=parse(text).map(x=>x.type)} catch(e) {parser=(e as Error).message}
    await reader.query('BEGIN READ ONLY'); await reader.query("SET LOCAL statement_timeout='150ms'")
    try {await reader.query({text,values:[],name:`sg2_${serial++}`})} catch(e){error=(e as Error).message}
    finally {clearTimeout(timer);await reader.query('ROLLBACK');await reader.query('DISCARD ALL')}
    const independent=(await control.query('SELECT (SELECT count(*)::int FROM sg2_probe) AS rows,(SELECT count(*)::int FROM pg_locks WHERE locktype=\'advisory\' AND pid=$1) AS locks',[pid])).rows[0]
    const clean=(await reader.query("SELECT current_setting('application_name') AS application,current_setting('statement_timeout') AS timeout,current_setting('transaction_read_only') AS readonly,ARRAY(SELECT pg_listening_channels()) AS listening")).rows[0]
    emit('sg2-pg',{name,text,error,parser,policy:pgPolicy(text),independent,clean})
   }
   const emptyValues=[{text:'SELECT 1; SELECT 2',values:[]},{text:'SELECT 1; SELECT 2',values:[],queryMode:'extended'}]
   for(const query of emptyValues){let error='',results=0;try{const r=await reader.query(query);results=Array.isArray(r)?r.length:1}catch(e){error=(e as Error).message};emit('sg2-protocol',{query,error,results})}
   await reader.query('BEGIN READ ONLY')
   const started=Date.now();let cancelError=''
   const timer=setTimeout(()=>{control.query('SELECT pg_cancel_backend($1)',[pid]).catch(console.error)},100)
   try{await reader.query({text:"SELECT set_config('statement_timeout','0',true),pg_sleep(30)",values:[],name:'deadline'})}catch(e){cancelError=(e as Error).message}finally{clearTimeout(timer);await reader.query('ROLLBACK');await reader.query('DISCARD ALL')}
   emit('sg2-hard-deadline',{elapsedMs:Date.now()-started,error:cancelError,activity:(await control.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]})
   await reader.query('SELECT pg_advisory_lock(71123)');await reader.query("SET application_name='session-residue'; SET statement_timeout='321ms'; LISTEN sg2_residue")
   const residue=(await control.query('SELECT count(*)::int AS locks FROM pg_locks WHERE locktype=\'advisory\' AND pid=$1',[pid])).rows[0]
   await reader.query('ROLLBACK');await reader.query('DISCARD ALL')
   emit('sg2-discard',{before:residue,after:(await control.query('SELECT count(*)::int AS locks FROM pg_locks WHERE locktype=\'advisory\' AND pid=$1',[pid])).rows[0],settings:(await reader.query("SELECT current_setting('application_name') AS application,current_setting('statement_timeout') AS timeout,ARRAY(SELECT pg_listening_channels()) AS listening")).rows[0],appBefore,appAfter:(await app.raw("SELECT pg_backend_pid() AS pid,current_setting('application_name') AS application,current_setting('statement_timeout') AS timeout,current_setting('transaction_read_only') AS readonly")).rows[0]})
   const path=this.app.tmpPath('db.sqlite3'), sqlite=new Database(path,{readonly:true,fileMustExist:true})
   const corpusSqlite=['SELECT * FROM probe','/* SELECT */ DELETE FROM probe','SELECT 1; DELETE FROM probe','WITH d AS (DELETE FROM probe RETURNING *) SELECT * FROM d','EXPLAIN ANALYZE DELETE FROM probe','PRAGMA user_version=5','PRAGMA journal_mode=WAL',`ATTACH DATABASE '${this.app.tmpPath('sg2-attach.sqlite3')}' AS other`,`VACUUM INTO '${this.app.tmpPath('sg2-vacuum.sqlite3')}'`,"SELECT load_extension('/missing/sg2')",'INSERT INTO probe VALUES (9,\'bad\') RETURNING *','PRAGMA query_only=OFF']
   corpusSqlite.push('SELECT * FROM probe WHERE id=1','SELECT a.id FROM probe a JOIN probe b ON a.id=b.id','WITH x AS (SELECT * FROM probe) SELECT * FROM x')
   for(const text of corpusSqlite){
    let error='',readonly:unknown,policy='DENY',statementKind:unknown
    try{
     const stmt=sqlite.prepare(text);readonly=stmt.readonly
     const ast=sqliteParse(text)
     statementKind=ast.statement.map((node:any)=>node.variant)
     const forbidden=(node:any):boolean=>{
      if(!node||typeof node!=='object')return false
      if(node.type==='function'||(node.type==='statement'&&!['list','select'].includes(node.variant)))return true
      return Object.values(node).some(forbidden)
     }
     policy=stmt.readonly&&ast.statement.length===1&&ast.statement[0].variant==='select'&&!forbidden(ast)?'ALLOW':'DENY'
     if(policy==='ALLOW')stmt.all()
    }catch(e){error=(e as Error).message}
    emit('sg2-sqlite-classify',{text,readonly,statementKind,policy,error})
   }
   let extensionError='';try{sqlite.prepare("SELECT load_extension('/missing/sg2')").get()}catch(e){extensionError=(e as Error).message}
   let jsExtensionError='';try{sqlite.loadExtension('/missing/sg2')}catch(e){jsExtensionError=(e as Error).message}
   emit('sg2-extension',{sqlDefault:extensionError,jsExtensionError,jsLoadExtensionType:typeof sqlite.loadExtension});sqlite.close()
   emit('sg2-sqlite-files',{attach:existsSync(this.app.tmpPath('sg2-attach.sqlite3')),vacuum:existsSync(this.app.tmpPath('sg2-vacuum.sqlite3'))})
   const module=this.app.tmpPath('sg2-executor.cjs')
   writeFileSync(module,`const Database=require('better-sqlite3'); const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads'); const sql='WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n'; if(process.env.MODE==='worker' && isMainThread){const w=new Worker(__filename,{workerData:process.env.DB_FILE});w.on('message',()=>{process.send({ready:true});setTimeout(async()=>{const started=Date.now();w.terminate().then(()=>process.send({terminated:true,elapsedMs:Date.now()-started}));setTimeout(()=>process.send({pending:true,elapsedMs:Date.now()-started}),300)},50)})}else{const d=new Database(workerData||process.env.DB_FILE,{readonly:true,fileMustExist:true}); if(parentPort)parentPort.postMessage({ready:true});else process.send({ready:true});d.prepare(sql).get();}`)
   for(const mode of ['worker','child']){
    const child=spawn(process.execPath,[module],{env:{...process.env,MODE:mode,DB_FILE:path},stdio:['ignore','pipe','pipe','ipc']})
    const done=Promise.withResolvers<void>();let started=0,heartbeat=0,killTimer:NodeJS.Timeout|undefined
    const beat=setInterval(()=>heartbeat++,10)
    child.on('message',(message:any)=>{emit('sg2-executor-message',{mode,...message});if(message.ready){started=Date.now();killTimer=setTimeout(()=>child.kill('SIGKILL'),mode==='child'?100:500)}})
    child.on('exit',(code,signal)=>{clearTimeout(killTimer);clearInterval(beat);emit('sg2-executor-exit',{mode,code,signal,elapsedAfterReadyMs:Date.now()-started,heartbeat});done.resolve()})
    child.stderr.on('data',data=>emit('sg2-executor-stderr',{mode,text:String(data)}))
    await done.promise
   }
   const finalSqlite=new Database(path,{readonly:true,fileMustExist:true})
   emit('sg2-final',{readerHealth:(await reader.query('SELECT 42 AS healthy')).rows,sqliteHealth:finalSqlite.prepare('SELECT count(*) AS rows FROM probe').get()})
   finalSqlite.close()
  }finally{await reader.end();await control.end();await db.manager.closeAll()}
 }
}

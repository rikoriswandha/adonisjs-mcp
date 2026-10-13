import {spawnSync} from 'node:child_process'
import {copyFileSync,existsSync,rmSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname,resolve} from 'node:path'
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),app=process.argv[2]||'/tmp/adonisjs-mcp-m0/s-g-api',cluster='/tmp/adonisjs-mcp-m0/s-g-pg',bin='/opt/homebrew/opt/postgresql@18/bin'
function run(command,args,cwd=root){const r=spawnSync(command,args,{cwd,encoding:'utf8',env:{...process.env,HOST:'127.0.0.1',PORT:'41120'}});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.status!==0)throw Error(`${command} failed ${r.status}`)}
run('node',[resolve(here,'run.mjs'),app])
run('npm',['install','--save-exact','pgsql-ast-parser@12.0.1','sqlite-parser@1.0.1'],app)
copyFileSync(resolve(here,'sql_probe_round2.ts'),resolve(app,'commands/sql_probe_round2.ts'))
if(existsSync(cluster))throw Error('Owned cluster path must be absent')
run(resolve(bin,'initdb'),['-D',cluster,'-U','postgres','--auth=trust'])
let started=false
try{run(resolve(bin,'pg_ctl'),['-D',cluster,'-o',`-p 55441 -h 127.0.0.1 -k ${cluster}`,'-l',`${cluster}/pg.log`,'start']);started=true;run('npm',['ls','pgsql-ast-parser','sqlite-parser'],app);run('node',['ace','spike:sql-round2'],app)}finally{if(started)run(resolve(bin,'pg_ctl'),['-D',cluster,'stop','-m','fast']);rmSync(cluster,{recursive:true,force:true})}

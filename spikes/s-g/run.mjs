import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../..')
const app=process.argv[2] || '/tmp/adonisjs-mcp-m0/s-g-api'
const cluster='/tmp/adonisjs-mcp-m0/s-g-pg', bin='/opt/homebrew/opt/postgresql@18/bin'
function run(command,args,cwd=root) {const result=spawnSync(command,args,{cwd,encoding:'utf8',env:{...process.env,HOST:'127.0.0.1',PORT:'41120'}}); process.stdout.write(result.stdout||''); process.stderr.write(result.stderr||''); if(result.status!==0) throw Error(`${command} failed: ${result.status}`)}
if(!existsSync(app)) run('bash',['spikes/clone-fixture.sh','api','s-g-api'])
run('npm',['install','--save-exact','pg@8.16.3'],app)
copyFileSync(resolve(here,'database.ts'),resolve(app,'config/database.ts'))
mkdirSync(resolve(app,'commands'),{recursive:true})
copyFileSync(resolve(here,'sql_probe.ts'),resolve(app,'commands/sql_probe.ts'))
if(existsSync(cluster)) throw Error('Cluster path exists: stop/remove owned prior cluster before rerun')
run(resolve(bin,'initdb'),['-D',cluster,'-U','postgres','--auth=trust'])
let started=false
try {
  run(resolve(bin,'pg_ctl'),['-D',cluster,'-o',`-p 55441 -h 127.0.0.1 -k ${cluster}`,'-l',`${cluster}/pg.log`,'start']); started=true
  run('node',['--version'],app)
  run('uname',['-a'])
  run('npm',['ls','@adonisjs/core','@adonisjs/lucid','knex','pg','better-sqlite3'],app)
  run(resolve(bin,'psql'),['-h','127.0.0.1','-p','55441','-U','postgres','-c','SELECT version()'])
  run('node',['ace','spike:sql'],app)
} finally {
  if(started) run(resolve(bin,'pg_ctl'),['-D',cluster,'stop','-m','fast'])
  rmSync(cluster,{recursive:true,force:true})
}

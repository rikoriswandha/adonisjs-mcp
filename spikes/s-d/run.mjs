import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { request } from 'node:http'
const root = resolve(import.meta.dirname, '../..')
const name = 's-d-api-' + Date.now()
const clone = process.argv[2] || '/tmp/adonisjs-mcp-m0/' + name
if (!resolve(clone).startsWith('/tmp/adonisjs-mcp-m0/s-d-') && !resolve(clone).startsWith('/private/tmp/adonisjs-mcp-m0/s-d-')) throw new Error('Use only a disposable s-d-* clone under /tmp/adonisjs-mcp-m0')
if (!process.argv[2]) { const r = spawnSync(root + '/spikes/clone-fixture.sh', ['api', name], { stdio: 'inherit' }); if(r.status) process.exit(r.status) }
const put = async (path, text) => { await mkdir(resolve(clone,path,'..'),{recursive:true}); await writeFile(resolve(clone,path),text) }
let rc = await readFile(clone+'/adonisrc.ts','utf8')
if (!rc.includes("import('#providers/probe_provider')")) rc = rc.replace("    () => import('#providers/api_provider'),", "    () => import('#providers/api_provider'),\n    () => import('#providers/probe_provider'),")
if (!rc.includes("import('#start/events')")) rc = rc.replace("    () => import('#start/validator'),", "    () => import('#start/validator'),\n    () => import('#start/events'),")
await put('adonisrc.ts',rc)
await put('app/controllers/probe_controller.ts', `export default class ProbeController { async index() { return {version: 1, pid: process.pid} } }\n`)
await put('app/models/probe_model.ts', `import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class ProbeModel extends BaseModel { static version = 1 }\n`)
await put('app/listeners/probe_listener.ts', `export default class ProbeListener { handle() { throw new Error('must not emit') } }\n`)
await put('app/middleware/probe_middleware.ts', `export default class ProbeMiddleware { async handle(ctx, next, options) { ctx.sdOrder ||= []; ctx.sdOrder.push(options.tag); await next() } }\n`)
await put('start/events.ts', `import emitter from '@adonisjs/core/services/emitter'\nimport ProbeListener from '../app/listeners/probe_listener.ts'\nexport class ProbeEvent {}\nemitter.on('sd:inline', () => {})\nemitter.on('sd:class', [ProbeListener, 'handle'])\nemitter.on('sd:lazy', [() => import('../app/listeners/probe_listener.ts'), 'handle'])\nemitter.listen(ProbeEvent, [ProbeListener, () => import('../app/listeners/probe_listener.ts')])\n`)
await put('start/events.ts', (await readFile(clone+'/start/events.ts','utf8')) + `emitter.once('sd:once', () => {})\nemitter.onAny(() => {})\n`)
await put('providers/probe_provider.ts', `export default class ProbeProvider {
 constructor(public app) {}
 register() { globalThis.sdState = { lifecycle: [], constructions: 0 }; this.app.container.bind('sd:binding', () => { globalThis.sdState.constructions++; return {} }); this.app.container.singleton('sd:singleton', () => { globalThis.sdState.constructions++; return {} }); this.app.container.alias('sd:alias', 'sd:singleton'); globalThis.sdState.lifecycle.push({phase:'register',pid:process.pid}) }
 async record(phase) { const router = await this.app.container.make('router'); globalThis.sdState.lifecycle.push({phase,pid:process.pid,commited:router.commited,routes:Object.values(router.toJSON()).flat().length}); return router }
 async boot() { const router = await this.record('boot'); router.get('/sd/boot', () => ({phase:'boot'})).as('sd.boot') }
 async start() { const router = await this.record('start'); router.get('/sd/start', () => ({phase:'start'})).as('sd.start') }
 async ready() { await this.record('ready') }
}\n`)
await put('start/routes.ts', `import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'
import emitter from '@adonisjs/core/services/emitter'
import app from '@adonisjs/core/services/app'
import { middleware } from '#start/kernel'
const named = router.named({ probe: () => import('../app/middleware/probe_middleware.ts'), unused: () => import('../app/middleware/probe_middleware.ts') })
router.get('/sd/controller', [() => import('../app/controllers/probe_controller.ts'), 'index']).as('sd.controller')
router.group(() => {
 router.get('/ordered', (ctx) => ({order:ctx.sdOrder})).as('ordered').use(named.probe({tag:'route'}))
 router.get('/protected', () => 'protected').as('protected').use(middleware.auth({guards:['api']}))
}).prefix('/sd/group').as('sd.group').use(named.probe({tag:'group'}))
router.group(() => { router.get('/sd/domain', () => 'domain').as('sd.domain') }).domain('sd.localhost')
const ref = (value) => typeof value === 'function' ? {kind:'function',name:value.name || null,source:value.toString()} : Array.isArray(value) ? value.map(ref) : value
router.get('/sd/snapshot', async () => ({
 pid:process.pid, lifecycle:globalThis.sdState.lifecycle, constructions:globalThis.sdState.constructions,
 modelVersion:(await import('../app/models/probe_model.ts')).default.version,
 commited:router.commited,
 listenerCount:emitter.listenerCount(),
 routes:Object.entries(router.toJSON()).flatMap(([domain,routes]) => routes.map(r => ({domain,name:r.name,pattern:r.pattern,methods:r.methods,handler:ref(r.handler),middleware:Array.from(r.middleware.all()).map(m => ({name:m.name || null,args:m.args ?? null,reference:ref(m.reference)}))}))),
 server:server.getMiddlewareList().map(m => ref(m.reference)),
 events:Array.from(emitter.eventsListeners, ([event,listeners]) => ({event:typeof event === 'function' ? event.name : String(event),listeners:Array.from(listeners.keys(),ref),count:listeners.size})),
 container:{ownKeys:Reflect.ownKeys(app.container).map(String), known:['sd:binding','sd:singleton','sd:alias'].map(key=>({key,exists:app.container.hasBinding(key)})),prototype:Object.getOwnPropertyNames(Object.getPrototypeOf(app.container))},
 handles:process._getActiveHandles().map(h=>h.constructor.name),
 })).as('sd.snapshot')
`)
const versions=spawnSync('npm',['ls','@adonisjs/core','@adonisjs/http-server','@adonisjs/fold','@adonisjs/events','@adonisjs/assembler','hot-hook'],{cwd:clone,encoding:'utf8'})
console.log('VERSIONS\n'+versions.stdout)
const proc=spawn(process.execPath,['ace','serve','--hmr'],{cwd:clone,env:{...process.env,HOST:'127.0.0.1',PORT:'41060'},detached:true,stdio:['ignore','pipe','pipe']})
let log=''; for(const s of [proc.stdout,proc.stderr]) s.on('data',d=>{log+=d.toString()})
const fetchJson=async path=>{const r=await fetch('http://127.0.0.1:41060'+path); if(!r.ok) throw new Error(await r.text()); return r.json()}
const wait=async predicate=>{for(let n=0;n<120;n++){try{const v=await fetchJson('/sd/snapshot');if(predicate(v))return v}catch{}await delay(500)}throw new Error('timeout\n'+log)}
try {
 const initial=await wait(()=>true); console.log('INITIAL '+JSON.stringify(initial))
 console.log('LIVE_BOOT '+JSON.stringify(await fetchJson('/sd/boot')))
 console.log('LIVE_START '+JSON.stringify(await fetchJson('/sd/start')))
 console.log('LIVE_ORDER '+JSON.stringify(await fetchJson('/sd/group/ordered')))
 console.log('LIVE_DOMAIN '+ await new Promise((resolve,reject) => { const req=request({hostname:'127.0.0.1',port:41060,path:'/sd/domain',headers:{host:'sd.localhost:41060'}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve(JSON.stringify({status:res.statusCode,body})))});req.on('error',reject);req.end() }))
 console.log('LIVE_AUTH_STATUS '+(await fetch('http://127.0.0.1:41060/sd/group/protected')).status)
 let before=initial
 const edits=[['controller','app/controllers/probe_controller.ts',s=>s.replace('version: 1','version: 2')],['routes','start/routes.ts',s=>s+"\nrouter.get('/sd/added', () => 'added').as('sd.added')\n"],['model','app/models/probe_model.ts',s=>s.replace('version = 1','version = 2')],['provider','providers/probe_provider.ts',s=>s+'\n// reload provider\n']]
 for(const [kind,path,change] of edits){await delay(1000); const old=before.pid; await put(path,change(await readFile(clone+'/'+path,'utf8'))); await delay(3000); const after=await wait(()=>true); console.log('HMR '+JSON.stringify({kind,beforePid:old,afterPid:after.pid,lifecycle:after.lifecycle,modelVersion:after.modelVersion,added:after.routes.some(r=>r.name==='sd.added'),events:after.events.map(e=>({event:e.event,count:e.count})),handles:after.handles,controller:await fetchJson('/sd/controller')}));before=after}
 for(let i=0;i<3;i++){await delay(1000);await put('start/routes.ts',(await readFile(clone+'/start/routes.ts','utf8'))+'\n// reload '+i+'\n');await delay(2500);const after=await wait(()=>true);console.log('RELOAD '+JSON.stringify({iteration:i,pid:after.pid,events:after.events.map(e=>({event:e.event,count:e.count})),handles:after.handles,lifecycle:after.lifecycle}));}
 console.log('SERVER_LOG\n'+log)
} finally { try{process.kill(-proc.pid,'SIGTERM')}catch{} await delay(1000);try{process.kill(-proc.pid,'SIGKILL')}catch{} }

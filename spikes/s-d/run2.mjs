import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const root=resolve(import.meta.dirname,'../..'), name='s-d2-api-'+Date.now(), clone='/tmp/adonisjs-mcp-m0/'+name
const r=spawnSync(root+'/spikes/clone-fixture.sh',['api',name],{stdio:'inherit'});if(r.status)process.exit(r.status)
const put=async(p,s)=>{await mkdir(resolve(clone,p,'..'),{recursive:true});await writeFile(clone+'/'+p,s)}
const ts=createRequire(clone+'/package.json')('typescript')
await put('app/probe_bindings.ts',`declare module '@adonisjs/core/types' { interface ContainerBindings { 'sd2:declared': object; 'sd2:absent': object; 'sd2:early': object } }\nexport {}\n`)
const declarations=[]
async function scan(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await scan(p);else if(e.isFile() && (p.endsWith('.d.ts') || p===clone+'/app/probe_bindings.ts')){const text=await readFile(p,'utf8');if(!text.includes('ContainerBindings'))continue;const ast=ts.createSourceFile(p,text,ts.ScriptTarget.Latest,true);function visit(n){if(ts.isInterfaceDeclaration(n)&&n.name.text==='ContainerBindings'){for(const m of n.members){if(m.name && (ts.isStringLiteral(m.name)||ts.isIdentifier(m.name)))declarations.push({key:m.name.text,file:p.slice(clone.length+1),line:ast.getLineAndCharacterOfPosition(m.getStart(ast)).line+1})}}ts.forEachChild(n,visit)}visit(ast)}}}
await scan(clone+'/node_modules');await scan(clone+'/app')
await put('sd2_declarations.json',JSON.stringify(declarations))
await put('providers/inventory_provider.ts',`import { tracingChannels } from '@adonisjs/application'
export default class InventoryProvider {
 originals = new Map(); subscriber; scope = null;
 constructor(public app) {
 globalThis.sd2 = {records:[],scopeChecks:[],constructions:0};
 this.subscriber={start:({provider})=>{this.scope=provider.constructor.name;globalThis.sd2.scopeChecks.push(this.scope)},end:()=>{this.scope=null}};
 tracingChannels.providerRegister.subscribe(this.subscriber);
 for(const method of ['bind','singleton','bindValue','alias','swap']) { const original=app.container[method];this.originals.set(method,original);const owner=this;
 app.container[method]=function(...args){const result=Reflect.apply(original,this,args);globalThis.sd2.records.push({key:typeof args[0]==='function'?'class:'+args[0].name:String(args[0]),keyType:typeof args[0],kind:method,origin:owner.scope || 'unknown',target:method==='alias'?(typeof args[1]==='function'?'class:'+args[1].name:String(args[1])):undefined,caller:new Error().stack?.split('\\n')[2]?.trim()});return result}; }
 }
 register(){this.app.container.bind('sd2:first',()=>{globalThis.sd2.constructions++;return {}})}
 shutdown(){tracingChannels.providerRegister.unsubscribe(this.subscriber);for(const [method,original] of this.originals)this.app.container[method]=original}
}\n`)
await put('providers/ground_provider.ts',`export class BoundClass {}\nexport class UnboundClass {}\nexport default class GroundProvider {constructor(public app){app.container.bindValue('sd2:constructor',{})} register(){this.app.container.bind('sd2:declared',()=>{globalThis.sd2.constructions++;return {}});this.app.container.singleton('sd2:singleton',()=>{globalThis.sd2.constructions++;return {}});this.app.container.bindValue('sd2:value',{});this.app.container.alias('sd2:alias','sd2:singleton');this.app.container.bind(BoundClass,()=>new BoundClass());this.app.container.swap(BoundClass,()=>new BoundClass())} boot(){this.app.container.bindValue('sd2:boot',{})} }\n`)
let rc=await readFile(clone+'/adonisrc.ts','utf8');rc=rc.replace('  providers: [',"  providers: [\n    () => import('#providers/inventory_provider'),");rc=rc.replace("    () => import('#providers/api_provider'),","    () => import('#providers/api_provider'),\n    () => import('#providers/ground_provider'),");await put('adonisrc.ts',rc)
await put('bin/server.ts',(await readFile(clone+'/bin/server.ts','utf8')).replace("await import('#start/env')","await import('#start/env'); app.container.bindValue('sd2:early', {}); app.container.bindValue('sd2:earlyUndeclared', {})"))
await put('start/routes.ts',`import router from '@adonisjs/core/services/router'\nimport app from '@adonisjs/core/services/app'\nimport declarations from '../sd2_declarations.json' with {type:'json'}\nimport {BoundClass,UnboundClass} from '../providers/ground_provider.ts'\nrouter.get('/sd2', async()=>{ const before=app.container.hasBinding(UnboundClass);const made=await app.container.make(UnboundClass); return {...globalThis.sd2,declarations:declarations.map(d=>({...d,exists:app.container.hasBinding(d.key)})),ground:['app','config','logger','sd2:first','sd2:declared','sd2:singleton','sd2:value','sd2:alias','sd2:early','sd2:earlyUndeclared'].map(key=>({key,exists:app.container.hasBinding(key),observed:globalThis.sd2.records.some(r=>r.key===key)})),classBinding:app.container.hasBinding(BoundClass),unbound:{before,after:app.container.hasBinding(UnboundClass),made:made instanceof UnboundClass}}})\n`)
// Exercise the same exported transformer addProvider API used by configure workflows.
const require=createRequire(clone+'/package.json');const {CodeTransformer}=await import(require.resolve('@adonisjs/assembler/code_transformer'))
const transformer=new CodeTransformer(new URL('file://'+clone+'/'))
await transformer.updateRcFile(rc => { rc.addProvider('#providers/inventory_provider'); rc.addProvider('#providers/codemod_tail') })
const after=await readFile(clone+'/adonisrc.ts','utf8');console.log('CODEMOD_FIRST '+(after.indexOf("import('#providers/inventory_provider')")<after.indexOf("import('@adonisjs/core/providers/app_provider')")));console.log('CODEMOD_TAIL '+after.includes('#providers/codemod_tail'));await put('adonisrc.ts',rc)
const proc=spawn(process.execPath,['--import=@poppinss/ts-exec','bin/server.ts'],{cwd:clone,env:{...process.env,HOST:'127.0.0.1',PORT:'41061'},detached:true,stdio:['ignore','pipe','pipe']});let log='';for(const s of [proc.stdout,proc.stderr])s.on('data',d=>log+=d)
try{let result;for(let i=0;i<100;i++){try{const res=await fetch('http://127.0.0.1:41061/sd2');if(res.ok){result=await res.json();break}}catch{}await delay(300)}if(!result)throw Error(log);console.log('INVENTORY '+JSON.stringify(result));console.log('DECLARED_SUMMARY '+JSON.stringify({total:result.declarations.length,unique:new Set(result.declarations.map(d=>d.key)).size,verified:result.declarations.filter(d=>d.exists).map(d=>d.key),absent:result.declarations.filter(d=>!d.exists).map(d=>d.key)}));console.log('SERVER_LOG '+log)}finally{try{process.kill(-proc.pid,'SIGTERM')}catch{}await delay(800);try{process.kill(-proc.pid,'SIGKILL')}catch{}}

import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const here = fileURLToPath(new URL('.', import.meta.url))
const repo = path.resolve(here, '../..')
const root = '/tmp/adonisjs-mcp-m0'
const kits = process.argv.slice(2).length ? process.argv.slice(2) : ['api', 'react']
const children = new Set()
const observations = []
function cmd(cwd, args, extra = {}, allowFailure = false) {
  const binary = args[0], result = spawnSync(binary, args.slice(1), {cwd, env:{...process.env,...extra}, encoding:'utf8', maxBuffer:20*1024*1024})
  const text = `${result.stdout || ''}${result.stderr || ''}`
  console.log(`COMMAND ${args.join(' ')} EXIT ${result.status}\n${text}`)
  observations.push({cwd,command:args.join(' '),exit:result.status,output:text})
  if (!allowFailure && result.status !== 0) throw new Error(`Failed: ${args.join(' ')}`)
  return result
}
async function server(cwd, production, port, expectHealthy) {
  let output = ''
  const child = spawn('node', production ? ['bin/server.js'] : ['--import=@poppinss/ts-exec','bin/server.ts'], {cwd, env:{...process.env,NODE_ENV:production?'production':'development',HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']})
  children.add(child)
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
  try {
    let healthy = false, responses = []
    for (let n=0;n<100;n++) {
      if (child.exitCode !== null) break
      try { const response = await fetch(`http://127.0.0.1:${port}/`); responses.push({path:'/',status:response.status,body:(await response.text()).slice(0,160)}); healthy=true; break } catch {}
      await new Promise(r=>setTimeout(r,100))
    }
    if (healthy) { const response=await fetch(`http://127.0.0.1:${port}/__adonis/mcp`); responses.push({path:'/__adonis/mcp',status:response.status,body:(await response.text()).slice(0,160)}) }
    const record={cwd,production,healthy,responses,exit:child.exitCode,output}
    console.log('SERVER',JSON.stringify(record,null,2)); observations.push(record)
    if (healthy !== expectHealthy) throw new Error('Unexpected server boot outcome')
    if (healthy && (responses[0].status !== 200 || responses[1].status !== (production ? 404 : 200))) throw new Error('Unexpected route outcome')
    if (healthy && production && (output.includes('SB_PACKAGE_MODULE_LOADED') || !output.includes('"buffer":false'))) throw new Error('Production package/buffer observed')
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]); if(child.exitCode===null) child.kill('SIGKILL') }
    children.delete(child)
  }
}
try {
  cmd(here,['node','--version']); cmd(here,['npm','--version']); cmd(here,['uname','-a'])
  cmd(path.join(here,'pkg'),['npm','pack','--pack-destination',root])
  const tarball=path.join(root,'rikology-adonisjs-mcp-0.0.0-spike.tgz')
  let port=41020
  for (const kit of kits) for (const strategy of ['unsafe','safe']) {
    const name=`s-b-${strategy}-${kit}-${Date.now()}`, clone=path.join(root,name)
    cmd(repo,['bash','spikes/clone-fixture.sh',kit,name])
    cmd(clone,['npm','install','--save-dev','--save-exact',tarball])
    cmd(clone,['npm','ls','@adonisjs/core','@adonisjs/application','@adonisjs/assembler','@adonisjs/lucid','@adonisjs/inertia','@adonisjs/vite','vite','@rikology/adonisjs-mcp'])
    cmd(clone,['node','ace','configure','@rikology/adonisjs-mcp'],{SB_STRATEGY:strategy})
    if (kit === 'api' && strategy === 'safe') {
      await cp(path.join(here,'environment-matrix.mjs'),path.join(clone,'environment-matrix.mjs'))
      for (const NODE_ENV of ['development','production','test']) cmd(clone,['node','--import=@poppinss/ts-exec','environment-matrix.mjs'],{NODE_ENV})
    }
    if (kit === 'react' && strategy === 'safe') cmd(clone,['npm','exec','vite','build'])
    if(strategy==='safe') await server(clone,false,port++,true)
    cmd(clone,['node','ace','build'])
    const build=path.join(clone,'build')
    await cp(path.join(clone,'.env'),path.join(build,'.env'))
    await mkdir(path.join(build,'tmp'),{recursive:true}); await cp(path.join(clone,'tmp/db.sqlite3'),path.join(build,'tmp/db.sqlite3'))
    for(const filename of ['adonisrc.js','config/mcp.js', ...(strategy==='safe'?['providers/mcp_dev_provider.js']:[])]) { const output=await readFile(path.join(build,filename),'utf8'); console.log('COMPILED',filename,output); observations.push({kit,strategy,compiled:filename,output}) }
    cmd(build,['npm','ci','--omit=dev'])
    let absent=false; try {await access(path.join(build,'node_modules/@rikology/adonisjs-mcp'))} catch {absent=true}
    console.log('PACKAGE_ABSENT',absent); observations.push({kit,strategy,packageAbsent:absent}); if(!absent) throw new Error('Package still installed')
    // A deployment must not resolve omitted dependencies from the source parent.
    const deployment = `${clone}-production`
    cmd(repo,['cp','-cR',build,deployment])
    await server(deployment,true,port++,strategy==='safe')
    for(const args of [['node','ace','list'],['node','ace','migration:status']]) {
      const result=cmd(deployment,args,{NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port)},strategy==='unsafe')
      if(strategy==='safe' && `${result.stdout}${result.stderr}`.includes('SB_PACKAGE_MODULE_LOADED')) throw new Error('Ace loaded package')
    }
  }
} finally {
  for(const child of children) child.kill('SIGKILL')
  await writeFile(path.join(root,'s-b-observations.json'),JSON.stringify(observations,null,2))
  console.log(`EVIDENCE ${root}/s-b-observations.json`)
}

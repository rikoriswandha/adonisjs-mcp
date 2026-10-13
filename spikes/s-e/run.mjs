import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const clone = process.argv[2] || execFileSync('bash', [path.join(root, 'spikes/clone-fixture.sh'), 'api', `s-e-api-${Date.now()}`], { encoding: 'utf8' }).trim()
console.log('CLONE', clone)
await mkdir(path.join(clone, 'node_modules/@spike/eval'), { recursive: true })
await writeFile(path.join(clone, 'node_modules/@spike/eval/package.json'), JSON.stringify({ name: '@spike/eval', type: 'module', exports: './evaluator.mjs' }))
await copyFile(path.join(here, 'evaluator.mjs'), path.join(clone, 'node_modules/@spike/eval/evaluator.mjs'))
const routePath = path.join(clone, 'start/routes.ts')
let routes = await readFile(routePath, 'utf8')
if (!routes.includes('./spike_eval.js')) await writeFile(routePath, routes + "\nimport './spike_eval.js'\n")
await copyFile(path.join(here, 'routes.ts'), path.join(clone, 'start/spike_eval.ts'))
const modelPath = path.join(clone, 'app/models/user.ts')
const model = await readFile(modelPath, 'utf8')
const baseline = model.replace(/\n  static spikeMarker = '[^']*'/g, '').replace('  static accessTokens', "  static spikeMarker = 'before'\n  static accessTokens")
await writeFile(modelPath, baseline)
const controllerPath = path.join(clone, 'app/controllers/spike_eval_controller.ts')
const controllerBaseline = await readFile(path.join(here, 'controller.ts'), 'utf8')
await writeFile(controllerPath, controllerBaseline)
await mkdir(path.join(clone, 'app/services'), { recursive: true })
await writeFile(path.join(clone, 'app/services/spike_eval_service.ts'), "export const marker = 'fresh-service'; export const sourceUrl = import.meta.url\n")
console.log(execFileSync('npm', ['ls', '@adonisjs/core', '@adonisjs/application', '@adonisjs/repl', '@adonisjs/lucid', '@adonisjs/assembler', '@poppinss/ts-exec', 'hot-hook'], { cwd: clone, encoding: 'utf8' }))
console.log('NODE', process.version, 'OS', execFileSync('sw_vers', { encoding: 'utf8' }).trim())
let child
async function stop() { if (!child) return; try { process.kill(-child.pid, 'SIGTERM') } catch {} await new Promise(r => setTimeout(r, 500)); try { process.kill(-child.pid, 'SIGKILL') } catch {} child = undefined }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function start(port, flag) {
  child = spawn(process.execPath, ['ace', 'serve', '--hmr'], { cwd: clone, detached: true, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', NODE_OPTIONS: flag ? '--experimental-vm-modules' : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', b => output += b)
  child.stderr.on('data', b => output += b)
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/__spike/state`, { signal: AbortSignal.timeout(500) }); if (r.ok) return } catch {} await sleep(250) }
  throw new Error(`Boot failed ${output}`)
}
async function evaluate(candidate, code, extra = {}, port = 41080) {
  const payload = encodeURIComponent(JSON.stringify({ candidate, code, ...extra }))
  const response = await fetch(`http://127.0.0.1:${port}/__spike/eval?payload=${payload}`, { signal: AbortSignal.timeout(5000) })
  const result = await response.json()
  console.log(JSON.stringify({ candidate, ...result }))
  return result
}
const natural = "const { default: User } = await import('#models/user'); return { same: User === appUser, marker: User.spikeMarker }"
try {
  await start(41080, false)
  console.log('WITHOUT_VM_FLAG')
  for (const candidate of ['async-function', 'compile-none', 'compile-default', 'compile-root-default', 'compile-app', 'script-default', 'script-root-default', 'script-app', 'source-app']) await evaluate(candidate, natural)
  await stop()
  await start(41080, true)
  console.log('WITH_VM_FLAG')
  for (const candidate of ['async-function', 'compile-none', 'compile-default', 'compile-root-default', 'compile-app', 'script-default', 'script-root-default', 'script-app', 'source-app']) await evaluate(candidate, natural)
  console.log('FRAMEWORK_CALLBACK_CONTROLLER_WITH_FLAG')
  const callbackBefore = await (await fetch('http://127.0.0.1:41080/__spike/controller')).json()
  console.log('CALLBACK_CONTROLLER_BEFORE', JSON.stringify(callbackBefore))
  const callbackCode = "const {default: Controller, sourceUrl} = await import('#controllers/spike_eval_controller'); return {marker: Controller.marker, url: sourceUrl, sameAsRouter: Controller === app.spikeExecutedController}"
  await evaluate('compile-app', callbackCode)
  await writeFile(controllerPath, controllerBaseline.replace('controller-before', 'controller-after'))
  let callbackAfter
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    callbackAfter = await (await fetch('http://127.0.0.1:41080/__spike/controller')).json()
    if (callbackAfter.marker === 'controller-after') break
    if (i === 99) throw new Error('Callback controller hot-swap not observed')
  }
  console.log('CALLBACK_CONTROLLER_AFTER', JSON.stringify({ ...callbackAfter, samePid: callbackBefore.pid === callbackAfter.pid }))
  await evaluate('compile-app', callbackCode)
  await evaluate('script-app', callbackCode)
  await evaluate('source-app', callbackCode)
  await stop()
  await writeFile(controllerPath, controllerBaseline)
  await start(41080, false)
  console.log('SELECTED_ROOT_LOADER_WITHOUT_FLAG')
  const controllerBefore = await (await fetch('http://127.0.0.1:41080/__spike/controller')).json()
  console.log('CONTROLLER_BEFORE', JSON.stringify(controllerBefore))
  const controllerCode = "const {default: Controller, sourceUrl} = await import('#controllers/spike_eval_controller'); return {marker: Controller.marker, url: sourceUrl, sameAsRouter: Controller === app.spikeExecutedController}"
  await evaluate('compile-root-default', controllerCode)
  async function tsReferrerMatrix(stage) {
    console.log('TS_REFERRER_MATRIX', stage)
    for (const candidate of ['compile-root-ts-default', 'compile-start-ts-default']) {
      await evaluate(candidate, natural, { callId: `${stage}-model` })
      await evaluate(candidate, controllerCode, { callId: `${stage}-controller` })
      await evaluate(candidate, "const service = await import('#services/spike_eval_service'); return {marker: service.marker, url: service.sourceUrl}", { callId: `${stage}-service` })
      const relative = candidate.includes('-start-') ? '../app/controllers/spike_eval_controller.js' : './app/controllers/spike_eval_controller.js'
      await evaluate(candidate, `const {default: Controller, sourceUrl} = await import('${relative}'); return {marker: Controller.marker, url: sourceUrl, sameAsRouter: Controller === app.spikeExecutedController}`, { callId: `${stage}-relative` })
      await evaluate(candidate, "const {DateTime} = await import('luxon'); return {package: 'luxon', year: DateTime.utc(2026,10,13).year}", { callId: `${stage}-package` })
    }
  }
  await tsReferrerMatrix('before-hot-swap')
  await writeFile(controllerPath, controllerBaseline.replace('controller-before', 'controller-after'))
  let controllerAfter
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    controllerAfter = await (await fetch('http://127.0.0.1:41080/__spike/controller')).json()
    if (controllerAfter.marker === 'controller-after') break
    if (i === 99) throw new Error('Controller hot-swap not observed')
  }
  console.log('CONTROLLER_AFTER', JSON.stringify({ ...controllerAfter, samePid: controllerBefore.pid === controllerAfter.pid }))
  await evaluate('compile-root-default', controllerCode)
  await evaluate('script-root-default', controllerCode)
  await tsReferrerMatrix('after-hot-swap')
  console.log('WARM_FRAMEWORK_SERVICE_THEN_DEFAULT_LOADER')
  await evaluate('async-function', "const service = await app.import('#services/spike_eval_service'); return {marker: service.marker, url: service.sourceUrl}", { callId: 'framework-warm' })
  await evaluate('compile-root-default', "const service = await import('#services/spike_eval_service'); return {marker: service.marker, url: service.sourceUrl}", { callId: 'mjs-after-warm' })
  await evaluate('compile-root-ts-default', "const service = await import('#services/spike_eval_service'); return {marker: service.marker, url: service.sourceUrl}", { callId: 'ts-after-warm' })
  await evaluate('compile-root-default', "const router = await app.container.make('router'); const {default: User} = await import('#models/user'); const user = new User(); user.email = 'probe@example.invalid'; return { router: router.constructor.name, bigint: 42n, map: new Map([['answer', 42n]]), model: user }")
  await Promise.all([evaluate('compile-root-default', "console.log(callId, 'start'); await new Promise(r => setTimeout(r, 90)); console.warn(callId, 'end'); return callId", { callId: 'A' }), evaluate('compile-root-default', "console.log(callId, 'start'); await new Promise(r => setTimeout(r, 20)); console.error(callId, 'end'); return callId", { callId: 'B' })])
  await evaluate('compile-root-default', "await new Promise(r => setTimeout(r, 200)); completions.push({ callId, aborted: signal.aborted }); return 'late'", { callId: 'late', timeout: 30 })
  await sleep(300)
  console.log('POST_TIMEOUT', await (await fetch('http://127.0.0.1:41080/__spike/state')).text())
  await evaluate('compile-root-default', "await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 500); signal.addEventListener('abort', () => { clearTimeout(timer); completions.push({ callId, cooperated: true }); reject(signal.reason) }, { once: true }) }); return 'finished'", { callId: 'cooperating', timeout: 30 })
  await sleep(50)
  console.log('COOPERATED', await (await fetch('http://127.0.0.1:41080/__spike/state')).text())
  const before = await (await fetch('http://127.0.0.1:41080/__spike/state')).json()
  await writeFile(modelPath, baseline.replace("'before'", "'after'"))
  for (let i = 0; i < 100; i++) { await sleep(200); try { const state = await (await fetch('http://127.0.0.1:41080/__spike/state')).json(); if (state.marker === 'after') { console.log('HMR', JSON.stringify({ before, after: state, restarted: before.pid !== state.pid })); break } if (i === 99) throw new Error('HMR marker unchanged') } catch (e) { if (i === 99) throw e } }
  await evaluate('compile-root-default', natural)
  await stop()
  console.log('ACE_REPL')
  const replHome = path.join(clone, 'spike-home')
  await mkdir(replHome, { recursive: true })
  await new Promise((resolve, reject) => {
    const repl = spawn(process.execPath, ['ace', 'repl'], { cwd: clone, detached: true, env: { ...process.env, HOME: replHome, PORT: '41082', HOST: '127.0.0.1', NODE_ENV: 'development' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let sent = false, output = ''
    const watchdog = setTimeout(() => { try { process.kill(-repl.pid, 'SIGKILL') } catch {} reject(new Error('REPL watchdog ' + output)) }, 15000)
    const read = b => { output += b; if (!sent && output.includes('Type ".ls"')) { sent = true; setTimeout(() => repl.stdin.write("const { default: ReplUser } = await import('#models/user')\n"), 300); setTimeout(() => repl.stdin.write("console.log('REPL_NATURAL', ReplUser.name, ReplUser.spikeMarker, ReplUser === (await import('#models/user')).default)\n"), 1200); setTimeout(() => repl.stdin.write('.exit\n'), 2200) } }
    repl.stdout.on('data', read); repl.stderr.on('data', read)
    repl.on('exit', code => { clearTimeout(watchdog); console.log(output); console.log('REPL_EXIT', code); resolve() })
  })
  await start(41081, true)
  console.log('BLOCKING_CHILD_PRE', await (await fetch('http://127.0.0.1:41081/__spike/state')).text())
  const block = evaluate('compile-app', 'while (true) {}', { timeout: 30 }, 41081).catch(e => console.log('BLOCK_EVAL_EXTERNAL_DEADLINE', e.name))
  await sleep(150)
  try { await fetch('http://127.0.0.1:41081/__spike/state', { signal: AbortSignal.timeout(500) }); console.log('BLOCKING_HTTP unexpectedly responsive') } catch (e) { console.log('BLOCKING_HTTP_FROZEN', e.name) }
  await stop()
  console.log('EXTERNAL_WATCHDOG_KILLED_CHILD')
  await block
} finally { await stop() }

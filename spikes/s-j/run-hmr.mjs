import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
const repo = fileURLToPath(new URL('../../', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))
const root = execFileSync('bash', ['spikes/clone-fixture.sh', 'api', process.argv[2] ?? `s-j-hmr-api-${Date.now()}`], { cwd: repo, encoding: 'utf8' }).trim()
await mkdir(`${root}/commands`, { recursive: true })
await copyFile(`${here}/hmr_probe.ts`, `${root}/commands/hmr_probe.ts`)
await copyFile(`${here}/hmr_routes.ts`, `${root}/start/sj_hmr_routes.ts`)
await copyFile(`${here}/guard.mjs`, `${root}/sj_guard.mjs`)
await writeFile(`${root}/start/routes.ts`, `${await readFile(`${root}/start/routes.ts`, 'utf8')}\nimport './sj_hmr_routes.js'\n`)
const records = []
const serverLogs = []
function emit(value) { records.push({ time: Date.now(), ...value }); console.log(JSON.stringify(records.at(-1))) }
const server = spawn(process.execPath, ['ace.js', 'serve', '--hmr'], {
  cwd: root, detached: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '41180', NODE_ENV: 'development', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
})
for (const stream of ['stdout', 'stderr']) server[stream].on('data', (chunk) => serverLogs.push({ time: Date.now(), stream, text: chunk.toString() }))
const base = 'http://127.0.0.1:41180'
async function get(path, timeout = 20000) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}
async function generated() {
  const result = {}
  for (const path of ['.adonisjs/server/controllers.ts', '.adonisjs/server/routes.json', '.adonisjs/client/registry/schema.d.ts']) {
    try {
      const text = await readFile(`${root}/${path}`, 'utf8')
      result[path] = { mtime: (await stat(`${root}/${path}`)).mtimeMs, hash: createHash('sha256').update(text).digest('hex'), hasHmrController: text.includes('spike_hmr'), hasHeldController: text.includes('spike_hmr_held') }
    } catch (error) { result[path] = { unavailable: error.code } }
  }
  return result
}
const owned = new Set([server.pid])
let polling = false
let poller
try {
  let ready = false
  for (let i = 0; i < 300; i++) { try { emit({ phase: 'ready', root, supervisorPid: server.pid, ...await get('/sj/hmr-ping', 500) }); ready = true; break } catch { await delay(100) } }
  if (!ready) throw new Error(JSON.stringify(serverLogs))
  polling = true
  poller = (async () => {
    let previous = ''
    while (polling) {
      try { const ping = await get('/sj/hmr-ping', 500); if (String(ping.pid) !== previous) { emit({ phase: 'http-pid', ...ping }); previous = String(ping.pid) } }
      catch (error) { emit({ phase: 'ping-error', message: error.message }) }
      await delay(100)
    }
  })()
  emit({ phase: 'baseline-codegen', generated: await generated() })
  for (const argv of [['make:controller', 'spike_hmr_probe'], ['make:model', 'spike_hmr_model'], ['make:validator', 'spike_hmr_validator'], ['spike:hmr', 'spike_hmr_held'], ['spike:hmr', 'spike_hmr_restart']]) {
    const start = Date.now()
    emit({ phase: 'request-start', argv, ping: await get('/sj/hmr-ping') })
    let restart
    if (argv[1] === 'spike_hmr_restart') restart = (async () => {
      await delay(600)
      emit({ phase: 'forcing-rc-restart' })
      await writeFile(`${root}/adonisrc.ts`, `${await readFile(`${root}/adonisrc.ts`, 'utf8')}\n// S-J controlled restart while command response is pending\n`)
    })()
    try {
      const result = await get(`/sj/hmr-run?${new URLSearchParams({ argv: JSON.stringify(argv) })}`)
      emit({ phase: 'request-result', argv, durationMs: Date.now() - start, result })
    } catch (error) { emit({ phase: 'request-lost', argv, durationMs: Date.now() - start, message: error.message, cause: String(error.cause) }) }
    await restart
    await delay(1500)
    const trace = (await readFile(`${root}/sj-hmr-trace.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
    for (const event of trace) if (event.phase === 'spawn') owned.add(event.childPid)
    emit({ phase: 'after-scenario', argv, generated: await generated(), processes: [...owned].map(pid => { try { process.kill(pid, 0); return { pid, alive: true } } catch { return { pid, alive: false } } }) })
  }
  await delay(13000)
  emit({ phase: 'final-ping', ...await get('/sj/hmr-ping') })
} finally {
  polling = false
  await poller
  try { const trace = (await readFile(`${root}/sj-hmr-trace.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse); for (const event of trace) if (event.phase === 'spawn') owned.add(event.childPid) } catch {}
  for (const pid of owned) { try { process.kill(-pid, 'SIGTERM') } catch {} }
  await delay(500)
  for (const pid of owned) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  await delay(200)
  emit({ phase: 'cleanup', processes: [...owned].map(pid => { try { process.kill(pid, 0); return { pid, alive: true } } catch { return { pid, alive: false } } }) })
  await writeFile(`${here}/observed-hmr${process.env.SJ_HMR_GUARD === '1' ? '-guard' : process.env.SJ_HMR_CLEANUP === '1' ? '-cleanup' : ''}.json`, JSON.stringify({ records, serverLogs, routeTrace: await readFile(`${root}/sj-hmr-trace.jsonl`, 'utf8').catch(() => ''), guardTrace: await readFile(`${root}/sj-guard-trace.jsonl`, 'utf8').catch(() => '') }, null, 2)+'\n')
}

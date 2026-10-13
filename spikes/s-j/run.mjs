import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const repo = fileURLToPath(new URL('../../', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))
const cloneName = process.argv[2] ?? `s-j-api-${Date.now()}`
const root = execFileSync('bash', ['spikes/clone-fixture.sh', 'api', cloneName], { cwd: repo, encoding: 'utf8' }).trim()
await mkdir(`${root}/commands`, { recursive: true })
await copyFile(`${here}/spike_probe.ts`, `${root}/commands/spike_probe.ts`)
await copyFile(`${here}/routes.ts`, `${root}/start/sj_routes.ts`)
await writeFile(`${root}/start/routes.ts`, `${await readFile(`${root}/start/routes.ts`, 'utf8')}\nimport './sj_routes.js'\n`)
console.log(execFileSync('npm', ['ls', '@adonisjs/core', '@adonisjs/ace', '@adonisjs/lucid', '@poppinss/ts-exec'], { cwd: root, encoding: 'utf8' }))
console.log(JSON.stringify({ node: process.version, os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), root }))
const server = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], {
  cwd: root, detached: true, env: { ...process.env, PORT: '41180', HOST: '127.0.0.1', NODE_ENV: 'development', SJ_SENTINEL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', (x) => { logs += x })
server.stderr.on('data', (x) => { logs += x })
const base = 'http://127.0.0.1:41180'
async function request(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}
async function command(argv, options = {}) {
  const params = new URLSearchParams({ argv: JSON.stringify(argv), ...options })
  return request(`/sj/run?${params}`)
}
function emit(name, value) { console.log(JSON.stringify({ scenario: name, ...value })) }
try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { await request('/sj/ping'); ready = true; break } catch { await delay(100) }
  }
  if (!ready) throw new Error(`Server failed: ${logs}`)
  for (const argv of [['list'], ['list:routes', '--json'], ['make:controller', 'spike_probe'], ['does:not:exist'], ['migration:run', '--connection=nope'], ['make:controller'], ['spike:probe', 'prompt']]) {
    const result = await command(argv, { deadline: '5000' })
    emit(argv.join(' '), result)
    if (argv[0] === 'make:controller' && argv[1]) {
      const path = `${root}/app/controllers/spike_probes_controller.ts`
      emit('generator-file', { path, bytes: (await stat(path)).size })
      await unlink(path)
      emit('generator-deleted', { deleted: true })
    }
  }
  const literal = '; touch SJ_SHELL_EXECUTED $(echo bad) | cat & > file'
  emit('argv-literal', await command(['spike:probe', 'inspect', literal]))
  let marker = false
  try { await stat(`${root}/SJ_SHELL_EXECUTED`); marker = true } catch {}
  emit('shell-marker', { exists: marker })
  const large = await command(['spike:probe', 'large'], { limit: '4096' })
  emit('bounded-output', { ...large, stdout: `[${Buffer.byteLength(large.stdout)} retained bytes]`, stderr: `[${Buffer.byteLength(large.stderr)} retained bytes]` })
  const sleeping = command(['spike:probe', 'sleep'], { deadline: '2500' })
  await delay(1000)
  const start = Date.now()
  emit('responsive-during-child', { ...await request('/sj/ping'), latencyMs: Date.now() - start })
  const timeout = await sleeping
  emit('deadline', timeout)
  await delay(400)
  const pids = [timeout.childPid, JSON.parse(timeout.stdout.trim()).childPid]
  emit('process-tree-cleanup', { processes: pids.map((pid) => { try { process.kill(pid, 0); return { pid, alive: true } } catch { return { pid, alive: false } } }) })
  emit('subprocess-state', await command(['spike:probe', 'state']))
  emit('parent-after-subprocess', await request('/sj/ping'))
  emit('inprocess-list', await command(['list'], { mode: 'inprocess' }))
  const local = command(['spike:probe', 'state'], { mode: 'inprocess' })
  await delay(200)
  emit('neighbor-during-inprocess', await request('/sj/ping'))
  emit('inprocess-capture', await local)
  emit('parent-after-inprocess', await request('/sj/ping'))
} finally {
  try { process.kill(-server.pid, 'SIGTERM') } catch {}
  await delay(400)
  try { process.kill(-server.pid, 'SIGKILL') } catch {}
  emit('server-stopped', { pid: server.pid })
}

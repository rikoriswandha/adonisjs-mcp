import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { setup, saveEvidence, production } from './round2.mjs'
const round2 = process.argv.includes('--production-safe')
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const name = `s-c-api-${process.pid}`
const cloned = spawnSync('bash', [resolve(repo, 'spikes/clone-fixture.sh'), 'api', name], { encoding: 'utf8' })
if (cloned.status !== 0) throw new Error(cloned.stderr)
const app = cloned.stdout.trim().split('\n').at(-1)
await mkdir(resolve(app, 'providers'), { recursive: true })
for (const file of ['capture.ts', 'provider.ts']) await copyFile(resolve(here, file), resolve(app, 'providers', file))
async function instrument(file, transform) {
  const path = resolve(app, file)
  await writeFile(path, transform(await readFile(path, 'utf8')))
}
await instrument('adonisrc.ts', (s) => s.replace('providers: [', "providers: [\n    () => import('./providers/provider.js'),"))
await instrument('config/logger.ts', (s) => "import { streamWrite } from '../providers/capture.js'\n" + s.replace('enabled: true,', 'enabled: true,\n      hooks: { streamWrite },'))
await instrument('app/exceptions/handler.ts', (s) => "import { observeException, custom } from '../../providers/capture.js'\n" + s.replace('return super.handle(error, ctx)', "custom.handles++\n    observeException(error, ctx)\n    return ctx.response.status(500).send({ error: (error as Error).message, request_id: ctx.request.id() })").replace('return super.report(error, ctx)', "custom.reports++\n    ctx.logger.error({ probe: true, event: 'custom-report', err: error }, 'probe custom report')\n    return super.report(error, ctx)"))
if (round2) await setup(app)
const versions = spawnSync('npm', ['ls', '@adonisjs/core', '@adonisjs/logger', '@adonisjs/http-server', 'pino'], { cwd: app, encoding: 'utf8' })
console.log('CLONE', app, '\nNODE', process.version, '\n' + versions.stdout)
const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], { cwd: app, env: { ...process.env, PORT: '41040', HOST: '127.0.0.1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderr = ''
child.stdout.on('data', (s) => { stdout += s })
child.stderr.on('data', (s) => { stderr += s })
const origin = 'http://127.0.0.1:41040'
async function get(path) { const response = await fetch(origin + path); return { status: response.status, body: await response.json() } }
try {
  let ready = false
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(stderr + stdout)
    try { await get('/probe/state'); ready = true; break } catch { await sleep(50) }
  }
  assert(ready, 'server ready')
  const responses = await Promise.all(Array.from({ length: 24 }, (_, id) => get('/probe/work/' + id)))
  const state = (await get('/probe/state')).body
  const records = state.logs.filter((x) => x.probe)
  assert.equal(records.length, 80)
  assert.equal(state.exceptions.length, 8)
  for (let id = 0; id < 24; id++) {
    const requestId = responses[id].body.request_id
    assert.equal(responses[id].status, id % 3 === 0 ? 500 : 200)
    for (const event of ['request', 'child', 'root']) {
      const matches = records.filter((x) => x.id === String(id) && x.event === event)
      assert.equal(matches.length, 1)
      if (event !== 'root') assert.equal(matches[0].request_id, requestId)
      else assert.equal(matches[0].request_id, undefined)
    }
    if (id % 3 === 0) {
      assert.equal(state.exceptions.filter((x) => x.request_id === requestId && x.message === `probe-error-${id}`).length, 1)
      assert.equal(records.filter((x) => x.event === 'custom-report' && x.request_id === requestId).length, 1)
    }
  }
  assert.equal(state.custom.reports, 8); assert.equal(state.custom.handles, 8)
  const detached = (await get('/probe/detach')).body
  assert.equal(detached.logSubscribers, 0); assert.equal(detached.exceptionSubscribers, 0); assert.equal(detached.diagnosticSubscribers, false)
  await get('/probe/work/30')
  const after = (await get('/probe/state')).body
  assert.deepEqual(after.logs, state.logs); assert.deepEqual(after.exceptions, state.exceptions)
  console.log('OBSERVATIONS', JSON.stringify({ concurrentRequests: 24, probeLogRecords: records.length, exceptions: state.exceptions.length, custom: state.custom, requestCorrelation: true, diagnosticCount: state.diagnosticCount, diagnosticKeys: state.diagnosticKeys, detachStopsCapture: true, subscribersAfterDetach: [detached.logSubscribers, detached.exceptionSubscribers], diagnosticSubscribersAfterDetach: detached.diagnosticSubscribers, bytes: state.bytes, dropped: state.dropped }))
} finally {
  const { promise, resolve: done } = Promise.withResolvers()
  child.once('exit', done)
  child.kill('SIGTERM')
  await Promise.race([promise, sleep(5000)])
  if (child.exitCode === null) { child.kill('SIGKILL'); await promise }
  const lines = stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  const probe = lines.filter((x) => x.probe)
  await writeFile(resolve(app, 's-c-stdout.log'), stdout)
  await writeFile(resolve(app, 's-c-stderr.log'), stderr)
  assert.equal(probe.length, 84)
  for (const id of [...Array.from({ length: 24 }, (_, i) => i), 30]) {
    for (const event of ['request', 'child', 'root']) assert.equal(probe.filter((x) => x.id === String(id) && x.event === event).length, 1)
  }
  const reportIds = probe.filter((x) => x.event === 'custom-report').map((x) => x.request_id)
  assert.equal(new Set(reportIds).size, 9)
  assert(stdout.includes('SC_SHUTDOWN '), 'provider shutdown executed')
  console.log('STDOUT_OBSERVATIONS', JSON.stringify({ probeLines: probe.length, expected: 84, once: true, providerShutdown: true, processStopped: child.exitCode !== null || child.signalCode !== null }))
  console.log('LOGS', resolve(app, 's-c-stdout.log'), resolve(app, 's-c-stderr.log'))
  if (round2) await saveEvidence(app, stdout, stderr)
}
const bounds = spawnSync(process.execPath, ['--import=@poppinss/ts-exec', '--input-type=module', '-e', `
  const { logs } = await import('./providers/capture.ts');
  for (let i = 0; i < 200; i++) logs.push({ i });
  if (logs.values().length !== 128 || logs.dropped !== 72) throw new Error('count bound');
  for (let i = 0; i < 40; i++) logs.push({ i, msg: 'x'.repeat(2000) });
  if (logs.bytes > 32768 || logs.values().length >= 40) throw new Error('byte bound');
  const before = logs.values().length; logs.push({ msg: 'x'.repeat(40000) });
  if (logs.values().length !== before) throw new Error('oversize bound');
  console.log('BOUNDS_OBSERVATIONS', JSON.stringify({ countLimit: 128, initialEvictions: 72, bytes: logs.bytes, retained: before, oversizedDropped: true }));
`], { cwd: app, encoding: 'utf8' })
if (bounds.status !== 0) throw new Error(bounds.stderr)
console.log(bounds.stdout.trim())
if (round2) await production(app)

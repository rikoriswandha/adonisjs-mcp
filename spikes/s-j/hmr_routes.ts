import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const active = new Set<number>()
if (process.env.SJ_HMR_CLEANUP === '1') app.terminating(async () => {
  trace({ phase: 'terminating-owned', children: [...active] })
  for (const pid of active) { try { process.kill(-pid, 'SIGTERM') } catch {} }
  await delay(200)
  for (const pid of active) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  trace({ phase: 'terminating-swept', children: [...active] })
})
const root = fileURLToPath(app.appRoot)
function trace(event: object) {
  appendFileSync(`${root}/sj-hmr-trace.jsonl`, `${JSON.stringify({ time: Date.now(), httpPid: process.pid, ...event })}\n`)
}
router.get('/sj/hmr-ping', () => ({ pid: process.pid, time: Date.now() }))
router.get('/sj/hmr-run', async ({ request }) => {
  const argv: string[] = JSON.parse(request.input('argv'))
  const nodeArgv = process.env.SJ_HMR_GUARD === '1' ? ['sj_guard.mjs', String(process.pid), ...argv] : ['ace.js', ...argv]
  const child = spawn(process.execPath, nodeArgv, {
    cwd: root, shell: false, detached: true, env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  trace({ phase: 'spawn', childPid: child.pid, argv })
  active.add(child.pid!)
  let stdout = '', stderr = ''
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); trace({ phase: 'stdout', childPid: child.pid, text: chunk.toString() }) })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); trace({ phase: 'stderr', childPid: child.pid, text: chunk.toString() }) })
  child.on('error', reject)
  child.on('close', (exitCode, signal) => {
    active.delete(child.pid!)
    trace({ phase: 'close', childPid: child.pid, exitCode, signal })
    resolve({ stdout, stderr, exitCode, signal, httpPid: process.pid, childPid: child.pid })
  })
  return promise
})

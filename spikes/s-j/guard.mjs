import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const parentPid = Number(process.argv[2])
const child = spawn(process.execPath, ['ace.js', ...process.argv.slice(3)], { cwd: process.cwd(), shell: false, detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
function trace(phase) { appendFileSync('sj-guard-trace.jsonl', `${JSON.stringify({ time: Date.now(), phase, parentPid, guardianPid: process.pid, acePid: child.pid })}\n`) }
trace('start')
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  trace('parent-gone-stop')
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    trace('swept')
    process.exit(1)
  }, 200)
}
process.on('SIGTERM', stop)
const timer = setInterval(() => { try { process.kill(parentPid, 0) } catch { stop() } }, 100)
child.on('error', () => { clearInterval(timer); process.exitCode = 1 })
child.on('close', (code) => { if (!stopping) { clearInterval(timer); trace('normal-close'); process.exitCode = code ?? 1 } })

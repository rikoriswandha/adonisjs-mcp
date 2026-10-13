import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import ace from '@adonisjs/core/services/ace'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

router.get('/sj/ping', () => {
  console.log('HTTP_NEIGHBOR_STDOUT')
  return { alive: true, sentinel: process.env.SJ_SENTINEL ?? null, pid: process.pid }
})
router.get('/sj/run', async ({ request }) => {
  const argv: string[] = JSON.parse(request.input('argv'))
  if (request.input('mode') === 'inprocess') {
    let stdout = '', stderr = ''
    const out = process.stdout.write, err = process.stderr.write
    process.stdout.write = (chunk: string | Uint8Array) => { stdout += String(chunk); return true }
    process.stderr.write = (chunk: string | Uint8Array) => { stderr += String(chunk); return true }
    try {
      const command = await ace.exec(argv[0], argv.slice(1))
      return { stdout, stderr, exitCode: command.exitCode, sentinel: process.env.SJ_SENTINEL }
    } finally { process.stdout.write = out; process.stderr.write = err }
  }
  const limit = Number(request.input('limit', 262144))
  const deadline = Number(request.input('deadline', 10000))
  const child = spawn(process.execPath, ['ace.js', ...argv], {
    cwd: fileURLToPath(app.appRoot), shell: false, detached: true,
    env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), seenOut = 0, seenErr = 0
  let timedOut = false
  const terminate = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal) } catch {} }
  let killTimer: NodeJS.Timeout | undefined
  const timer = setTimeout(() => {
    timedOut = true
    terminate('SIGTERM')
    killTimer = setTimeout(() => terminate('SIGKILL'), 200)
  }, deadline)
  child.stdout.on('data', (chunk: Buffer) => {
    seenOut += chunk.length
    stdout = Buffer.concat([stdout, chunk.subarray(0, Math.max(0, limit - stdout.length))])
  })
  child.stderr.on('data', (chunk: Buffer) => {
    seenErr += chunk.length
    stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, limit - stderr.length))])
  })
  child.on('error', reject)
  child.on('close', (exitCode, signal) => {
    clearTimeout(timer)
    // Always sweep descendants, even if the group leader already exited.
    terminate('SIGKILL')
    clearTimeout(killTimer)
    resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode, signal, timedOut,
      seenOut, seenErr, truncated: seenOut > limit || seenErr > limit, childPid: child.pid })
  })
  return promise
})

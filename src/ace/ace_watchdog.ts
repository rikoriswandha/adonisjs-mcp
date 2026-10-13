/*
|--------------------------------------------------------------------------
| Ace watchdog
|--------------------------------------------------------------------------
|
| Child-process entry spawned by `runner.ts`. It owns the Ace console
| process group independently of the HTTP application: the deadline,
| cancellation, parent-death detection and the final SIGKILL sweep all run
| here, so they still happen when the dev server is SIGKILLed by a restart.
|
| Output is captured as bounded prefixes while both pipes keep draining, so
| a chatty command never blocks on a full pipe. The result always reaches
| the parent once the command leader exits, even when a process that escaped
| the group keeps the pipes open: the pipes are closed after a short grace
| period.
|
*/

import { spawn } from 'node:child_process'

export interface AceRequest {
  type: 'run'
  argv: string[]
  timeout: number

  /**
   * Bytes retained per stream. The runner redacts and cuts to its own
   * budget afterwards, so this includes slack for secrets straddling the
   * cut.
   */
  retain: number
  parentPid: number
}

export interface AceResult {
  exitCode: number | null
  signal: string | null
  outcome: 'exited' | 'timeout' | 'cancelled'
  stdout: string
  stderr: string
  bytes: { stdout: number; stderr: number }
  truncated: { stdout: boolean; stderr: boolean }

  /**
   * The command leader exited but a process outside its group kept the
   * pipes open; the watchdog closed them. Output written later is lost.
   */
  streamsForcedClosed: boolean
  durationMs: number
}

export type AceMessage =
  | { type: 'started'; pid: number }
  | { type: 'result'; result: AceResult }
  | { type: 'error'; message: string }

/**
 * Grace for the pipes to close after the leader exited.
 */
const EXIT_DRAIN_MS = 1000

/**
 * Between SIGTERM and SIGKILL of the group.
 */
const KILL_GRACE_MS = 2000

/**
 * After SIGKILL, report even if the pipes are still held open.
 */
const FORCE_FINISH_MS = 1000

const PARENT_POLL_MS = 100

class Capture {
  bytes = 0
  retained = 0
  readonly #chunks: Buffer[] = []

  constructor(readonly limit: number) {}

  append(chunk: Buffer) {
    this.bytes += chunk.length
    const take = Math.min(chunk.length, this.limit - this.retained)
    if (take > 0) {
      this.#chunks.push(Buffer.from(chunk.subarray(0, take)))
      this.retained += take
    }
  }

  /**
   * Streaming decode drops an incomplete trailing UTF-8 sequence instead of
   * emitting a replacement character at the cut.
   */
  text() {
    return new TextDecoder().decode(Buffer.concat(this.#chunks), { stream: true })
  }
}

function send(message: AceMessage, then: () => void) {
  if (process.connected) {
    process.send!(message, () => then())
  } else {
    then()
  }
}

function run(request: AceRequest) {
  const started = Date.now()
  const stdout = new Capture(request.retain)
  const stderr = new Capture(request.retain)
  const child = spawn(process.execPath, ['ace.js', ...request.argv], {
    cwd: process.cwd(),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  let outcome: AceResult['outcome'] = 'exited'
  let exited = false
  let exitCode: number | null = null
  let exitSignal: string | null = null
  let streamsForcedClosed = false
  let failure: Error | undefined
  let finished = false
  const timers: NodeJS.Timeout[] = []

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal)
      } catch {
        // The group is already gone.
      }
    }
  }

  const finish = () => {
    if (finished) {
      return
    }
    finished = true
    for (const timer of timers) {
      clearTimeout(timer)
    }
    clearInterval(parentPoll)
    signalGroup('SIGKILL')
    const message: AceMessage = failure
      ? { type: 'error', message: failure.message }
      : {
          type: 'result',
          result: {
            exitCode,
            signal: exitSignal,
            outcome,
            stdout: stdout.text(),
            stderr: stderr.text(),
            bytes: { stdout: stdout.bytes, stderr: stderr.bytes },
            truncated: {
              stdout: stdout.bytes > stdout.retained,
              stderr: stderr.bytes > stderr.retained,
            },
            streamsForcedClosed,
            durationMs: Date.now() - started,
          },
        }
    send(message, () => process.exit(0))
  }

  const stop = (reason: 'timeout' | 'cancelled') => {
    if (finished || outcome !== 'exited') {
      return
    }
    if (exited) {
      // Only pipes held by escaped processes remain; nothing to interrupt.
      finish()
      return
    }
    outcome = reason
    signalGroup('SIGTERM')
    timers.push(
      setTimeout(() => {
        signalGroup('SIGKILL')
        timers.push(setTimeout(finish, FORCE_FINISH_MS))
      }, KILL_GRACE_MS)
    )
  }

  timers.push(setTimeout(() => stop('timeout'), request.timeout))
  const parentPoll = setInterval(() => {
    try {
      process.kill(request.parentPid, 0)
    } catch {
      stop('cancelled')
    }
  }, PARENT_POLL_MS)
  process.on('disconnect', () => stop('cancelled'))
  process.on('SIGTERM', () => stop('cancelled'))
  process.on('message', (message: { type?: string }) => {
    if (message.type === 'cancel') {
      stop('cancelled')
    }
  })

  child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
  child.once('error', (error) => {
    failure = error
  })
  child.once('exit', (code, signal) => {
    exited = true
    exitCode = code
    exitSignal = signal
    // Sweep descendants left in the group.
    signalGroup('SIGKILL')
    timers.push(
      setTimeout(() => {
        streamsForcedClosed = true
        child.stdout.destroy()
        child.stderr.destroy()
        finish()
      }, EXIT_DRAIN_MS)
    )
  })
  child.once('close', (code, signal) => {
    if (!exited) {
      exitCode = code
      exitSignal = signal
    }
    finish()
  })

  if (child.pid !== undefined && process.connected) {
    process.send!({ type: 'started', pid: child.pid } satisfies AceMessage)
  }
}

let received = false
process.on('message', (message: AceRequest | { type: 'cancel' }) => {
  if (received) {
    return
  }
  received = true
  if (message.type === 'run') {
    run(message)
  } else {
    send({ type: 'error', message: 'Cancelled before the command started' }, () => process.exit(0))
  }
})

// Do not outlive an owner that disappears before sending the request.
process.on('disconnect', () => {
  if (!received) {
    process.exit(0)
  }
})

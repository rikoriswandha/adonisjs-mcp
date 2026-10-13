/*
|--------------------------------------------------------------------------
| Ace runner
|--------------------------------------------------------------------------
|
| `run_ace_command` backend. Spawns the package-owned watchdog
| (`ace_watchdog.ts`), which runs `node ace.js <argv>` in its own process
| group. Console code never runs in the HTTP process. Output is redacted
| before it is cut to the result budget.
|
*/
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.js'
import { packageRoot } from '../package_info.js'
import type { Redactor } from '../redaction.js'
import type { AceMessage, AceRequest, AceResult } from './ace_watchdog.js'

export const ACE_LIMITATIONS = [
  'Runs in a new console process: no shared HTTP container, in-memory, ALS or tenant state; provider boot side effects happen.',
  'Stdin is closed and non-TTY. Interactive prompts receive no answer; exit 0 does not prove a prompt finished.',
  'A dev-server hard restart loses the result: outcome and performed side effects are unknown. Inspect state; do not retry blindly.',
  'Generators and migrations can write files and databases. Killing the process group does not undo side effects; no automatic retry.',
  'POSIX process-group cleanup does not cover processes that deliberately detach into another group: they are not killed, and pipes they hold are closed shortly after the command exits (streamsForcedClosed). This is not a sandbox.',
]

/**
 * Extra time past the deadline before the watchdog itself is killed. Covers
 * the watchdog's own SIGTERM→SIGKILL grace, forced finish and pipe drain.
 */
const SAFETY_MARGIN_MS = 8000

/**
 * Bytes retained past the per-stream budget so a secret straddling the cut
 * is still redacted as a whole.
 */
const REDACTION_SLACK_BYTES = 4096

/**
 * Longest prefix of `text` within `maxBytes`, without a broken trailing
 * UTF-8 sequence.
 */
function utf8Prefix(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) {
    return { text, cut: false }
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true }),
    cut: true,
  }
}

export async function aceWatchdogEntry() {
  const root = await packageRoot()
  const entry = root && join(root, 'build/src/ace/ace_watchdog.js')
  return entry && existsSync(entry) ? entry : undefined
}
export class AceRunner {
  constructor(
    private appRoot: string,
    private redactor: Redactor
  ) {}
  async available() {
    if (process.platform === 'win32' || !existsSync(join(this.appRoot, 'ace.js'))) {
      return {
        available: false as const,
        code: 'CAPABILITY_UNSUPPORTED' as const,
        reason: 'Ace requires POSIX process groups and an app-local ace.js',
      }
    }
    if (!(await aceWatchdogEntry())) {
      return {
        available: false as const,
        code: 'CAPABILITY_UNSUPPORTED' as const,
        reason: 'The installed package is missing build/src/ace/ace_watchdog.js',
      }
    }
    return { available: true as const }
  }
  async run(argv: string[], timeout: number, maxBytes: number, signal: AbortSignal) {
    const entry = await aceWatchdogEntry()
    if (!entry) throw new ToolError('CAPABILITY_UNSUPPORTED', 'The Ace watchdog entry is missing')
    if (signal.aborted)
      throw new ToolError('CANCELLED', 'The call was cancelled before Ace was started')
    const watchdog = spawn(process.execPath, [entry], {
      cwd: this.appRoot,
      detached: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      env: { ...process.env },
    })
    let result: AceResult | undefined
    let error: Error | undefined
    let commandPid: number | undefined
    let emergency = false
    let diagnostic = ''
    watchdog.stderr?.on('data', (chunk: Buffer) => {
      if (diagnostic.length < 1024)
        diagnostic += chunk.toString('utf8').slice(0, 1024 - diagnostic.length)
    })
    watchdog.on('message', (message: AceMessage) => {
      if (message.type === 'started') commandPid = message.pid
      if (message.type === 'result') result = message.result
      if (message.type === 'error') error = new Error(message.message)
    })
    const exited = Promise.withResolvers<void>()
    watchdog.once('close', () => exited.resolve())
    watchdog.on('error', (failure) => {
      error = failure
      if (watchdog.pid === undefined) exited.resolve()
    })
    const cancel = () => {
      if (watchdog.connected)
        watchdog.send({ type: 'cancel' }, (failure) => {
          if (failure) error ??= failure
        })
    }
    const killGroup = () => {
      if (commandPid !== undefined) {
        try {
          process.kill(-commandPid, 'SIGKILL')
        } catch {
          /* Already gone. */
        }
      }
      watchdog.kill('SIGKILL')
    }
    const safety = setTimeout(() => {
      emergency = true
      killGroup()
    }, timeout + SAFETY_MARGIN_MS)
    // Two streams share the result after reserving space for argv and
    // metadata; each gets half again so ordinary JSON escaping still fits.
    // Pathological escaping (control bytes) is shortened further by the
    // result encoder, which flags truncation.
    const budget = Math.max(
      0,
      Math.floor((maxBytes - Buffer.byteLength(JSON.stringify(argv)) - 8192) / 4)
    )
    const request: AceRequest = {
      type: 'run',
      argv,
      timeout,
      // Slack so a secret straddling the cut is redacted before cutting.
      retain: budget + REDACTION_SLACK_BYTES,
      parentPid: process.pid,
    }
    // The request goes first: a cancel sent earlier would be taken for it.
    watchdog.send(request, (failure) => {
      if (failure) {
        error = failure
        killGroup()
      }
    })
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      await exited.promise
    } finally {
      clearTimeout(safety)
      signal.removeEventListener('abort', cancel)
    }
    if (!result) {
      throw new ToolError(
        emergency ? (signal.aborted ? 'CANCELLED' : 'TIMEOUT') : 'EXECUTION_FAILED',
        this.redactor.text(
          `Ace watchdog failed${emergency ? '; the owned process group was killed; side effects are not undone' : ''}: ${error?.message || diagnostic || 'no result'}`
        ),
        { details: { signal: watchdog.signalCode, limitations: ACE_LIMITATIONS } }
      )
    }
    const stdout = utf8Prefix(this.redactor.text(result.stdout), budget)
    const stderr = utf8Prefix(this.redactor.text(result.stderr), budget)
    const data = {
      ...result,
      argv: argv.map((value) => this.redactor.text(value)),
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: {
        stdout: result.bytes.stdout > budget || stdout.cut,
        stderr: result.bytes.stderr > budget || stderr.cut,
      },
    }
    if (result.outcome !== 'exited') {
      throw new ToolError(
        result.outcome === 'timeout' ? 'TIMEOUT' : 'CANCELLED',
        'The Ace process group was killed; side effects already performed are not undone. Inspect state; do not retry automatically.',
        { details: { ...data, limitations: ACE_LIMITATIONS } }
      )
    }
    return { data, limitations: ACE_LIMITATIONS }
  }
}

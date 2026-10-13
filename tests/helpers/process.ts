/*
|--------------------------------------------------------------------------
| Child process helpers
|--------------------------------------------------------------------------
|
| Fixture processes never inherit the developer's environment wholesale:
| variables such as DATABASE_URL, PG*, NODE_OPTIONS or npm_config_* could
| point a fixture at a real database or change npm behavior. Only the
| allowlisted keys below are forwarded.
|
*/

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'

const INHERITED_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
] as const

/**
 * Minimal environment for fixture processes plus explicit overrides.
 */
export function isolatedEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of INHERITED_KEYS) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key]
    }
  }
  return { ...environment, ...overrides }
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  text: string

  /**
   * Parsed record when the line is a JSON object (pino output).
   */
  record?: Record<string, unknown>
}

/**
 * Line-oriented capture of a child process output.
 */
export class LogCapture {
  #lines: LogLine[] = []
  #waiters = new Set<() => void>()

  attach(readable: Readable | null, stream: LogLine['stream']) {
    if (!readable) {
      return
    }
    let pending = ''
    readable.setEncoding('utf8')
    readable.on('data', (chunk: string) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) {
        this.#push(stream, part)
      }
    })
    readable.on('end', () => {
      if (pending) {
        this.#push(stream, pending)
      }
    })
  }

  #push(stream: LogLine['stream'], text: string) {
    const line: LogLine = { stream, text }
    if (text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          line.record = Object.fromEntries(Object.entries(parsed))
        }
      } catch {
        // Not JSON; keep the raw text only.
      }
    }
    this.#lines.push(line)
    for (const notify of this.#waiters) {
      notify()
    }
  }

  get lines(): readonly LogLine[] {
    return this.#lines
  }

  /**
   * Structured (JSON) log records only.
   */
  get records(): Record<string, unknown>[] {
    return this.#lines.flatMap((line) => (line.record ? [line.record] : []))
  }

  text(): string {
    return this.#lines.map((line) => line.text).join('\n')
  }

  /**
   * Resolves with the first line matching `predicate`, including lines
   * captured before the call.
   */
  waitFor(predicate: (line: LogLine) => boolean, timeoutMs: number): Promise<LogLine> {
    const { promise, resolve, reject } = Promise.withResolvers<LogLine>()
    let checked = 0
    const check = () => {
      for (; checked < this.#lines.length; checked++) {
        if (predicate(this.#lines[checked])) {
          cleanup()
          resolve(this.#lines[checked])
          return
        }
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for log line.\n${this.text()}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      this.#waiters.delete(check)
    }
    this.#waiters.add(check)
    check()
    return promise
  }
}

export interface CommandResult {
  command: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Spawns a process in its own process group so the whole tree can be
 * signalled.
 */
export function spawnGroup(command: string, args: readonly string[], options: CommandOptions) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Sends `signal` to the process group of `child`. Missing groups are
 * ignored.
 */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) {
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

/**
 * Whether any process of the group led by `pid` is still alive.
 */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Runs a command to completion. On deadline the whole process group is
 * killed and the result reports the signal.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions
): Promise<CommandResult> {
  const child = spawnGroup(command, args, options)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))

  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), options.timeoutMs ?? 300_000)
  const closed = Promise.withResolvers<[number | null, NodeJS.Signals | null]>()
  child.once('error', closed.reject)
  child.once('close', (code, closeSignal) => closed.resolve([code, closeSignal]))
  const [exitCode, signal] = await closed.promise.finally(() => clearTimeout(timer))

  return { command: [command, ...args].join(' '), exitCode, signal, stdout, stderr }
}

/**
 * Like `runCommand`, but fails with the captured output on non-zero exit.
 */
export async function runChecked(
  command: string,
  args: readonly string[],
  options: CommandOptions
): Promise<CommandResult> {
  const result = await runCommand(command, args, options)
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${result.exitCode ?? result.signal}): ${result.command}\ncwd: ${options.cwd}\n${result.stdout}\n${result.stderr}`
    )
  }
  return result
}

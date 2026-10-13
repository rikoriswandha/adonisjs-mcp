/*
|--------------------------------------------------------------------------
| SQLite executor
|--------------------------------------------------------------------------
|
| Runs one read-only query in a dedicated child process (see
| `sqlite_reader.ts`). The deadline is measured from spawn and enforced
| with SIGKILL: better-sqlite3 runs queries synchronously, so only killing
| the process interrupts them without blocking the application. The
| process inherits no application environment and is awaited until it
| exits on every path.
|
*/

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.js'
import { packageRoot } from '../package_info.js'
import type { AnalyzeRequest, ReaderMessage } from './sqlite_reader.js'

const STDERR_LIMIT = 8 * 1024

export interface SqliteReadRequest extends Omit<AnalyzeRequest, 'type'> {
  timeoutMs: number
  signal: AbortSignal

  /**
   * Throws a `ToolError` to refuse the query before it runs.
   */
  authorize(tables: readonly string[]): void
}

export interface SqliteReadResult {
  columns: string[]
  rows: unknown[][]
  hasMore: boolean
  tables: string[]
  truncatedValues: boolean
}

/**
 * Built entry of the reader process, shipped in the package.
 */
export async function sqliteReaderEntry(): Promise<string | undefined> {
  const root = await packageRoot()
  const entry = root && join(root, 'build', 'src', 'database', 'sqlite_reader.js')
  return entry && existsSync(entry) ? entry : undefined
}

export async function runSqliteRead(request: SqliteReadRequest): Promise<SqliteReadResult> {
  const entry = await sqliteReaderEntry()
  if (!entry) {
    throw new ToolError(
      'CAPABILITY_UNSUPPORTED',
      'The SQLite reader process is not part of this installation (build/src/database/sqlite_reader.js is missing)'
    )
  }

  const child = spawn(process.execPath, [entry], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '' },
    serialization: 'json',
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr += chunk.slice(0, STDERR_LIMIT - stderr.length)
    }
  })

  /**
   * `error` fires when the process cannot be spawned (then no `exit`
   * follows) or when IPC fails because it died; only `exit` proves it is
   * gone otherwise.
   */
  let childError: Error | undefined
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.on('error', (error) => {
      childError ??= error
      if (child.pid === undefined) {
        resolve()
      }
      waiting?.()
    })
  })
  const ended = () =>
    childError !== undefined || child.exitCode !== null || child.signalCode !== null
  const inbox: ReaderMessage[] = []
  let waiting: (() => void) | undefined
  child.on('message', (message: ReaderMessage) => {
    inbox.push(message)
    waiting?.()
  })
  void exited.then(() => waiting?.())

  let stopped: 'TIMEOUT' | 'CANCELLED' | null = null
  const kill = () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  const stop = (reason: 'TIMEOUT' | 'CANCELLED') => {
    stopped ??= reason
    kill()
  }
  const timer = setTimeout(() => stop('TIMEOUT'), request.timeoutMs)
  const onAbort = () => stop('CANCELLED')
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) {
    stop('CANCELLED')
  }

  const next = async (): Promise<ReaderMessage> => {
    while (inbox.length === 0) {
      if (stopped) {
        throw stopped === 'TIMEOUT'
          ? new ToolError(
              'TIMEOUT',
              `The query exceeded its ${request.timeoutMs} ms deadline; the SQLite reader process was killed`
            )
          : new ToolError(
              'CANCELLED',
              'The call was cancelled; the SQLite reader process was killed'
            )
      }
      if (ended()) {
        throw new ToolError(
          'EXECUTION_FAILED',
          `The SQLite reader process exited unexpectedly (${
            childError?.message ?? child.signalCode ?? child.exitCode
          })${stderr ? `: ${stderr.trim()}` : ''}`
        )
      }
      await new Promise<void>((resolve) => {
        waiting = resolve
        if (stopped || ended()) {
          resolve()
        }
      })
      waiting = undefined
    }
    const message = inbox.shift()!
    if (message.type === 'error') {
      throw new ToolError(message.code, message.message)
    }
    return message
  }

  try {
    const analyze: AnalyzeRequest = {
      type: 'analyze',
      file: request.file,
      driver: request.driver,
      sql: request.sql,
      bindings: request.bindings,
      explain: request.explain,
      maxRows: request.maxRows,
      maxValueChars: request.maxValueChars,
    }
    child.send(analyze)
    const analyzed = await next()
    if (analyzed.type !== 'analyzed') {
      throw new ToolError('EXECUTION_FAILED', 'The SQLite reader process answered out of order')
    }
    request.authorize(analyzed.tables)
    child.send({ type: 'execute' })
    const result = await next()
    if (result.type !== 'result') {
      throw new ToolError('EXECUTION_FAILED', 'The SQLite reader process answered out of order')
    }
    return {
      columns: result.columns,
      rows: result.rows,
      hasMore: result.hasMore,
      tables: analyzed.tables,
      truncatedValues: result.truncatedValues,
    }
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
    kill()
    await exited
  }
}

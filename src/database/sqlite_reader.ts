/*
|--------------------------------------------------------------------------
| SQLite reader process
|--------------------------------------------------------------------------
|
| Entry point of the child process that runs one read-only SQLite query
| for `execute_sql_query`. It owns its own connection, opened readonly on
| an existing file with the application's better-sqlite3 driver; no
| application state, extension loading or user-defined function exists
| here. The parent kills the process at the deadline, which interrupts a
| synchronous query that no in-process timeout could stop.
|
| Protocol (IPC, JSON):
|   parent → { type: 'analyze', ...AnalyzeRequest }
|   child  → { type: 'analyzed', tables } | { type: 'error', code, message }
|   parent → { type: 'execute' }
|   child  → { type: 'result', columns, rows, hasMore, truncatedValues }
|          | { type: 'error', code, message }
|
*/

import { createRequire } from 'node:module'
import {
  SQLITE_READ_KEYWORDS,
  checkSqliteProgram,
  leadingKeyword,
  type SqliteInstruction,
} from './sqlite_policy.js'

export interface AnalyzeRequest {
  type: 'analyze'
  file: string

  /**
   * Resolved entry file of the application's better-sqlite3 package.
   */
  driver: string
  sql: string
  bindings: unknown[]
  explain: boolean
  maxRows: number

  /**
   * String values longer than this are shortened.
   */
  maxValueChars: number
}

export type ReaderMessage =
  | { type: 'analyzed'; tables: string[] }
  | {
      type: 'result'
      columns: string[]
      rows: unknown[][]
      hasMore: boolean
      truncatedValues: boolean
    }
  | { type: 'error'; code: 'READ_ONLY_VIOLATION' | 'EXECUTION_FAILED'; message: string }

interface Statement {
  readonly reader: boolean
  readonly readonly: boolean
  raw(toggle?: boolean): Statement
  columns(): Array<{ name: string }>
  iterate(...bindings: unknown[]): IterableIterator<unknown[]>
  all(...bindings: unknown[]): unknown[]
}

interface Database {
  prepare(sql: string): Statement
  close(): void
}

type DatabaseConstructor = new (
  file: string,
  options: { readonly: boolean; fileMustExist: boolean }
) => Database

class Denied extends Error {}

function send(message: ReaderMessage): Promise<void> {
  return new Promise((resolve) => {
    process.send!(message, undefined, {}, () => resolve())
  })
}

function nextMessage(): Promise<unknown> {
  return new Promise((resolve) => process.once('message', resolve))
}

function value(input: unknown, maxChars: number, flags: { truncated: boolean }): unknown {
  if (typeof input === 'string' && input.length > maxChars) {
    flags.truncated = true
    return `${input.slice(0, maxChars)}…`
  }
  if (typeof input === 'bigint') {
    return input.toString()
  }
  if (input instanceof Uint8Array) {
    return `[Binary ${input.byteLength} bytes]`
  }
  return input
}

/**
 * Prepares and checks the statement; returns the tables it reads.
 */
function analyze(
  database: Database,
  request: AnalyzeRequest
): { statement: Statement; tables: string[] } {
  const keyword = leadingKeyword(request.sql)
  if (!SQLITE_READ_KEYWORDS.has(keyword)) {
    throw new Denied(
      `only SELECT, WITH and VALUES queries are allowed, got "${keyword || 'empty statement'}"`
    )
  }
  let statement: Statement
  try {
    statement = database.prepare(request.sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/more than one statement/i.test(message)) {
      throw new Denied('exactly one statement is required')
    }
    throw error
  }
  if (!statement.readonly) {
    throw new Denied('the statement writes to the database')
  }
  if (!statement.reader) {
    throw new Denied('the statement does not return rows')
  }
  const program = database
    .prepare(`EXPLAIN ${request.sql}`)
    .all(...request.bindings) as SqliteInstruction[]
  const verdict = checkSqliteProgram(program)
  if (!verdict.allowed) {
    throw new Denied(verdict.reason)
  }
  const schema = database
    .prepare('SELECT tbl_name, rootpage FROM sqlite_schema WHERE rootpage > 0')
    .all() as Array<{ tbl_name: string; rootpage: number }>
  const tables = new Set<string>()
  for (const page of verdict.rootPages) {
    tables.add(
      page === 1
        ? 'sqlite_schema'
        : (schema.find((row) => row.rootpage === page)?.tbl_name ?? `#${page}`)
    )
  }
  return { statement, tables: [...tables].sort() }
}

async function main() {
  const request = (await nextMessage()) as AnalyzeRequest
  const Driver = createRequire(request.driver)(request.driver) as DatabaseConstructor
  let database: Database | undefined
  try {
    database = new Driver(request.file, { readonly: true, fileMustExist: true })
    const { statement, tables } = analyze(database, request)
    await send({ type: 'analyzed', tables })

    const next = (await nextMessage()) as { type: string }
    if (next.type !== 'execute') {
      return
    }
    const flags = { truncated: false }
    const target = request.explain
      ? database.prepare(`EXPLAIN QUERY PLAN ${request.sql}`)
      : statement
    target.raw(true)
    const columns = target.columns().map((column) => column.name)
    const rows: unknown[][] = []
    let hasMore = false
    for (const row of target.iterate(...request.bindings)) {
      if (rows.length === request.maxRows) {
        hasMore = true
        break
      }
      rows.push(row.map((item) => value(item, request.maxValueChars, flags)))
    }
    await send({ type: 'result', columns, rows, hasMore, truncatedValues: flags.truncated })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await send({
      type: 'error',
      code: error instanceof Denied ? 'READ_ONLY_VIOLATION' : 'EXECUTION_FAILED',
      message,
    })
  } finally {
    database?.close()
    process.disconnect()
  }
}

if (process.send) {
  void main()
}

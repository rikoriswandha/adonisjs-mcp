/*
|--------------------------------------------------------------------------
| PostgreSQL reader
|--------------------------------------------------------------------------
|
| Executes one policy-approved read query on a connection owned by this
| package, never on the application pool:
|
| 1. Connect as the configured reader role; refuse superusers, roles with
|    write privileges and (for tenant reads) roles with BYPASSRLS.
| 2. BEGIN READ ONLY, transaction-local statement_timeout and tenant
|    setting through trusted parameterized statements.
| 3. Inspect the relations the query names (row security flags), and let
|    the caller authorize them before anything runs.
| 4. DECLARE a cursor for the query and FETCH at most maxRows + 1 rows,
|    so the server never materializes more for the client. Every
|    statement uses the extended protocol, so a statement can never carry
|    a second command.
| 5. A deadline or cancellation cancels the running statement through a
|    separate control connection (pg_cancel_backend), waits for it to
|    settle, rolls back and closes the reader connection. The session is
|    discarded entirely, so nothing it did can leak into later calls.
|
*/

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ToolError } from '../errors.js'
import type { RelationName } from './postgres_policy.js'

/**
 * Setting read by row security policies, as set by the tenant package's
 * `TenantDatabaseExecutor`.
 */
export const TENANT_SETTING = 'app.tenant_id'

interface PgQueryConfig {
  text: string
  values?: unknown[]
  queryMode: 'extended'
  rowMode?: 'array'
}

interface PgResult {
  rows: unknown[]
  fields: Array<{ name: string }>
}

interface PgClient {
  readonly processID?: number | null
  connect(): Promise<void>
  query(config: PgQueryConfig): Promise<PgResult>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): void
}

export interface PgModule {
  Client: new (config: Record<string, unknown>) => PgClient
}

export interface RelationInfo {
  schema: string | null
  name: string

  /**
   * `missing` when the name does not resolve to a relation (e.g. a CTE).
   */
  kind:
    | 'table'
    | 'partitioned table'
    | 'view'
    | 'materialized view'
    | 'foreign table'
    | 'other'
    | 'missing'
  rowSecurity: boolean | null
  forceRowSecurity: boolean | null
}

export interface ReaderRequest {
  connection: Record<string, unknown>
  sql: string
  bindings: unknown[]
  maxRows: number
  timeoutMs: number
  signal: AbortSignal
  explain: boolean
  relations: readonly RelationName[]

  /**
   * Tenant id set as `app.tenant_id` for the transaction, or `null`.
   */
  tenantId: string | null

  /**
   * Throws a `ToolError` to refuse the query before it runs.
   */
  authorize(relations: readonly RelationInfo[]): void
}

export interface ReaderResult {
  role: string
  columns: string[]
  rows: unknown[][]
  hasMore: boolean
  relations: RelationInfo[]
}

const RELATION_KINDS: Record<string, RelationInfo['kind']> = {
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
}

const ROLE_QUERY = `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
  (SELECT count(*) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
      AND (pg_catalog.has_table_privilege(c.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(c.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(c.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(c.oid, 'TRUNCATE')))::int AS writable
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`

const RELATIONS_QUERY = `SELECT r.schema_name, r.rel_name, n.nspname, c.relname, c.relkind,
  c.relrowsecurity, c.relforcerowsecurity
FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r(schema_name, rel_name, position)
LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(
  CASE WHEN r.schema_name = '' THEN pg_catalog.format('%I', r.rel_name)
  ELSE pg_catalog.format('%I.%I', r.schema_name, r.rel_name) END)
LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
ORDER BY r.position`

const CURSOR = 'adonisjs_mcp_cursor'

/**
 * How much later than the external deadline PostgreSQL's own
 * statement_timeout fires.
 */
const STATEMENT_TIMEOUT_GRACE_MS = 1000

/**
 * The `pg` driver installed in the application, or `undefined`.
 */
export function loadPg(appRoot: string): PgModule | undefined {
  try {
    const module: unknown = createRequire(join(appRoot, 'package.json'))('pg')
    const candidate = module as Partial<PgModule> & { default?: Partial<PgModule> }
    const client = candidate.Client ?? candidate.default?.Client
    return typeof client === 'function' ? { Client: client } : undefined
  } catch {
    return undefined
  }
}

function sqlState(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function failure(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error
  }
  const state = sqlState(error)
  const message = error instanceof Error ? error.message : String(error)
  if (state === '25006') {
    return new ToolError('READ_ONLY_VIOLATION', message, { details: { sqlState: state } })
  }
  if (state === '57014') {
    return new ToolError(
      'TIMEOUT',
      `The query was cancelled by PostgreSQL's statement_timeout backstop: ${message}`,
      { details: { sqlState: state } }
    )
  }
  return new ToolError('EXECUTION_FAILED', message, {
    ...(state ? { details: { sqlState: state } } : {}),
    cause: error,
  })
}

function query(text: string, values: unknown[] = [], arrays = false): PgQueryConfig {
  return { text, values, queryMode: 'extended', ...(arrays ? { rowMode: 'array' } : {}) }
}

async function cancelBackend(pg: PgModule, connection: Record<string, unknown>, pid: number) {
  const control = new pg.Client({ ...connection, application_name: 'adonisjs-mcp-cancel' })
  control.on('error', () => {})
  try {
    await control.connect()
    await control.query(query('SELECT pg_catalog.pg_cancel_backend($1)', [pid]))
  } finally {
    await control.end().catch(() => {})
  }
}

export async function runPostgresRead(pg: PgModule, request: ReaderRequest): Promise<ReaderResult> {
  const started = performance.now()
  const reader = new pg.Client({
    ...request.connection,
    application_name: 'adonisjs-mcp-reader',
    connectionTimeoutMillis: request.timeoutMs,
  })
  reader.on('error', () => {})

  let stopped: 'TIMEOUT' | 'CANCELLED' | null = null
  let cancellation: Promise<void> | undefined
  let connected = false
  const stop = (reason: 'TIMEOUT' | 'CANCELLED') => {
    if (stopped) {
      return
    }
    stopped = reason
    const pid = reader.processID
    if (connected && typeof pid === 'number') {
      cancellation = cancelBackend(pg, request.connection, pid).catch(() => {})
    } else if (!connected) {
      cancellation = reader.end().catch(() => {})
    }
  }
  const stoppedError = () =>
    stopped === 'TIMEOUT'
      ? new ToolError(
          'TIMEOUT',
          `The query exceeded its ${request.timeoutMs} ms deadline and was cancelled in PostgreSQL (pg_cancel_backend)`
        )
      : new ToolError('CANCELLED', 'The call was cancelled; the query was cancelled in PostgreSQL')
  const checkpoint = () => {
    if (stopped) {
      throw stoppedError()
    }
  }

  const timer = setTimeout(() => stop('TIMEOUT'), request.timeoutMs)
  const onAbort = () => stop('CANCELLED')
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) {
    stop('CANCELLED')
  }

  try {
    await reader.connect()
    connected = true
    checkpoint()

    const roleResult = await reader.query(query(ROLE_QUERY))
    const role = roleResult.rows[0] as
      { role: string; superuser: boolean; bypass_rls: boolean; writable: number } | undefined
    if (!role) {
      throw new ToolError('CAPABILITY_UNSUPPORTED', 'The reader role could not be inspected')
    }
    if (role.superuser) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `The configured reader role "${role.role}" is a superuser; use a role with only SELECT privileges`
      )
    }
    if (role.writable > 0) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `The configured reader role "${role.role}" can write ${role.writable} relation(s); grant it SELECT only`
      )
    }
    if (request.tenantId !== null && role.bypass_rls) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `The configured reader role "${role.role}" has BYPASSRLS; tenant-scoped SQL needs a role subject to row security`
      )
    }
    checkpoint()

    await reader.query(query('BEGIN READ ONLY'))
    /**
     * Backstop for the external deadline, in case the application's event
     * loop is blocked when the timer should fire.
     */
    const remaining = Math.max(1, Math.ceil(request.timeoutMs - (performance.now() - started)))
    await reader.query(
      query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [
        String(remaining + STATEMENT_TIMEOUT_GRACE_MS),
      ])
    )
    if (request.tenantId !== null) {
      await reader.query(
        query('SELECT pg_catalog.set_config($1, $2, true)', [TENANT_SETTING, request.tenantId])
      )
    }

    let relations: RelationInfo[] = []
    if (request.relations.length > 0) {
      const inspected = await reader.query(
        query(RELATIONS_QUERY, [
          request.relations.map((relation) => relation.schema ?? ''),
          request.relations.map((relation) => relation.name),
        ])
      )
      relations = (
        inspected.rows as Array<{
          schema_name: string
          rel_name: string
          nspname: string | null
          relname: string | null
          relkind: string | null
          relrowsecurity: boolean | null
          relforcerowsecurity: boolean | null
        }>
      ).map((row) => ({
        schema: row.nspname ?? (row.schema_name || null),
        name: row.relname ?? row.rel_name,
        kind: row.relkind === null ? 'missing' : (RELATION_KINDS[row.relkind] ?? 'other'),
        rowSecurity: row.relrowsecurity,
        forceRowSecurity: row.relforcerowsecurity,
      }))
    }
    request.authorize(relations)
    checkpoint()

    if (request.explain) {
      const plan = await reader.query(query(`EXPLAIN ${request.sql}`, request.bindings, true))
      return {
        role: role.role,
        columns: plan.fields.map((field) => field.name),
        rows: plan.rows as unknown[][],
        hasMore: false,
        relations,
      }
    }

    await reader.query(
      query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${request.sql}`, request.bindings)
    )
    checkpoint()
    const fetched = await reader.query(
      query(`FETCH FORWARD ${request.maxRows + 1} FROM ${CURSOR}`, [], true)
    )
    const rows = fetched.rows as unknown[][]
    return {
      role: role.role,
      columns: fetched.fields.map((field) => field.name),
      rows: rows.slice(0, request.maxRows),
      hasMore: rows.length > request.maxRows,
      relations,
    }
  } catch (error) {
    if (stopped) {
      throw stoppedError()
    }
    throw failure(error)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
    await cancellation
    if (connected) {
      await reader.query(query('ROLLBACK')).catch(() => {})
    }
    await reader.end().catch(() => {})
  }
}

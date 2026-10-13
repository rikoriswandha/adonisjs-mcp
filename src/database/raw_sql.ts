/*
|--------------------------------------------------------------------------
| Raw SQL
|--------------------------------------------------------------------------
|
| Chooses how `execute_sql_query` runs a statement and applies the tenant
| policy (plan D28, D29):
|
| - Read-only (default): never on the application pool. PostgreSQL runs on
|   a dedicated least-privilege reader (`tools.sql.readers`), SQLite in a
|   readonly child process. Other dialects are not supported.
| - Read-write (`tools.sql.readOnly: false`): the statement runs on the
|   application connection and can change data.
|
| Tenants (`@rikology/adonisjs-tenant`): raw SQL is not an ORM scope, so a
| `tenant` is only honored where the database enforces it, i.e. on
| PostgreSQL tables with FORCE ROW LEVEL SECURITY read by a reader without
| BYPASSRLS, with `app.tenant_id` set by this package. Without a tenant,
| reading tenant-scoped tables (TenantScope models, row security tables)
| requires `tools.sql.allowCrossTenant` and is labelled cross-tenant.
|
*/

import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { ToolError } from '../errors.js'
import type {
  Availability,
  AvailabilityContext,
  PostgresReaderConfig,
  ResolvedMcpConfig,
  TenantIdentity,
  ToolContext,
} from '../types.js'
import { lucidAvailability, type ConnectionDescription, type LucidAccess } from './lucid.js'
import type { ModelCatalog } from './models.js'
import { checkPostgresQuery } from './postgres_policy.js'
import { loadPg, runPostgresRead, TENANT_SETTING, type RelationInfo } from './postgres_reader.js'
import { runSqliteRead } from './sqlite_executor.js'

export type SqlBinding = string | number | boolean | null | Array<string | number | boolean | null>

export interface RawSqlInput {
  query: string
  bindings?: SqlBinding[]
  connection?: string
  tenant?: string
  explain?: boolean
  timeout?: number
}

type Executor =
  | { kind: 'postgres-reader'; connection: Record<string, unknown> }
  | { kind: 'sqlite-reader'; file: string; driver: string }

type Support = { supported: true; executor: Executor } | { supported: false; reason: string }

interface TenantPolicy {
  tenant: TenantIdentity | null
  crossTenant: boolean
  tenantTables: ReadonlySet<string>
}

function readerConnection(
  connection: ConnectionDescription,
  reader: Readonly<PostgresReaderConfig>
): Record<string, unknown> | string {
  if ('connectionString' in reader) {
    return { connectionString: reader.connectionString }
  }
  const base = connection.config.connection
  if (typeof base === 'string' || base?.connectionString !== undefined) {
    return `connection "${connection.name}" is configured with a connection string; set tools.sql.readers.${connection.name}.connectionString for the reader`
  }
  const ssl = reader.ssl ?? base?.ssl
  return {
    host: reader.host ?? base?.host,
    port: reader.port ?? (base?.port === undefined ? undefined : Number(base.port)),
    database: reader.database ?? base?.database,
    user: reader.user,
    password: reader.password,
    ...(ssl === undefined
      ? {}
      : { ssl: typeof ssl === 'object' && ssl !== null ? { ...ssl } : ssl }),
  }
}

/**
 * Bare table name, for comparisons with model tables (`schema.table`).
 */
function tableName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

export class RawSql {
  readonly #lucid: LucidAccess
  readonly #catalog: ModelCatalog

  constructor(lucid: LucidAccess, catalog: ModelCatalog) {
    this.#lucid = lucid
    this.#catalog = catalog
  }

  /**
   * How read-only SQL would run on `connection`, without connecting.
   */
  support(connection: ConnectionDescription, config: ResolvedMcpConfig): Support {
    if (connection.dialect === 'postgres') {
      const reader = config.tools.sql.readers[connection.name]
      if (!reader) {
        return {
          supported: false,
          reason: `PostgreSQL connection "${connection.name}" has no dedicated reader: set tools.sql.readers.${connection.name} in config/mcp.ts to a role with only SELECT privileges (e.g. { user: 'app_reader', password: env.get('DB_READER_PASSWORD') })`,
        }
      }
      if (!loadPg(this.#lucid.appRoot)) {
        return { supported: false, reason: 'the "pg" driver is not installed in the application' }
      }
      const settings = readerConnection(connection, reader)
      return typeof settings === 'string'
        ? { supported: false, reason: settings }
        : { supported: true, executor: { kind: 'postgres-reader', connection: settings } }
    }
    if (connection.dialect === 'sqlite') {
      const settings = connection.config.connection
      const filename = typeof settings === 'object' ? settings.filename : undefined
      if (!filename || filename === ':memory:' || filename.startsWith('file:')) {
        return {
          supported: false,
          reason: `SQLite connection "${connection.name}" is not a database file (in-memory and URI databases cannot be opened read-only by a separate process)`,
        }
      }
      let driver: string
      try {
        driver = createRequire(join(this.#lucid.appRoot, 'package.json')).resolve('better-sqlite3')
      } catch {
        return {
          supported: false,
          reason:
            'read-only SQLite queries need the better-sqlite3 driver installed in the application',
        }
      }
      return {
        supported: true,
        executor: {
          kind: 'sqlite-reader',
          file: isAbsolute(filename) ? filename : resolve(process.cwd(), filename),
          driver,
        },
      }
    }
    return {
      supported: false,
      reason: `read-only enforcement for the "${connection.client}" client is not implemented (supported: PostgreSQL with a reader, SQLite files)`,
    }
  }

  /**
   * Served when Lucid is active and, in read-only mode, at least one
   * connection can run read-only SQL.
   */
  availability(context: AvailabilityContext): Availability {
    const lucid = lucidAvailability(context)
    if (!lucid.available || !context.config.tools.sql.readOnly) {
      return lucid
    }
    const verdicts = this.#lucid
      .connections()
      .map((connection) => ({ connection, support: this.support(connection, context.config) }))
    if (verdicts.some(({ support }) => support.supported)) {
      return { available: true }
    }
    return {
      available: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason:
        verdicts
          .map(({ support }) => (support.supported ? '' : support.reason))
          .filter(Boolean)
          .join('; ') || 'no database connection is configured',
    }
  }

  async #tenantTables(connection: ConnectionDescription): Promise<Set<string>> {
    const snapshot = await this.#catalog.snapshot()
    const primary = this.#lucid.primaryConnectionName()
    return new Set(
      snapshot.models
        .filter((model) => model.tenantScoped && (model.connection ?? primary) === connection.name)
        .map((model) => tableName(model.table))
    )
  }

  async #tenantPolicy(input: RawSqlInput, context: ToolContext, connection: ConnectionDescription) {
    const tenancy = context.tenancy
    if (input.tenant !== undefined && !tenancy) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        'The tenant option requires @rikology/adonisjs-tenant (binding "tenant.service"), which is not active'
      )
    }
    const policy: TenantPolicy = {
      tenant: null,
      crossTenant: false,
      tenantTables: tenancy ? await this.#tenantTables(connection) : new Set(),
    }
    if (input.tenant !== undefined && tenancy) {
      policy.tenant = await tenancy.resolve(input.tenant)
    }
    return policy
  }

  async execute(input: RawSqlInput, context: ToolContext) {
    const { readOnly, maxRows, allowCrossTenant, timeout: maxTimeout } = context.config.tools.sql
    const timeout = input.timeout ?? maxTimeout
    if (timeout > maxTimeout) {
      throw new ToolError(
        'INPUT_INVALID',
        `timeout ${timeout} ms exceeds tools.sql.timeout (${maxTimeout} ms)`
      )
    }
    const connection = this.#lucid.connection(input.connection)
    const policy = await this.#tenantPolicy(input, context, connection)
    const bindings = input.bindings ?? []
    const base = {
      connection: connection.name,
      dialect: connection.dialect,
      maxRows,
    }

    if (!readOnly) {
      return this.#readWrite(input, context, connection, policy, base)
    }

    const support = this.support(connection, context.config)
    if (!support.supported) {
      throw new ToolError('CAPABILITY_UNSUPPORTED', support.reason)
    }

    const crossTenantCheck = (tenantTablesRead: string[]) => {
      if (policy.tenant || tenantTablesRead.length === 0) {
        return
      }
      if (!allowCrossTenant) {
        throw new ToolError(
          'TENANT_SCOPE_REQUIRED',
          `The query reads tenant-scoped tables (${tenantTablesRead.join(', ')}) without a tenant. Pass "tenant" (PostgreSQL row level security only), use query_model with "tenant", or set tools.sql.allowCrossTenant to read across tenants.`
        )
      }
      policy.crossTenant = true
    }

    if (support.executor.kind === 'sqlite-reader') {
      if (policy.tenant) {
        throw new ToolError(
          'TENANT_SCOPE_REQUIRED',
          'SQLite has no row level security, so raw SQL cannot be limited to one tenant. Use query_model with "tenant" to read what the tenant sees.'
        )
      }
      const result = await runSqliteRead({
        file: support.executor.file,
        driver: support.executor.driver,
        sql: input.query,
        bindings,
        explain: input.explain ?? false,
        maxRows,
        maxValueChars: context.config.limits.maxResultBytes,
        timeoutMs: timeout,
        signal: context.signal,
        authorize: (tables) => {
          crossTenantCheck(tables.filter((table) => policy.tenantTables.has(table)))
        },
      })
      const limitations = [
        `Executed in a separate process on a read-only connection to the SQLite file; the statement was checked against its compiled program (single read-only SELECT/WITH/VALUES, built-in functions only, no virtual tables). At most ${maxRows} rows are read.`,
      ]
      if (result.truncatedValues) {
        limitations.push('Long string values were shortened.')
      }
      return {
        data: {
          ...base,
          mode: 'read-only',
          executor: 'sqlite-reader',
          columns: result.columns,
          rows: result.rows,
          returnedRows: result.rows.length,
          hasMore: result.hasMore,
          tablesRead: result.tables,
          tenant: null,
          crossTenant: policy.crossTenant,
        },
        limitations: [...limitations, ...this.#tenantNotes(policy)],
      }
    }

    const { loadPostgresParser } = await import('./postgres_parser.js')
    const verdict = checkPostgresQuery(await loadPostgresParser(), input.query)
    if (!verdict.allowed) {
      throw new ToolError(
        'READ_ONLY_VIOLATION',
        `The statement is outside the read-only subset: ${verdict.reason}`,
        { details: { reason: verdict.reason } }
      )
    }
    const cteNames = new Set(verdict.cteNames)
    const pg = loadPg(this.#lucid.appRoot)!
    const result = await runPostgresRead(pg, {
      connection: support.executor.connection,
      sql: input.query,
      bindings,
      maxRows,
      timeoutMs: timeout,
      signal: context.signal,
      explain: input.explain ?? false,
      relations: verdict.relations,
      tenantId: policy.tenant ? String(policy.tenant.id) : null,
      authorize: (relations) => {
        const read = relations.filter(
          (relation) =>
            !(
              relation.kind === 'missing' &&
              relation.schema === null &&
              cteNames.has(relation.name)
            )
        )
        if (policy.tenant) {
          const unprotected = read.filter(
            (relation) =>
              !(
                (relation.kind === 'table' || relation.kind === 'partitioned table') &&
                relation.rowSecurity === true &&
                relation.forceRowSecurity === true
              )
          )
          if (unprotected.length > 0) {
            throw new ToolError(
              'TENANT_SCOPE_REQUIRED',
              `Tenant-scoped raw SQL may only read tables with FORCE ROW LEVEL SECURITY; ${unprotected
                .map((relation) => `${qualified(relation)} (${describeProtection(relation)})`)
                .join(
                  ', '
                )} ${unprotected.length === 1 ? 'is' : 'are'} not protected. Use query_model with "tenant" instead.`
            )
          }
          return
        }
        crossTenantCheck(
          read
            .filter(
              (relation) => policy.tenantTables.has(relation.name) || relation.rowSecurity === true
            )
            .map(qualified)
        )
      },
    })
    const limitations = [
      `Executed by the dedicated reader role "${result.role}" in a READ ONLY transaction (extended protocol, server-side cursor; at most ${maxRows} rows fetched), never on the application pool. Views, operators and functions defined in the database are trusted code.`,
    ]
    return {
      data: {
        ...base,
        mode: 'read-only',
        executor: 'postgres-reader',
        role: result.role,
        columns: result.columns,
        rows: result.rows,
        returnedRows: result.rows.length,
        hasMore: result.hasMore,
        tablesRead: result.relations
          .filter((relation) => relation.kind !== 'missing')
          .map(qualified),
        tenant: policy.tenant,
        crossTenant: policy.crossTenant,
      },
      limitations: [...limitations, ...this.#tenantNotes(policy)],
    }
  }

  #tenantNotes(policy: TenantPolicy): string[] {
    if (policy.tenant) {
      return [
        `Rows are limited by the database's row level security with ${TENANT_SETTING} = ${String(policy.tenant.id)} for this transaction.`,
      ]
    }
    if (policy.crossTenant) {
      return [
        'Cross-tenant read (tools.sql.allowCrossTenant): tenant-scoped tables were read without a tenant. Row security tables show only what their policies allow without a tenant setting.',
      ]
    }
    return []
  }

  async #readWrite(
    input: RawSqlInput,
    context: ToolContext,
    connection: ConnectionDescription,
    policy: TenantPolicy,
    base: { connection: string; dialect: string; maxRows: number }
  ) {
    if (policy.tenant) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        'Tenant-scoped raw SQL requires read-only mode (tools.sql.readOnly), where row level security is enforced on a dedicated reader'
      )
    }
    if (context.tenancy && !context.config.tools.sql.allowCrossTenant) {
      throw new ToolError(
        'TENANT_SCOPE_REQUIRED',
        'In read-write mode statements run on the application connection and are not checked for tenant-scoped tables. Set tools.sql.allowCrossTenant to run raw SQL across tenants.'
      )
    }
    if (context.tenancy) {
      policy.crossTenant = true
    }
    const sql = input.explain
      ? `${connection.dialect === 'sqlite' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} ${input.query}`
      : input.query
    const timeout = input.timeout ?? context.config.tools.sql.timeout
    const db = await this.#lucid.db()
    const query = db.connection(connection.name).rawQuery(sql, input.bindings ?? [])
    if (connection.dialect === 'postgres') {
      query.timeout(timeout, { cancel: true })
    }
    let response: unknown
    try {
      response = await query
    } catch (error) {
      if (error instanceof Error && error.name === 'KnexTimeoutError') {
        throw new ToolError(
          'TIMEOUT',
          `The statement exceeded ${timeout} ms and was cancelled in PostgreSQL; its effects may or may not have been applied`
        )
      }
      throw error
    }
    const { columns, rows, affectedRows } = normalizeResponse(response)
    const maxRows = base.maxRows
    return {
      data: {
        ...base,
        mode: 'read-write',
        executor: 'app-connection',
        columns,
        rows: rows.slice(0, maxRows),
        returnedRows: Math.min(rows.length, maxRows),
        hasMore: rows.length > maxRows,
        affectedRows,
        tenant: null,
        crossTenant: policy.crossTenant,
      },
      limitations: [
        'Read-write mode (tools.sql.readOnly: false): the statement ran on the application connection pool without a read-only boundary and can change data. The row limit was applied after the driver loaded the whole result.',
        ...(connection.dialect === 'postgres'
          ? []
          : ['The deadline is not enforced on this dialect: the driver cannot cancel queries.']),
        ...this.#tenantNotes(policy),
      ],
    }
  }
}

function qualified(relation: Pick<RelationInfo, 'schema' | 'name'>): string {
  return relation.schema ? `${relation.schema}.${relation.name}` : relation.name
}

function describeProtection(relation: RelationInfo): string {
  if (relation.kind === 'missing') {
    return 'unknown relation'
  }
  if (relation.kind !== 'table' && relation.kind !== 'partitioned table') {
    return relation.kind
  }
  if (!relation.rowSecurity) {
    return 'row level security disabled'
  }
  return 'row level security not forced'
}

/**
 * Rows of a driver response as column names and arrays.
 */
function normalizeResponse(response: unknown): {
  columns: string[]
  rows: unknown[][]
  affectedRows: number | null
} {
  const fromObjects = (objects: unknown[]) => {
    const columns = [
      ...new Set(
        objects.flatMap((row) => (typeof row === 'object' && row !== null ? Object.keys(row) : []))
      ),
    ]
    return {
      columns,
      rows: objects.map((row) =>
        columns.map((column) => (row as Record<string, unknown>)[column] ?? null)
      ),
    }
  }
  if (Array.isArray(response)) {
    return { ...fromObjects(response), affectedRows: null }
  }
  if (typeof response === 'object' && response !== null) {
    const result = response as { rows?: unknown; rowCount?: unknown; changes?: unknown }
    if (Array.isArray(result.rows)) {
      return {
        ...fromObjects(result.rows),
        affectedRows: typeof result.rowCount === 'number' ? result.rowCount : null,
      }
    }
    if (typeof result.changes === 'number') {
      return { columns: [], rows: [], affectedRows: result.changes }
    }
  }
  return { columns: [], rows: [], affectedRows: null }
}

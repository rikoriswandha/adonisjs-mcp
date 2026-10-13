/*
|--------------------------------------------------------------------------
| Lucid access
|--------------------------------------------------------------------------
|
| The database tools use the application's own Lucid service (binding
| `lucid.db`) and its connection config. Lucid is an optional peer: it is
| never imported eagerly, and only through the application importer, so
| the copy the application uses is the one inspected.
|
*/

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import { z } from 'zod'
import { ToolError } from '../errors.js'
import type { Availability, AvailabilityContext } from '../types.js'

export const LUCID_BINDING = 'lucid.db'

export type Dialect = 'postgres' | 'sqlite' | 'mysql' | 'mssql' | 'oracle' | 'unknown'

export interface ColumnInfo {
  type: string
  defaultValue: unknown
  maxLength: number | null
  nullable: boolean
}

/**
 * The part of Lucid's query client used by this package.
 */
export interface LucidQueryClient {
  readonly connectionName: string
  readonly dialect: { readonly name: string }
  readonly schema: { hasTable(table: string): Promise<boolean> }
  query(): LucidSelect
  rawQuery(sql: string, bindings?: unknown[]): LucidRawQuery
  columnsInfo(
    table: string,
    column?: undefined,
    schema?: string
  ): Promise<Record<string, ColumnInfo>>
  getAllTables(schemas?: string[]): Promise<string[]>
}

export interface LucidSelect extends PromiseLike<Record<string, unknown>[]> {
  from(table: string): LucidSelect
  select(...columns: string[]): LucidSelect
  orderBy(column: string, direction?: 'asc' | 'desc'): LucidSelect
}

export interface LucidRawQuery extends PromiseLike<unknown> {
  timeout(ms: number, options?: { cancel?: boolean }): LucidRawQuery
}

export interface LucidDatabase {
  readonly primaryConnectionName: string
  connection(name?: string): LucidQueryClient
}

/**
 * The parts of a Lucid connection config this package reads.
 */
const connectionConfig = z.object({
  client: z.string(),
  connection: z
    .union([
      z.string(),
      z.object({
        host: z.string().optional(),
        port: z.union([z.number(), z.string()]).optional(),
        user: z.string().optional(),
        password: z.string().optional(),
        database: z.string().optional(),
        ssl: z.unknown().optional(),
        connectionString: z.string().optional(),
        filename: z.string().optional(),
      }),
    ])
    .optional(),
  searchPath: z.array(z.string()).optional(),
  migrations: z
    .object({
      paths: z.array(z.string()).optional(),
      tableName: z.string().optional(),
      naturalSort: z.boolean().optional(),
    })
    .optional(),
})

export type ConnectionConfig = z.output<typeof connectionConfig>

export interface ConnectionDescription {
  name: string
  client: string
  dialect: Dialect
  config: ConnectionConfig
}

export function dialectOf(client: string): Dialect {
  switch (client) {
    case 'pg':
    case 'postgres':
    case 'postgresql':
      return 'postgres'
    case 'sqlite':
    case 'sqlite3':
    case 'better-sqlite3':
    case 'libsql':
      return 'sqlite'
    case 'mysql':
    case 'mysql2':
      return 'mysql'
    case 'mssql':
      return 'mssql'
    case 'oracledb':
      return 'oracle'
    default:
      return 'unknown'
  }
}

/**
 * Availability shared by every database tool and resource.
 */
export function lucidAvailability(context: AvailabilityContext): Availability {
  if (context.app.container.hasBinding(LUCID_BINDING as never)) {
    return { available: true }
  }
  const root = fileURLToPath(context.app.appRoot)
  try {
    createRequire(join(root, 'package.json')).resolve('@adonisjs/lucid')
  } catch {
    return {
      available: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: '@adonisjs/lucid is not installed in the application',
    }
  }
  return {
    available: false,
    code: 'CAPABILITY_UNSUPPORTED',
    reason:
      '@adonisjs/lucid is installed but its provider is not registered (no "lucid.db" binding)',
  }
}

export class LucidAccess {
  readonly app: ApplicationService

  constructor(app: ApplicationService) {
    this.app = app
  }

  get appRoot(): string {
    return fileURLToPath(this.app.appRoot)
  }

  async db(): Promise<LucidDatabase> {
    return (await this.app.container.make(LUCID_BINDING as never)) as LucidDatabase
  }

  /**
   * Imports a Lucid module through the application importer.
   */
  async import<T>(specifier: string): Promise<T> {
    return (await this.app.import(specifier)) as T
  }

  /**
   * Connections declared in `config/database.ts`.
   */
  connections(): ConnectionDescription[] {
    const parsed = z
      .record(z.string(), z.unknown())
      .safeParse(this.app.config.get('database.connections', {}))
    if (!parsed.success) {
      return []
    }
    return Object.entries(parsed.data).flatMap(([name, value]) => {
      const config = connectionConfig.safeParse(value)
      return config.success
        ? [
            {
              name,
              client: config.data.client,
              dialect: dialectOf(config.data.client),
              config: config.data,
            },
          ]
        : []
    })
  }

  primaryConnectionName(): string | null {
    const name: unknown = this.app.config.get('database.connection', null)
    return typeof name === 'string' ? name : null
  }

  /**
   * The named connection, or the primary one. Unknown names fail with
   * `INPUT_INVALID` listing the configured connections.
   */
  connection(name: string | undefined): ConnectionDescription {
    const connections = this.connections()
    const wanted = name ?? this.primaryConnectionName()
    const found = connections.find((connection) => connection.name === wanted)
    if (!found) {
      throw new ToolError(
        'INPUT_INVALID',
        `Unknown database connection "${wanted ?? ''}". Configured connections: ${
          connections.map((connection) => connection.name).join(', ') || 'none'
        }`
      )
    }
    return found
  }

  /**
   * Schemas Lucid lists tables from for a PostgreSQL connection.
   */
  static searchPath(connection: ConnectionDescription): string[] {
    return connection.config.searchPath ?? ['public']
  }
}

/*
|--------------------------------------------------------------------------
| Migrations and schema
|--------------------------------------------------------------------------
|
| Migration status is read, never produced by the migrator: Lucid's
| `MigrationRunner#getList()` creates the history table when it is
| missing, so files are listed with Lucid's own `sourceFiles()` (same
| names the migrator records) and compared with the history table only
| when it exists. Nothing runs `up()`/`down()`.
|
| The schema diff compares the physical columns declared by models
| (`columnName`) with the columns the database reports through Lucid's
| introspection. Computed properties are serialized values, not columns,
| and are listed separately instead of being reported as missing.
|
*/

import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LucidAccess, type ColumnInfo, type ConnectionDescription } from './lucid.js'
import type { ModelCatalog } from './models.js'

export interface MigrationEntry {
  name: string

  /**
   * File relative to the application root, `null` when the file is gone.
   */
  file: string | null

  /**
   * `corrupt`: recorded as migrated, but the file no longer exists.
   */
  status: 'migrated' | 'pending' | 'corrupt'
  batch: number | null
  migratedAt: string | null
}

export interface MigrationStatus {
  connection: string
  table: string
  tableExists: boolean
  paths: string[]
  migrations: MigrationEntry[]
  summary: { migrated: number; pending: number; corrupt: number; lastBatch: number | null }
}

interface SourceFile {
  name: string
  absPath: string
}

interface HistoryRow {
  name: string
  batch: number | string
  migration_time: unknown
}

const HISTORY_TABLES = new Set(['adonis_schema', 'adonis_schema_versions'])

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function splitTable(table: string): { schema: string | undefined; name: string } {
  const index = table.lastIndexOf('.')
  return index === -1
    ? { schema: undefined, name: table }
    : { schema: table.slice(0, index), name: table.slice(index + 1) }
}

export class MigrationInspector {
  readonly #lucid: LucidAccess

  constructor(lucid: LucidAccess) {
    this.#lucid = lucid
  }

  async status(connectionName?: string): Promise<MigrationStatus> {
    const connection = this.#lucid.connection(connectionName)
    return this.statusOf(connection)
  }

  async statusOf(connection: ConnectionDescription): Promise<MigrationStatus> {
    const app = this.#lucid.app
    const config = connection.config.migrations ?? {}
    const table = config.tableName ?? 'adonis_schema'
    const paths =
      config.paths && config.paths.length > 0
        ? config.paths
        : [`./${app.relativePath(app.migrationsPath()) || 'database/migrations'}`]
    const { sourceFiles } = await this.#lucid.import<{
      sourceFiles(
        from: URL,
        directory: string,
        naturalSort: boolean
      ): Promise<{ files: SourceFile[] }>
    }>('@adonisjs/lucid/utils')
    const directories = await Promise.all(
      paths.map((path) => sourceFiles(app.appRoot, path, config.naturalSort ?? false))
    )
    const files = directories.flatMap((directory) => directory.files)

    const db = await this.#lucid.db()
    const client = db.connection(connection.name)
    const tableExists = await client.schema.hasTable(table)
    const history = tableExists
      ? ((await client
          .query()
          .from(table)
          .select('name', 'batch', 'migration_time')
          .orderBy('id', 'asc')) as unknown as HistoryRow[])
      : []
    const recorded = new Map(history.map((row) => [row.name, row]))
    const appRoot = fileURLToPath(app.appRoot)

    const migrations: MigrationEntry[] = files.map((file) => {
      const row = recorded.get(file.name)
      return {
        name: file.name,
        file: toPosix(relative(appRoot, file.absPath)),
        status: row ? 'migrated' : 'pending',
        batch: row ? Number(row.batch) : null,
        migratedAt: row ? timestamp(row.migration_time) : null,
      }
    })
    const onDisk = new Set(files.map((file) => file.name))
    for (const row of history) {
      if (!onDisk.has(row.name)) {
        migrations.push({
          name: row.name,
          file: null,
          status: 'corrupt',
          batch: Number(row.batch),
          migratedAt: timestamp(row.migration_time),
        })
      }
    }
    const count = (status: MigrationEntry['status']) =>
      migrations.filter((migration) => migration.status === status).length
    const batches = history.map((row) => Number(row.batch))
    return {
      connection: connection.name,
      table,
      tableExists,
      paths,
      migrations,
      summary: {
        migrated: count('migrated'),
        pending: count('pending'),
        corrupt: count('corrupt'),
        lastBatch: batches.length > 0 ? Math.max(...batches) : null,
      },
    }
  }
}

export interface ModelDiff {
  model: string
  name: string
  table: string
  status: 'in-sync' | 'drift' | 'missing-table'

  /**
   * Model columns whose physical column does not exist in the table.
   */
  missingColumns: Array<{ property: string; columnName: string }>

  /**
   * Table columns no model column maps to.
   */
  undeclaredColumns: Array<{ column: string } & ColumnInfo>

  /**
   * Computed properties: never compared with the table.
   */
  computed: string[]
}

export class SchemaDiff {
  readonly #lucid: LucidAccess
  readonly #catalog: ModelCatalog
  readonly #migrations: MigrationInspector

  constructor(lucid: LucidAccess, catalog: ModelCatalog, migrations: MigrationInspector) {
    this.#lucid = lucid
    this.#catalog = catalog
    this.#migrations = migrations
  }

  async diff(connectionName?: string) {
    const connection = this.#lucid.connection(connectionName)
    const primary = this.#lucid.primaryConnectionName()
    const snapshot = await this.#catalog.snapshot()
    const models = snapshot.models.filter(
      (model) => (model.connection ?? primary) === connection.name
    )
    const db = await this.#lucid.db()
    const client = db.connection(connection.name)
    const schemas =
      connection.dialect === 'postgres' ? LucidAccess.searchPath(connection) : undefined
    const tables = new Set(await client.getAllTables(schemas))

    const diffs: ModelDiff[] = []
    for (const model of models) {
      const { schema, name } = splitTable(model.table)
      const base: Omit<ModelDiff, 'status'> = {
        model: model.id,
        name: model.name,
        table: model.table,
        missingColumns: [],
        undeclaredColumns: [],
        computed: model.computed.map((computed) => computed.name),
      }
      const columns =
        schema === undefined && !tables.has(name)
          ? {}
          : await client.columnsInfo(name, undefined, schema)
      if (Object.keys(columns).length === 0) {
        diffs.push({ ...base, status: 'missing-table' })
        continue
      }
      const declared = new Set(model.columns.map((column) => column.columnName))
      const missingColumns = model.columns
        .filter((column) => !Object.hasOwn(columns, column.columnName))
        .map((column) => ({ property: column.name, columnName: column.columnName }))
      const undeclaredColumns = Object.entries(columns)
        .filter(([column]) => !declared.has(column))
        .map(([column, info]) => ({ column, ...info }))
      diffs.push({
        ...base,
        missingColumns,
        undeclaredColumns,
        status: missingColumns.length + undeclaredColumns.length === 0 ? 'in-sync' : 'drift',
      })
    }

    const mapped = new Set(models.map((model) => splitTable(model.table).name))
    const migrations = await this.#migrations.statusOf(connection)
    return {
      connection: connection.name,
      dialect: connection.dialect,
      models: diffs,
      unmappedTables: [...tables]
        .filter(
          (table) => !mapped.has(table) && !HISTORY_TABLES.has(table) && table !== migrations.table
        )
        .sort(),
      migrations: migrations.summary,
      failures: snapshot.failures,
    }
  }
}

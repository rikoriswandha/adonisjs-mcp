/*
|--------------------------------------------------------------------------
| Model discovery
|--------------------------------------------------------------------------
|
| Lucid has no global model registry, so models are discovered by scanning
| the configured models directory (`app.modelsPath()`, including
| subdirectories) and importing every script through the application
| importer: the classes are the ones the application uses. A file is a
| model file when one of its exports extends Lucid's `BaseModel`; other
| files are skipped, and files that fail to import or boot are reported
| per file instead of being dropped.
|
| The catalog is cached under a generation key derived from the file list,
| sizes and modification times. ESM modules are never re-imported with a
| cache-busting suffix: a file modified after the process started is
| flagged, because the running process may still use the previous version.
|
*/

import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LucidAccess } from './lucid.js'

const SCRIPT_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs'])
const DECLARATION = /\.d\.[mc]?ts$/

/**
 * Static side of a Lucid model, as far as this package reads it.
 */
export interface LucidModelClass {
  readonly name: string
  table: string
  primaryKey: string
  connection?: string
  booted: boolean
  boot(): void
  $columnsDefinitions: Map<string, LucidColumnDefinition>
  $computedDefinitions: Map<string, { serializeAs: string | null }>
  $relationsDefinitions: Map<string, LucidRelation>
  query(options?: unknown): unknown
}

export interface LucidColumnDefinition {
  columnName: string
  serializeAs: string | null
  isPrimary: boolean
  hasGetter?: boolean
  hasSetter?: boolean
}

export interface LucidRelation {
  readonly type: string
  readonly serializeAs: string | null
  booted: boolean
  boot(): void
  relatedModel(): LucidModelClass
  throughModel?: () => LucidModelClass
  [key: string]: unknown
}

export interface ModelColumn {
  /**
   * Model property name.
   */
  name: string

  /**
   * Physical column in the table.
   */
  columnName: string

  /**
   * Key in serialized output; `null` hides the column from `serialize()`.
   */
  serializeAs: string | null
  isPrimary: boolean
}

export interface ModelRelationSummary {
  name: string
  type: string
  relatedModel: string | null

  /**
   * Catalog id of the related model, when it was discovered.
   */
  relatedModelId: string | null
  throughModel?: string | null
  serializeAs: string | null

  /**
   * Keys resolved by Lucid when the relation booted (property names and
   * physical column names).
   */
  keys: Record<string, string>
  error?: string
}

export interface ModelSummary {
  /**
   * Path of the file inside the models directory without extension,
   * suffixed with `#export` for named exports, e.g. `user`, `admin/role`.
   */
  id: string
  name: string
  exportName: string
  file: string
  table: string
  primaryKey: string

  /**
   * Connection set on the model, `null` when it uses the primary one.
   */
  connection: string | null

  /**
   * Model this one extends, when that parent is a discovered model too.
   */
  extends: string | null
  columns: ModelColumn[]

  /**
   * Computed properties: serialized values, never table columns.
   */
  computed: Array<{ name: string; serializeAs: string | null }>
  relations: ModelRelationSummary[]

  /**
   * Uses the `TenantScope` mixin of `@rikology/adonisjs-tenant`: queries
   * are scoped to the tenant context on the physical `tenant_id` column.
   */
  tenantScoped: boolean

  /**
   * The file changed after the process started, so the running process
   * may still use an older version of the model.
   */
  changedSinceProcessStart: boolean
}

export interface ModelFailure {
  file: string
  error: string
}

export interface ModelCatalogSnapshot {
  /**
   * Models directory, relative to the application root.
   */
  directory: string
  generation: string
  models: ModelSummary[]

  /**
   * Files that failed to import or boot.
   */
  failures: ModelFailure[]

  /**
   * Script files without an export extending BaseModel.
   */
  skipped: string[]
}

export interface DiscoveredModel {
  summary: ModelSummary
  model: LucidModelClass
}

interface CatalogState {
  snapshot: ModelCatalogSnapshot
  classes: Map<string, LucidModelClass>
}

interface ScannedFile {
  absolute: string
  relative: string
  mtimeMs: number
  size: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function withoutExtension(path: string): string {
  return path.slice(0, path.length - extname(path).length)
}

async function scan(directory: string): Promise<ScannedFile[]> {
  let entries
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          SCRIPT_EXTENSIONS.has(extname(entry.name)) &&
          !DECLARATION.test(entry.name)
      )
      .map(async (entry) => {
        const absolute = join(entry.parentPath, entry.name)
        const stats = await stat(absolute)
        return {
          absolute,
          relative: toPosix(relative(directory, absolute)),
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        }
      })
  )
  return files.sort((left, right) => (left.relative < right.relative ? -1 : 1))
}

function generationOf(files: readonly ScannedFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file.relative}\0${file.mtimeMs}\0${file.size}\n`)
  }
  return hash.digest('hex').slice(0, 16)
}

function relationKeys(relation: LucidRelation): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const key of [
    'localKey',
    'localKeyColumnName',
    'foreignKey',
    'foreignKeyColumnName',
    'pivotTable',
    'pivotForeignKey',
    'pivotRelatedForeignKey',
    'throughLocalKey',
    'throughLocalKeyColumnName',
    'throughForeignKey',
    'throughForeignKeyColumnName',
  ]) {
    const value = relation[key]
    if (typeof value === 'string') {
      keys[key] = value
    }
  }
  return keys
}

export class ModelCatalog {
  readonly #lucid: LucidAccess
  #state?: { generation: string; promise: Promise<CatalogState> }

  constructor(lucid: LucidAccess) {
    this.#lucid = lucid
  }

  get directory(): string {
    return this.#lucid.app.modelsPath()
  }

  /**
   * Current catalog. Scans file metadata on every call; imports only when
   * the generation changed.
   */
  async snapshot(): Promise<ModelCatalogSnapshot> {
    const state = await this.#load()
    return state.snapshot
  }

  /**
   * Finds a model by catalog id or class name. Returns the candidates
   * when a class name is ambiguous.
   */
  async find(
    reference: string
  ): Promise<{ found: DiscoveredModel } | { found: null; candidates: string[] }> {
    const state = await this.#load()
    const byId = state.snapshot.models.find((model) => model.id === reference)
    const matches = byId
      ? [byId]
      : state.snapshot.models.filter((model) => model.name === reference)
    if (matches.length === 1) {
      return { found: { summary: matches[0], model: state.classes.get(matches[0].id)! } }
    }
    return { found: null, candidates: matches.map((model) => model.id) }
  }

  /**
   * Summary of a model class, when it is part of the catalog.
   */
  async describe(model: LucidModelClass): Promise<ModelSummary | undefined> {
    const state = await this.#load()
    for (const [id, candidate] of state.classes) {
      if (candidate === model) {
        return state.snapshot.models.find((summary) => summary.id === id)
      }
    }
    return undefined
  }

  async #load(): Promise<CatalogState> {
    const directory = this.directory
    const files = await scan(directory)
    const generation = generationOf(files)
    if (this.#state?.generation !== generation) {
      const promise = this.#build(directory, files, generation)
      this.#state = { generation, promise }
      promise.catch(() => {
        if (this.#state?.promise === promise) {
          this.#state = undefined
        }
      })
    }
    return this.#state!.promise
  }

  async #build(
    directory: string,
    files: readonly ScannedFile[],
    generation: string
  ): Promise<CatalogState> {
    const { BaseModel } = await this.#lucid.import<{ BaseModel: LucidModelClass }>(
      '@adonisjs/lucid/orm'
    )
    const isModel = (value: unknown): value is LucidModelClass =>
      typeof value === 'function' &&
      value !== (BaseModel as unknown) &&
      Object.prototype.isPrototypeOf.call(BaseModel, value)

    const appRoot = this.#lucid.appRoot
    const processStart = performance.timeOrigin
    const failures: ModelFailure[] = []
    const skipped: string[] = []
    const found: Array<{
      id: string
      exportName: string
      model: LucidModelClass
      file: ScannedFile
    }> = []

    for (const file of files) {
      const appRelative = toPosix(relative(appRoot, file.absolute))
      let module: Record<string, unknown>
      try {
        const url = pathToFileURL(await realpath(file.absolute)).href
        module = await this.#lucid.import<Record<string, unknown>>(url)
      } catch (error) {
        failures.push({ file: appRelative, error: errorMessage(error) })
        continue
      }
      const seen = new Set<unknown>()
      const exportNames = Object.keys(module).sort((left, right) =>
        left === 'default' ? -1 : right === 'default' ? 1 : left < right ? -1 : 1
      )
      let models = 0
      for (const exportName of exportNames) {
        const value = module[exportName]
        if (!isModel(value) || seen.has(value)) {
          continue
        }
        seen.add(value)
        models++
        const base = withoutExtension(file.relative)
        found.push({
          id: exportName === 'default' ? base : `${base}#${exportName}`,
          exportName,
          model: value,
          file,
        })
      }
      if (models === 0) {
        skipped.push(appRelative)
      }
    }

    const classes = new Map<string, LucidModelClass>()
    const ids = new Map<LucidModelClass, string>()
    const booted: typeof found = []
    for (const entry of found) {
      try {
        entry.model.boot()
        booted.push(entry)
        ids.set(entry.model, entry.id)
      } catch (error) {
        failures.push({
          file: toPosix(relative(appRoot, entry.file.absolute)),
          error: `${entry.model.name}.boot() failed: ${errorMessage(error)}`,
        })
      }
    }

    const models = booted.map(({ id, exportName, model, file }): ModelSummary => {
      classes.set(id, model)
      const parent: unknown = Object.getPrototypeOf(model)
      const relations = [...model.$relationsDefinitions.entries()].map(
        ([name, relation]): ModelRelationSummary => {
          const summary: ModelRelationSummary = {
            name,
            type: relation.type,
            relatedModel: null,
            relatedModelId: null,
            serializeAs: relation.serializeAs,
            keys: {},
          }
          try {
            relation.boot()
            const related = relation.relatedModel()
            summary.relatedModel = related.name
            summary.relatedModelId = ids.get(related) ?? null
            if (typeof relation.throughModel === 'function') {
              summary.throughModel = relation.throughModel().name
            }
            summary.keys = relationKeys(relation)
          } catch (error) {
            summary.error = errorMessage(error)
          }
          return summary
        }
      )
      return {
        id,
        name: model.name,
        exportName,
        file: toPosix(relative(appRoot, file.absolute)),
        table: model.table,
        primaryKey: model.primaryKey,
        connection: typeof model.connection === 'string' ? model.connection : null,
        extends: ids.get(parent as LucidModelClass) ?? null,
        columns: [...model.$columnsDefinitions.entries()].map(([name, column]) => ({
          name,
          columnName: column.columnName,
          serializeAs: column.serializeAs,
          isPrimary: column.isPrimary,
        })),
        computed: [...model.$computedDefinitions.entries()].map(([name, computed]) => ({
          name,
          serializeAs: computed.serializeAs,
        })),
        relations,
        tenantScoped:
          typeof (model as unknown as Record<string, unknown>).forTenant === 'function' &&
          typeof (model as unknown as Record<string, unknown>).withoutTenantScope === 'function',
        changedSinceProcessStart: file.mtimeMs > processStart,
      }
    })

    return {
      snapshot: {
        directory: toPosix(relative(appRoot, directory)) || '.',
        generation,
        models,
        failures,
        skipped,
      },
      classes,
    }
  }
}

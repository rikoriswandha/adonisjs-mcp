/*
|--------------------------------------------------------------------------
| query_model
|--------------------------------------------------------------------------
|
| Answers "what does the application see": rows are read through
| `Model.query()`, so model hooks (tenant scope, soft-delete filters),
| `serializeAs`, computed properties and preloads behave as in the app.
| Input is structured; every column and relation is validated against the
| model definition, and values only travel as query bindings.
|
| The package builds SELECT queries only. Hooks and serializers defined by
| the application are trusted code and may have side effects.
|
*/

import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import { lucidAvailability, type LucidAccess } from '../../database/lucid.js'
import type { LucidModelClass, ModelCatalog, ModelSummary } from '../../database/models.js'
import type { AnyToolDefinition, TenantIdentity, ToolContext, ToolOutput } from '../../types.js'

const MAX_PRELOAD_DEPTH = 4
const DEFAULT_LIMIT = 20

const scalar = z.union([z.string().max(10_000), z.number(), z.boolean()])
const identifier = z.string().min(1).max(200)

const inputSchema = z.object({
  model: identifier.describe("Model class name (e.g. 'User') or get_models id (e.g. 'admin/role')"),
  where: z
    .record(identifier, z.union([scalar, z.null(), z.array(scalar).max(1000)]))
    .optional()
    .describe('Equality by column (property or physical name); null is IS NULL, an array is IN'),
  filters: z
    .array(
      z.object({
        column: identifier,
        operator: z.enum(['=', '!=', '<', '<=', '>', '>=', 'like', 'not like']),
        value: scalar,
      })
    )
    .max(20)
    .optional(),
  whereNull: z.array(identifier).max(20).optional(),
  whereNotNull: z.array(identifier).max(20).optional(),
  preload: z
    .array(z.string().min(1).max(300))
    .max(10)
    .optional()
    .describe("Relation names, nested with dots, e.g. ['posts', 'posts.comments']"),
  orderBy: z
    .array(z.object({ column: identifier, direction: z.enum(['asc', 'desc']).optional() }))
    .max(5)
    .optional(),
  limit: z.int().positive().optional().describe('Rows to return, at most tools.sql.maxRows'),
  offset: z.int().min(0).optional(),
  serialize: z
    .boolean()
    .optional()
    .describe('true (default): model.serialize() as the app would render it; false: toObject()'),
  tenant: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Tenant key resolved by the app tenancy config (@rikology/adonisjs-tenant)'),
})

type Input = z.output<typeof inputSchema>

interface QueryBuilder {
  where(column: string, operatorOrValue: unknown, value?: unknown): QueryBuilder
  whereIn(column: string, values: unknown[]): QueryBuilder
  whereNull(column: string): QueryBuilder
  whereNotNull(column: string): QueryBuilder
  orderBy(column: string, direction: 'asc' | 'desc'): QueryBuilder
  limit(limit: number): QueryBuilder
  offset(offset: number): QueryBuilder
  preload(relation: string, callback: (query: QueryBuilder) => void): QueryBuilder
  timeout(ms: number, options?: { cancel?: boolean }): QueryBuilder
  then: PromiseLike<ModelRow[]>['then']
}

interface ModelRow {
  serialize(): Record<string, unknown>
  toObject(): Record<string, unknown>
  $preloaded: Record<string, ModelRow | ModelRow[] | null>
}

interface PreloadNode {
  model: LucidModelClass
  children: Map<string, PreloadNode>
}

/**
 * Physical column for a property or column name of `model`.
 */
function columnOf(model: LucidModelClass, name: string): string {
  const byProperty = model.$columnsDefinitions.get(name)
  if (byProperty) {
    return byProperty.columnName
  }
  for (const definition of model.$columnsDefinitions.values()) {
    if (definition.columnName === name) {
      return definition.columnName
    }
  }
  throw new ToolError(
    'INPUT_INVALID',
    `Unknown column "${name}" on model ${model.name}. Columns: ${[
      ...model.$columnsDefinitions.keys(),
    ].join(', ')}`
  )
}

function preloadTree(model: LucidModelClass, paths: readonly string[]): PreloadNode {
  const root: PreloadNode = { model, children: new Map() }
  for (const path of paths) {
    const segments = path.split('.')
    if (segments.length > MAX_PRELOAD_DEPTH) {
      throw new ToolError(
        'INPUT_INVALID',
        `Preload "${path}" is nested deeper than ${MAX_PRELOAD_DEPTH} levels`
      )
    }
    let node = root
    for (const segment of segments) {
      const relation = node.model.$relationsDefinitions.get(segment)
      if (!relation) {
        throw new ToolError(
          'INPUT_INVALID',
          `Unknown relation "${segment}" on model ${node.model.name} (preload "${path}"). Relations: ${
            [...node.model.$relationsDefinitions.keys()].join(', ') || 'none'
          }`
        )
      }
      let child = node.children.get(segment)
      if (!child) {
        relation.boot()
        const related = relation.relatedModel()
        related.boot()
        child = { model: related, children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
  }
  return root
}

function* treeModels(node: PreloadNode, path = ''): Generator<[string, LucidModelClass]> {
  for (const [name, child] of node.children) {
    const childPath = path ? `${path}.${name}` : name
    yield [childPath, child.model]
    yield* treeModels(child, childPath)
  }
}

function applyPreloads(query: QueryBuilder, node: PreloadNode, relatedLimit: number) {
  for (const [name, child] of node.children) {
    query.preload(name, (related) => {
      related.limit(relatedLimit + 1)
      applyPreloads(related, child, relatedLimit)
    })
  }
}

/**
 * Preload paths whose query hit the related row limit.
 */
function truncatedPreloads(rows: readonly ModelRow[], node: PreloadNode, limit: number): string[] {
  const truncated: string[] = []
  const visit = (parents: readonly ModelRow[], current: PreloadNode, path: string) => {
    for (const [name, child] of current.children) {
      const loaded = new Set<ModelRow>()
      for (const parent of parents) {
        const value = parent.$preloaded[name]
        for (const item of Array.isArray(value) ? value : value ? [value] : []) {
          loaded.add(item)
        }
      }
      const childPath = path ? `${path}.${name}` : name
      if (loaded.size > limit) {
        truncated.push(childPath)
      }
      visit([...loaded], child, childPath)
    }
  }
  visit(rows, node, '')
  return truncated
}

function isTenantScoped(model: LucidModelClass): boolean {
  const statics = model as unknown as Record<string, unknown>
  return typeof statics.forTenant === 'function' && typeof statics.withoutTenantScope === 'function'
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'KnexTimeoutError'
}

export class ModelQuery {
  readonly #lucid: LucidAccess
  readonly #catalog: ModelCatalog

  constructor(lucid: LucidAccess, catalog: ModelCatalog) {
    this.#lucid = lucid
    this.#catalog = catalog
  }

  async run(input: Input, context: ToolContext): Promise<ToolOutput> {
    const { maxRows, allowCrossTenant, timeout } = context.config.tools.sql
    const lookup = await this.#catalog.find(input.model)
    if (!lookup.found) {
      throw new ToolError(
        'INPUT_INVALID',
        lookup.candidates.length > 1
          ? `Model name "${input.model}" is ambiguous; use one of the ids: ${lookup.candidates.join(', ')}`
          : `Unknown model "${input.model}". Call get_models for the available models.`
      )
    }
    const { model, summary } = lookup.found
    const limit = input.limit ?? Math.min(DEFAULT_LIMIT, maxRows)
    if (limit > maxRows) {
      throw new ToolError('INPUT_INVALID', `limit ${limit} exceeds tools.sql.maxRows (${maxRows})`)
    }

    const tree = preloadTree(model, input.preload ?? [])
    const scopedPreloads = [...treeModels(tree)].filter(([, related]) => isTenantScoped(related))
    const rootScoped = isTenantScoped(model)
    const tenancy = context.tenancy

    let tenant: TenantIdentity | null = null
    let crossTenant = false
    if (input.tenant !== undefined) {
      if (!tenancy) {
        throw new ToolError(
          'CAPABILITY_UNSUPPORTED',
          'The tenant option requires @rikology/adonisjs-tenant (binding "tenant.service"), which is not active'
        )
      }
      tenant = await tenancy.resolve(input.tenant)
    } else if (rootScoped || scopedPreloads.length > 0) {
      if (!allowCrossTenant) {
        throw new ToolError(
          'TENANT_SCOPE_REQUIRED',
          `${summary.name} reads tenant-scoped data${
            scopedPreloads.length > 0
              ? ` (preloads: ${scopedPreloads.map(([path]) => path).join(', ')})`
              : ''
          }. Pass "tenant", or set tools.sql.allowCrossTenant to read across tenants.`
        )
      }
      if (scopedPreloads.length > 0) {
        throw new ToolError(
          'TENANT_SCOPE_REQUIRED',
          `Cross-tenant reads cannot preload tenant-scoped relations (${scopedPreloads
            .map(([path]) => path)
            .join(', ')}); pass "tenant" instead.`
        )
      }
      crossTenant = true
    }

    const dialect = this.#lucid.connection(summary.connection ?? undefined).dialect
    const execute = async () => {
      const statics = model as unknown as { withoutTenantScope(): QueryBuilder }
      const query = (crossTenant ? statics.withoutTenantScope() : model.query()) as QueryBuilder
      for (const [name, value] of Object.entries(input.where ?? {})) {
        const column = columnOf(model, name)
        if (value === null) {
          query.whereNull(column)
        } else if (Array.isArray(value)) {
          query.whereIn(column, value)
        } else {
          query.where(column, value)
        }
      }
      for (const filter of input.filters ?? []) {
        query.where(columnOf(model, filter.column), filter.operator, filter.value)
      }
      for (const name of input.whereNull ?? []) {
        query.whereNull(columnOf(model, name))
      }
      for (const name of input.whereNotNull ?? []) {
        query.whereNotNull(columnOf(model, name))
      }
      for (const order of input.orderBy ?? []) {
        query.orderBy(columnOf(model, order.column), order.direction ?? 'asc')
      }
      applyPreloads(query, tree, maxRows)
      query.limit(limit + 1)
      if (input.offset) {
        query.offset(input.offset)
      }
      query.timeout(timeout, { cancel: dialect === 'postgres' })
      return await query
    }

    let rows: ModelRow[]
    try {
      rows = tenant && tenancy ? await tenancy.run(tenant, execute) : await execute()
    } catch (error) {
      if (isTimeout(error)) {
        throw new ToolError(
          'TIMEOUT',
          `The model query exceeded tools.sql.timeout (${timeout} ms)${
            dialect === 'postgres'
              ? ' and was cancelled in PostgreSQL'
              : '; SQLite queries are not interrupted'
          }`
        )
      }
      throw error
    }

    const hasMore = rows.length > limit
    const returned = rows.slice(0, limit)
    const serialize = input.serialize ?? true
    const preloadTruncated = truncatedPreloads(returned, tree, maxRows)
    const limitations = [
      'Rows are read through Model.query(): model hooks (tenant scope, soft-delete filters), serializeAs and computed properties apply as in the application. Hooks and serializers are application code and may have side effects; the package itself only issues SELECT queries.',
    ]
    if (preloadTruncated.length > 0) {
      limitations.push(
        `Preloads ${preloadTruncated.join(', ')} reached tools.sql.maxRows (${maxRows}) related rows; the limit applies to the whole relation query, so some parents may miss related rows.`
      )
    }
    if (crossTenant) {
      limitations.push(
        'Cross-tenant read (tools.sql.allowCrossTenant): the tenant scope of the model was disabled for this query.'
      )
    }
    return {
      data: {
        model: modelReference(summary),
        rows: returned.map((row) => (serialize ? row.serialize() : row.toObject())),
        returnedRows: returned.length,
        hasMore,
        limit,
        offset: input.offset ?? 0,
        serialized: serialize,
        scope: { tenantScoped: rootScoped, tenant, crossTenant },
        preloadTruncated,
      },
      evidence: ['runtime'],
      limitations,
    }
  }
}

function modelReference(summary: ModelSummary) {
  return {
    id: summary.id,
    name: summary.name,
    table: summary.table,
    connection: summary.connection,
  }
}

export function queryModelTool(query: ModelQuery): AnyToolDefinition {
  return defineTool({
    name: 'query_model',
    title: 'Query a Lucid model',
    description:
      'Reads rows through a Lucid model of the running AdonisJS application (Model.query()), so tenant scopes, model hooks such as soft-delete filters, serializeAs and computed properties apply: it shows what the app sees. Structured filters only; columns and relations are validated. Compare with execute_sql_query for the physical rows. The package only issues SELECT queries, but application hooks run.',
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: lucidAvailability,
    handler: (input, context) => query.run(input, context),
  })
}

import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import type { RawSql } from '../../database/raw_sql.js'
import type { AnyToolDefinition, ResolvedMcpConfig } from '../../types.js'

const binding = z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()])

const READ_ONLY_DESCRIPTION =
  'Runs one read-only SQL query against the database of the running AdonisJS application and returns the physical rows (soft-deleted rows included, no model scopes): what the database holds, unlike query_model. Read-only is enforced by the database: PostgreSQL runs on a dedicated least-privilege reader in a READ ONLY transaction, SQLite in a separate read-only process. Only single SELECT/WITH/VALUES statements with built-in functions are accepted. Bindings use the dialect placeholders ($1 for PostgreSQL, ? for SQLite). Returns columns, rows (at most tools.sql.maxRows), whether more rows exist, the tables read and the dialect.'

const READ_WRITE_DESCRIPTION =
  'Runs one SQL statement against the database of the running AdonisJS application on its own connection pool. tools.sql.readOnly is false in this application, so the statement CAN CHANGE OR DELETE DATA; there is no read-only boundary. Bindings use ? placeholders. Returns columns, rows (at most tools.sql.maxRows), affected rows when known, and the dialect.'

export function executeSqlQueryTool(sql: RawSql, config: ResolvedMcpConfig): AnyToolDefinition {
  const readOnly = config.tools.sql.readOnly
  return defineTool({
    name: 'execute_sql_query',
    title: 'Execute SQL',
    description: readOnly ? READ_ONLY_DESCRIPTION : READ_WRITE_DESCRIPTION,
    inputSchema: z.object({
      query: z.string().min(1).max(100_000).describe('One SQL statement'),
      bindings: z
        .array(z.union([binding, z.array(binding).max(1000)]))
        .max(100)
        .optional()
        .describe('Positional values for the statement placeholders'),
      connection: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Lucid connection name; defaults to the primary connection'),
      tenant: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Tenant key resolved by the app tenancy config; PostgreSQL tables with FORCE ROW LEVEL SECURITY only'
        ),
      explain: z
        .boolean()
        .optional()
        .describe('Return the query plan (EXPLAIN without ANALYZE) instead of rows'),
      timeout: z
        .int()
        .positive()
        .optional()
        .describe('Deadline in milliseconds, at most tools.sql.timeout'),
    }),
    annotations: readOnly
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    available: (context) => sql.availability(context),
    async handler(input, context) {
      const { data, limitations } = await sql.execute(input, context)
      return { data, evidence: ['runtime'], limitations }
    },
  })
}

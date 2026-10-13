import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { lucidAvailability } from '../../database/lucid.js'
import type { SchemaDiff } from '../../database/schema.js'
import type { AnyToolDefinition } from '../../types.js'

export function diffSchemaTool(schema: SchemaDiff): AnyToolDefinition {
  return defineTool({
    name: 'diff_schema',
    title: 'Model vs database schema',
    description:
      'Compares the Lucid models of a connection with the physical tables of the running AdonisJS application database: missing tables, model columns missing in the table (e.g. a pending migration), table columns not declared on the model, tables without a model, plus the migration summary. Computed properties are listed, never treated as missing columns. Read-only; does not generate or run migrations.',
    inputSchema: z.object({
      connection: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Lucid connection name; defaults to the primary connection'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: lucidAvailability,
    async handler(input) {
      return {
        data: await schema.diff(input.connection),
        evidence: ['runtime'],
        limitations: [
          'Column types and constraints are reported for undeclared columns only; model column types are not declared at runtime and are not compared.',
          'Only models discovered under the models directory are compared (see get_models).',
        ],
      }
    },
  })
}

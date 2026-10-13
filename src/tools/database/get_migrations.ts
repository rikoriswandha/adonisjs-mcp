import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { lucidAvailability } from '../../database/lucid.js'
import type { MigrationInspector } from '../../database/schema.js'
import type { AnyToolDefinition } from '../../types.js'

export function getMigrationsTool(migrations: MigrationInspector): AnyToolDefinition {
  return defineTool({
    name: 'get_migrations',
    title: 'Migration status',
    description:
      'Lists the migrations of a Lucid connection in the running AdonisJS application: name, file, status (migrated, pending, or corrupt when a migrated file is missing), batch and migration time, read from the migration files and the history table. Never runs migrations and never creates the history table.',
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
      const status = await migrations.status(input.connection)
      return {
        data: status,
        evidence: ['runtime', 'source'],
        limitations: [
          'Migrations squashed into a schema dump are reported as corrupt when their files were removed.',
          ...(status.tableExists
            ? []
            : [
                `The history table "${status.table}" does not exist yet; every migration is pending.`,
              ]),
        ],
      }
    },
  })
}

import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import type { EnvIntrospection } from '../../introspection/env.js'
import { appTypeScript } from '../../introspection/typescript.js'
import type { AnyToolDefinition } from '../../types.js'

const NO_TYPESCRIPT =
  'The application has no typescript package, which is needed to read the Env.create() schema of start/env.ts without executing it.'

export function getEnvTool(env: EnvIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_env',
    title: 'Environment variables',
    description:
      'Lists the environment variables declared in the Env.create() schema of the running AdonisJS application (start/env.ts) with their schema type, whether they are optional or secret, and whether each is present in the process environment. Never returns values. Read-only.',
    inputSchema: z.object({
      prefix: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Only keys starting with this prefix, e.g. DB_'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async available() {
      return (await appTypeScript(env.appRoot))
        ? { available: true }
        : { available: false, code: 'DEPENDENCY_UNAVAILABLE', reason: NO_TYPESCRIPT }
    },
    async handler(input) {
      const ts = await appTypeScript(env.appRoot)
      if (!ts) {
        throw new ToolError('DEPENDENCY_UNAVAILABLE', NO_TYPESCRIPT)
      }
      const report = await env.read(ts, input.prefix)
      const limitations = [
        'Keys are read from the schema source; variables used without a schema entry are not listed. Presence reflects process.env, which also holds values loaded from .env files.',
      ]
      if (report.unextractable > 0) {
        limitations.push(
          `${report.unextractable} schema entr${report.unextractable === 1 ? 'y' : 'ies'} (spread, computed or shorthand) could not be read statically.`
        )
      }
      return { data: report, evidence: ['source', 'runtime'], limitations }
    },
  })
}

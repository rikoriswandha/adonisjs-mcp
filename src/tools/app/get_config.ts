import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import type { ConfigIntrospection } from '../../introspection/config.js'
import type { AnyToolDefinition, ResourceDefinition, ToolOutput } from '../../types.js'

const LIMITATIONS = [
  'Values under sensitive key names (password, secret, token, apiKey, credentials, ...), values of secret-looking environment variables and URL credentials are redacted. A secret stored under a neutral key name that is not an environment value can remain visible.',
  'Functions, class instances, getters and lazy config providers are summarized, not evaluated.',
]

function describe(config: ConfigIntrospection, key?: string): ToolOutput {
  return { data: config.read(key), evidence: ['runtime'], limitations: LIMITATIONS }
}

export function getConfigTool(config: ConfigIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_config',
    title: 'Resolved config',
    description:
      "Returns the resolved configuration of the running AdonisJS application (app.config) at a dot key such as 'database.connections', or the whole config without a key, with secrets redacted. Read-only; does not resolve lazy config providers or call getters.",
    inputSchema: z.object({
      key: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe("Dot-separated key, e.g. 'app.http' or 'database.connection'"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (input) => describe(config, input.key),
  })
}

export function configResource(config: ConfigIntrospection): ResourceDefinition {
  return {
    name: 'config',
    uri: 'adonis://config/{key}',
    title: 'Resolved config',
    description: 'Same data as the get_config tool for one dot key, e.g. adonis://config/database.',
    read({ variables }) {
      const key = variables.key
      if (typeof key !== 'string') {
        throw new ToolError('INPUT_INVALID', 'The config resource takes exactly one key')
      }
      return describe(config, key)
    },
  }
}

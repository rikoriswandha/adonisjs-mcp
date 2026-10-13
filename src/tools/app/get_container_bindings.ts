import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import type { ContainerIntrospection } from '../../introspection/container.js'
import type { AnyToolDefinition } from '../../types.js'

export function getContainerBindingsTool(container: ContainerIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_container_bindings',
    title: 'Container bindings',
    description:
      "Lists IoC container bindings of the running AdonisJS application that can be discovered: keys declared in ContainerBindings (core, installed packages, app sources) and registrations observed at boot when the app's dev hooks enable it, each verified live with hasBinding(). Reports kind, alias target and registering provider only when observed. Partial by design. Read-only; constructs no service.",
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Case-insensitive substring of the binding key'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(input) {
      const inventory = await container.bindings(input.pattern)
      return {
        data: {
          coverage: 'partial',
          bindings: inventory.bindings,
          declaredUnavailable: inventory.declaredUnavailable,
          lanes: inventory.lanes,
        },
        evidence: ['runtime', 'source'],
        limitations: inventory.limitations,
      }
    },
  })
}

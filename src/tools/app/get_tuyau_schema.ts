import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import {
  allAvailable,
  packageAvailability,
  typescriptAvailability,
} from '../../introspection/integrations.js'
import type { TuyauIntrospection } from '../../introspection/tuyau.js'
import type { AnyToolDefinition } from '../../types.js'

export function getTuyauSchemaTool(service: TuyauIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_tuyau_schema',
    title: 'Tuyau generated schema',
    description:
      'Reads the running AdonisJS application router and its generated Tuyau registry artifacts with the application TypeScript AST. Reports generator hook declarations, artifact metadata, generated route values and optional type-only declaration text. Never imports or executes generated files, generator filters, controllers or validators. Route matching does not verify type-shape freshness.',
    inputSchema: z.object({
      name: z.string().min(1).max(200).optional().describe('Exact generated route name'),
      includeTypes: z
        .boolean()
        .default(true)
        .describe('Include bounded generated type-only declaration text'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: (context) =>
      allAvailable(
        () => packageAvailability(context, 'tuyau'),
        () => typescriptAvailability(context)
      ),
    handler: (input) => service.describe(input),
  })
}

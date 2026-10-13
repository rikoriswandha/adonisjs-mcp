import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { type SourceLocation } from '../../introspection/source_location.js'

export function getSourceLocationTool(resolver: SourceLocation) {
  return defineTool({
    name: 'get_source_location',
    title: 'Resolve application source location',
    description:
      'Resolves app imports, local paths, installed package exports and legacy App namespaces without executing code. Supply symbol separately (Class.member or declaration name); reference never embeds a symbol suffix. Lines require the application TypeScript compiler. Reports verified source maps only.',
    inputSchema: z.object({
      reference: z.string().min(1).max(1000),
      symbol: z.string().min(1).max(200).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (input) => resolver.resolve(input.reference, input.symbol),
  })
}

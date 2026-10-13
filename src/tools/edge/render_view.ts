import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { packageAvailability } from '../../introspection/integrations.js'
import type { ViewIntrospection } from '../../introspection/views.js'
import type { ResolvedMcpConfig } from '../../types.js'

export function renderViewTool(views: ViewIntrospection, config: ResolvedMcpConfig) {
  return defineTool({
    name: 'render_view',
    title: 'Render Edge view',
    description:
      'Renders an exact inventoried view through the running application Edge instance with JSON state. Templates, globals and helpers are application code and can have side effects. Request-specific request, auth, csrf globals are absent or may fail; @vite in development may fail without a Vite dev server. Returns bounded HTML text, never browser content. Not read-only.',
    inputSchema: z.object({
      name: z.string().min(1).max(500),
      state: z.record(z.string(), z.json()).optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    available: (context) => packageAvailability(context, 'edge'),
    handler: (input) => views.render(input.name, input.state ?? {}, config.limits.maxResultBytes),
  })
}

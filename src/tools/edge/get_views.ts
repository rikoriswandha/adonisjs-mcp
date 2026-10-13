import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { packageAvailability } from '../../introspection/integrations.js'
import type { ViewIntrospection } from '../../introspection/views.js'

export function getViewsTool(views: ViewIntrospection) {
  return defineTool({
    name: 'get_views',
    title: 'Edge views',
    description:
      'Reads mounted view roots, registered templates and component identities/tags from the running application Edge loader, with bounded file inventory and source discovery of slot references. Imports Edge but never renders templates or executes helpers. Read-only.',
    inputSchema: z.object({ name: z.string().min(1).max(500).optional() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: (context) => packageAvailability(context, 'edge'),
    handler: (input) => views.inventory(input.name),
  })
}

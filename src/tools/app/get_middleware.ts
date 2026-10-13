import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import type { RouteIntrospection } from '../../introspection/routes.js'
import type { AnyToolDefinition } from '../../types.js'

export function getMiddlewareTool(routes: RouteIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_middleware',
    title: 'Middleware',
    description:
      'Lists the middleware of the running AdonisJS application in execution order: the server stack (every request, including unmatched URLs), the router stack (every matched route), and named middleware with how many routes use them. Read-only; executes no middleware.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler() {
      const result = await routes.middleware()
      return {
        data: { server: result.server, router: result.router, named: result.named },
        evidence: ['runtime', 'source'],
        limitations: [
          'The router stack is derived from committed route stacks (leading global middleware); AdonisJS keeps no separate list for router.use().',
          'Group and route middleware are only visible per route (see get_routes).',
          ...result.limitations,
        ],
      }
    },
  })
}

import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import type { RouteFilter, RouteIntrospection } from '../../introspection/routes.js'
import type {
  AnyToolDefinition,
  AvailabilityContext,
  ResourceDefinition,
  ToolOutput,
} from '../../types.js'

const LIMITATIONS = [
  'Lazy controller and middleware modules are reported by their import specifier, not resolved to files.',
  'Anonymous handlers and middleware have name null; the framework keeps no name for them.',
  'Route surfaces come from surface prefixes, api.* domains and the default surface of the profile, not from observed responses.',
]

export async function describeRoutes(
  routes: RouteIntrospection,
  context: AvailabilityContext,
  filter: RouteFilter = {}
): Promise<ToolOutput> {
  const result = await routes.routes(await context.profile(), filter)
  const limitations = [...LIMITATIONS]
  if (!result.committed) {
    limitations.unshift('The router is not committed yet; routes may be incomplete.')
  }
  return {
    data: { count: result.routes.length, routes: result.routes },
    evidence: ['runtime', 'source'],
    limitations,
  }
}

export function getRoutesTool(routes: RouteIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_routes',
    title: 'Routes',
    description:
      'Lists the routes committed by the running AdonisJS application in router order: HTTP methods, pattern, params, name, domain, controller (import specifier and method) or closure handler, the full middleware stack in execution order (global, named with args, closures), and the request surface (api or web) with how it was determined. Filters are literal substrings. Read-only; executes no handler or middleware.',
    inputSchema: z.object({
      pattern: z.string().min(1).max(500).optional().describe('Substring of the route pattern'),
      method: z.string().min(1).max(20).optional().describe('HTTP method, e.g. GET'),
      name: z.string().min(1).max(200).optional().describe('Substring of the route name'),
      domain: z.string().min(1).max(500).optional().describe("Exact domain, e.g. 'root'"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (input, context) => describeRoutes(routes, context, input),
  })
}

export function routesResource(routes: RouteIntrospection): ResourceDefinition {
  return {
    name: 'routes',
    uri: 'adonis://routes',
    title: 'Routes',
    description: 'Same data as the get_routes tool without filters.',
    read: (_request, context) => describeRoutes(routes, context),
  }
}

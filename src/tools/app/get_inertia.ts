import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import {
  allAvailable,
  packageAvailability,
  typescriptAvailability,
} from '../../introspection/integrations.js'
import type { InertiaIntrospection } from '../../introspection/inertia.js'
import type { AvailabilityContext } from '../../types.js'

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const limitations = [
  'Source syntax is static evidence, not an observed response; no controller, share, flash, lazy prop or transformer callback is executed.',
  'Files changed since process start may differ from the version used by the running process.',
  'Generated declarations are type-only evidence and may be missing or stale.',
]
const inertiaAvailable = (context: AvailabilityContext) =>
  allAvailable(
    () => packageAvailability(context, 'inertia'),
    () => typescriptAvailability(context)
  )
export function getInertiaPagesTool(service: InertiaIntrospection) {
  return defineTool({
    name: 'get_inertia_pages',
    title: 'Inertia pages',
    description:
      'Reads committed routes of the running AdonisJS application and statically maps their handlers to Inertia pages and prop keys. Reads page source and generated declarations; never executes controllers or render callbacks.',
    inputSchema: z.object({ route: z.string().min(1).max(500).optional() }),
    annotations,
    available: inertiaAvailable,
    handler: async (input) => ({
      data: await service.pages(input.route),
      evidence: ['runtime', 'source', 'generated'],
      limitations: [
        ...limitations,
        'Dynamic components, unresolved handlers and ambiguous route-source matches remain unknown.',
      ],
    }),
  })
}
export function getSharedPropsTool(service: InertiaIntrospection) {
  return defineTool({
    name: 'get_shared_props',
    title: 'Inertia shared props',
    description:
      'Reads the runtime middleware stack of the running AdonisJS application, then extracts Inertia share and flash return keys from source. Never calls middleware or evaluates shared values.',
    inputSchema: z.object({}),
    annotations,
    available: inertiaAvailable,
    handler: async () => ({
      data: await service.shared(),
      evidence: ['runtime', 'source', 'generated'],
      limitations: [
        ...limitations,
        'inertia.share calls outside the mounted BaseInertiaMiddleware subclass are not discovered.',
        'Inertia v5 config has no sharedData.',
      ],
    }),
  })
}
export function getTransformersTool(service: InertiaIntrospection) {
  return defineTool({
    name: 'get_transformers',
    title: 'Transformers',
    description:
      'Reads transformer source in the running AdonisJS application and generated Data aliases. Reports resource type text and statically extracted variant output keys; never imports or instantiates transformers.',
    inputSchema: z.object({ name: z.string().min(1).max(200).optional() }),
    annotations,
    available: typescriptAvailability,
    handler: async (input) => ({
      data: await service.transformers(input.name),
      evidence: ['source', 'generated'],
      limitations,
    }),
  })
}

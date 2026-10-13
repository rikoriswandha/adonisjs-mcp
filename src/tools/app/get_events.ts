import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import type { EventIntrospection } from '../../introspection/events.js'
import type { AnyToolDefinition } from '../../types.js'

export function getEventsTool(events: EventIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_events',
    title: 'Events',
    description:
      'Lists events of the running AdonisJS application with their persistent listeners (inline functions, listener classes or lazy-imported listener modules with the method called). Read-only; emits nothing and imports no listener.',
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Case-insensitive substring of the event name'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(input) {
      const result = await events.events(input.pattern)
      const limitations = [
        'Only listeners registered with on()/listen() are listed. once() and onAny() listeners are not kept in the emitter listener map; transportListenerCount includes them without identifying them.',
        'Events that only have once() or onAny() listeners are not listed.',
      ]
      return {
        data: {
          coverage: 'persistent-listeners',
          events: result.events,
          listedListeners: result.mappedListeners,
          totalTransportListeners: result.totalTransportListeners,
        },
        evidence: ['runtime', 'source'],
        limitations,
      }
    },
  })
}

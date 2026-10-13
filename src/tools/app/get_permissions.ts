/*
|--------------------------------------------------------------------------
| Registered authorization metadata
|--------------------------------------------------------------------------
|
| Bouncer abilities and policy registrations. Neither represents a grant
| or an authorization decision for a user.
|
*/
import { z } from 'zod'
import { defineTool, isPlainObject } from '../../define_tool.js'
import { packageAvailability } from '../../introspection/integrations.js'
import { describeReference } from '../../introspection/references.js'
import { errorMessage } from '../../introspection/source_files.js'
import type { Redactor } from '../../redaction.js'
import type { AnyToolDefinition, AvailabilityContext } from '../../types.js'

function available(context: AvailabilityContext) {
  return packageAvailability(context, 'bouncer')
}

export function getPermissionsTool(redactor: Redactor): AnyToolDefinition {
  return defineTool({
    name: 'get_permissions',
    title: 'Registered Bouncer abilities and policies',
    description:
      'Reads Bouncer ability names (#abilities/main) and policy registrations (#policies/main) from the running AdonisJS application. Imports trusted application modules (top-level code runs); never evaluates abilities, policy loaders or authorization decisions.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available,
    async handler(_input, context) {
      const bouncer: Record<string, unknown> = {}
      try {
        const module = (await context.app.import('#abilities/main')) as Record<string, unknown>
        bouncer.abilities = Object.entries(module)
          .filter(
            ([, value]) =>
              isPlainObject(value) &&
              typeof value.allowGuest === 'boolean' &&
              typeof value.original === 'function' &&
              typeof value.execute === 'function'
          )
          .map(([name]) => redactor.text(name))
        bouncer.abilitiesFound = true
        bouncer.recognition =
          'Bouncer.ability object shape: allowGuest boolean, original function, execute function; callbacks are not called'
      } catch (error) {
        bouncer.abilitiesFound = false
        bouncer.abilitiesReason = redactor.text(errorMessage(error))
      }
      try {
        const module = (await context.app.import('#policies/main')) as { policies?: unknown }
        if (!isPlainObject(module.policies)) {
          bouncer.policiesFound = false
          bouncer.policiesReason = '#policies/main does not export a policies object'
        } else {
          bouncer.policiesFound = true
          bouncer.policies = await Promise.all(
            Object.entries(module.policies).map(async ([name, loader]) => ({
              ...(await describeReference(loader)),
              name: redactor.text(name),
              evidence: 'source',
            }))
          )
        }
      } catch (error) {
        bouncer.policiesFound = false
        bouncer.policiesReason = redactor.text(errorMessage(error))
      }
      return {
        data: {
          ...bouncer,
          meaning: 'Registered names and metadata only; not authorization decisions for any user.',
        },
        evidence: ['runtime', 'source'],
        limitations: [
          'Trusted application module imports run top-level code. Ability object recognition is structural, not proof of provenance.',
          'Policy actions and user grants are not enumerated; lazy policy loaders are never called.',
        ],
      }
    },
  })
}

/*
|--------------------------------------------------------------------------
| Registered authorization metadata
|--------------------------------------------------------------------------
|
| Plus permission registries and Bouncer abilities are separate adapters.
| Neither represents a grant or an authorization decision for a user.
|
*/
import { z } from 'zod'
import { defineTool, isPlainObject } from '../../define_tool.js'
import { packageAvailability } from '../../introspection/integrations.js'
import { describeReference } from '../../introspection/references.js'
import { errorMessage } from '../../introspection/source_files.js'
import { project } from '../../redaction.js'
import type { Redactor } from '../../redaction.js'
import type { AnyToolDefinition, AvailabilityContext } from '../../types.js'

async function available(context: AvailabilityContext) {
  const plus = await packageAvailability(context, 'permissions')
  const bouncer = await packageAvailability(context, 'bouncer')
  return plus.available || bouncer.available ? { available: true as const } : plus
}

export function getPermissionsTool(redactor: Redactor): AnyToolDefinition {
  return defineTool({
    name: 'get_permissions',
    title: 'Registered permissions and abilities',
    description:
      'Reads registered permission metadata and Bouncer ability/policy names from the running AdonisJS application. Imports trusted application modules (top-level code runs); never evaluates abilities, policy loaders or authorization decisions.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available,
    async handler(_input, context) {
      const profile = await context.profile()
      const adapters: Record<string, unknown> = {}
      if (profile.packages.permissions.version === null) {
        adapters.permissions = { installed: false }
      } else {
        try {
          const module = (await context.app.import('#start/permissions')) as {
            permissions?: { all(): unknown; active(): unknown; keys(): unknown }
          }
          if (
            !module.permissions ||
            typeof module.permissions.all !== 'function' ||
            typeof module.permissions.active !== 'function' ||
            typeof module.permissions.keys !== 'function'
          ) {
            adapters.permissions = {
              installed: true,
              found: false,
              reason: '#start/permissions does not export a Permissions registry',
            }
          } else {
            const all = module.permissions.all()
            adapters.permissions = {
              installed: true,
              found: true,
              module: '#start/permissions',
              evidence: 'runtime',
              // Project values individually: the metadata field "key" is an identifier, not a credential.
              all: Array.isArray(all)
                ? all.map((entry: unknown) =>
                    isPlainObject(entry)
                      ? {
                          key: redactor.text(String(entry.key)),
                          ...(project(
                            {
                              description: entry.description,
                              inactive: entry.inactive,
                              aliases: entry.aliases,
                            },
                            { redactor }
                          ) as object),
                        }
                      : project(entry, { redactor })
                  )
                : project(all, { redactor }),
              active: project(module.permissions.active(), { redactor }),
              keys: project(module.permissions.keys(), { redactor }),
            }
          }
        } catch (error) {
          adapters.permissions = {
            installed: true,
            found: false,
            reason: redactor.text(errorMessage(error)),
          }
        }
      }
      if (profile.packages.bouncer.version === null) {
        adapters.bouncer = { installed: false }
      } else {
        const bouncer: Record<string, unknown> = { installed: true, evidence: 'runtime' }
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
        adapters.bouncer = bouncer
      }
      return {
        data: {
          adapters,
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

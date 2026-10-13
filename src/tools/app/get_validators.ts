import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import { packageAvailability } from '../../introspection/integrations.js'
import type { ValidatorIntrospection } from '../../introspection/validators.js'
import type { AnyToolDefinition } from '../../types.js'

export function getValidatorsTool(service: ValidatorIntrospection): AnyToolDefinition {
  return defineTool({
    name: 'get_validators',
    title: 'Compiled Vine validators',
    description:
      'Reads compiled Vine validators exported by the running AdonisJS application validators directory. Imports validator modules (top-level code runs); never runs validation, conditional/rule callbacks or dynamic message providers. Compiled AST is authoritative, not JSON Schema.',
    inputSchema: z.object({ name: z.string().min(1).max(300).optional() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: (context) => packageAvailability(context, 'vine'),
    async handler(input) {
      const snapshot = await service.snapshot()
      const validators = snapshot.validators.filter(
        (validator) =>
          input.name === undefined || validator.name === input.name || validator.id === input.name
      )
      if (input.name !== undefined && validators.length === 0) {
        throw new ToolError(
          'NOT_FOUND',
          `No validator "${input.name}". Known candidates: ${snapshot.validators.map((validator) => validator.id).join(', ') || 'none'}`
        )
      }
      const limitations = [
        'Only exported compiled validators under app.validatorsPath() are discovered; inline validators in controllers/routes are not discovered.',
        'Importing trusted validator modules runs top-level application code. Validation, rule callbacks and conditional callbacks are never invoked.',
        'Dynamic/custom rule semantics and branch applicability remain unknown. Built-in classification is a full function-definition match against installed Vine entry source, not a name allowlist; unverified definitions remain unknown.',
        'JSON Schema is omitted: it is a non-authoritative projection and Vine 4.4.0 loses required nullable fields.',
        'Messages are read only when the messages provider exposes toJSON(); dynamic provider resolution is unknown.',
      ]
      if (snapshot.validators.some((validator) => validator.changedSinceProcessStart)) {
        limitations.push(
          'Validator files changed after process start; the running process may still use the previous version until restart.'
        )
      }
      if (snapshot.truncated) {
        limitations.push('Directory scan reached its file limit; discovery is partial.')
      }
      if (snapshot.outsideRoot) {
        limitations.push('Symlinks outside the validators directory were skipped.')
      }
      if (snapshot.failures.length) {
        limitations.push('Some files/exports failed introspection; see failures.')
      }
      return { data: { ...snapshot, validators }, evidence: ['runtime', 'source'], limitations }
    },
  })
}

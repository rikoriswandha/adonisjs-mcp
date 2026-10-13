import { InvalidDefinitionError } from './errors.js'
import type {
  AnyToolDefinition,
  ExtraToolLoader,
  ToolDefinition,
  ToolInputSchema,
} from './types.js'

/**
 * snake_case tool names: lowercase words joined by single underscores.
 * MCP clients namespace tools per server, so no `adonis_` prefix is needed
 * for builtin tools; extension packages prefix their domain.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
export const MAX_TOOL_NAME_LENGTH = 64

const ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const

export function toolNameIssue(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) {
    return 'must be a non-empty string'
  }
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return `must be at most ${MAX_TOOL_NAME_LENGTH} characters`
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return `"${name}" must be snake_case (lowercase letters and digits joined by "_"), e.g. "audit_list_entries"`
  }
  return undefined
}

/**
 * Zod v4 schemas carry `_zod.def`; v3 schemas and other Standard Schema
 * libraries do not. Checked structurally so an application's own copy of
 * Zod v4 is accepted.
 */
export function isZodObjectSchema(value: unknown): value is ToolInputSchema {
  if (!isPlainObject(value) || !isPlainObject(value._zod)) {
    return false
  }
  const definition = value._zod.def
  return isPlainObject(definition) && definition.type === 'object'
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Asserts that `value` satisfies the tool definition contract.
 */
export function assertToolDefinition(
  value: unknown,
  subject = 'tool definition'
): asserts value is AnyToolDefinition {
  if (!isPlainObject(value)) {
    throw new InvalidDefinitionError(subject, ['must be an object created with defineTool()'])
  }

  const issues: string[] = []
  const nameIssue = toolNameIssue(value.name)
  if (nameIssue) {
    issues.push(`name: ${nameIssue}`)
  }
  if (typeof value.description !== 'string' || value.description.trim().length === 0) {
    issues.push('description: must be a non-empty string')
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    issues.push('title: must be a string')
  }
  if (!isZodObjectSchema(value.inputSchema)) {
    issues.push('inputSchema: must be a Zod v4 object schema, e.g. z.object({ limit: z.number() })')
  }
  if (typeof value.handler !== 'function') {
    issues.push('handler: must be a function')
  }
  if (value.available !== undefined && typeof value.available !== 'function') {
    issues.push('available: must be a function')
  }
  if (value.annotations !== undefined) {
    if (!isPlainObject(value.annotations)) {
      issues.push('annotations: must be an object')
    } else {
      for (const hint of ANNOTATION_HINTS) {
        const hintValue = value.annotations[hint]
        if (hintValue !== undefined && typeof hintValue !== 'boolean') {
          issues.push(`annotations.${hint}: must be a boolean`)
        }
      }
    }
  }

  if (issues.length > 0) {
    const label =
      typeof value.name === 'string' && value.name ? `${subject} "${value.name}"` : subject
    throw new InvalidDefinitionError(label, issues)
  }
}

/**
 * Defines a tool served via the running AdonisJS application. The input
 * type of `handler` is inferred from `inputSchema`.
 *
 * Extension packages must import this lazily, after checking that the
 * MCP registry is bound, because the package is a development
 * dependency of the application.
 */
export function defineTool<Schema extends ToolInputSchema>(
  definition: ToolDefinition<Schema>
): ToolDefinition<Schema> {
  assertToolDefinition(definition)
  return definition
}

/**
 * Runs `extraTools` loaders in order and validates every exported
 * definition.
 */
export async function loadExtraTools(
  loaders: readonly ExtraToolLoader[]
): Promise<AnyToolDefinition[]> {
  const definitions: AnyToolDefinition[] = []

  for (const [index, loader] of loaders.entries()) {
    const subject = `extraTools[${index}]`
    let loaded: unknown
    try {
      loaded = await loader()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new InvalidDefinitionError(subject, [`loader failed: ${message}`], { cause: error })
    }

    const exported = isPlainObject(loaded) ? loaded.default : undefined
    if (exported === undefined) {
      throw new InvalidDefinitionError(subject, [
        'module must default-export a tool definition or an array of them',
      ])
    }

    if (Array.isArray(exported)) {
      for (const [position, definition] of exported.entries()) {
        assertToolDefinition(definition, `${subject} default[${position}]`)
        definitions.push(definition)
      }
    } else {
      assertToolDefinition(exported, subject)
      definitions.push(exported)
    }
  }

  return definitions
}

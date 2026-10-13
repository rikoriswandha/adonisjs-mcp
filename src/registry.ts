/*
|--------------------------------------------------------------------------
| Definition registry
|--------------------------------------------------------------------------
|
| One registry per application, bound as `mcp.registry`. It owns tool,
| resource and prompt definitions plus `extend()` wrappers; it never owns
| transports or sessions. The provider finalizes it when the application
| is ready, producing an immutable snapshot that every MCP request reads.
|
*/

import { InvalidDefinitionError, RegistryClosedError } from './errors.js'
import {
  assertToolDefinition,
  isPlainObject,
  isZodObjectSchema,
  toolNameIssue,
} from './define_tool.js'
import type {
  AnyToolDefinition,
  McpRegistry,
  PromptDefinition,
  ResourceDefinition,
  ToolCallWrapper,
  ToolDefinition,
  ToolInputSchema,
} from './types.js'

export type AnyPromptDefinition = PromptDefinition<ToolInputSchema>

/**
 * Immutable view of the registry served to MCP requests. Definitions are
 * sorted by name, so the served lists do not depend on provider order.
 */
export interface RegistrySnapshot {
  readonly tools: readonly AnyToolDefinition[]

  /**
   * Registered tools withheld by `disable()` or `tools.disabled`.
   */
  readonly disabledTools: readonly string[]
  readonly resources: readonly ResourceDefinition[]
  readonly prompts: readonly AnyPromptDefinition[]

  /**
   * `extend()` wrappers in registration order, outermost first.
   */
  readonly wrappers: readonly ToolCallWrapper[]
}

/**
 * URI scheme followed by `//`, e.g. `adonis://profile`.
 */
const RESOURCE_URI = /^[a-z][a-z0-9+.-]*:\/\/\S+$/

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function labelled(subject: string, value: Record<string, unknown>): string {
  return typeof value.name === 'string' && value.name ? `${subject} "${value.name}"` : subject
}

function commonIssues(value: Record<string, unknown>, descriptionRequired: boolean): string[] {
  const issues: string[] = []
  const nameIssue = toolNameIssue(value.name)
  if (nameIssue) {
    issues.push(`name: ${nameIssue}`)
  }
  if (descriptionRequired || value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.trim().length === 0) {
      issues.push('description: must be a non-empty string')
    }
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    issues.push('title: must be a string')
  }
  if (value.available !== undefined && typeof value.available !== 'function') {
    issues.push('available: must be a function')
  }
  return issues
}

export function assertResourceDefinition(value: unknown): asserts value is ResourceDefinition {
  if (!isPlainObject(value)) {
    throw new InvalidDefinitionError('resource definition', ['must be an object'])
  }
  const issues = commonIssues(value, false)
  if (typeof value.uri !== 'string' || !RESOURCE_URI.test(value.uri)) {
    issues.push("uri: must be an absolute URI or URI template such as 'adonis://profile'")
  }
  if (typeof value.read !== 'function') {
    issues.push('read: must be a function')
  }
  if (issues.length > 0) {
    throw new InvalidDefinitionError(labelled('resource definition', value), issues)
  }
}

export function assertPromptDefinition(value: unknown): asserts value is AnyPromptDefinition {
  if (!isPlainObject(value)) {
    throw new InvalidDefinitionError('prompt definition', ['must be an object'])
  }
  const issues = commonIssues(value, true)
  if (value.argsSchema !== undefined && !isZodObjectSchema(value.argsSchema)) {
    issues.push('argsSchema: must be a Zod v4 object schema')
  }
  if (typeof value.get !== 'function') {
    issues.push('get: must be a function')
  }
  if (issues.length > 0) {
    throw new InvalidDefinitionError(labelled('prompt definition', value), issues)
  }
}

export class DefinitionRegistry implements McpRegistry {
  #tools = new Map<string, AnyToolDefinition>()
  #resources = new Map<string, ResourceDefinition>()
  #resourceUris = new Map<string, string>()
  #prompts = new Map<string, AnyPromptDefinition>()
  #wrappers: ToolCallWrapper[] = []
  #disabled = new Set<string>()
  #snapshot?: RegistrySnapshot

  get finalized(): boolean {
    return this.#snapshot !== undefined
  }

  #assertOpen(action: string) {
    if (this.#snapshot) {
      throw new RegistryClosedError(action)
    }
  }

  tool<Schema extends ToolInputSchema>(definition: ToolDefinition<Schema>): void {
    this.#assertOpen('register a tool')
    assertToolDefinition(definition)
    if (this.#tools.has(definition.name)) {
      throw new InvalidDefinitionError(`tool "${definition.name}"`, [
        'name is already registered; tool names must be unique across the application and its packages',
      ])
    }
    this.#tools.set(definition.name, definition)
  }

  resource(definition: ResourceDefinition): void {
    this.#assertOpen('register a resource')
    assertResourceDefinition(definition)
    const issues: string[] = []
    if (this.#resources.has(definition.name)) {
      issues.push('name is already registered')
    }
    const owner = this.#resourceUris.get(definition.uri)
    if (owner !== undefined) {
      issues.push(`uri "${definition.uri}" is already served by resource "${owner}"`)
    }
    if (issues.length > 0) {
      throw new InvalidDefinitionError(`resource "${definition.name}"`, issues)
    }
    this.#resources.set(definition.name, definition)
    this.#resourceUris.set(definition.uri, definition.name)
  }

  prompt<Schema extends ToolInputSchema>(definition: PromptDefinition<Schema>): void {
    this.#assertOpen('register a prompt')
    assertPromptDefinition(definition)
    if (this.#prompts.has(definition.name)) {
      throw new InvalidDefinitionError(`prompt "${definition.name}"`, [
        'name is already registered',
      ])
    }
    this.#prompts.set(definition.name, definition as AnyPromptDefinition)
  }

  extend(wrapper: ToolCallWrapper): void {
    this.#assertOpen('add a tool wrapper')
    if (typeof wrapper !== 'function') {
      throw new InvalidDefinitionError('extend() wrapper', ['must be a function'])
    }
    this.#wrappers.push(wrapper)
  }

  disable(name: string): void {
    this.#assertOpen('disable a tool')
    const issue = toolNameIssue(name)
    if (issue) {
      throw new InvalidDefinitionError('disable() tool name', [issue])
    }
    this.#disabled.add(name)
  }

  /**
   * Closes registration and returns the snapshot served from now on.
   * Idempotent.
   */
  finalize(): RegistrySnapshot {
    if (!this.#snapshot) {
      const tools = [...this.#tools.values()].sort(byName)
      this.#snapshot = Object.freeze({
        tools: Object.freeze(tools.filter((tool) => !this.#disabled.has(tool.name))),
        disabledTools: Object.freeze(
          tools.filter((tool) => this.#disabled.has(tool.name)).map((tool) => tool.name)
        ),
        resources: Object.freeze([...this.#resources.values()].sort(byName)),
        prompts: Object.freeze([...this.#prompts.values()].sort(byName)),
        wrappers: Object.freeze([...this.#wrappers]),
      })
    }
    return this.#snapshot
  }
}

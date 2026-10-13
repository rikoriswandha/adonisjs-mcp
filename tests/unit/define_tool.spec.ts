import { test } from '@japa/runner'
import { z } from 'zod'
import { defineTool, loadExtraTools } from '../../src/define_tool.js'
import { InvalidDefinitionError } from '../../src/errors.js'
import type { ToolContext, ToolDefinition, ToolOutput } from '../../src/types.js'

const listEntries = defineTool({
  name: 'audit_list_entries',
  description: 'Lists audit entries via the running AdonisJS app',
  inputSchema: z.object({ model: z.string().optional(), limit: z.number().default(20) }),
  annotations: { readOnlyHint: true },
  handler: (input) => ({ data: { model: input.model ?? null, limit: input.limit } }),
})

function definitionIssues(definition: unknown): readonly string[] {
  try {
    defineTool(definition as ToolDefinition)
  } catch (error) {
    if (error instanceof InvalidDefinitionError) {
      return error.issues
    }
    throw error
  }
  throw new Error('expected definition to be rejected')
}

test.group('defineTool', () => {
  test('infers handler input from the Zod schema output', ({ expectTypeOf }) => {
    defineTool({
      name: 'typed_tool',
      description: 'Typed input via the running AdonisJS app',
      inputSchema: z.object({ id: z.number(), tags: z.array(z.string()).default([]) }),
      handler(input, context) {
        expectTypeOf(input).toEqualTypeOf<{ id: number; tags: string[] }>()
        expectTypeOf(context).toEqualTypeOf<ToolContext>()
        return { data: input.id }
      },
    })
  })

  test('returns the definition unchanged so it can be registered', async ({ assert }) => {
    const output: ToolOutput = await listEntries.handler(
      listEntries.inputSchema.parse({ model: 'User' }),
      {} as ToolContext
    )
    assert.deepEqual(output, { data: { model: 'User', limit: 20 } })
  })

  test('rejects names that are not snake_case', ({ assert }) => {
    for (const name of [
      'listEntries',
      'list-entries',
      'list.entries',
      '_list',
      'list__entries',
      '',
      'a'.repeat(65),
    ]) {
      const issues = definitionIssues({ ...listEntries, name })
      assert.lengthOf(issues, 1, name)
      assert.match(issues[0], /^name: /, name)
    }
  })

  test('requires a Zod v4 object input schema', ({ assert }) => {
    for (const inputSchema of [z.string(), { limit: z.number() }, undefined]) {
      assert.deepEqual(definitionIssues({ ...listEntries, inputSchema }), [
        'inputSchema: must be a Zod v4 object schema, e.g. z.object({ limit: z.number() })',
      ])
    }
  })

  test('reports every missing or malformed member at once', ({ assert }) => {
    assert.deepEqual(
      definitionIssues({
        name: 'broken_tool',
        description: ' ',
        inputSchema: z.object({}),
        available: true,
        annotations: { readOnlyHint: 'yes' },
      }),
      [
        'description: must be a non-empty string',
        'handler: must be a function',
        'available: must be a function',
        'annotations.readOnlyHint: must be a boolean',
      ]
    )
  })

  test('names the offending tool in the error message', ({ assert }) => {
    assert.throws(
      () => defineTool({ ...listEntries, handler: undefined } as unknown as ToolDefinition),
      /^Invalid tool definition "audit_list_entries":\n {2}- handler: must be a function$/
    )
  })
})

test.group('loadExtraTools', () => {
  const second = defineTool({ ...listEntries, name: 'audit_count_entries' })

  test('loads single and array default exports in loader order', async ({ assert }) => {
    const tools = await loadExtraTools([
      async () => ({ default: [listEntries, second] }),
      async () => ({ default: listEntries }),
    ])
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['audit_list_entries', 'audit_count_entries', 'audit_list_entries']
    )
  })

  test('locates invalid exports by loader index and position', async ({ assert }) => {
    await assert.rejects(
      () =>
        loadExtraTools([
          async () => ({ default: listEntries }),
          async () => ({ default: [second, { ...second, name: 'BadName' }] as never }),
        ]),
      /^Invalid extraTools\[1\] default\[1\] "BadName":\n {2}- name: /
    )
    await assert.rejects(
      () => loadExtraTools([async () => ({}) as never]),
      'Invalid extraTools[0]:\n  - module must default-export a tool definition or an array of them'
    )
  })

  test('wraps loader failures with the loader index', async ({ assert }) => {
    const failure = new Error("Cannot find module '#start/mcp_tools'")
    try {
      await loadExtraTools([async () => Promise.reject(failure)])
      assert.fail('expected loader failure')
    } catch (error) {
      assert.instanceOf(error, InvalidDefinitionError)
      assert.equal(
        (error as InvalidDefinitionError).message,
        "Invalid extraTools[0]:\n  - loader failed: Cannot find module '#start/mcp_tools'"
      )
      assert.strictEqual((error as InvalidDefinitionError).cause, failure)
    }
  })
})

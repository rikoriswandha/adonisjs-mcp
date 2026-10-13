import { test } from '@japa/runner'
import { z } from 'zod'
import { defineTool } from '../../src/define_tool.js'
import { InvalidDefinitionError, RegistryClosedError } from '../../src/errors.js'
import { DefinitionRegistry } from '../../src/registry.js'
import type { ResourceDefinition } from '../../src/types.js'

function tool(name: string) {
  return defineTool({
    name,
    description: 'Fixture tool via the running AdonisJS app',
    inputSchema: z.object({}),
    handler: () => ({ data: name }),
  })
}

function resource(name: string, uri: string): ResourceDefinition {
  return { name, uri, read: () => ({ data: name }) }
}

test.group('DefinitionRegistry', () => {
  test('rejects a second tool with the same name, whichever registers first', ({ assert }) => {
    const registry = new DefinitionRegistry()
    registry.tool(tool('audit_list_entries'))
    assert.throws(
      () => registry.tool(tool('audit_list_entries')),
      /tool "audit_list_entries".*already registered/s
    )
    assert.deepEqual(
      registry.finalize().tools.map((definition) => definition.name),
      ['audit_list_entries']
    )
  })

  test('rejects resources reusing a name or a URI', ({ assert }) => {
    const registry = new DefinitionRegistry()
    registry.resource(resource('profile', 'adonis://profile'))
    assert.throws(
      () => registry.resource(resource('profile', 'adonis://other')),
      /already registered/
    )
    assert.throws(
      () => registry.resource(resource('profile_copy', 'adonis://profile')),
      /already served by resource "profile"/
    )
  })

  test('withholds disabled tools registered before or after disable()', ({ assert }) => {
    const registry = new DefinitionRegistry()
    registry.tool(tool('registered_first'))
    registry.disable('registered_first')
    registry.disable('registered_later')
    registry.tool(tool('registered_later'))
    registry.tool(tool('kept'))

    const snapshot = registry.finalize()
    assert.deepEqual(
      snapshot.tools.map((definition) => definition.name),
      ['kept']
    )
    assert.deepEqual(snapshot.disabledTools, ['registered_first', 'registered_later'])
  })

  test('serves the same lists whatever order providers register in', ({ assert }) => {
    const forward = new DefinitionRegistry()
    const backward = new DefinitionRegistry()
    const names = ['zeta_tool', 'alpha_tool', 'mid_tool']
    for (const name of names) {
      forward.tool(tool(name))
    }
    for (const name of names.toReversed()) {
      backward.tool(tool(name))
    }
    const listed = (registry: DefinitionRegistry) =>
      registry.finalize().tools.map((definition) => definition.name)
    assert.deepEqual(listed(forward), ['alpha_tool', 'mid_tool', 'zeta_tool'])
    assert.deepEqual(listed(backward), listed(forward))
  })

  test('closes every registration method once finalized', ({ assert }) => {
    const registry = new DefinitionRegistry()
    const snapshot = registry.finalize()
    assert.strictEqual(registry.finalize(), snapshot)

    const attempts: Array<() => void> = [
      () => registry.tool(tool('late_tool')),
      () => registry.resource(resource('late', 'adonis://late')),
      () =>
        registry.prompt({
          name: 'late_prompt',
          description: 'Late',
          get: () => ({ messages: [] }),
        }),
      () => registry.extend((_call, next) => next()),
      () => registry.disable('late_tool'),
    ]
    for (const attempt of attempts) {
      assert.throws(attempt, RegistryClosedError)
    }
  })

  test('validates resource and prompt definitions', ({ assert }) => {
    const registry = new DefinitionRegistry()
    assert.throws(
      () => registry.resource({ name: 'bad', uri: 'profile', read: () => ({ data: 1 }) }),
      InvalidDefinitionError
    )
    assert.throws(
      () =>
        registry.prompt({
          name: 'bad_prompt',
          description: '',
          argsSchema: { shape: {} } as never,
          get: () => ({ messages: [] }),
        }),
      /description.*\n.*argsSchema/s
    )
  })
})

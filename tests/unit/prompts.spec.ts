import { test } from '@japa/runner'
import { buildAddFeature } from '../../src/prompts/add_feature.js'
import { buildDebugRequest, debugRequestPrompt } from '../../src/prompts/debug_request.js'
import type { WorkflowCapabilities } from '../../src/prompts/workflow.js'
import type { ProjectProfile } from '../../src/types.js'

function profile(kind: ProjectProfile['kind'], generated = false): ProjectProfile {
  return {
    kind,
    app: {
      name: 'fixture',
      root: '/tmp/fixture',
      environment: 'web',
      nodeVersion: '24',
      coreVersion: '7',
    },
    surfaces: { web: null, api: null, default: null },
    inertia: kind === 'inertia' || kind === 'hybrid' ? { adapter: 'react', ssr: false } : null,
    auth: null,
    packages: {} as ProjectProfile['packages'],
    generated: { controllers: generated, data: generated, tuyauRegistry: false },
    endpoint: { path: '/__adonis/mcp', allowRemoteAccess: false },
    limitations: [],
  }
}
const names = [
  'get_project_profile',
  'get_routes',
  'get_middleware',
  'http_request',
  'get_last_exceptions',
  'get_logs',
  'get_source_location',
  'search_package_docs',
  'get_validators',
  'get_models',
  'get_migrations',
  'diff_schema',
  'get_tuyau_schema',
  'run_ace_command',
  'get_inertia_pages',
  'get_shared_props',
  'get_transformers',
  'get_views',
  'render_view',
]
const capabilities: WorkflowCapabilities = {
  tools: names.map((name) => ({ name, status: 'served' })),
  resources: [{ name: 'profile', status: 'served' }],
  prompts: [],
}

test.group('Workflow prompts', () => {
  test('API contract inspection follows the served Tuyau tool', ({ assert }) => {
    const unserved: WorkflowCapabilities = {
      ...capabilities,
      tools: capabilities.tools.map((entry) =>
        entry.name === 'get_tuyau_schema'
          ? {
              name: entry.name,
              status: 'unavailable',
              code: 'DEPENDENCY_UNAVAILABLE',
              reason: 'no Tuyau',
            }
          : entry
      ),
    }
    const without = buildAddFeature({ feature: 'x' }, profile('api'), unserved).messages[0].text
    assert.notInclude(without, 'get_tuyau_schema')
    const withTuyau = buildAddFeature({ feature: 'x' }, profile('api'), capabilities).messages[0]
      .text
    assert.include(withTuyau, '`get_tuyau_schema`')
  })
  for (const kind of ['api', 'inertia', 'edge'] as const) {
    test(`feature branches for ${kind}`, ({ assert }) => {
      const result = buildAddFeature({ feature: 'bookings' }, profile(kind), capabilities)
        .messages[0].text
      assert.include(result, '`get_validators`')
      assert.include(result, '`http_request`')
      assert.isTrue(result.indexOf('`get_models`') < result.indexOf('`run_ace_command`'))
      assert.isTrue(result.indexOf('`run_ace_command`') < result.indexOf('`http_request`'))
      assert.include(result, 'make:validator')
      assert.include(result, 'make:controller')
      assert.include(result, '`get_migrations`')
      assert.include(result, '`diff_schema`')
      assert.include(result, 'make:migration')
      if (kind === 'api') {
        assert.include(result, 'JSON')
        assert.notInclude(result, '`get_inertia_pages`')
        assert.notInclude(result, '`get_views`')
      }
      if (kind === 'inertia') {
        assert.include(result, 'node ace make:page')
        assert.include(result, 'X-Inertia')
        assert.include(result, '`get_transformers`')
      }
      if (kind === 'edge') {
        assert.include(result, 'Edge template')
        assert.include(result, 'make:view')
        assert.include(result, '`render_view`')
        assert.notInclude(result, 'make:page')
      }
    })
  }
  test('hybrid asks before planning and selects each surface', ({ assert }) => {
    const hybrid = profile('hybrid')
    const unresolved = buildAddFeature({ feature: 'bookings' }, hybrid, capabilities).messages[0]
      .text
    assert.match(unresolved, /ask.*web, api or both/i)
    assert.notInclude(unresolved, 'Create a thin controller')
    const api = buildAddFeature({ feature: 'bookings', surface: 'api' }, hybrid, capabilities)
      .messages[0].text
    assert.include(api, 'JSON')
    assert.notInclude(api, '`get_inertia_pages`')
    const web = buildAddFeature({ feature: 'bookings', surface: 'web' }, hybrid, capabilities)
      .messages[0].text
    assert.include(web, '`get_inertia_pages`')
    const both = buildAddFeature(
      { feature: 'bookings', surface: 'both' },
      profile('hybrid', true),
      capabilities
    ).messages[0].text
    assert.include(both, 'one validator, one service')
    assert.include(both, 'two thin controllers')
    assert.include(both, '@generated/data')
    assert.include(both, 'JSON')
    assert.include(both, 'X-Inertia')
  })
  test('hybrid Edge web surface follows view conventions', ({ assert }) => {
    const hybrid = { ...profile('hybrid'), inertia: null }
    const result = buildAddFeature({ feature: 'bookings', surface: 'web' }, hybrid, capabilities)
      .messages[0].text
    assert.include(result, '`get_views`')
    assert.include(result, '`render_view`')
    assert.notInclude(result, '`get_inertia_pages`')
  })
  test('debug method validates known methods and normalizes case', ({ assert }) => {
    const prompt = debugRequestPrompt(async () => profile('api'))
    if (!prompt.argsSchema) throw new Error('Debug request schema is required')
    for (const method of ['get', 'Head', 'post', 'put', 'patch', 'delete', 'options']) {
      const args = prompt.argsSchema.parse({ path: '/', method })
      const result = buildDebugRequest(args, profile('api'), capabilities).messages[0].text
      assert.include(result, `"method":"${method.toUpperCase()}"`)
    }
    assert.isFalse(prompt.argsSchema.safeParse({ path: '/', method: 'TRACE' }).success)
    const result = buildDebugRequest({ path: '/', guard: 'api' }, profile('api'), capabilities)
      .messages[0].text
    assert.include(result, 'guard is ignored without userId')
    assert.notInclude(result, '"as":')
  })
  test('generated aliases are conditional', ({ assert }) => {
    const absent = buildAddFeature({ feature: 'x' }, profile('inertia'), capabilities).messages[0]
      .text
    assert.notInclude(absent, '#generated/controllers')
    assert.notInclude(absent, '@generated/data')
    const present = buildAddFeature({ feature: 'x' }, profile('inertia', true), capabilities)
      .messages[0].text
    assert.include(present, '#generated/controllers')
    assert.include(present, '@generated/data')
  })
  test('unserved tools carry reasons without executable references', ({ assert }) => {
    const unavailable: WorkflowCapabilities = {
      ...capabilities,
      tools: capabilities.tools.map((entry) =>
        entry.name === 'get_logs'
          ? { name: entry.name, status: 'unavailable', reason: 'capture not instrumented' }
          : entry
      ),
    }
    const result = buildDebugRequest({ path: '/fail' }, profile('api'), unavailable).messages[0]
      .text
    assert.notInclude(result, '`get_logs`')
    assert.include(result, 'Not available: get_logs — capture not instrumented')
    assert.include(result, '`get_last_exceptions`')
    assert.include(result, '(tool not available, see below)')
    assert.notInclude(result, 'available project evidence')
  })
  test('debugging identity and tenant only come from arguments', ({ assert }) => {
    const absent = buildDebugRequest({ path: '/fail' }, profile('api'), capabilities).messages[0]
      .text
    assert.notInclude(absent, '"as":')
    assert.notInclude(absent, '"tenant":')
    assert.include(absent, '"method":"GET"')
    assert.include(absent, 'side effects')
    assert.include(absent, 'already contains correlated logs and exceptions')
    const steps = [
      'get_routes',
      'http_request',
      'get_last_exceptions',
      'get_logs',
      'get_source_location',
    ]
    for (let index = 1; index < steps.length; index++) {
      assert.isTrue(
        absent.indexOf(`\`${steps[index - 1]}\``) < absent.indexOf(`\`${steps[index]}\``)
      )
    }
    const present = buildDebugRequest(
      { path: '/fail', method: 'POST', userId: '4', guard: 'api', tenant: 'team' },
      profile('api'),
      capabilities
    ).messages[0].text
    assert.include(present, '"as":{"userId":"4","guard":"api"}')
    assert.include(present, '"tenant":"team"')
    assert.include(present, '"method":"POST"')
  })
})

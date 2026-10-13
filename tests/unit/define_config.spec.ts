import { test } from '@japa/runner'
import { defineConfig, resolveConfig } from '../../src/define_config.js'
import { InvalidMcpConfigError } from '../../src/errors.js'
import type { McpConfig, ResolvedMcpConfig } from '../../src/types.js'

function issuesOf(input: unknown): readonly string[] {
  try {
    resolveConfig(input)
  } catch (error) {
    if (error instanceof InvalidMcpConfigError) {
      return error.issues
    }
    throw error
  }
  throw new Error('expected config to be rejected')
}

test.group('resolveConfig | defaults and merge', () => {
  test('an absent config resolves to the documented defaults', ({ assert }) => {
    const config = resolveConfig(undefined)

    assert.deepEqual(config, {
      enabled: true,
      path: '/__adonis/mcp',
      allowRemoteAccess: false,
      allowedHosts: [],
      allowedOrigins: [],
      limits: { maxRequestBytes: 1_048_576, maxResultBytes: 262_144 },
      profile: { surfaces: {} },
      tools: {
        disabled: [],
        projectEval: { timeout: 30_000 },
        sql: { readOnly: true, maxRows: 100, allowCrossTenant: false },
        logs: { bufferSize: 1000, exceptionBufferSize: 100 },
        docs: { include: ['@adonisjs/*', '@rikology/*'] },
        http: { timeout: 30_000 },
        ace: { timeout: 30_000 },
      },
      extraTools: [],
    })
  })

  test('nested partial values keep sibling defaults', ({ assert }) => {
    const config = resolveConfig({ tools: { sql: { maxRows: 5 }, logs: { bufferSize: 10 } } })

    assert.deepEqual(config.tools.sql, { readOnly: true, maxRows: 5, allowCrossTenant: false })
    assert.deepEqual(config.tools.logs, { bufferSize: 10, exceptionBufferSize: 100 })
    assert.deepEqual(config.tools.http, { timeout: 30_000 })
  })

  test('arrays replace defaults so docs scopes can be narrowed', ({ assert }) => {
    const config = resolveConfig({ tools: { docs: { include: ['@adonisjs/*'] } } })
    assert.deepEqual(config.tools.docs.include, ['@adonisjs/*'])

    const empty = resolveConfig({ tools: { docs: { include: [] } } })
    assert.deepEqual(empty.tools.docs.include, [])
  })

  test('projectEval false disables eval instead of falling back to defaults', ({ assert }) => {
    assert.isFalse(resolveConfig({ tools: { projectEval: false } }).tools.projectEval)
    assert.deepEqual(resolveConfig({ tools: { projectEval: {} } }).tools.projectEval, {
      timeout: 30_000,
    })
  })

  test('disabled tools are kept once, in order', ({ assert }) => {
    const config = resolveConfig({
      tools: { disabled: ['project_eval', 'run_ace_command', 'project_eval'] },
    })
    assert.deepEqual(config.tools.disabled, ['project_eval', 'run_ace_command'])
  })

  test('kill switch and remote access are honored', ({ assert }) => {
    const config = resolveConfig({ enabled: false, allowRemoteAccess: true })
    assert.isFalse(config.enabled)
    assert.isTrue(config.allowRemoteAccess)
  })

  test('hosts and origins are normalized to exact values', ({ assert }) => {
    const config = resolveConfig({
      allowedHosts: ['Dev.Test:3333', 'dev.test:3333', '[::1]:4000'],
      allowedOrigins: ['HTTP://Dev.Test:3333/', 'https://app.example'],
    })
    assert.deepEqual(config.allowedHosts, ['dev.test:3333', '[::1]:4000'])
    assert.deepEqual(config.allowedOrigins, ['http://dev.test:3333', 'https://app.example'])
  })

  test('lazy extraTools loaders are kept without being called', ({ assert }) => {
    let calls = 0
    const loader = async () => {
      calls++
      return { default: [] }
    }

    const config = resolveConfig({ extraTools: [loader] })

    assert.deepEqual(config.extraTools, [loader])
    assert.equal(calls, 0)
  })

  test('resolved config is frozen and resolves to itself', ({ assert }) => {
    const config = defineConfig({
      path: '/_mcp',
      allowedHosts: ['dev.test'],
      profile: { surfaces: { api: { prefix: '/api', guard: 'api' }, default: 'api' } },
      tools: { projectEval: false, disabled: ['project_eval'] },
    })

    assert.isTrue(Object.isFrozen(config))
    assert.isTrue(Object.isFrozen(config.tools.sql))
    assert.isTrue(Object.isFrozen(config.tools.disabled))
    assert.isTrue(Object.isFrozen(config.profile.surfaces.api))
    assert.deepEqual(resolveConfig(config), config)
  })

  test('resolved config is accepted wherever input config is', ({ expectTypeOf }) => {
    expectTypeOf<ResolvedMcpConfig>().toMatchTypeOf<McpConfig>()
  })
})

test.group('resolveConfig | validation', () => {
  test('unknown keys are reported with their full path', ({ assert }) => {
    assert.sameMembers(
      [...issuesOf({ tools: { sqll: {} }, enabeld: true })],
      [
        'enabeld: unknown option (check for a typo)',
        'tools.sqll: unknown option (check for a typo)',
      ]
    )
  })

  test('endpoint path must be an exact absolute path', ({ assert }) => {
    for (const path of [
      'mcp',
      '/',
      '/mcp/',
      '/mcp/:id',
      '/mcp/*',
      '/mcp?x=1',
      '/a//b',
      '/a/../b',
      '/m%63p',
    ]) {
      const issues = issuesOf({ path })
      assert.lengthOf(issues, 1, path)
      assert.match(issues[0], /^path: must be an exact absolute path/, path)
    }
    assert.equal(resolveConfig({ path: '/__dev/mcp-v2' }).path, '/__dev/mcp-v2')
  })

  test('hosts and origins reject wildcards, null and non-exact forms', ({ assert }) => {
    for (const host of ['*.test', 'user@dev.test', 'dev.test/path', '', 'dev.test:99999']) {
      assert.match(issuesOf({ allowedHosts: [host] })[0], /^allowedHosts\[0\]: /, host)
    }
    for (const origin of [
      'null',
      '*',
      'http://*.test',
      'ftp://dev.test',
      'http://dev.test/app',
      'http://user@dev.test',
      'dev.test',
      'http://dev.test?x',
    ]) {
      assert.match(issuesOf({ allowedOrigins: [origin] })[0], /^allowedOrigins\[0\]: /, origin)
    }
  })

  test('numeric limits must be positive integers', ({ assert }) => {
    assert.deepEqual(
      issuesOf({
        tools: { sql: { maxRows: 0 }, logs: { bufferSize: 1.5 } },
        limits: { maxResultBytes: -1 },
      }).map((issue) => issue.split(':')[0]),
      ['limits.maxResultBytes', 'tools.sql.maxRows', 'tools.logs.bufferSize']
    )
  })

  test('projectEval accepts false or an options object only', ({ assert }) => {
    assert.deepEqual(issuesOf({ tools: { projectEval: true } }), [
      'tools.projectEval: must be false or an object such as { timeout: 30000 }',
    ])
  })

  test('disabled tool names must be snake_case', ({ assert }) => {
    const issues = issuesOf({ tools: { disabled: ['project_eval', 'projectEval', ''] } })
    assert.lengthOf(issues, 2)
    assert.match(issues[0], /^tools\.disabled\[1\]: "projectEval" must be snake_case/)
    assert.match(issues[1], /^tools\.disabled\[2\]: must be a non-empty string/)
  })

  test('docs scopes accept package names and scope wildcards only', ({ assert }) => {
    assert.deepEqual(
      resolveConfig({ tools: { docs: { include: ['edge.js', '@vinejs/vine', '@tuyau/*'] } } }).tools
        .docs.include,
      ['edge.js', '@vinejs/vine', '@tuyau/*']
    )
    for (const pattern of ['*', '@*/*', '@scope', '../secrets', '@a/b/c', 'UPPER']) {
      assert.lengthOf(issuesOf({ tools: { docs: { include: [pattern] } } }), 1, pattern)
    }
  })

  test('extraTools entries must be lazy loaders', ({ assert }) => {
    assert.deepEqual(issuesOf({ extraTools: [{ name: 'eager_tool' }] }), [
      "extraTools[0]: must be a lazy loader such as () => import('#start/mcp_tools')",
    ])
  })

  test('surface corrections are validated', ({ assert }) => {
    const issues = issuesOf({
      profile: { surfaces: { api: { prefix: 'api', guard: '' }, default: 'mobile' } },
    })
    assert.lengthOf(issues, 3)
    assert.match(issues[0], /^profile\.surfaces\.api\.prefix: /)
    assert.match(issues[1], /^profile\.surfaces\.api\.guard: /)
    assert.match(issues[2], /^profile\.surfaces\.default: /)
  })

  test('the error message lists every issue for the developer', ({ assert }) => {
    assert.throws(
      () => resolveConfig({ path: 'x', tools: { sql: { maxRows: 0 } } }),
      /Invalid MCP configuration in config\/mcp\.ts:\n {2}- path: .+\n {2}- tools\.sql\.maxRows: /
    )
  })

  test('non-object configs are rejected', ({ assert }) => {
    assert.lengthOf(issuesOf(null), 1)
    assert.lengthOf(issuesOf('config'), 1)
  })
})

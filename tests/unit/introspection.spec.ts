import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { resolveConfig } from '../../src/define_config.js'
import { ToolError } from '../../src/errors.js'
import { ConfigIntrospection } from '../../src/introspection/config.js'
import { routeSurface } from '../../src/introspection/routes.js'
import { Redactor } from '../../src/redaction.js'
import type { McpConfig, ProjectProfile, SurfaceReport } from '../../src/types.js'

function surface(prefix: string | null): SurfaceReport {
  return { prefix, guard: null, evidence: [] }
}

function profile(surfaces: ProjectProfile['surfaces']): ProjectProfile {
  return { surfaces } as ProjectProfile
}

test.group('Introspection | route surface', () => {
  test('the longest matching prefix wins and says where it came from', ({ assert }) => {
    const config = resolveConfig({
      profile: { surfaces: { web: { prefix: '/' }, api: { prefix: '/api' } } },
    } satisfies McpConfig)
    const hybrid = profile({ web: surface('/'), api: surface('/api'), default: null })

    assert.deepInclude(routeSurface({ pattern: '/api/v1/users', domain: 'root' }, hybrid, config), {
      name: 'api',
      source: 'config',
    })
    assert.deepInclude(routeSurface({ pattern: '/apiary', domain: 'root' }, hybrid, config), {
      name: 'web',
      source: 'config',
    })
  })

  test('falls back to api domains, then the default, then no surface', ({ assert }) => {
    const config = resolveConfig({})
    const inferred = profile({ web: surface(null), api: surface('/api'), default: 'web' })
    assert.deepInclude(routeSurface({ pattern: '/api/users', domain: 'root' }, inferred, config), {
      name: 'api',
      source: 'inferred',
    })
    assert.deepInclude(
      routeSurface({ pattern: '/users', domain: 'api.example.com' }, inferred, config),
      {
        name: 'api',
        source: 'inferred',
      }
    )
    assert.deepInclude(routeSurface({ pattern: '/dashboard', domain: 'root' }, inferred, config), {
      name: 'web',
      source: 'default',
    })

    const undecided = profile({ web: surface(null), api: surface('/api'), default: null })
    assert.deepInclude(routeSurface({ pattern: '/dashboard', domain: 'root' }, undecided, config), {
      name: null,
      source: null,
    })
  })
})

test.group('Introspection | config', () => {
  const tree = {
    database: {
      connection: 'pg',
      connections: { pg: { connection: { host: 'db', password: 'pw-literal-value' } } },
    },
    mail: { credentials: { user: 'u', pass: 'p' } },
    flags: Object.create({ inherited: true }) as Record<string, unknown>,
  }
  const config = new ConfigIntrospection(
    { config: { all: () => tree } } as unknown as ApplicationService,
    new Redactor([])
  )

  test('reads own keys and masks sensitive values', ({ assert }) => {
    assert.deepEqual(config.read('database.connections.pg.connection'), {
      key: 'database.connections.pg.connection',
      value: { host: 'db', password: '[REDACTED]' },
    })
    assert.deepEqual(config.read('mail.credentials.user'), {
      key: 'mail.credentials.user',
      value: '[REDACTED]',
    })
  })

  test('rejects prototype keys and reports missing keys', ({ assert }) => {
    const code = (key: string) => {
      try {
        config.read(key)
        return 'ok'
      } catch (error) {
        return error instanceof ToolError ? error.code : 'unexpected'
      }
    }
    assert.equal(code('database.__proto__'), 'INPUT_INVALID')
    assert.equal(code('database.constructor'), 'INPUT_INVALID')
    assert.equal(code('database..connection'), 'INPUT_INVALID')
    assert.equal(code('flags.inherited'), 'NOT_FOUND')
    assert.equal(code('database.connection.length'), 'NOT_FOUND')
    assert.equal(code('missing'), 'NOT_FOUND')
  })
})

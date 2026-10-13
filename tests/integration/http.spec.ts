/*
|--------------------------------------------------------------------------
| Real HTTP, impersonation and surface routing (M5)
|--------------------------------------------------------------------------
|
| Hybrid kit: the Inertia React starter kit (session guard, Shield CSRF,
| Inertia middleware) with a token guard, JSON routes, the same path on two
| methods and on two domains, an Edge page and failing/slow handlers.
| Official MCP clients drive `http_request` against the live application
| and compare what it reports with the application's own state.
|
| Tenant kit: the API kit with `@rikology/adonisjs-tenant` tenant-aware
| token and session guards (membership pivot), a header resolver and
| tenant middleware before auth: the M5 exit gate.
|
*/

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient, type ProtocolEra } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  instrumentCapture,
  setExtensionProviders,
  toolPayload,
  writeMcpConfig,
  waitForMcp,
} from '../helpers/mcp_endpoint.js'

interface Envelope<T> {
  data: T
  limitations?: string[]
}

interface Failure {
  code: string
  message: string
}

interface HttpData {
  request: {
    method: string
    path: string
    host: string
    route: { pattern: string; name: string | null; domain: string; methods: string[] } | null
    surface: { name: string; renderer: string | null; source: string; detail: string }
    tenant: { requested: string; id: string; mapping: { kind: string; header?: string } } | null
    as: { guard: string; driver: string; kind: string; userId: number | string } | null
    csrf: boolean
    inertiaVersion: string | null
  }
  response: {
    status: number
    headers: Record<string, string>
  }
  body: {
    kind: string
    bytes?: number
    truncated?: boolean
    json?: unknown
    text?: string
    inertia?: {
      component: string
      version: string | null
      props: Record<string, unknown>
      flash?: Record<string, unknown>
    }
    html?: {
      title: string | null
      headings: Array<{ level: number; text: string }>
      forms: Array<{ action: string | null; method: string; fields: string[] }>
      links: Array<{ href: string; text: string }>
      text: string
    }
  }
  validation: { source: string; errors: unknown } | null
  redirects: Array<{ status: number; location: string | null; method: string; path: string }>
  unfollowedRedirect: { location: string; reason: string } | null
  requestIds: string[]
  auth: Array<{
    requestId: string
    guard: string | null
    outcome: string
    userId: number | string | null
  }> | null
  logs: {
    entries: Array<{
      requestId: string | null
      message: string | null
      fields: Record<string, unknown>
    }>
  } | null
  exceptions: Array<{
    message: string
    code: string | null
    status: number | null
    request: { id: string | null } | null
  }> | null
}

interface SqlData {
  rows: unknown[][]
}

async function withClient<T>(
  app: RunningApp,
  run: (client: Client) => Promise<T>,
  era: ProtocolEra = 'modern'
) {
  const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

async function http(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'http_request', arguments: args })
  if (result.isError) {
    throw new Error(`http_request failed: ${JSON.stringify(result.content)}`)
  }
  return toolPayload<Envelope<HttpData>>(result)
}

async function httpError(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'http_request', arguments: args })
  if (!result.isError) {
    throw new Error(`http_request unexpectedly succeeded: ${JSON.stringify(result.content)}`)
  }
  return toolPayload<{ error: Failure }>(result).error
}

/**
 * Raw text of a tool result, to scan for leaked credentials.
 */
async function rawText(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'http_request', arguments: args })
  return JSON.stringify(result.content)
}

async function tokenCount(client: Client): Promise<number> {
  const result = await client.callTool({
    name: 'execute_sql_query',
    arguments: { query: 'SELECT count(*) AS total FROM auth_access_tokens' },
  })
  if (result.isError) {
    throw new Error(`execute_sql_query failed: ${JSON.stringify(result.content)}`)
  }
  return Number(toolPayload<Envelope<SqlData>>(result).data.rows[0][0])
}

/**
 * Credential shapes minted by the tool: bearer tokens and encrypted or
 * signed cookie values, raw or URL-encoded.
 */
const CREDENTIAL_SHAPES = /oat_[\w.-]{8,}|\b[es](?::|%3A)[\w-]{16,}/

const SEED_USERS = `import { BaseSchema } from '@adonisjs/lucid/schema'
import hash from '@adonisjs/core/services/hash'

export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      const now = new Date().toISOString()
      await db.table('users').multiInsert([
        { id: 1, email: 'ada@example.com', full_name: 'Ada', password: await hash.make('ada-password'), created_at: now },
        { id: 2, email: 'bob@example.com', full_name: 'Bob', password: await hash.make('bob-password'), created_at: now },
      ])
    })
  }
}
`

test.group('HTTP | hybrid Inertia and API kit', (group) => {
  let fixture: FixtureApp
  let app: RunningApp

  group.setup(async () => {
    fixture = await FixtureApp.create('hybrid')
    try {
      await writeFile(
        join(fixture.root, 'database', 'migrations', '1790000000000_seed_users.ts'),
        SEED_USERS
      )
      await fixture.migrate()
      await installPackage(fixture)
      await instrumentCapture(fixture)
      await writeMcpConfig(fixture, '')
      app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return () => fixture.dispose()
  })

  test('requests never leave the application or reach the MCP endpoint', async ({ assert }) => {
    await withClient(app, async (client) => {
      const rejected = await Promise.all(
        [
          { path: '/__adonis/mcp', surface: 'api' },
          { path: '/__ADONIS/mcp/', surface: 'api' },
          { path: '/__adonis/%6dcp', surface: 'api' },
          { path: '/__adonis/%256dcp', surface: 'api' },
          { path: '/x/../__adonis/mcp', surface: 'api' },
          { path: '//evil.test/steal', surface: 'api' },
          { path: 'http://evil.test/steal', surface: 'api' },
          { path: '/\\evil.test', surface: 'api' },
          { path: '/status', domain: 'evil.test', surface: 'api' },
          { path: '/status', domain: 'api.fixture.test:80', surface: 'api' },
          { path: '/status', headers: { Host: 'evil.test' }, surface: 'api' },
          { path: '/status', headers: { 'X-Forwarded-For': '10.0.0.1' }, surface: 'api' },
          { path: '/status', headers: { Authorization: 'Bearer forged' }, surface: 'api' },
          { path: '/status', headers: { 'X-Adonisjs-Mcp-Call': 'x' }, surface: 'api' },
        ].map((args) => httpError(client, args))
      )
      assert.deepEqual(
        rejected.map((error) => error.code),
        rejected.map(() => 'INPUT_INVALID')
      )
      assert.include(rejected[2].message, 'MCP endpoint')
      assert.include(rejected[8].message, 'api.fixture.test')

      for (const [target, reason] of [
        ['mcp', 'MCP endpoint'],
        ['encoded', 'MCP endpoint'],
        ['external', 'leaves the application origin'],
      ] as const) {
        const result = await http(client, {
          path: `/__fixture/redirect/${target}`,
          surface: 'api',
          followRedirects: true,
        })
        assert.equal(result.data.response.status, 302, target)
        assert.lengthOf(result.data.requestIds, 1, target)
        assert.include(result.data.unfollowedRedirect!.reason, reason, target)
      }

      const followed = await http(client, {
        path: '/__fixture/redirect/whoami',
        surface: 'api',
        followRedirects: true,
      })
      assert.equal(followed.data.response.status, 200)
      assert.deepEqual(followed.data.body.json, { web: null, api: null })
      assert.deepInclude(followed.data.redirects[0], {
        status: 302,
        path: '/__fixture/redirect/whoami',
      })

      const manual = await http(client, { path: '/__fixture/redirect/whoami', surface: 'api' })
      assert.equal(manual.data.response.status, 302)
      assert.equal(manual.data.unfollowedRedirect!.reason, 'followRedirects is off')
    })
  })

  test('the surface follows route guards, domains and explicit overrides', async ({ assert }) => {
    await withClient(app, async (client) => {
      const profile = await client.callTool({ name: 'get_project_profile', arguments: {} })
      const surfaces = toolPayload<
        Envelope<{
          kind: string
          surfaces: {
            web: { renderer: string } | null
            api: { prefix: string | null } | null
            default: string | null
          }
        }>
      >(profile).data
      assert.equal(surfaces.kind, 'hybrid')
      assert.equal(surfaces.surfaces.web!.renderer, 'inertia')
      assert.equal(surfaces.surfaces.api!.prefix, '/api')
      assert.isNull(surfaces.surfaces.default)

      const rendered = await http(client, { path: '/' })
      assert.equal(rendered.data.request.surface.name, 'web')
      assert.equal(rendered.data.request.surface.source, 'route-render')
      const undecided = await httpError(client, { path: '/__fixture/whoami' })
      assert.equal(undecided.code, 'INPUT_INVALID')
      assert.include(undecided.message, "surface: 'web' or 'api'")

      const page = await http(client, { path: '/status', surface: 'web' })
      assert.equal(page.data.response.status, 200, 'the actual Inertia version avoids a 409')
      assert.equal(page.data.body.kind, 'inertia')
      assert.equal(page.data.body.inertia!.component, 'home')
      assert.equal(page.data.body.inertia!.props.status, 'root')
      assert.equal(page.data.body.inertia!.version, page.data.request.inertiaVersion)

      const domain = await http(client, { path: '/status', domain: 'API.fixture.test' })
      assert.deepInclude(domain.data.request.surface, { name: 'api', source: 'inferred' })
      assert.deepEqual(domain.data.request.route, {
        pattern: '/status',
        name: null,
        domain: 'api.fixture.test',
        methods: ['GET', 'HEAD'],
      })
      assert.deepEqual(domain.data.body.json, { status: 'api-domain' })

      const webReport = await http(client, { path: '/__fixture/reports', as: { userId: 1 } })
      assert.deepInclude(webReport.data.request.surface, { name: 'web', source: 'route-guard' })
      assert.deepInclude(webReport.data.request.as, { guard: 'web', kind: 'session-cookie' })
      assert.equal(webReport.data.body.inertia!.component, 'dashboard')
      assert.equal(webReport.data.body.inertia!.props.report, 'web')

      const apiReport = await http(client, {
        method: 'POST',
        path: '/__fixture/reports',
        as: { userId: 1 },
      })
      assert.deepInclude(apiReport.data.request.surface, { name: 'api', source: 'route-guard' })
      assert.deepInclude(apiReport.data.request.as, { guard: 'api', kind: 'access-token' })
      assert.deepEqual(apiReport.data.body.json, { report: 'api', userId: 1 })
      assert.isFalse(apiReport.data.request.csrf, 'API clients get no CSRF token by default')

      const conflict = await httpError(client, {
        path: '/__fixture/reports',
        surface: 'api',
        as: { userId: 1, guard: 'web' },
      })
      assert.equal(conflict.code, 'INPUT_INVALID')
      assert.include(conflict.message, 'contradicts')

      const api = await http(client, { path: '/__fixture/echo', surface: 'api' })
      const apiHeaders = (api.data.body.json as { headers: Record<string, string> }).headers
      assert.equal(apiHeaders.accept, 'application/json')
      assert.notProperty(apiHeaders, 'x-inertia')
      assert.notProperty(apiHeaders, 'x-inertia-version')
      const web = await http(client, { path: '/__fixture/echo', surface: 'web' })
      const webHeaders = (web.data.body.json as { headers: Record<string, string> }).headers
      assert.equal(webHeaders['x-inertia'], 'true')
      assert.equal(webHeaders['x-inertia-version'], web.data.request.inertiaVersion)
    })
  })

  test('session impersonation passes Shield CSRF, validation flash and auth like a browser', async ({
    assert,
  }) => {
    await withClient(
      app,
      async (client) => {
        const invalid = await http(client, {
          method: 'POST',
          path: '/__fixture/notes',
          as: { userId: 1 },
          body: { title: '' },
          headers: { Referer: '/dashboard' },
          followRedirects: true,
        })
        assert.isTrue(invalid.data.request.csrf)
        assert.deepEqual(
          invalid.data.redirects.map((hop) => [hop.method, hop.status, hop.location]),
          [['POST', 302, '/dashboard']]
        )
        assert.equal(invalid.data.response.status, 200)
        assert.deepEqual(invalid.data.validation, {
          source: 'inertia-props.errors',
          errors: { title: 'The title field must be defined' },
        })
        assert.deepEqual(
          invalid.data.auth!.filter((event) => event.guard === 'web').map((event) => event.userId),
          [1, 1]
        )

        const valid = await http(client, {
          method: 'POST',
          path: '/__fixture/notes',
          as: { userId: 1 },
          body: { title: 'Hello' },
          followRedirects: true,
        })
        assert.equal(valid.data.body.inertia!.component, 'dashboard')
        assert.deepInclude(valid.data.body.inertia!.flash, { success: 'Saved Hello' })
        assert.isNull(valid.data.validation)

        const forged = await http(client, {
          method: 'POST',
          path: '/__fixture/notes',
          as: { userId: 1 },
          body: { title: 'Hello' },
          csrf: false,
        })
        assert.equal(forged.data.response.status, 302)
        assert.deepEqual(
          forged.data.exceptions!.map((exception) => exception.code),
          ['E_BAD_CSRF_TOKEN']
        )

        const anonymous = await http(client, {
          method: 'POST',
          path: '/__fixture/notes',
          body: { title: 'Hello' },
        })
        assert.equal(anonymous.data.response.status, 302)
        assert.equal(anonymous.data.response.headers.location, '/login')

        const bob = await http(client, {
          path: '/__fixture/whoami',
          surface: 'web',
          as: { userId: 2 },
        })
        assert.deepEqual(bob.data.body.json, { web: 2, api: null })
        const after = await http(client, { path: '/__fixture/whoami', surface: 'web' })
        assert.deepEqual(after.data.body.json, { web: null, api: null }, 'nothing carries over')
      },
      'legacy'
    )
  })

  test('access tokens live only for the call, whatever the outcome', async ({ assert }) => {
    await withClient(app, async (client) => {
      assert.equal(await tokenCount(client), 0)

      const me = await http(client, { path: '/api/v1/me', as: { userId: 1 } })
      assert.deepEqual(me.data.body.json, { id: 1, email: 'ada@example.com' })
      assert.deepInclude(
        me.data.auth!.find((event) => event.guard === 'api'),
        { outcome: 'succeeded', userId: 1 }
      )
      assert.isTrue(me.limitations!.some((text) => text.includes('deleted when the call ended')))

      const failed = await http(client, { path: '/api/v1/fail', as: { userId: 2 } })
      assert.equal(failed.data.response.status, 500)
      assert.equal(failed.data.exceptions![0].message, 'Fixture API failure')

      const slow = await httpError(client, {
        path: '/api/v1/slow',
        as: { userId: 2 },
        timeout: 300,
      })
      assert.equal(slow.code, 'TIMEOUT')
      assert.include(slow.message, 'does not stop handler code')

      const controller = new AbortController()
      const cancelled = client.callTool(
        { name: 'http_request', arguments: { path: '/api/v1/slow', as: { userId: 1 } } },
        { signal: controller.signal }
      )
      setTimeout(() => controller.abort(), 300)
      await assert.rejects(() => cancelled)

      let remaining = await tokenCount(client)
      for (let attempt = 0; remaining !== 0 && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        remaining = await tokenCount(client)
      }
      assert.equal(remaining, 0, 'success, error, timeout and cancel leave no token')

      const anonymous = await http(client, { path: '/api/v1/me' })
      assert.equal(anonymous.data.response.status, 401)
      const invalid = await Promise.all([
        httpError(client, { path: '/api/v1/me', as: { userId: 99 } }),
        httpError(client, { path: '/api/v1/me', as: { userId: 1, guard: 'nope' } }),
        httpError(client, { path: '/api/v1/me', as: { userId: 1, model: 'Missing' } }),
      ])
      assert.deepEqual(
        invalid.map((error) => error.code),
        ['NOT_FOUND', 'INPUT_INVALID', 'INPUT_INVALID']
      )
      assert.equal(await tokenCount(client), 0)
    })
  })

  test('minted credentials never appear in results', async ({ assert }) => {
    await withClient(app, async (client) => {
      for (const [surface, as] of [
        ['api', { userId: 1, guard: 'api' }],
        ['web', { userId: 2, guard: 'web' }],
      ] as const) {
        const text = await rawText(client, { path: '/__fixture/echo', surface, as })
        assert.notMatch(text, CREDENTIAL_SHAPES, as.guard)
        assert.notInclude(text, 'Bearer oat_', as.guard)
        const result = await http(client, { path: '/__fixture/echo', surface, as })
        const seen = (result.data.body.json as { seen: string[] }).seen
        assert.isTrue(
          seen.some((value) => value.includes('[REDACTED]')),
          `${as.guard}: the echoed credential is masked under a neutral key`
        )
      }
    })
  })

  test('logs and exceptions are those of the request, not of concurrent traffic', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const noise = Array.from({ length: 6 }, (_, index) =>
        app.fetch(`/__fixture/fail/noise-${index}`, { headers: { accept: 'application/json' } })
      )
      const [result] = await Promise.all([
        http(client, { path: '/__fixture/fail/mine', surface: 'api' }),
        ...noise,
      ])
      assert.equal(result.data.response.status, 500)
      assert.deepEqual(
        result.data.exceptions!.map((exception) => [exception.message, exception.status]),
        [['Fixture failure mine', 500]]
      )
      assert.isNotEmpty(result.data.logs!.entries)
      for (const entry of result.data.logs!.entries) {
        assert.include(result.data.requestIds, entry.requestId ?? '(none)')
      }
      assert.isTrue(
        result.data.logs!.entries.some(
          (entry) =>
            entry.message === 'fixture failure requested' && entry.fields.failure === 'mine'
        )
      )
    })
  })

  test('HTML responses are outlined and large bodies are cut, not buffered', async ({ assert }) => {
    await withClient(app, async (client) => {
      const result = await http(client, { path: '/__fixture/html', surface: 'web' })
      assert.equal(result.data.body.kind, 'html')
      const html = result.data.body.html!
      assert.equal(html.title, 'Fixture & page')
      assert.deepEqual(html.headings, [
        { level: 1, text: 'Fixture page' },
        { level: 2, text: 'Sign in' },
      ])
      assert.deepEqual(html.forms, [
        { action: '/login', method: 'POST', fields: ['_csrf', 'email', 'password'] },
      ])
      assert.deepEqual(
        html.links.map((link) => link.href),
        ['/dashboard', '/signup']
      )
      assert.notInclude(html.text, 'not part of the outline')

      const big = await http(client, { path: '/__fixture/big', surface: 'api' })
      assert.equal(big.data.response.status, 200)
      assert.deepInclude(big.data.body, { kind: 'text', truncated: true })
      assert.isAtMost(big.data.body.bytes!, 256 * 1024)
      assert.isTrue(big.limitations!.some((text) => text.includes('limits.maxResultBytes')))
      const after = await app.fetch('/__fixture/whoami', {
        headers: { accept: 'application/json' },
      })
      assert.equal(after.status, 200, 'the application keeps serving after the cut')
    })
  })
})

const TENANCY_CONFIG = `const tenancyConfig = {
  default: 'header',
  failOnMissing: true,
  tenants: {
    header: {
      resolver: 'header' as const,
      options: {
        header: 'X-Tenant-ID',
        tenants: {
          a: { id: 'a', name: 'Tenant A' },
          b: { id: 'b', name: 'Tenant B' },
        },
      },
    },
  },
}

export default tenancyConfig
`

const TENANT_AUTH = `import { defineTenantAuthConfig, tenantGuards } from '@rikology/adonisjs-tenant/guards'
import { TenantUserProvider } from '@rikology/adonisjs-tenant/user_providers'
import { tokensUserProvider } from '@adonisjs/auth/access_tokens'
import { sessionUserProvider } from '@adonisjs/auth/session'
import User from '#models/user'

export default defineTenantAuthConfig({
  default: 'api',
  guards: {
    api: tenantGuards.accessTokens({
      provider: tokensUserProvider({ tokens: 'accessTokens', model: () => import('#models/user') }),
      tenantTokenProvider: User.accessTokens,
    }),
    web: tenantGuards.session({
      provider: sessionUserProvider({ model: () => import('#models/user') }),
      tenantProvider: new TenantUserProvider(User, { pivotTable: 'tenant_user' }),
    }),
  },
})
`

const TENANT_USER = `import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { withTenantAuthFinder } from '@rikology/adonisjs-tenant/mixins'

export default class User extends withTenantAuthFinder(() => hash.use(), {
  uids: ['email'],
  passwordColumnName: 'password',
  membership: { pivotTable: 'tenant_user' },
})(UserSchema) {}
`

const TENANT_MIGRATION = `import { BaseSchema } from '@adonisjs/lucid/schema'
import hash from '@adonisjs/core/services/hash'

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('auth_access_tokens', (table) => {
      table.string('tenant_id').nullable()
    })
    this.schema.createTable('tenant_user', (table) => {
      table.string('tenant_id').notNullable()
      table.integer('user_id').notNullable()
      table.unique(['tenant_id', 'user_id'])
    })
    this.schema.createTable('tenant_notes', (table) => {
      table.increments('id')
      table.string('tenant_id').notNullable()
      table.string('body').notNullable()
    })
    this.defer(async (db) => {
      const now = new Date().toISOString()
      await db.table('users').multiInsert([
        { id: 1, email: 'ada@example.com', full_name: 'Ada', password: await hash.make('ada-password'), created_at: now },
        { id: 2, email: 'bob@example.com', full_name: 'Bob', password: await hash.make('bob-password'), created_at: now },
        { id: 3, email: 'eve@example.com', full_name: 'Eve', password: await hash.make('eve-password'), created_at: now },
      ])
      await db.table('tenant_user').multiInsert([
        { tenant_id: 'a', user_id: 1 },
        { tenant_id: 'b', user_id: 2 },
      ])
      await db.table('tenant_notes').multiInsert([
        { tenant_id: 'a', body: 'A-private' },
        { tenant_id: 'b', body: 'B-private' },
      ])
    })
  }
}
`

const TENANT_ROUTES = `
import { getTenantContext } from '@rikology/adonisjs-tenant'
import User from '#models/user'
import { setTimeout as sleep } from 'node:timers/promises'

const tenantMiddleware = router.named({
  tenant: () => import('@rikology/adonisjs-tenant/middleware'),
})

async function tenantNotes(userId: number) {
  const tenant = getTenantContext()!
  const rows = await db.from('tenant_notes').where('tenant_id', String(tenant.id)).orderBy('id')
  return { user: userId, tenant: tenant.id, notes: rows.map((row) => row.body) }
}

router
  .group(() => {
    router.post('login', async ({ request }) => {
      const user = await User.verifyCredentials(request.input('email'), request.input('password'))
      const token = await User.accessTokens.create(user)
      return { token: token.value!.release() }
    })
    router
      .get('notes', ({ auth }) => tenantNotes(auth.use('api').user!.id))
      .use(middleware.auth({ guards: ['api'] }))
    router
      .get('session-notes', ({ auth }) => tenantNotes(auth.use('web').user!.id))
      .use(middleware.auth({ guards: ['web'] }))
    router
      .get('fail', () => {
        throw new Error('Tenant fixture failure')
      })
      .use(middleware.auth({ guards: ['api'] }))
    router
      .get('slow', async ({ auth }) => {
        await sleep(3000)
        return { id: auth.use('api').user!.id }
      })
      .use(middleware.auth({ guards: ['api'] }))
  })
  .prefix('/tenant')
  .use(tenantMiddleware.tenant())

router.get('/tenant-free/whoami', async ({ auth }) => ({
  api: await auth.use('api').check(),
  web: await auth.use('web').check(),
  tenant: getTenantContext()?.id ?? null,
}))
`

interface NotesBody {
  user: number
  tenant: string
  notes: string[]
}

test.group('HTTP | tenant-aware guards (M5 exit gate)', (group) => {
  let fixture: FixtureApp
  let app: RunningApp

  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    try {
      await fixture.npm(['install', '--save-exact', '@rikology/adonisjs-tenant@1.0.2'])
      await writeFile(
        join(fixture.root, 'database', 'migrations', '1790000000000_tenant_auth.ts'),
        TENANT_MIGRATION
      )
      await fixture.migrate()
      await installPackage(fixture)
      await instrumentCapture(fixture)
      await writeFile(join(fixture.root, 'config', 'tenancy.ts'), TENANCY_CONFIG)
      await writeFile(join(fixture.root, 'config', 'auth.ts'), TENANT_AUTH)
      await writeFile(join(fixture.root, 'app', 'models', 'user.ts'), TENANT_USER)
      await writeFile(
        join(fixture.root, 'providers', 'tenancy_fixture_provider.ts'),
        "export { default } from '@rikology/adonisjs-tenant/providers/tenancy_provider'\n"
      )
      await setExtensionProviders(fixture, ['tenancy_fixture_provider'])
      const routes = join(fixture.root, 'start', 'routes.ts')
      await writeFile(routes, `${await readFile(routes, 'utf8')}${TENANT_ROUTES}`)
      await writeMcpConfig(fixture, '')
      app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return () => fixture.dispose()
  })

  test('tenant A as user A matches a direct request and leaves no auth or tenant state', async ({
    assert,
  }) => {
    const headersA = {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-tenant-id': 'a',
    }
    const login = await app.fetch('/tenant/login', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ email: 'ada@example.com', password: 'ada-password' }),
    })
    const { token } = (await login.json()) as { token: string }
    const directResponse = await app.fetch('/tenant/notes', {
      headers: { ...headersA, authorization: `Bearer ${token}` },
    })
    const direct = (await directResponse.json()) as NotesBody
    assert.deepEqual(direct, { user: 1, tenant: 'a', notes: ['A-private'] })

    await withClient(app, async (client) => {
      const before = await tokenCount(client)
      const reproduced = await http(client, {
        path: '/tenant/notes',
        as: { userId: 1 },
        tenant: 'a',
      })
      assert.equal(reproduced.data.response.status, directResponse.status)
      assert.deepEqual(reproduced.data.body.json, direct)
      assert.deepInclude(reproduced.data.request.tenant!, {
        requested: 'a',
        id: 'a',
        mapping: { kind: 'header', header: 'X-Tenant-ID' },
      })
      assert.deepInclude(
        reproduced.data.auth!.find((event) => event.guard === 'api'),
        { outcome: 'succeeded', userId: 1 }
      )
      assert.equal(await tokenCount(client), before, 'the minted token is gone')

      const anonymousTenant = await http(client, { path: '/tenant/notes', tenant: 'a' })
      assert.equal(anonymousTenant.data.response.status, 401)
    })

    const nextResponse = await app.fetch('/tenant-free/whoami', {
      headers: { accept: 'application/json' },
    })
    assert.deepEqual(await nextResponse.json(), { api: false, web: false, tenant: null })
  })

  test('membership, tenant keys and the tenant header fail closed before minting', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const before = await tokenCount(client)
      const errors = await Promise.all([
        httpError(client, { path: '/tenant/notes', as: { userId: 1 }, tenant: 'b' }),
        httpError(client, { path: '/tenant/notes', as: { userId: 3 }, tenant: 'a' }),
        httpError(client, { path: '/tenant/notes', as: { userId: 1 }, tenant: 'zzz' }),
        httpError(client, { path: '/tenant/notes', as: { userId: 1 } }),
        httpError(client, { path: '/tenant/notes', headers: { 'X-Tenant-ID': 'b' } }),
      ])
      assert.deepEqual(
        errors.map((error) => error.code),
        ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'TENANT_SCOPE_REQUIRED', 'INPUT_INVALID']
      )
      assert.include(errors[0].message, 'not a member of tenant "b"')
      assert.equal(await tokenCount(client), before)
    })
  })

  test('concurrent tenants only see their own data through token and session guards', async ({
    assert,
  }) => {
    const clients = await Promise.all(
      (['modern', 'legacy'] as const).map((era) =>
        connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
      )
    )
    try {
      const before = await tokenCount(clients[0])
      const calls = [
        { path: '/tenant/notes', as: { userId: 1 }, tenant: 'a' },
        { path: '/tenant/notes', as: { userId: 2 }, tenant: 'b' },
        { path: '/tenant/session-notes', as: { userId: 1, guard: 'web' }, tenant: 'a' },
        { path: '/tenant/session-notes', as: { userId: 2, guard: 'web' }, tenant: 'b' },
      ]
      const results = await Promise.all(
        [...calls, ...calls].map((args, index) => http(clients[index % 2], args))
      )
      assert.deepEqual(
        results.map((result) => result.data.body.json),
        [...calls, ...calls].map((args) =>
          args.tenant === 'a'
            ? { user: 1, tenant: 'a', notes: ['A-private'] }
            : { user: 2, tenant: 'b', notes: ['B-private'] }
        )
      )
      assert.equal(await tokenCount(clients[0]), before)
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  })

  test('tenant-bound tokens are deleted after application errors and deadlines', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const before = await tokenCount(client)
      const failed = await http(client, { path: '/tenant/fail', as: { userId: 2 }, tenant: 'b' })
      assert.equal(failed.data.response.status, 500)
      assert.equal(failed.data.exceptions![0].message, 'Tenant fixture failure')
      const slow = await httpError(client, {
        path: '/tenant/slow',
        as: { userId: 2 },
        tenant: 'b',
        timeout: 300,
      })
      assert.equal(slow.code, 'TIMEOUT')
      assert.equal(await tokenCount(client), before)
    })
  })
})

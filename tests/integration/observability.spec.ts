/*
|--------------------------------------------------------------------------
| Runtime observability and basic metadata (M3)
|--------------------------------------------------------------------------
|
| The API starter kit is instrumented with the opt-in capture hooks (dev
| gateway, logger `hooks.streamWrite`, one observer call in the exception
| handler) and extended with probe routes, container bindings, event
| listeners, an unused named middleware and a sentinel secret. Official
| MCP clients read routes, middleware, logs, exceptions, bindings, events,
| config and env from the live process.
|
*/

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient, type ProtocolEra } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  instrumentCapture,
  resourcePayload,
  setExtensionProviders,
  toolPayload,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'
import type { CapturedException, CapturedLog } from '../../src/types.js'

const LITERAL_SECRET = `sentinel-literal-${randomBytes(6).toString('hex')}`

const PROBE_ROUTES = `
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'

router.get('/__fixture/work/:id', ({ params, logger: requestLogger }) => {
  const secret = env.get('FIXTURE_SENTINEL_SECRET')
  logger.info({ probe: 'root', id: params.id }, 'root log')
  requestLogger.info({ probe: 'ctx', id: params.id, apiKey: secret }, \`ctx log with \${secret}\`)
  requestLogger.child({ step: 'child' }).info({ probe: 'child', id: params.id }, 'child log')
  return { id: params.id }
})

router
  .get('/__fixture/fail/:id', ({ params }) => {
    throw new Error(\`fixture failure \${params.id} near \${env.get('FIXTURE_SENTINEL_SECRET')}\`)
  })
  .as('fixture.fail')

router.get('/__fixture/capture', async () => {
  try {
    const hooks = await import('@rikology/adonisjs-mcp/hooks')
    return { status: hooks.instrumentationStatus() }
  } catch {
    return { status: null }
  }
})

router.get('/__fixture/constructions', () => {
  return { count: (globalThis as { __fixtureConstructions?: number }).__fixtureConstructions ?? 0 }
})
`

const EVENTS_PRELOAD = `import emitter from '@adonisjs/core/services/emitter'

emitter.on('fixture:inline' as any, function inlineListener() {})
emitter.on('fixture:lazy' as any, [() => import('#listeners/fixture_listener'), 'handle'] as any)
emitter.once('fixture:once' as any, () => {})
`

const LISTENER = `export default class FixtureListener {
  handle() {
    throw new Error('fixture listener must never run during introspection')
  }
}
`

const BINDINGS_PROVIDER = `import type { ApplicationService } from '@adonisjs/core/types'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'fixture.singleton': { id: number }
    'fixture.alias': { id: number }
    'fixture.declared': string
    'fixture.declaredAbsent': string
  }
}

const state = globalThis as { __fixtureConstructions?: number }
const construct = () => {
  state.__fixtureConstructions = (state.__fixtureConstructions ?? 0) + 1
}

export default class FixtureBindingsProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    const container = this.app.container as any
    container.singleton('fixture.singleton', () => {
      construct()
      return { id: 1 }
    })
    container.bind('fixture.bound', () => {
      construct()
      return 'bound'
    })
    container.alias('fixture.alias', 'fixture.singleton')
  }

  boot() {
    ;(this.app.container as any).bindValue('fixture.declared', 'declared in boot')
  }
}
`

const TOOLS_PROVIDER = `import type { ApplicationService } from '@adonisjs/core/types'

export default class FixtureToolsProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    if (!this.app.inDev || !this.app.container.hasBinding('mcp.registry')) {
      return
    }
    const registry = await this.app.container.make('mcp.registry')
    const { z } = await import('zod')
    const app = this.app
    registry.tool({
      name: 'fixture_log',
      description: 'Writes one log record via the running AdonisJS app logger',
      inputSchema: z.object({ marker: z.string() }),
      async handler(input, context) {
        const logger = await app.container.make('logger')
        await new Promise((resolve) => setTimeout(resolve, 20))
        logger.info({ probe: 'tool', marker: input.marker }, 'fixture tool log')
        return { data: { callId: context.callId } }
      },
    })
  }
}
`

interface Envelope<T> {
  data: T
  evidence?: string[]
  limitations?: string[]
  truncated: boolean
}

interface LogsData {
  entries: CapturedLog[]
  matched: number
  lastSeq: number
  capture: { observed: number; retained: number; evicted: number }
}

interface ExceptionsData {
  exceptions: Array<CapturedException & { occurrences: number }>
  matched: number
}

interface MiddlewareEntry {
  type: string
  name: string | null
  module: string | null
  method: string | null
  args?: unknown
  owner?: string
  usedByRoutes?: number
  source?: string
}

interface RouteEntry {
  methods: string[]
  pattern: string
  name: string | null
  domain: string
  params: Array<{ name: string; optional: boolean }>
  handler: { type: string; name?: string | null; module?: string | null; method?: string | null }
  middleware: MiddlewareEntry[]
  surface: { name: string | null; source: string | null }
}

interface BindingEntry {
  key: string
  kind: string | null
  aliasOf: string | null
  origin: string | null
  evidence: string[]
  declaredIn: Array<{ file: string }>
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

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
  }
  return toolPayload<Envelope<T>>(result)
}

interface CaptureProbe {
  status: {
    hooksLoaded: boolean
    subscribers: { logs: number; exceptions: number }
    containerObservation: boolean
  } | null
}

async function json<T>(response: Promise<Response>): Promise<T> {
  const resolved = await response
  return (await resolved.json()) as T
}

async function statusOf(response: Promise<Response>): Promise<number> {
  const resolved = await response
  return resolved.status
}

async function editFile(path: string, edit: (source: string) => string) {
  await writeFile(path, edit(await readFile(path, 'utf8')))
}

test.group('Observability | instrumented API starter kit', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  let envSecret: string

  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    await fixture.migrate()
    await installPackage(fixture)
    await instrumentCapture(fixture)

    envSecret = `sentinel-env-${randomBytes(8).toString('hex')}`
    await appendFile(join(fixture.root, '.env'), `FIXTURE_SENTINEL_SECRET=${envSecret}\n`)
    await editFile(join(fixture.root, 'start', 'env.ts'), (source) =>
      source.replace(/\}\)\s*$/, '  FIXTURE_SENTINEL_SECRET: Env.schema.string.optional(),\n})\n')
    )
    await writeFile(
      join(fixture.root, 'config', 'sentinel.ts'),
      `import env from '#start/env'

export default {
  payment: {
    webhookSecret: env.get('FIXTURE_SENTINEL_SECRET'),
    endpoint: 'https://merchant:${LITERAL_SECRET}@pay.example/hook',
    label: 'fixture-payments',
  },
  mirror: env.get('FIXTURE_SENTINEL_SECRET'),
  database: { password: '${LITERAL_SECRET}' },
}
`
    )
    await appendFile(join(fixture.root, 'start', 'routes.ts'), PROBE_ROUTES)
    await writeFile(join(fixture.root, 'start', 'events.ts'), EVENTS_PRELOAD)
    await mkdir(join(fixture.root, 'app', 'listeners'), { recursive: true })
    await writeFile(join(fixture.root, 'app', 'listeners', 'fixture_listener.ts'), LISTENER)
    await writeFile(
      join(fixture.root, 'providers', 'fixture_bindings_provider.ts'),
      BINDINGS_PROVIDER
    )
    await writeFile(join(fixture.root, 'providers', 'fixture_tools_provider.ts'), TOOLS_PROVIDER)
    await setExtensionProviders(fixture, ['fixture_bindings_provider', 'fixture_tools_provider'])
    await editFile(join(fixture.root, 'adonisrc.ts'), (source) =>
      source.replace(/preloads: \[/, "preloads: [\n    () => import('#start/events'),")
    )
    await editFile(join(fixture.root, 'start', 'kernel.ts'), (source) =>
      source.replace(
        /(auth: \(\) => import\('#middleware\/auth_middleware'\),)/,
        "$1\n  fixtureUnused: () => import('#middleware/container_bindings_middleware'),"
      )
    )
    await writeMcpConfig(fixture, '')
    app = await fixture.start({ nodeEnv: 'development' })
    return () => fixture.dispose()
  })

  test('concurrent requests appear as the right logs, exceptions and routes', async ({
    assert,
  }) => {
    await app.logs.waitFor((line) => line.text.includes('MCP endpoint ready'), 10_000)
    const ids = Array.from({ length: 12 }, (_, index) => String(index + 1))
    const failing = ['f1', 'f2', 'f3', 'f4']

    const [workResponses, failResponses, missing, toolCall] = await Promise.all([
      Promise.all(
        ids.map((id) =>
          app.fetch(`/__fixture/work/${id}`, { headers: { 'X-Request-Id': `work-${id}` } })
        )
      ),
      Promise.all(
        failing.map((id) =>
          app.fetch(`/__fixture/fail/${id}`, { headers: { 'X-Request-Id': `fail-${id}` } })
        )
      ),
      app.fetch('/__fixture/does-not-exist', { headers: { 'X-Request-Id': 'missing-1' } }),
      withClient(app, (client) =>
        call<{ callId: string }>(client, 'fixture_log', { marker: 'during-traffic' })
      ),
    ])
    assert.isTrue(workResponses.every((response) => response.status === 200))
    assert.isTrue(failResponses.every((response) => response.status === 500))
    assert.equal(missing.status, 404)

    await withClient(app, async (client) => {
      const all = await call<LogsData>(client, 'get_logs', { tail: 1000 })
      const probeEntries = all.data.entries.filter(
        (entry) => typeof entry.fields.probe === 'string'
      )
      for (const id of ids) {
        for (const probe of ['root', 'ctx', 'child']) {
          const captured = probeEntries.filter(
            (entry) => entry.fields.probe === probe && entry.fields.id === id
          )
          assert.lengthOf(captured, 1, `${probe} ${id} captured once`)
          const printed = app.logs.records.filter(
            (record) => record.probe === probe && record.id === id
          )
          assert.lengthOf(printed, 1, `${probe} ${id} printed once`)
        }
      }

      const request = await call<LogsData>(client, 'get_logs', { requestId: 'work-7' })
      assert.sameMembers(
        request.data.entries.map((entry) => entry.fields.probe),
        ['ctx', 'child'],
        'root logger records carry no request id'
      )
      assert.isTrue(request.data.entries.every((entry) => entry.callId === null))

      const tool = await call<LogsData>(client, 'get_logs', { callId: toolCall.data.callId })
      assert.deepEqual(
        tool.data.entries.map((entry) => entry.fields.marker),
        ['during-traffic'],
        'only the record written inside the call is attributed to it'
      )
      const traffic = probeEntries.filter((entry) => entry.fields.probe !== 'tool')
      assert.isTrue(traffic.every((entry) => entry.callId === null))

      const errors = await call<LogsData>(client, 'get_logs', {
        level: 'error',
        grep: 'FIXTURE FAILURE F3',
      })
      assert.isAtLeast(errors.data.entries.length, 1, 'the default report logs the failure')

      const exceptions = await call<ExceptionsData>(client, 'get_last_exceptions', { limit: 20 })
      const failures = exceptions.data.exceptions.filter((entry) =>
        entry.request?.id?.startsWith('fail-')
      )
      assert.sameMembers(
        failures.map((entry) => entry.request!.id),
        failing.map((id) => `fail-${id}`)
      )
      for (const entry of failures) {
        assert.deepInclude(entry, { status: 500, statusSource: 'response', name: 'Error' })
        assert.deepEqual(entry.request!.route, {
          pattern: '/__fixture/fail/:id',
          name: 'fixture.fail',
        })
        assert.match(entry.message, /^fixture failure f\d near \[REDACTED\]$/)
        assert.equal(entry.occurrences, failing.length)
        assert.isTrue(entry.stack.some((frame) => frame.includes('./start/routes.ts')))
      }
      const notFound = exceptions.data.exceptions.find((entry) => entry.request?.id === 'missing-1')
      assert.deepInclude(notFound, { status: 404, code: 'E_ROUTE_NOT_FOUND' })
      assert.isNull(notFound!.request!.route)

      const routes = await call<{ routes: RouteEntry[] }>(client, 'get_routes', {
        pattern: '/__fixture/fail',
      })
      assert.lengthOf(routes.data.routes, 1)
      assert.deepInclude(routes.data.routes[0], {
        pattern: '/__fixture/fail/:id',
        name: 'fixture.fail',
        domain: 'root',
      })
      assert.deepEqual(routes.data.routes[0].params, [
        { name: 'id', optional: false, wildcard: false },
      ])
      assert.equal(routes.data.routes[0].handler.type, 'closure')
    })
  })

  test('routes and middleware match the committed router', async ({ assert }) => {
    await withClient(app, async (client) => {
      const routes = await call<{ routes: RouteEntry[] }>(client, 'get_routes', {
        pattern: '/api/v1/account',
      })
      const profile = routes.data.routes.find(
        (route) => route.pattern === '/api/v1/account/profile'
      )!
      assert.deepEqual(profile.methods, ['GET', 'HEAD'])
      assert.equal(profile.name, 'profile.profile.show')
      assert.deepInclude(profile.handler, {
        type: 'controller',
        module: '#controllers/profile_controller',
        method: 'show',
      })
      assert.deepEqual(
        profile.middleware.map((entry) => [entry.type, entry.name ?? entry.module]),
        [
          ['global', '@adonisjs/core/bodyparser_middleware'],
          ['global', '@adonisjs/session/session_middleware'],
          ['global', '@adonisjs/shield/shield_middleware'],
          ['global', '@adonisjs/auth/initialize_auth_middleware'],
          ['global', '#middleware/silent_auth_middleware'],
          ['named', 'auth'],
        ]
      )
      assert.deepInclude(profile.surface, { name: 'api', source: 'inferred' })

      const home = await call<{ routes: RouteEntry[] }>(client, 'get_routes', {
        pattern: '/',
        method: 'get',
      })
      const root = home.data.routes.find((route) => route.pattern === '/')!
      assert.deepEqual(root.handler, { type: 'closure', name: null })
      assert.deepInclude(root.surface, { name: 'api', source: 'default' })

      const resource = resourcePayload<Envelope<{ routes: RouteEntry[] }>>(
        await client.readResource({ uri: 'adonis://routes' })
      )
      const all = await call<{ routes: RouteEntry[] }>(client, 'get_routes')
      assert.deepEqual(resource.data.routes, all.data.routes)

      const middleware = await call<{
        server: MiddlewareEntry[]
        router: MiddlewareEntry[] | null
        named: MiddlewareEntry[]
      }>(client, 'get_middleware')
      assert.deepEqual(
        middleware.data.server.map((entry) => entry.owner ?? entry.module),
        [
          '@rikology/adonisjs-mcp',
          '#middleware/force_json_response_middleware',
          '#middleware/container_bindings_middleware',
          '@adonisjs/cors/cors_middleware',
        ]
      )
      assert.deepEqual(
        middleware.data.router?.map((entry) => entry.module),
        [
          '@adonisjs/core/bodyparser_middleware',
          '@adonisjs/session/session_middleware',
          '@adonisjs/shield/shield_middleware',
          '@adonisjs/auth/initialize_auth_middleware',
          '#middleware/silent_auth_middleware',
        ]
      )
      assert.deepEqual(
        middleware.data.named.map((entry) => [
          entry.name,
          entry.module,
          entry.usedByRoutes,
          entry.source,
        ]),
        [
          ['auth', '#middleware/auth_middleware', 2, 'route stacks'],
          [
            'fixtureUnused',
            '#middleware/container_bindings_middleware',
            0,
            'preload export `middleware`',
          ],
        ]
      )
    })
  })

  test('container bindings are inventoried without constructing services', async ({ assert }) => {
    await withClient(app, async (client) => {
      const inventory = await call<{
        coverage: string
        bindings: BindingEntry[]
        declaredUnavailable: Array<{ key: string }>
        lanes: { sourceDeclared: { enabled: boolean }; runtimeObserved: { enabled: boolean } }
      }>(client, 'get_container_bindings')
      const byKey = (key: string) => inventory.data.bindings.find((entry) => entry.key === key)

      assert.equal(inventory.data.coverage, 'partial')
      assert.isTrue(inventory.data.lanes.sourceDeclared.enabled)
      assert.isTrue(inventory.data.lanes.runtimeObserved.enabled)

      assert.deepInclude(byKey('fixture.singleton'), {
        kind: 'singleton',
        origin: 'FixtureBindingsProvider',
      })
      assert.sameMembers(byKey('fixture.singleton')!.evidence, [
        'source-declared',
        'runtime-observed',
        'runtime-verified',
      ])
      assert.deepInclude(byKey('fixture.alias'), { kind: 'alias', aliasOf: 'fixture.singleton' })
      assert.deepInclude(byKey('fixture.bound'), {
        kind: 'bind',
        origin: 'FixtureBindingsProvider',
      })
      assert.notInclude(byKey('fixture.bound')!.evidence, 'source-declared')
      assert.deepInclude(byKey('fixture.declared'), { kind: 'bindValue', origin: null })
      assert.include(
        byKey('fixture.declared')!.declaredIn[0].file,
        'providers/fixture_bindings_provider.ts'
      )
      assert.deepInclude(byKey('lucid.db'), { origin: 'DatabaseServiceProvider' })
      assert.deepInclude(byKey('mcp.registry'), { kind: 'bindValue', origin: 'McpProvider' })
      assert.include(
        inventory.data.declaredUnavailable.map((entry) => entry.key),
        'fixture.declaredAbsent'
      )

      const filtered = await call<{ bindings: BindingEntry[] }>(client, 'get_container_bindings', {
        pattern: 'FIXTURE.S',
      })
      assert.deepEqual(
        filtered.data.bindings.map((entry) => entry.key),
        ['fixture.singleton']
      )
    })

    const constructions = await app.fetch('/__fixture/constructions')
    assert.deepEqual(await constructions.json(), { count: 0 })
  })

  test('events list persistent listeners without emitting', async ({ assert }) => {
    await withClient(app, async (client) => {
      const result = await call<{
        events: Array<{
          event: string
          listeners: Array<{
            type: string
            name: string | null
            module: string | null
            method: string | null
          }>
          transportListenerCount: number | null
        }>
        totalTransportListeners: number | null
      }>(client, 'get_events', { pattern: 'fixture:' })
      const byEvent = Object.fromEntries(result.data.events.map((entry) => [entry.event, entry]))
      assert.deepEqual(Object.keys(byEvent).sort(), ['fixture:inline', 'fixture:lazy'])
      assert.deepInclude(byEvent['fixture:inline'].listeners[0], {
        type: 'function',
        name: 'inlineListener',
      })
      assert.deepInclude(byEvent['fixture:lazy'].listeners[0], {
        type: 'lazy',
        module: '#listeners/fixture_listener',
        method: 'handle',
      })
      assert.equal(byEvent['fixture:lazy'].transportListenerCount, 1)
      assert.notInclude(app.logs.text(), 'fixture listener must never run')
    })
  })

  test('config and env are readable without exposing values', async ({ assert }) => {
    await withClient(app, async (client) => {
      const connection = await call<{ key: string; value: unknown }>(client, 'get_config', {
        key: 'database.connection',
      })
      assert.deepEqual(connection.data, { key: 'database.connection', value: 'sqlite' })

      const sentinel = await call<{ value: Record<string, unknown> }>(client, 'get_config', {
        key: 'sentinel',
      })
      assert.deepEqual(sentinel.data.value, {
        payment: {
          webhookSecret: '[REDACTED]',
          endpoint: 'https://merchant:[REDACTED]@pay.example/hook',
          label: 'fixture-payments',
        },
        mirror: '[REDACTED]',
        database: { password: '[REDACTED]' },
      })

      const invalid = await client.callTool({
        name: 'get_config',
        arguments: { key: 'app.__proto__' },
      })
      assert.isTrue(invalid.isError)
      assert.equal(toolPayload<{ error: { code: string } }>(invalid).error.code, 'INPUT_INVALID')
      const missing = await client.callTool({ name: 'get_config', arguments: { key: 'nope.key' } })
      assert.equal(toolPayload<{ error: { code: string } }>(missing).error.code, 'NOT_FOUND')

      const resource = resourcePayload<Envelope<{ value: unknown }>>(
        await client.readResource({ uri: 'adonis://config/sentinel' })
      )
      assert.deepEqual(resource.data.value, sentinel.data.value)
      await assert.rejects(() => client.readResource({ uri: 'adonis://config/nope' }))
      for (const uri of [
        'adonis://config/app.%5F%5Fproto%5F%5F',
        'adonis://config/app%2Econstructor',
        'adonis://config/..%2Fapp',
      ]) {
        const failure = await client.readResource({ uri }).then(
          () => null,
          (error: Error) => error.message
        )
        assert.match(failure ?? '', /INPUT_INVALID|not found/i, uri)
      }

      const env = await call<{
        file: string
        variables: Array<{
          key: string
          type: string | null
          optional: boolean
          secret: boolean
          present: boolean
        }>
      }>(client, 'get_env')
      const byKey = Object.fromEntries(env.data.variables.map((entry) => [entry.key, entry]))
      assert.equal(env.data.file, 'start/env.ts')
      assert.deepInclude(byKey.APP_KEY, { type: 'secret', secret: true, present: true })
      assert.deepInclude(byKey.DB_HOST, { type: 'string', optional: true, present: false })
      assert.deepInclude(byKey.FIXTURE_SENTINEL_SECRET, { secret: true, present: true })
      assert.notProperty(byKey.APP_KEY, 'value')

      const prefixed = await call<{ variables: Array<{ key: string }> }>(client, 'get_env', {
        prefix: 'DB_',
      })
      assert.isTrue(prefixed.data.variables.every((entry) => entry.key.startsWith('DB_')))
    })
  })

  test('no tool or resource returns a sentinel secret', async ({ assert }) => {
    const appKey = /^APP_KEY=(.*)$/m.exec(await readFile(join(fixture.root, '.env'), 'utf8'))![1]
    await app.fetch('/__fixture/work/sentinel', { headers: { 'X-Request-Id': 'sentinel-run' } })
    await app.fetch('/__fixture/fail/sentinel')

    for (const era of ['modern', 'legacy'] as const) {
      const outputs = await withClient(
        app,
        async (client) => {
          const texts: string[] = []
          const { tools } = await client.listTools()
          for (const name of [
            'get_project_profile',
            'get_logs',
            'get_last_exceptions',
            'get_routes',
            'get_middleware',
            'get_container_bindings',
            'get_events',
            'get_config',
            'get_env',
          ]) {
            assert.include(
              tools.map((tool) => tool.name),
              name,
              era
            )
            const result = await client.callTool({
              name,
              arguments: name === 'get_logs' ? { tail: 1000 } : {},
            })
            assert.notOk(result.isError, name)
            texts.push(JSON.stringify(result))
          }
          for (const uri of [
            'adonis://profile',
            'adonis://routes',
            'adonis://config/sentinel',
            'adonis://config/app',
          ]) {
            texts.push(JSON.stringify(await client.readResource({ uri })))
          }
          return texts
        },
        era
      )
      for (const text of outputs) {
        assert.notInclude(text, envSecret)
        assert.notInclude(text, LITERAL_SECRET)
        assert.notInclude(text, appKey)
      }
    }
    assert.include(app.logs.text(), envSecret, 'the application itself still logs the secret')
  })

  test('disabled config and test processes keep no capture state', async ({ assert }) => {
    const enabled = await json<CaptureProbe>(app.fetch('/__fixture/capture'))
    assert.deepInclude(enabled.status, {
      hooksLoaded: true,
      subscribers: { logs: 1, exceptions: 1 },
      containerObservation: true,
    })
    await app.stop()

    await writeMcpConfig(fixture, '  enabled: false,')
    try {
      const disabled = await fixture.start({ nodeEnv: 'development' })
      await disabled.fetch('/__fixture/work/1')
      const status = await json<CaptureProbe>(disabled.fetch('/__fixture/capture'))
      assert.deepInclude(status.status, {
        hooksLoaded: true,
        subscribers: { logs: 0, exceptions: 0 },
        containerObservation: false,
      })
      assert.equal(await statusOf(disabled.fetch(DEFAULT_PATH, { method: 'POST' })), 404)
      await disabled.stop()

      const testProcess = await fixture.start({ nodeEnv: 'test' })
      const inTest = await json<CaptureProbe>(testProcess.fetch('/__fixture/capture'))
      // The probe route itself imports the hooks module; nothing subscribes.
      assert.deepInclude(inTest.status, {
        subscribers: { logs: 0, exceptions: 0 },
        containerObservation: false,
      })
      await testProcess.stop()
    } finally {
      await writeMcpConfig(fixture, '')
    }
  })

  test('a pruned production deployment of the instrumented app boots and handles errors', async ({
    assert,
  }) => {
    const deployment = await fixture.buildProduction()
    const production = await deployment.start()
    assert.equal(await statusOf(production.fetch('/__fixture/work/1')), 200)
    assert.equal(await statusOf(production.fetch('/__fixture/fail/1')), 500)
    assert.deepEqual(await json<CaptureProbe>(production.fetch('/__fixture/capture')), {
      status: null,
    })
    assert.equal(await statusOf(production.fetch(DEFAULT_PATH, { method: 'POST' })), 404)
    const isWorkLog = (record: Record<string, unknown> | undefined) =>
      record?.probe === 'ctx' && record.id === '1'
    await production.logs.waitFor((line) => isWorkLog(line.record), 10_000)
    assert.lengthOf(production.logs.records.filter(isWorkLog), 1)
    assert.notInclude(production.logs.text(), 'ERR_MODULE_NOT_FOUND')
    await production.stop()
  })
})

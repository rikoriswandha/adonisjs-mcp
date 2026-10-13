/*
|--------------------------------------------------------------------------
| MCP endpoint in a running application (M2)
|--------------------------------------------------------------------------
|
| The packed package is installed into the API starter kit, which keeps
| its force-JSON middleware, bodyparser and Shield (with CSRF enabled).
| Official MCP clients of both protocol eras talk to the live endpoint;
| raw HTTP requests exercise the guards. Two extension providers register
| tools, a wrapper, a resource template and a prompt from `boot()`.
|
*/

import { networkInterfaces } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import { AppStartError, FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient, type ProtocolEra } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  INITIALIZE_BODY,
  MCP_HEADERS,
  addRegistryProbe,
  installPackage,
  rawRequest,
  rawSocketStatus,
  resourcePayload,
  setExtensionProviders,
  setMcpProviderEnvironments,
  toolPayload,
  writeMcpConfig,
  waitForMcp,
} from '../helpers/mcp_endpoint.js'
import type { CapabilityReport, ProjectProfile } from '../../src/types.js'

interface ProfilePayload {
  data: ProjectProfile & {
    capabilities: Record<'tools' | 'resources' | 'prompts', CapabilityReport[]>
  }
  evidence: string[]
  truncated: boolean
}

interface EchoPayload {
  data: { value: string; callId: string }
}

interface FailurePayload {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

const ERAS: ProtocolEra[] = ['modern', 'legacy']

const FIRST_PROVIDER = `import type { ApplicationService } from '@adonisjs/core/types'

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      return reject(signal.reason)
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

export default class FixtureMcpProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    if (!this.app.inDev || !this.app.container.hasBinding('mcp.registry')) {
      return
    }
    const registry = await this.app.container.make('mcp.registry')
    const { z } = await import('zod')
    const { ToolError } = await import('@rikology/adonisjs-mcp')
    const empty = z.object({})
    const description = 'Fixture tool via the running AdonisJS app'

    registry.disable('fixture_hidden_early')
    registry.tool({ name: 'fixture_hidden_early', description, inputSchema: empty, handler: () => ({ data: null }) })
    registry.tool({ name: 'fixture_hidden_late', description, inputSchema: empty, handler: () => ({ data: null }) })
    registry.tool({
      name: 'fixture_echo',
      description,
      inputSchema: z.object({ value: z.string(), delayMs: z.number().int().min(0).max(60000).default(0) }),
      annotations: { readOnlyHint: true },
      async handler(input, context) {
        try {
          await wait(input.delayMs, context.signal)
        } catch (error) {
          console.log(\`FIXTURE_ECHO_ABORTED \${input.value}\`)
          throw error
        }
        return { data: { value: input.value, callId: context.callId } }
      },
    })
    registry.tool({
      name: 'fixture_fail',
      description,
      inputSchema: empty,
      handler() {
        throw new Error(\`connection refused for key \${process.env.APP_KEY}\`)
      },
    })
    registry.tool({
      name: 'fixture_missing_dependency',
      description,
      inputSchema: empty,
      available: () => ({ available: false, code: 'DEPENDENCY_UNAVAILABLE', reason: 'fixture package is not installed' }),
      handler: () => ({ data: null }),
    })
    registry.tool({
      name: 'fixture_broken_integration',
      description,
      inputSchema: empty,
      available() {
        throw new Error('probe exploded')
      },
      handler: () => ({ data: null }),
    })
    registry.extend(async (call, next) => {
      console.log(\`FIXTURE_WRAPPER \${call.name} \${call.context.callId}\`)
      return next()
    })
    registry.resource({
      name: 'fixture_item',
      uri: 'fixture://items/{id}',
      read({ variables }) {
        if (variables.id === 'missing') {
          throw new ToolError('NOT_FOUND', 'no such item')
        }
        return { data: { id: variables.id } }
      },
    })
    registry.prompt({
      name: 'fixture_prompt',
      description: 'Asks about a topic of the fixture app',
      argsSchema: z.object({ topic: z.string() }),
      get: ({ topic }) => ({ messages: [{ role: 'user', text: \`Explain \${topic} in this app\` }] }),
    })
  }
}
`

const SECOND_PROVIDER = `import type { ApplicationService } from '@adonisjs/core/types'

export default class SecondMcpProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    if (!this.app.inDev || !this.app.container.hasBinding('mcp.registry')) {
      return
    }
    const registry = await this.app.container.make('mcp.registry')
    const { z } = await import('zod')
    registry.tool({
      name: 'second_provider_tool',
      description: 'Second fixture tool via the running AdonisJS app',
      inputSchema: z.object({}),
      handler: () => ({ data: 'second' }),
    })
  }
}
`

const BASE_CONFIG = `  tools: { disabled: ['fixture_hidden_late'] },`

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address
}

async function withClient<T>(
  app: RunningApp,
  era: ProtocolEra,
  run: (client: Client) => Promise<T>
) {
  const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

async function toolNames(app: RunningApp, era: ProtocolEra, path = DEFAULT_PATH) {
  const client = await connectMcpClient(new URL(path, app.url), { era })
  try {
    const { tools } = await client.listTools()
    return tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

test.group('Endpoint | API starter kit', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  let servedTools: string[] = []

  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    await fixture.migrate()
    await installPackage(fixture)
    await writeFile(join(fixture.root, 'providers', 'fixture_mcp_provider.ts'), FIRST_PROVIDER)
    await writeFile(join(fixture.root, 'providers', 'second_mcp_provider.ts'), SECOND_PROVIDER)
    await setExtensionProviders(fixture, ['fixture_mcp_provider', 'second_mcp_provider'])
    await addRegistryProbe(fixture)

    const shieldFile = join(fixture.root, 'config', 'shield.ts')
    const shield = await readFile(shieldFile, 'utf8')
    await writeFile(shieldFile, shield.replace(/(csrf: \{[\s\S]*?enabled: )false/, '$1true'))

    await writeMcpConfig(fixture, BASE_CONFIG)
    app = await fixture.start({ nodeEnv: 'development' })
    return () => fixture.dispose()
  })

  test('both protocol eras list tools and read the project profile', async ({ assert }) => {
    assert.include(app.logs.text(), 'MCP_PROBE web true')
    await app.logs.waitFor((line) => line.text.includes('MCP endpoint ready'), 10_000)

    for (const era of ERAS) {
      await withClient(app, era, async (client) => {
        const { tools } = await client.listTools()
        const names = tools.map((tool) => tool.name)
        assert.includeMembers(names, [
          'get_project_profile',
          'fixture_echo',
          'second_provider_tool',
        ])
        for (const hidden of [
          'fixture_hidden_early',
          'fixture_hidden_late',
          'fixture_missing_dependency',
          'fixture_broken_integration',
        ]) {
          assert.notInclude(names, hidden, era)
        }
        assert.deepEqual(names, names.toSorted(), 'tools are listed in name order')
        servedTools = names

        const profileTool = tools.find((tool) => tool.name === 'get_project_profile')!
        assert.deepInclude(profileTool.annotations, { readOnlyHint: true, destructiveHint: false })

        const called = await client.callTool({ name: 'get_project_profile', arguments: {} })
        assert.notOk(called.isError)
        const profile = toolPayload<ProfilePayload>(called)
        assert.equal(profile.data.kind, 'api', era)
        assert.isFalse(profile.truncated)

        const read = await client.readResource({ uri: 'adonis://profile' })
        const resource = resourcePayload<ProfilePayload>(read)
        assert.equal(resource.data.kind, profile.data.kind)
        assert.deepEqual(resource.data.packages, profile.data.packages)
        assert.deepEqual(resource.data.capabilities, profile.data.capabilities)
      })
    }
  })

  test('the profile reports active integrations with their evidence', async ({ assert }) => {
    const profile = await withClient(app, 'modern', async (client) =>
      toolPayload<ProfilePayload>(
        await client.callTool({ name: 'get_project_profile', arguments: {} })
      )
    )
    const { packages, surfaces, auth, generated } = profile.data

    for (const key of ['lucid', 'auth', 'session', 'shield', 'vine'] as const) {
      assert.isTrue(packages[key].active, key)
      assert.isString(packages[key].version, key)
      assert.equal(packages[key].declared, 'dependencies', key)
    }
    assert.isNull(packages.tuyau.active, 'Tuyau has no runtime signal')
    assert.isString(packages.tuyau.version)
    for (const key of ['inertia', 'tenant', 'queue', 'transmit', 'permissions'] as const) {
      assert.deepInclude(packages[key], { version: null, active: false }, key)
    }
    assert.deepEqual(auth, { guards: ['api', 'web'], default: 'api' })
    assert.isNull(surfaces.web)
    assert.equal(surfaces.api?.prefix, '/api')
    assert.equal(surfaces.default, 'api')
    assert.deepInclude(generated, { controllers: true, tuyauRegistry: true })
    assert.equal(profile.data.endpoint.path, DEFAULT_PATH)
    assert.isNull(profile.data.inertia)

    const tools = profile.data.capabilities.tools
    const byName = (name: string) => tools.find((entry) => entry.name === name)
    assert.deepEqual(byName('get_project_profile'), {
      name: 'get_project_profile',
      status: 'served',
    })
    assert.equal(byName('fixture_hidden_early')?.status, 'disabled')
    assert.equal(byName('fixture_hidden_late')?.status, 'disabled')
    assert.deepEqual(byName('fixture_missing_dependency'), {
      name: 'fixture_missing_dependency',
      status: 'unavailable',
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: 'fixture package is not installed',
    })
    assert.equal(byName('fixture_broken_integration')?.code, 'INTEGRATION_FAILED')
    assert.match(byName('fixture_broken_integration')!.reason!, /probe exploded/)
  })

  test('concurrent clients on both eras get only their own results', async ({ assert }) => {
    const clients = await Promise.all(
      [...ERAS, ...ERAS].map((era) => connectMcpClient(new URL(DEFAULT_PATH, app.url), { era }))
    )
    try {
      const results = await Promise.all(
        clients.map(async (client, index) => {
          const payload = toolPayload<EchoPayload>(
            await client.callTool({
              name: 'fixture_echo',
              arguments: { value: `client-${index}`, delayMs: 300 - index * 50 },
            })
          )
          return payload.data
        })
      )
      assert.deepEqual(
        results.map((result) => result.value),
        ['client-0', 'client-1', 'client-2', 'client-3']
      )
      assert.lengthOf(new Set(results.map((result) => result.callId)), 4)
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  })

  test('a client that disconnects mid-call cancels only its own call', async ({ assert }) => {
    const slow = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    const controller = new AbortController()
    try {
      const pending = slow.callTool(
        { name: 'fixture_echo', arguments: { value: 'slow-call', delayMs: 20_000 } },
        { signal: controller.signal }
      )
      const outcome = pending.then(
        () => 'resolved',
        () => 'rejected'
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      controller.abort()
      assert.equal(await outcome, 'rejected')
      await app.logs.waitFor((line) => line.text.includes('FIXTURE_ECHO_ABORTED slow-call'), 5000)

      for (const era of ERAS) {
        const payload = await withClient(app, era, async (client) =>
          toolPayload<EchoPayload>(
            await client.callTool({ name: 'fixture_echo', arguments: { value: `after-${era}` } })
          )
        )
        assert.equal(payload.data.value, `after-${era}`)
      }
    } finally {
      await slow.close()
    }
  })

  test('wrappers run once per call and failures are normalized and redacted', async ({
    assert,
  }) => {
    const appKey = /^APP_KEY=(.*)$/m.exec(await readFile(join(fixture.root, '.env'), 'utf8'))![1]

    for (const era of ERAS) {
      await withClient(app, era, async (client) => {
        const echo = toolPayload<EchoPayload>(
          await client.callTool({ name: 'fixture_echo', arguments: { value: era } })
        )
        const wrapped = app.logs.lines.filter((line) =>
          line.text.includes(`FIXTURE_WRAPPER fixture_echo ${echo.data.callId}`)
        )
        assert.lengthOf(wrapped, 1, era)

        const failed = await client.callTool({ name: 'fixture_fail', arguments: {} })
        assert.isTrue(failed.isError, era)
        const failure = toolPayload<FailurePayload>(failed)
        assert.equal(failure.error.code, 'EXECUTION_FAILED')
        assert.equal(failure.error.message, 'connection refused for key [REDACTED]')
        assert.notInclude(JSON.stringify(failed), appKey)

        const item = await client.readResource({ uri: 'fixture://items/42' })
        assert.deepEqual(resourcePayload<{ data: unknown }>(item).data, { id: '42' })
        await assert.rejects(() => client.readResource({ uri: 'fixture://items/missing' }))

        const prompt = await client.getPrompt({
          name: 'fixture_prompt',
          arguments: { topic: 'routes' },
        })
        assert.deepEqual(prompt.messages, [
          { role: 'user', content: { type: 'text', text: 'Explain routes in this app' } },
        ])
      })
    }
  })

  test('network guards reject hostile requests before the SDK', async ({ assert }) => {
    const url = new URL(DEFAULT_PATH, app.url).href
    const host = `127.0.0.1:${app.port}`
    const send = (headers: Record<string, string>, method = 'POST') =>
      rawRequest(url, { method, headers: { ...MCP_HEADERS, ...headers }, body: INITIALIZE_BODY })

    const accepted = await send({ Host: host })
    assert.equal(accepted.status, 200, 'control request with the same body is served')

    const forbidden: Array<[string, Record<string, string>]> = [
      ['foreign Host', { Host: `evil.example:${app.port}` }],
      ['rebinding Host', { Host: `localhost.evil.example:${app.port}` }],
      ['Host on another port', { Host: `localhost:${app.port + 1}` }],
      ['Host with userinfo', { Host: `user@localhost:${app.port}` }],
      ['null Origin', { Host: host, Origin: 'null' }],
      ['foreign Origin', { Host: host, Origin: 'http://evil.example' }],
      ['Origin on another port', { Host: host, Origin: `http://localhost:${app.port + 1}` }],
      [
        'Host overridden by forwarding headers',
        {
          'Host': `evil.example:${app.port}`,
          'X-Forwarded-Host': host,
          'Forwarded': `host=${host}`,
        },
      ],
      ['MCP tool recursion', { 'Host': host, 'x-adonisjs-mcp-call': '1' }],
    ]
    for (const [label, headers] of forbidden) {
      const response = await send(headers)
      assert.equal(response.status, 403, label)
      assert.equal(JSON.parse(response.body).error.code, -32000, label)
    }

    const allowedOrigin = await send({ Host: host, Origin: `http://localhost:${app.port}` })
    assert.equal(allowedOrigin.status, 200)

    const duplicateHost = await rawSocketStatus(
      app.port,
      `POST ${DEFAULT_PATH} HTTP/1.1\r\nHost: ${host}\r\nHost: evil.example\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream`,
      INITIALIZE_BODY
    )
    assert.equal(duplicateHost, 403)
    const missingHost = await rawSocketStatus(
      app.port,
      `POST ${DEFAULT_PATH} HTTP/1.0\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream`,
      INITIALIZE_BODY
    )
    assert.equal(missingHost, 403)

    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
      const response = await rawRequest(url, { method, headers: { Host: host } })
      assert.equal(response.status, 405, method)
      assert.equal(response.headers.allow, 'POST', method)
    }
  })

  test('body limits and protocol errors are answered without reaching tools', async ({
    assert,
  }) => {
    const url = new URL(DEFAULT_PATH, app.url).href
    const headers = { ...MCP_HEADERS, Host: `127.0.0.1:${app.port}` }

    const malformed = await rawRequest(url, {
      headers,
      body: '{"jsonrpc":"2.0","method":"initialize","params":{"token":"zzz-raw-body-sentinel"',
    })
    assert.equal(malformed.status, 400)
    assert.equal(JSON.parse(malformed.body).error.code, -32700)
    assert.notInclude(malformed.body, 'zzz-raw-body-sentinel')

    const oversized = await rawRequest(url, {
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { pad: 'x'.repeat(1024 * 1024) },
      }),
    })
    assert.equal(oversized.status, 413)

    const plainText = await rawRequest(url, {
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: INITIALIZE_BODY,
    })
    assert.equal(plainText.status, 415)

    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'raw-client', version: '0.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const protocolCases: Array<[string, Record<string, string>, unknown, number]> = [
      [
        'modern header without envelope',
        { 'mcp-protocol-version': '2026-07-28' },
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        -32602,
      ],
      [
        'unsupported revision',
        { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {
            _meta: { ...envelope, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
          },
        },
        -32022,
      ],
      [
        'header and envelope versions differ',
        { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: envelope } },
        -32020,
      ],
      [
        'header and body methods differ',
        { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' },
        { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: envelope } },
        -32020,
      ],
    ]
    for (const [label, extraHeaders, body, code] of protocolCases) {
      const response = await rawRequest(url, {
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, label)
      assert.equal(JSON.parse(response.body).error.code, code, label)
    }
  })

  test('the application keeps its CSRF protection', async ({ assert }) => {
    const response = await rawRequest(new URL('/api/v1/auth/login', app.url).href, {
      headers: { 'Host': `127.0.0.1:${app.port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'secret-password' }),
    })
    assert.oneOf(response.status, [302, 403])
    assert.isTrue(
      app.logs.lines.some((line) =>
        /E_BAD_CSRF_TOKEN|Invalid or expired CSRF token/.test(line.text)
      ) || /CSRF/i.test(response.body)
    )
  })

  test('binding to every interface does not expose the endpoint to the network', async ({
    assert,
  }) => {
    const address = lanAddress()!
    const exposed = await fixture.start({ nodeEnv: 'development', host: '0.0.0.0' })
    try {
      const url = `http://${address}:${exposed.port}${DEFAULT_PATH}`
      for (const host of [`${address}:${exposed.port}`, `localhost:${exposed.port}`]) {
        const response = await rawRequest(url, {
          headers: {
            ...MCP_HEADERS,
            'Host': host,
            'X-Forwarded-For': '127.0.0.1',
            'Forwarded': 'for=127.0.0.1',
            'X-Real-IP': '127.0.0.1',
          },
          body: INITIALIZE_BODY,
        })
        assert.equal(response.status, 403, host)
        assert.include(JSON.parse(response.body).error.message, 'peer address is not loopback')
      }
      const home = await rawRequest(`http://${address}:${exposed.port}/`, {
        method: 'GET',
        headers: { Host: `${address}:${exposed.port}` },
      })
      assert.equal(home.status, 200, 'the application itself stays reachable')
    } finally {
      await exposed.stop()
    }
  }).skip(lanAddress() === undefined, 'no non-loopback IPv4 interface on this machine')

  test('stopping the server closes in-flight MCP calls of both eras', async ({ assert }) => {
    const clients = await Promise.all(
      ERAS.map((era) => connectMcpClient(new URL(DEFAULT_PATH, app.url), { era }))
    )
    const outcomes = clients.map((client, index) =>
      client
        .callTool({
          name: 'fixture_echo',
          arguments: { value: `shutdown-${index}`, delayMs: 30_000 },
        })
        .then(
          () => 'resolved',
          () => 'rejected'
        )
    )
    await new Promise((resolve) => setTimeout(resolve, 500))

    const started = Date.now()
    await app.stop()
    const exit = await app.exited
    assert.isBelow(Date.now() - started, 10_000)
    assert.deepEqual(exit, { exitCode: 0, signal: null })
    assert.deepEqual(await Promise.all(outcomes), ['rejected', 'rejected'])
    await Promise.allSettled(clients.map((client) => client.close()))
  })

  test('provider registration order does not change the served tools', async ({ assert }) => {
    await setExtensionProviders(fixture, ['second_mcp_provider', 'fixture_mcp_provider'])
    const reordered = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(reordered)
    try {
      for (const era of ERAS) {
        assert.deepEqual(await toolNames(reordered, era), servedTools, era)
      }
    } finally {
      await reordered.stop()
      await setExtensionProviders(fixture, ['fixture_mcp_provider', 'second_mcp_provider'])
    }
  })

  test('a custom path serves the endpoint there only', async ({ assert }) => {
    await writeMcpConfig(fixture, `  path: '/__custom/mcp',\n${BASE_CONFIG}`)
    const custom = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(custom)
    try {
      assert.include(await toolNames(custom, 'legacy', '/__custom/mcp'), 'get_project_profile')
      const old = await custom.fetch(DEFAULT_PATH, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: INITIALIZE_BODY,
      })
      assert.equal(old.status, 404)
    } finally {
      await custom.stop()
      await writeMcpConfig(fixture, BASE_CONFIG)
    }
  })

  test('disabled config, test processes and console commands mount nothing', async ({ assert }) => {
    const endpointStatus = async (target: RunningApp) => {
      const response = await target.fetch(DEFAULT_PATH, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: INITIALIZE_BODY,
      })
      return response.status
    }

    await writeMcpConfig(fixture, `  enabled: false,\n${BASE_CONFIG}`)
    try {
      const disabled = await fixture.start({ nodeEnv: 'development' })
      assert.equal(await endpointStatus(disabled), 404)
      assert.include(disabled.logs.text(), 'MCP_PROBE web false')
      assert.notInclude(disabled.logs.text(), 'MCP endpoint ready')
      await disabled.stop()
    } finally {
      await writeMcpConfig(fixture, BASE_CONFIG)
    }

    const testing = await fixture.start({ nodeEnv: 'test' })
    assert.equal(await endpointStatus(testing), 404)
    assert.include(testing.logs.text(), 'MCP_PROBE web false')
    await testing.stop()

    await setMcpProviderEnvironments(fixture, ['web', 'console'])
    try {
      const listed = await fixture.ace(['list:routes'], 'development')
      assert.equal(listed.exitCode, 0, listed.stdout + listed.stderr)
      assert.include(listed.stdout, 'MCP_PROBE console false')
      assert.notInclude(listed.stdout, DEFAULT_PATH)
    } finally {
      await setMcpProviderEnvironments(fixture, ['web'])
    }
  })

  test('an application route on the MCP path keeps working and disables the endpoint', async ({
    assert,
  }) => {
    const routesFile = join(fixture.root, 'start', 'routes.ts')
    const routes = await readFile(routesFile, 'utf8')
    await writeFile(
      routesFile,
      `${routes}\nrouter.get('${DEFAULT_PATH}', () => ({ owner: 'application' }))\n`
    )
    try {
      const conflicted = await fixture.start({ nodeEnv: 'development' })
      const line = await conflicted.logs.waitFor(
        (entry) => entry.text.includes('MCP endpoint disabled'),
        10_000
      )
      assert.include(
        String(line.record?.msg),
        `"${DEFAULT_PATH}" is also an application route (GET, HEAD)`
      )
      const response = await conflicted.fetch(DEFAULT_PATH)
      assert.deepEqual(await response.json(), { owner: 'application' })
      await conflicted.stop()
    } finally {
      await writeFile(routesFile, routes)
    }
  })

  test('a duplicate tool name fails the boot', async ({ assert }) => {
    await writeFile(
      join(fixture.root, 'start', 'mcp_tools.ts'),
      `import { z } from 'zod'
import { defineTool } from '@rikology/adonisjs-mcp'

export default defineTool({
  name: 'fixture_echo',
  description: 'Duplicate via the running AdonisJS app',
  inputSchema: z.object({}),
  handler: () => ({ data: null }),
})
`
    )
    await writeMcpConfig(
      fixture,
      `${BASE_CONFIG}\n  extraTools: [() => import('#start/mcp_tools')],`
    )
    try {
      await fixture.start({ nodeEnv: 'development' })
      assert.fail('expected the boot to fail')
    } catch (error) {
      assert.instanceOf(error, AppStartError)
      assert.include((error as AppStartError).logs.text(), 'tool "fixture_echo"')
      assert.include((error as AppStartError).logs.text(), 'already registered')
    } finally {
      await writeMcpConfig(fixture, BASE_CONFIG)
    }
  })
})

test.group('Endpoint | API without Lucid, auth or views', (group) => {
  let fixture: FixtureApp

  group.setup(async () => {
    fixture = await FixtureApp.create('api-bare')
    await installPackage(fixture)
    return () => fixture.dispose()
  })

  test('the profile claims no optional integration that is absent', async ({ assert }) => {
    const app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const home = await app.fetch('/')
    assert.equal(home.status, 200)

    const profile = await withClient(app, 'legacy', async (client) =>
      toolPayload<ProfilePayload>(
        await client.callTool({ name: 'get_project_profile', arguments: {} })
      )
    )
    const { packages } = profile.data
    for (const [key, report] of Object.entries(packages)) {
      assert.isNull(report.version, key)
      assert.isFalse(report.active, key)
      assert.isNull(report.declared, key)
      assert.notProperty(report, 'error', key)
    }
    assert.equal(profile.data.kind, 'api')
    assert.isNull(profile.data.auth)
    assert.isNull(profile.data.inertia)
    assert.isNull(profile.data.surfaces.web)
    assert.deepEqual(profile.data.generated, {
      controllers: false,
      data: false,
      tuyauRegistry: false,
    })
    assert.deepEqual(profile.data.limitations, [])
    const statuses = Object.fromEntries(
      profile.data.capabilities.tools.map((entry) => [entry.name, entry.code ?? entry.status])
    )
    assert.deepEqual(statuses, {
      diff_schema: 'DEPENDENCY_UNAVAILABLE',
      execute_sql_query: 'DEPENDENCY_UNAVAILABLE',
      get_config: 'served',
      get_container_bindings: 'served',
      get_env: 'served',
      get_events: 'served',
      get_inertia_pages: 'DEPENDENCY_UNAVAILABLE',
      get_last_exceptions: 'CAPABILITY_UNSUPPORTED',
      get_logs: 'CAPABILITY_UNSUPPORTED',
      get_middleware: 'served',
      get_migrations: 'DEPENDENCY_UNAVAILABLE',
      get_models: 'DEPENDENCY_UNAVAILABLE',
      get_permissions: 'DEPENDENCY_UNAVAILABLE',
      get_project_profile: 'served',
      get_queue_jobs: 'DEPENDENCY_UNAVAILABLE',
      get_routes: 'served',
      get_shared_props: 'DEPENDENCY_UNAVAILABLE',
      get_source_location: 'served',
      get_transformers: 'served',
      get_tuyau_schema: 'DEPENDENCY_UNAVAILABLE',
      get_validators: 'DEPENDENCY_UNAVAILABLE',
      get_views: 'DEPENDENCY_UNAVAILABLE',
      http_request: 'served',
      project_eval: 'CAPABILITY_UNSUPPORTED',
      query_model: 'DEPENDENCY_UNAVAILABLE',
      render_view: 'DEPENDENCY_UNAVAILABLE',
      run_ace_command: 'served',
      search_package_docs: 'served',
    })
    const models = profile.data.capabilities.resources.find((entry) => entry.name === 'models')
    assert.deepInclude(models, { status: 'unavailable', code: 'DEPENDENCY_UNAVAILABLE' })
    const logs = profile.data.capabilities.tools.find((entry) => entry.name === 'get_logs')
    assert.include(logs!.reason, 'hooks: { streamWrite }')

    const plain = await withClient(app, 'modern', async (client) => {
      const result = await client.callTool({ name: 'http_request', arguments: { path: '/' } })
      return toolPayload<{
        data: { response: { status: number }; body: { json: unknown }; auth: unknown }
      }>(result)
    })
    assert.equal(plain.data.response.status, 200)
    assert.deepEqual(plain.data.body.json, { hello: 'world' })
    assert.isNull(plain.data.auth)
    const impersonation = await withClient(app, 'legacy', async (client) => {
      const result = await client.callTool({
        name: 'http_request',
        arguments: { path: '/', as: { userId: 1 } },
      })
      assert.isTrue(result.isError)
      return toolPayload<{ error: { code: string; message: string } }>(result).error
    })
    assert.equal(impersonation.code, 'DEPENDENCY_UNAVAILABLE')
    assert.include(impersonation.message, '@adonisjs/auth')

    const bindings = await withClient(app, 'modern', async (client) =>
      toolPayload<{
        data: {
          bindings: Array<{
            key: string
            kind: string | null
            origin: string | null
            evidence: string[]
          }>
          lanes: { runtimeObserved: { enabled: boolean } }
        }
      }>(await client.callTool({ name: 'get_container_bindings', arguments: {} }))
    )
    assert.isFalse(bindings.data.lanes.runtimeObserved.enabled)
    const router = bindings.data.bindings.find((entry) => entry.key === 'router')
    assert.deepInclude(router, { kind: null, origin: null })
    assert.deepEqual(router!.evidence, ['source-declared', 'runtime-verified'])
    assert.isUndefined(bindings.data.bindings.find((entry) => entry.key === 'lucid.db'))
  })
})

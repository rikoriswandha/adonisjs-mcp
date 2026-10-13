import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import type { CapabilityReport, LogPage, ProjectProfile } from '../../src/types.js'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  instrumentCapture,
  resourcePayload,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

interface PackageData {
  manifest: Record<string, unknown>
  rc: {
    providers: { specifier: string | null; environment: string[] }[]
    hooks: Record<string, number>
  }
}
interface Described extends ProjectProfile {
  capabilities: { tools: CapabilityReport[] }
}
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return toolPayload<{ data: T }>(result).data
}
async function resource<T>(client: Client, uri: string) {
  const result = await client.readResource({ uri })
  return resourcePayload<{ data: T }>(result).data
}

test.group('Resources and workflow prompts | real API app', (group) => {
  let fixture: FixtureApp
  let client: Client
  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    try {
      await installPackage(fixture)
      await writeMcpConfig(fixture, '')
      await instrumentCapture(fixture)
      const path = join(fixture.root, 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      manifest.scripts = {
        ...(manifest.scripts as Record<string, string>),
        secret_probe: 'API_TOKEN=script-sentinel-123456 npm run x',
        cli_probe: 'npm run x --authToken=flag-sentinel-555555 --password flag-sentinel-666666',
      }
      manifest.optionalDependencies = {
        'secret_probe': 'git+https://user:url-sentinel-654321@example.com/x.git',
        'username_probe': 'git+https://username-sentinel-333333@github.com/o/r.git',
        'query_probe': 'https://reg.example.com/p.tgz?token=query-sentinel-444444',
        'csrf-tokens': '^1.2.3',
      }
      manifest.unlistedSecret = 'not-allowlisted-sentinel'
      await writeFile(path, JSON.stringify(manifest, null, 2))
      await appendFile(
        join(fixture.root, 'start/routes.ts'),
        "\nrouter.get('/__fixture/prompt-fail', () => { throw new Error('prompt-fail') })\n"
      )
      const app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
      client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return async () => {
      await client.close()
      await fixture.dispose()
    }
  })
  test('package is default-deny, redacted and has runtime-aligned source imports', async ({
    assert,
  }) => {
    const data = await resource<PackageData>(client, 'adonis://package')
    const serialized = JSON.stringify(data)
    for (const sentinel of [
      'script-sentinel-123456',
      'url-sentinel-654321',
      'not-allowlisted-sentinel',
      'username-sentinel-333333',
      'query-sentinel-444444',
      'flag-sentinel-555555',
      'flag-sentinel-666666',
    ])
      assert.notInclude(serialized, sentinel)
    assert.include(serialized, '[REDACTED]')
    assert.equal(
      (data.manifest.optionalDependencies as Record<string, string>)['csrf-tokens'],
      '^1.2.3'
    )
    assert.isTrue(
      Object.keys(data.manifest).every((key) =>
        [
          'name',
          'version',
          'private',
          'type',
          'engines',
          'packageManager',
          'imports',
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies',
          'scripts',
        ].includes(key)
      )
    )
    assert.deepEqual(
      data.rc.providers.find((entry) => entry.specifier === '#providers/mcp_dev_provider')
        ?.environment,
      ['web']
    )
    assert.isTrue(Object.values(data.rc.hooks).every((count) => typeof count === 'number'))
    const path = join(fixture.root, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    manifest.version = '9.8.7'
    await writeFile(path, JSON.stringify(manifest))
    const fresh = await resource<PackageData>(client, 'adonis://package')
    assert.equal(fresh.manifest.version, '9.8.7')
  })
  test('resources share tool data in the same client session', async ({ assert }) => {
    for (const [uri, tool, args] of [
      ['adonis://profile', 'get_project_profile', {}],
      ['adonis://routes', 'get_routes', {}],
      ['adonis://models', 'get_models', {}],
      ['adonis://config/app', 'get_config', { key: 'app' }],
    ] as const)
      assert.deepEqual(await resource(client, uri), await call(client, tool, args))
  })
  test('prompts list and build without running requests or adding logs', async ({ assert }) => {
    const listed = await client.listPrompts()
    assert.includeMembers(
      listed.prompts.map((entry) => entry.name),
      ['debug_request', 'add_feature']
    )
    const profile = await call<Described>(client, 'get_project_profile')
    const before = await call<LogPage>(client, 'get_logs')
    const debug = await client.getPrompt({
      name: 'debug_request',
      arguments: { path: '/__fixture/prompt-fail' },
    })
    const feature = await client.getPrompt({
      name: 'add_feature',
      arguments: { feature: 'booking' },
    })
    const after = await call<LogPage>(client, 'get_logs')
    assert.deepEqual(after, before)
    for (const prompt of [debug, feature]) {
      const output = JSON.stringify(prompt.messages)
      assert.notInclude(output, 'not registered')
      for (const match of output.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        const tool = profile.capabilities.tools.find((entry) => entry.name === match[1])
        if (tool) assert.equal(tool.status, 'served', match[1])
      }
    }
    const featureText = JSON.stringify(feature.messages)
    for (const name of [
      '`get_inertia_pages`',
      '`get_shared_props`',
      '`get_transformers`',
      '`get_views`',
      '`render_view`',
    ])
      assert.notInclude(featureText, name)
    assert.include(JSON.stringify(debug.messages), '`http_request`')
  })
})

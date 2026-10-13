import { appendFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from '@japa/runner'
import { FixtureApp, type FixtureKit } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'
import type { CapabilityReport } from '../../src/types.js'

interface SchemaPayload {
  data: {
    status: 'missing' | 'stale' | 'fresh-routes'
    completeness: string
    hook: {
      declared: boolean
      changedSinceProcessStart: boolean
      calls: Array<{ options: { keys: string[]; completeness: string } }>
    }
    artifacts: Array<{
      file: string
      exists: boolean
      size: number | null
      mtime: string | null
      changedSinceProcessStart: boolean
    }>
    routes: Array<{
      name: string
      methods: string[]
      pattern: string
      evidence: string
      types?: {
        evidence: string
        typeOnly: boolean
        shapes: Record<string, string>
        truncated: boolean
      } | null
    }>
    freshness: {
      comparison: string
      typeShapesVerified: boolean
      missingFromRegistry: Array<{ name: string; domain: string }>
      notInRuntime: string[]
      changed: Array<{ name: string }>
    }
  }
  limitations: string[]
}

async function setup(kit: FixtureKit = 'api') {
  const fixture = await FixtureApp.create(kit)
  try {
    if (kit === 'api') {
      await appendFile(
        join(fixture.root, 'start/routes.ts'),
        `\nrouter.get('/__fixture/tuyau/:id', () => ({ ok: true })).as('fixture.tuyau')\nrouter.group(() => { router.post('/__fixture/domain', () => ({})).as('fixture.domain') }).domain('api.fixture.test')\n`
      )
      await fixture.migrate()
    }
    await installPackage(fixture)
    await writeMcpConfig(fixture, '')
    return fixture
  } catch (error) {
    await fixture.dispose()
    throw error
  }
}

test.group('Tuyau generated registry', () => {
  test('direct runner reports stale routes, generated types, literal filters and unknown options', async ({
    assert,
  }) => {
    const fixture = await setup()
    try {
      const app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), {
        era: 'modern',
      })
      try {
        const payload = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.equal(payload.data.status, 'stale')
        assert.equal(payload.data.completeness, 'complete')
        assert.isTrue(payload.data.hook.declared)
        assert.deepEqual(payload.data.hook.calls[0].options, { keys: [], completeness: 'complete' })
        assert.includeMembers(
          payload.data.freshness.missingFromRegistry.map((entry) => entry.name),
          ['fixture.tuyau', 'fixture.domain']
        )
        assert.equal(
          payload.data.freshness.missingFromRegistry.find(
            (entry) => entry.name === 'fixture.domain'
          )!.domain,
          'api.fixture.test'
        )
        assert.deepEqual(payload.data.freshness.changed, [])
        assert.deepEqual(payload.data.freshness.notInRuntime, [])
        const signup = payload.data.routes.find((route) => route.name === 'auth.new_account.store')!
        assert.deepEqual(signup.methods, ['POST'])
        assert.equal(signup.pattern, '/api/v1/auth/signup')
        assert.equal(signup.evidence, 'generated')
        assert.deepInclude(signup.types!, {
          evidence: 'generated',
          typeOnly: true,
          truncated: false,
        })
        assert.include(signup.types!.shapes.body, 'signupValidator')
        assert.include(signup.types!.shapes.response, 'new_account_controller')
        assert.isFalse(payload.data.freshness.typeShapesVerified)
        assert.isTrue(
          payload.data.artifacts.every(
            (artifact) => artifact.exists && artifact.size! > 0 && artifact.mtime !== null
          )
        )
        const filtered = toolPayload<SchemaPayload>(
          await client.callTool({
            name: 'get_tuyau_schema',
            arguments: { name: signup.name, includeTypes: false },
          })
        )
        assert.lengthOf(filtered.data.routes, 1)
        assert.notProperty(filtered.data.routes[0], 'types')
        const unknown = await client.callTool({
          name: 'get_tuyau_schema',
          arguments: { name: 'does.not.exist' },
        })
        assert.isTrue(unknown.isError)
        const failure = toolPayload<{ error: { code: string; message: string } }>(unknown)
        assert.equal(failure.error.code, 'NOT_FOUND')
        assert.include(failure.error.message, signup.name)
        const rcPath = join(fixture.root, 'adonisrc.ts')
        const rc = await readFile(rcPath, 'utf8')
        await writeFile(
          rcPath,
          `const fixtureOptions = {}\n${rc.replace('generateRegistry()', 'generateRegistry(fixtureOptions)')}`
        )
        const dynamic = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.equal(dynamic.data.freshness.comparison, 'filtered/unknown')
        assert.equal(dynamic.data.hook.calls[0].options.completeness, 'unknown')
        assert.isTrue(dynamic.data.hook.changedSinceProcessStart)
        await writeFile(
          rcPath,
          rc.replace('generateRegistry()', 'generateRegistry({ filters: [] })')
        )
        const options = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.deepEqual(options.data.hook.calls[0].options.keys, ['filters'])
        assert.equal(options.data.freshness.comparison, 'filtered/unknown')
        await writeFile(rcPath, rc)
        const indexPath = join(fixture.root, '.adonisjs/client/registry/index.ts')
        const index = await readFile(indexPath, 'utf8')
        await writeFile(
          indexPath,
          index
            .replace('/api/v1/auth/signup', '/__fixture/changed')
            .replaceAll('auth.access_tokens.store', 'fixture.removed')
        )
        const altered = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.deepEqual(
          altered.data.freshness.changed.map((entry) => entry.name),
          ['auth.new_account.store']
        )
        assert.deepEqual(altered.data.freshness.notInRuntime, ['fixture.removed'])
        assert.isTrue(
          altered.data.artifacts.find((artifact) => artifact.file.endsWith('/index.ts'))!
            .changedSinceProcessStart
        )
        await writeFile(indexPath, 'const routes = {} as const\nexport { routes }\n')
        const empty = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.equal(empty.data.status, 'stale')
        assert.equal(empty.data.completeness, 'complete')
        assert.deepEqual(empty.data.routes, [])
        await writeFile(rcPath, rc.replace('generateRegistry(),', ''))
        const noHook = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.equal(noHook.data.status, 'missing')
        assert.isFalse(noHook.data.hook.declared)
        assert.isTrue(noHook.data.artifacts.every((artifact) => artifact.exists))
      } finally {
        await client.close()
      }
    } finally {
      await fixture.dispose()
    }
  }).timeout(180_000)

  test('assembler hmr runner regenerates added routes and reports fresh-routes only', async ({
    assert,
  }) => {
    const fixture = await setup()
    try {
      const artifact = join(fixture.root, '.adonisjs/client/registry/index.ts')
      const before = await stat(artifact)
      const app = await fixture.start({ nodeEnv: 'development', runner: 'hmr' })
      await waitForMcp(app)
      const deadline = Date.now() + 20_000
      let current = await stat(artifact)
      while (current.mtimeMs <= before.mtimeMs && Date.now() < deadline) {
        await delay(100)
        current = await stat(artifact)
      }
      assert.isAbove(current.mtimeMs, before.mtimeMs)
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), {
        era: 'modern',
      })
      try {
        const payload = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.equal(payload.data.status, 'fresh-routes')
        assert.deepEqual(payload.data.freshness.missingFromRegistry, [])
        assert.deepEqual(payload.data.freshness.notInRuntime, [])
        assert.deepEqual(payload.data.freshness.changed, [])
        const added = payload.data.routes.find((route) => route.name === 'fixture.tuyau')!
        assert.equal(added.pattern, '/__fixture/tuyau/:id')
        assert.deepEqual(added.methods, ['GET', 'HEAD'])
        assert.isTrue(added.types!.typeOnly)
        assert.isFalse(payload.data.freshness.typeShapesVerified)
      } finally {
        await client.close()
      }
    } finally {
      await fixture.dispose()
    }
  }).timeout(180_000)

  test('absent generated artifacts are missing, not an empty registry', async ({ assert }) => {
    const fixture = await setup()
    try {
      await rm(join(fixture.root, '.adonisjs/client/registry'), { recursive: true })
      const app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), {
        era: 'modern',
      })
      try {
        const payload = toolPayload<SchemaPayload>(
          await client.callTool({ name: 'get_tuyau_schema', arguments: {} })
        )
        assert.equal(payload.data.status, 'missing')
        assert.isTrue(payload.data.hook.declared)
        assert.isTrue(
          payload.data.artifacts.every((artifact) => !artifact.exists && artifact.size === null)
        )
        assert.deepEqual(payload.data.routes, [])
      } finally {
        await client.close()
      }
    } finally {
      await fixture.dispose()
    }
  }).timeout(180_000)

  test('edge kit exposes dependency-unavailable capability without Tuyau', async ({ assert }) => {
    const fixture = await setup('edge')
    try {
      const app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), {
        era: 'modern',
      })
      try {
        const profile = toolPayload<{ data: { capabilities: { tools: CapabilityReport[] } } }>(
          await client.callTool({ name: 'get_project_profile', arguments: {} })
        )
        assert.deepInclude(
          profile.data.capabilities.tools.find((entry) => entry.name === 'get_tuyau_schema')!,
          { status: 'unavailable', code: 'DEPENDENCY_UNAVAILABLE' }
        )
        const tools = await client.listTools()
        assert.notInclude(
          tools.tools.map((tool) => tool.name),
          'get_tuyau_schema'
        )
      } finally {
        await client.close()
      }
    } finally {
      await fixture.dispose()
    }
  }).timeout(180_000)
})

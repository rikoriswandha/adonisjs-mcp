import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { FixtureApp } from '../tests/helpers/fixture_app.js'
import { packedPackage } from '../tests/helpers/package_tarball.js'
import { connectMcpClient } from '../tests/helpers/mcp_client.js'
import { resourcePayload, toolPayload, waitForMcp } from '../tests/helpers/mcp_endpoint.js'
import { runChecked } from '../tests/helpers/process.js'

const tarball = process.env.ADONISJS_MCP_TARBALL
  ? resolve(process.env.ADONISJS_MCP_TARBALL)
  : await packedPackage()
console.log(`Verified artifact: ${tarball}`)
const fixture = await FixtureApp.create('api')
try {
  const overrides = process.env.ADONISJS_MCP_FIXTURE_OVERRIDES?.split(/\s+/).filter(Boolean)
  if (overrides?.length) await fixture.npm(['install', '--save-exact', ...overrides])
  await fixture.npm(['install', '--save-dev', tarball])
  await fixture.migrate()
  const configure = ['configure', '@rikology/adonisjs-mcp', '--instrument', '--vm-modules']
  const first = await fixture.ace(configure, 'development')
  assert.equal(first.exitCode, 0, first.stdout + first.stderr)
  const hashes = async () => {
    const pending = ['']
    const snapshot: Record<string, string> = {}
    while (pending.length) {
      const directory = pending.pop()!
      const entries = await readdir(join(fixture.root, directory), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) pending.push(path)
        else if (entry.isFile()) {
          snapshot[path] = createHash('sha256')
            .update(await readFile(join(fixture.root, path)))
            .digest('hex')
        }
      }
    }
    return snapshot
  }
  const before = await hashes()
  const second = await fixture.ace(configure, 'development')
  assert.equal(second.exitCode, 0, second.stdout + second.stderr)
  assert.deepEqual(await hashes(), before, 'configure rerun changed application files')
  const manifest = JSON.parse(await readFile(join(fixture.root, 'package.json'), 'utf8')) as {
    scripts: { dev: string }
    dependencies: Record<string, string>
  }
  console.log(`Fixture dependencies: ${JSON.stringify(manifest.dependencies)}`)
  const nodeOptions = manifest.scripts.dev.match(/^NODE_OPTIONS=([^ ]+)/)?.[1]
  assert.equal(nodeOptions, '--experimental-vm-modules')
  const app = await fixture.start({ nodeEnv: 'development', runner: 'hmr', nodeOptions })
  try {
    await waitForMcp(app)
    const client = await connectMcpClient(new URL('/__adonis/mcp', app.url), { era: 'modern' })
    try {
      const tools = await client.listTools()
      assert.ok(tools.tools.some((tool) => tool.name === 'get_routes'))
      for (const name of ['get_project_profile', 'get_routes', 'get_migrations']) {
        const result = await client.callTool({ name, arguments: {} })
        assert.ok(!result.isError, JSON.stringify(toolPayload(result)))
        const payload = toolPayload<{
          data: { kind?: string; routes?: { pattern: string }[]; summary?: { migrated: number } }
        }>(result)
        if (name === 'get_project_profile') assert.equal(payload.data.kind, 'api')
        if (name === 'get_routes')
          assert.ok(payload.data.routes?.some((route) => route.pattern === '/'))
        if (name === 'get_migrations') assert.ok((payload.data.summary?.migrated ?? 0) > 0)
      }
      const profile = resourcePayload<{ data: { kind: string } }>(
        await client.readResource({ uri: 'adonis://profile' })
      )
      assert.equal(profile.data.kind, 'api')
    } finally {
      await client.close()
    }
  } finally {
    await app.stop()
  }
  const deployment = await fixture.buildProduction()
  await runChecked(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict'; for (const name of ['@rikology/adonisjs-mcp', 'zod']) assert.throws(() => import.meta.resolve(name), { code: 'ERR_MODULE_NOT_FOUND' })`,
    ],
    { cwd: deployment.root, env: fixture.environment('production') }
  )
  const production = await deployment.start()
  try {
    const home = await production.fetch('/')
    const endpoint = await production.fetch('/__adonis/mcp', { method: 'POST' })
    assert.equal(home.status, 200)
    assert.equal(endpoint.status, 404)
  } finally {
    await production.stop()
  }
  for (const command of [['list'], ['migration:status']]) {
    const result = await deployment.ace(command)
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
  }
  console.log(
    'smoke:pack ok: configure hashes unchanged; live tools/resource; standalone production HTTP/Ace; MCP and zod absent'
  )
} finally {
  await fixture.dispose()
}

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { FixtureApp } from '../tests/helpers/fixture_app.js'
import { connectMcpClient } from '../tests/helpers/mcp_client.js'
import { resourcePayload, toolPayload, waitForMcp } from '../tests/helpers/mcp_endpoint.js'
import { runChecked } from '../tests/helpers/process.js'

const packageName = '@rikology/adonisjs-mcp'
const args = process.argv.slice(2)
const local = args[0] === '--tarball'
assert.ok(
  args.length === (local ? 2 : 1) && args[local ? 1 : 0],
  'Usage: smoke:published -- <version> | --tarball <path>'
)
const version = local ? undefined : args[0]
assert.ok(local || /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version!), 'Expected an exact version')
const specifier = local ? resolve(args[1]) : `${packageName}@${version}`
const fixture = await FixtureApp.create('api')
try {
  let registryIntegrity: string | undefined
  if (!local) {
    // Registry propagation is bounded to six attempts, not an indefinite retry.
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const result = await fixture.npm(['view', specifier, 'dist', '--json'])
        const dist = JSON.parse(result.stdout) as {
          integrity?: string
          attestations?: { url?: string; provenance?: { predicateType?: string } }
        }
        assert.ok(dist.integrity, 'Registry metadata is missing dist.integrity')
        assert.ok(
          dist.attestations?.url && dist.attestations.provenance?.predicateType,
          'Registry metadata is missing a provenance attestation'
        )
        registryIntegrity = dist.integrity
        break
      } catch (error) {
        if (attempt === 6) throw error
        console.log(`Registry/provenance not ready (${attempt}/6); retrying in 10 seconds`)
        await delay(10_000)
      }
    }
  }
  await fixture.npm(['install', '--save-dev', '--save-exact', specifier])
  const lock = JSON.parse(await readFile(join(fixture.root, 'package-lock.json'), 'utf8')) as {
    packages: Record<
      string,
      { version?: string; integrity?: string; devDependencies?: Record<string, string> }
    >
  }
  const installed = lock.packages[`node_modules/${packageName}`]
  assert.ok(installed, 'Package is not present in consumer lockfile')
  assert.ok(lock.packages[''].devDependencies?.[packageName], 'Package must be a devDependency')
  if (!local) {
    assert.equal(installed.version, version)
    assert.equal(
      installed.integrity,
      registryIntegrity,
      'Installed integrity differs from registry'
    )
    // Verifies signatures and attestations against the installed dependency tree.
    const signatures = await fixture.npm(['audit', 'signatures'])
    console.log(signatures.stdout.trim())
  }
  const manifest = JSON.parse(
    await readFile(join(fixture.root, 'node_modules', packageName, 'package.json'), 'utf8')
  ) as { version: string; exports: Record<string, unknown> }
  const exports = Object.keys(manifest.exports).map((entry) =>
    entry === '.' ? packageName : `${packageName}${entry.slice(1)}`
  )
  await runChecked(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `for (const name of ${JSON.stringify(exports)}) { import.meta.resolve(name); await import(name) }`,
    ],
    { cwd: fixture.root, env: fixture.environment('development') }
  )
  const configured = await fixture.ace(
    ['configure', packageName, '--instrument', '--vm-modules'],
    'development'
  )
  assert.equal(configured.exitCode, 0, `${configured.stdout}\n${configured.stderr}`)
  const app = await fixture.start({
    nodeEnv: 'development',
    nodeOptions: '--experimental-vm-modules',
  })
  await waitForMcp(app)
  for (const era of ['modern', 'legacy'] as const) {
    const client = await connectMcpClient(new URL('/__adonis/mcp', app.url), { era })
    try {
      const profileResult = await client.callTool({ name: 'get_project_profile', arguments: {} })
      assert.notEqual(profileResult.isError, true)
      const profile = toolPayload<{ data: unknown }>(profileResult)
      assert.ok(profile.data)
      const routesResult = await client.callTool({ name: 'get_routes', arguments: {} })
      assert.notEqual(routesResult.isError, true)
      const routes = toolPayload<{ data: { routes: { pattern: string }[] } }>(routesResult)
      assert.ok(routes.data.routes.some((route) => route.pattern === '/__fixture/environment'))
      const resource = resourcePayload<{ data: unknown }>(
        await client.readResource({ uri: 'adonis://profile' })
      )
      assert.deepEqual(resource.data, profile.data)
      console.log(`PASS ${era}: get_project_profile, get_routes, adonis://profile`)
    } finally {
      await client.close()
    }
  }
  console.log(
    `PASS ${packageName}@${manifest.version}: ${exports.length} exports, configure, fresh API consumer (${local ? 'local tarball; registry/provenance not exercised' : 'registry integrity and provenance verified'})`
  )
} finally {
  await fixture.dispose()
}

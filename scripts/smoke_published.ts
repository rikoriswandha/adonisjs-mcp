import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { FixtureApp } from '../tests/helpers/fixture_app.js'
import { connectMcpClient } from '../tests/helpers/mcp_client.js'
import { resourcePayload, toolPayload, waitForMcp } from '../tests/helpers/mcp_endpoint.js'
import { isolatedEnvironment, runChecked } from '../tests/helpers/process.js'

const packageName = '@rikology/adonisjs-mcp'
const args = process.argv.slice(2)
const local = args[0] === '--tarball'
const usage =
  'Usage: smoke:published -- <version> --expected-sha512 <file> | --tarball <path> [--expected-sha512 <file>]'
if (args[0] === '--help') {
  console.log(usage)
  process.exit(0)
}
assert.ok(
  (local && (args.length === 2 || args.length === 4)) || (!local && args.length === 3),
  usage
)
const checksumIndex = local ? 2 : 1
assert.ok(
  (local && args.length === 2) ||
    (args[checksumIndex] === '--expected-sha512' && args[checksumIndex + 1]),
  usage
)
const checksumPath = args[checksumIndex + 1]
const checksumContents = checksumPath ? await readFile(resolve(checksumPath), 'utf8') : undefined
const expectedSha512 = checksumContents?.trim()
assert.ok(
  !checksumPath || (expectedSha512 && /^[a-f0-9]{128}$/.test(expectedSha512)),
  'Invalid SHA-512 file'
)
const version = local ? undefined : args[0]
assert.ok(local || /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version!), 'Expected an exact version')
const specifier = local ? resolve(args[1]) : `${packageName}@${version}`
const downloadRoot = await mkdtemp(join(tmpdir(), 'adonisjs-mcp-published-'))
let fixture: FixtureApp | undefined
try {
  let tarball = local ? specifier : undefined
  if (!local) {
    // npm processes a fresh publish for minutes before serving it (0.1.0 took several);
    // retry for up to 30 minutes, never indefinitely.
    for (let attempt = 1; attempt <= 60; attempt++) {
      try {
        const result = await runChecked('npm', ['view', specifier, 'dist', '--json'], {
          cwd: downloadRoot,
          env: isolatedEnvironment({ npm_config_prefer_online: 'true' }),
        })
        const dist = JSON.parse(result.stdout) as {
          integrity?: string
          attestations?: { url?: string; provenance?: { predicateType?: string } }
        }
        assert.ok(dist.integrity, 'Registry metadata is missing dist.integrity')
        assert.ok(
          dist.attestations?.url && dist.attestations.provenance?.predicateType,
          'Registry metadata is missing a provenance attestation'
        )
        const packed = await runChecked(
          'npm',
          ['pack', specifier, '--json', '--pack-destination', downloadRoot],
          { cwd: downloadRoot, env: isolatedEnvironment({ npm_config_prefer_online: 'true' }) }
        )
        const files = JSON.parse(packed.stdout) as { filename: string }[]
        assert.equal(files.length, 1, 'Expected exactly one published tarball')
        tarball = join(downloadRoot, files[0].filename)
        break
      } catch (error) {
        if (attempt === 60) throw error
        console.log(`Registry/provenance not ready (${attempt}/60); retrying in 30 seconds`)
        await delay(30_000)
      }
    }
  }
  assert.ok(tarball, 'No tarball was downloaded')
  if (expectedSha512) {
    const actualSha512 = createHash('sha512')
      .update(await readFile(tarball))
      .digest('hex')
    assert.equal(actualSha512, expectedSha512, 'Published tarball differs from verified artifact')
    console.log('PASS tarball SHA-512 matches verified artifact')
  }
  fixture = await FixtureApp.create('api')
  await fixture.npm(['install', '--save-dev', '--save-exact', local ? tarball : specifier])
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
    `PASS ${packageName}@${manifest.version}: ${exports.length} exports, configure, fresh API consumer (${local ? 'local tarball; registry/provenance not exercised' : 'verified artifact SHA-512 and provenance checked'})`
  )
} finally {
  await fixture?.dispose()
  await rm(downloadRoot, { recursive: true, force: true })
}

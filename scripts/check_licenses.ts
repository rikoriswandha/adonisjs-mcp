import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecked, isolatedEnvironment } from '../tests/helpers/process.js'
import { packedPackage } from '../tests/helpers/package_tarball.js'

interface Manifest {
  name: string
  version: string
  license?: string
  dependencies?: Record<string, string>
}
const root = fileURLToPath(new URL('../', import.meta.url))
const allowed: Record<string, true> = {
  'MIT': true,
  'ISC': true,
  'BSD-2-Clause': true,
  'BSD-3-Clause': true,
  'Apache-2.0': true,
  '0BSD': true,
  'BlueOak-1.0.0': true,
  // nearley's railroad-diagrams uses the CC0 public-domain dedication.
  'CC0-1.0': true,
}
const inventory = new Map<string, Manifest>()
const pending = [join(root, 'package.json')]
const visited = new Set<string>()
while (pending.length) {
  const path = pending.pop()!
  if (visited.has(path)) continue
  visited.add(path)
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
  if (path !== join(root, 'package.json')) {
    assert.ok(
      manifest.license && Object.hasOwn(allowed, manifest.license),
      `${manifest.name}@${manifest.version}: unapproved license ${manifest.license ?? '(missing)'}`
    )
    inventory.set(`${manifest.name}@${manifest.version}`, manifest)
  }
  const require = createRequire(path)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    let directory = dirname(require.resolve(name))
    for (;;) {
      try {
        const candidate = JSON.parse(
          await readFile(join(directory, 'package.json'), 'utf8')
        ) as Manifest
        if (candidate.name === name) {
          pending.push(join(directory, 'package.json'))
          break
        }
      } catch {}
      const parent = dirname(directory)
      assert.notEqual(parent, directory, `Cannot locate manifest for ${name}`)
      directory = parent
    }
  }
}
console.table(
  [...inventory.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, version, license }) => ({ name, version, license }))
)
const artifact = process.env.ADONISJS_MCP_TARBALL
  ? resolve(process.env.ADONISJS_MCP_TARBALL)
  : await packedPackage()
const listing = await runChecked('tar', ['-tzf', artifact], {
  cwd: root,
  env: isolatedEnvironment(),
})
const files = listing.stdout
  .trim()
  .split('\n')
  .filter((path) => !path.endsWith('/'))
  .map((path) => path.replace(/^package\//, ''))
for (const path of files) {
  assert.ok(
    path.startsWith('build/') ||
      path === 'skills/adonisjs-mcp/SKILL.md' ||
      ['package.json', 'README.md', 'LICENSE.md', 'CHANGELOG.md'].includes(path),
    `Unexpected tarball path: ${path}`
  )
  assert.ok(
    !/(^|\/)(tests?|fixtures?|spikes|coverage|logs?|tmp|node_modules|\.env(?:\.[^/]*)?)(\/|$)|^build\/(bin|scripts|docs)\/|\.(?:log|sqlite3?|db)(?:-(?:wal|shm))?$/.test(
      path
    ),
    `Forbidden tarball path: ${path}`
  )
  assert.ok(
    !path.endsWith('.ts') || path.endsWith('.d.ts'),
    `Source TypeScript in tarball: ${path}`
  )
}
console.log(
  `check:licenses ok: ${inventory.size} runtime dependencies; ${files.length} allowed tarball files; artifact ${artifact}`
)

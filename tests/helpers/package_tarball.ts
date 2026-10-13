import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureRoot, repositoryRoot } from './fixture_root.js'
import { isolatedEnvironment, runChecked } from './process.js'

let packed: Promise<string> | undefined

/**
 * Packs the built package once per test process and returns the tarball
 * path. Requires `npm run build` (done by `npm run test:integration`).
 */
export function packedPackage(): Promise<string> {
  packed ??= (async () => {
    if (!existsSync(join(repositoryRoot, 'build', 'index.js'))) {
      throw new Error('build/ is missing; run `npm run build` before integration tests')
    }
    const destination = await mkdtemp(join(fixtureRoot(), 'pack-'))
    process.once('exit', () => rmSync(destination, { recursive: true, force: true }))
    const result = await runChecked(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
      { cwd: repositoryRoot, env: isolatedEnvironment() }
    )
    const [{ filename }] = JSON.parse(result.stdout) as [{ filename: string }]
    return join(destination, filename)
  })()
  return packed
}

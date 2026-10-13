import { mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedEnvironment, runChecked } from './process.js'

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Directory holding disposable fixture apps, installed templates and
 * PostgreSQL clusters.
 *
 * It must live outside the repository: Node resolves packages through
 * ancestor `node_modules`, so a fixture nested in the repository would see
 * this package's development dependencies and hide missing-package
 * failures (observed in spike S-B).
 */
export function fixtureRoot(): string {
  const root = process.env.ADONISJS_MCP_FIXTURE_ROOT ?? join(tmpdir(), 'adonisjs-mcp-fixtures')
  mkdirSync(root, { recursive: true })
  const resolved = realpathSync(root)
  const fromRepository = relative(realpathSync(repositoryRoot), resolved)
  if (!fromRepository.startsWith('..') && !isAbsolute(fromRepository)) {
    throw new Error(`Fixture root ${resolved} must be outside the repository ${repositoryRoot}`)
  }
  return resolved
}

/**
 * Asks the OS for a free loopback TCP port.
 */
export async function freePort(): Promise<number> {
  const server = createServer()
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise

  const address = server.address()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise

  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine a free port')
  }
  return address.port
}

/**
 * Copies a directory tree, using copy-on-write clones where the file
 * system supports them so `node_modules` copies stay cheap.
 */
export async function copyTree(source: string, destination: string) {
  const options = { cwd: fixtureRoot(), env: isolatedEnvironment() }
  const cloneArgs =
    process.platform === 'darwin'
      ? ['-cR', source, destination]
      : ['-R', '--reflink=auto', source, destination]
  try {
    await runChecked('cp', cloneArgs, options)
  } catch {
    await runChecked('rm', ['-rf', destination], options)
    await runChecked('cp', ['-R', source, destination], options)
  }
}

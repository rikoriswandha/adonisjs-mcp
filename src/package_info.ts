import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = '@rikology/adonisjs-mcp'

interface PackageManifest {
  root: string
  version: string
}

let manifest: Promise<PackageManifest | undefined> | undefined

/**
 * Root directory and version of this package, read from its own
 * `package.json`. Works from source and from bundled build output, whose
 * depth differs.
 */
function ownManifest(): Promise<PackageManifest | undefined> {
  manifest ??= (async () => {
    let directory = dirname(fileURLToPath(import.meta.url))
    while (true) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'name' in parsed &&
          parsed.name === PACKAGE_NAME &&
          'version' in parsed &&
          typeof parsed.version === 'string'
        ) {
          return { root: directory, version: parsed.version }
        }
      } catch {
        // No readable manifest here; keep walking up.
      }
      const parent = dirname(directory)
      if (parent === directory) {
        return undefined
      }
      directory = parent
    }
  })()
  return manifest
}

export async function packageVersion(): Promise<string> {
  const own = await ownManifest()
  return own?.version ?? '0.0.0'
}

/**
 * Root directory of this package, where `build/` lives once installed.
 */
export async function packageRoot(): Promise<string | undefined> {
  const own = await ownManifest()
  return own?.root
}

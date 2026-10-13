import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = '@rikology/adonisjs-mcp'

/**
 * Version of this package, read from its own `package.json`. Works from
 * source and from bundled build output, whose depth differs.
 */
export async function packageVersion(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url))
  while (true) {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (
        typeof manifest === 'object' &&
        manifest !== null &&
        'name' in manifest &&
        manifest.name === PACKAGE_NAME &&
        'version' in manifest &&
        typeof manifest.version === 'string'
      ) {
        return manifest.version
      }
    } catch {
      // No readable manifest here; keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return '0.0.0'
    }
    directory = parent
  }
}

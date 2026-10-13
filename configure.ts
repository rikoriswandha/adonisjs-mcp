/*
|--------------------------------------------------------------------------
| Configure hook
|--------------------------------------------------------------------------
|
| Runs on `node ace configure @rikology/adonisjs-mcp`. The package is a
| development dependency, so nothing loaded in production may import it:
|
| - `config/mcp.ts` imports the config type only.
| - `providers/mcp_dev_provider.ts` imports the package provider only
|   when `app.inDev` is true.
| - `adonisrc.ts` references the app-local wrapper for the `web` process.
|
| Every step is idempotent: existing files are kept and the provider is
| added once.
|
*/

import { readFile } from 'node:fs/promises'
import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.js'

const PROVIDER_ALIAS = '#providers/*'
const WRAPPER_PROVIDER = '#providers/mcp_dev_provider'

export async function configure(command: Configure) {
  const manifest: unknown = JSON.parse(await readFile(command.app.makePath('package.json'), 'utf8'))
  const hasProviderAlias =
    typeof manifest === 'object' &&
    manifest !== null &&
    'imports' in manifest &&
    typeof manifest.imports === 'object' &&
    manifest.imports !== null &&
    PROVIDER_ALIAS in manifest.imports

  if (!hasProviderAlias) {
    throw new Error(
      `Cannot configure @rikology/adonisjs-mcp: package.json "imports" has no "${PROVIDER_ALIAS}" alias. Add "${PROVIDER_ALIAS}": "./providers/*.js" and run the command again.`
    )
  }

  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/mcp.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'providers/mcp_dev_provider.stub', {})
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider(WRAPPER_PROVIDER, ['web'])
  })
}

/*
|--------------------------------------------------------------------------
| Package installed from its tarball into a real application
|--------------------------------------------------------------------------
|
| M1 exit gate: the packed artifact installs as a devDependency, configure
| writes the production-safe surface (D21/D22), development loads the
| package provider, and a pruned production deployment boots without the
| package or zod.
|
*/

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { AppStartError, FixtureApp } from '../helpers/fixture_app.js'
import { packedPackage } from '../helpers/package_tarball.js'

const APP_TOOLS_MODULE = `import { z } from 'zod'
import { defineTool } from '@rikology/adonisjs-mcp'

export default [
  defineTool({
    name: 'fixture_app_state',
    description: 'Reports fixture state via the running AdonisJS app',
    inputSchema: z.object({ limit: z.number().int().positive().default(10) }),
    annotations: { readOnlyHint: true },
    handler(input, context) {
      const limit: number = input.limit
      return { data: { limit, inDev: context.app.inDev }, evidence: ['runtime'] }
    },
  }),
]
`

function mcpConfig(overrides: string) {
  return `import type { McpConfig } from '@rikology/adonisjs-mcp'

const mcpConfig = {
  enabled: true,
  path: '/__custom/mcp',
  allowRemoteAccess: false,
  tools: {
    disabled: ['project_eval'],
    docs: { include: ['@adonisjs/*', '@rikology/*'] },
    ${overrides}
  },
  extraTools: [() => import('#start/mcp_tools')],
} satisfies McpConfig

export default mcpConfig
`
}

test.group('Package | installed from tarball', (group) => {
  let fixture: FixtureApp

  group.setup(async () => {
    const tarball = await packedPackage()
    fixture = await FixtureApp.create('api')
    await fixture.migrate()
    await fixture.npm(['install', '--save-dev', tarball, 'zod@^4.2.0'])
    return () => fixture.dispose()
  })

  test('configure writes the production-safe surface and is idempotent', async ({ assert }) => {
    const first = await fixture.ace(['configure', '@rikology/adonisjs-mcp'], 'development')
    assert.equal(first.exitCode, 0, first.stdout + first.stderr)

    const configFile = join(fixture.root, 'config', 'mcp.ts')
    const generatedConfig = await readFile(configFile, 'utf8')
    assert.include(generatedConfig, "import type { McpConfig } from '@rikology/adonisjs-mcp'")
    assert.include(generatedConfig, 'satisfies McpConfig')
    assert.notMatch(generatedConfig, /^import (?!type)/m)

    const wrapper = await readFile(join(fixture.root, 'providers', 'mcp_dev_provider.ts'), 'utf8')
    assert.include(wrapper, "await import('@rikology/adonisjs-mcp/providers/mcp_provider')")
    assert.include(wrapper, 'app.inDev')

    await writeFile(configFile, mcpConfig(''))
    await writeFile(join(fixture.root, 'start', 'mcp_tools.ts'), APP_TOOLS_MODULE)

    const second = await fixture.ace(['configure', '@rikology/adonisjs-mcp'], 'development')
    assert.equal(second.exitCode, 0, second.stdout + second.stderr)

    assert.equal(await readFile(configFile, 'utf8'), mcpConfig(''))
    const rcFile = await readFile(join(fixture.root, 'adonisrc.ts'), 'utf8')
    assert.lengthOf(rcFile.match(/#providers\/mcp_dev_provider/g) ?? [], 1)
    assert.match(
      rcFile,
      /file: \(\) => import\('#providers\/mcp_dev_provider'\),\s*environment: \['web'\]/
    )
    assert.notInclude(rcFile, '@rikology/adonisjs-mcp')
  })

  test('the application typechecks against the published declarations', async ({ assert }) => {
    const result = await fixture.npm(['exec', '--', 'tsc', '--noEmit'])
    assert.equal(result.exitCode, 0)
  })

  test('development loads the package provider, which validates config', async ({ assert }) => {
    const app = await fixture.start({ nodeEnv: 'development' })
    const home = await app.fetch('/')
    assert.equal(home.status, 200)
    await app.stop()

    const configFile = join(fixture.root, 'config', 'mcp.ts')
    await writeFile(configFile, mcpConfig('sql: { maxRows: 0 },'))
    try {
      await fixture.start({ nodeEnv: 'development' })
      assert.fail('expected development boot to reject the config')
    } catch (error) {
      assert.instanceOf(error, AppStartError)
      const output = (error as AppStartError).logs.text()
      assert.include(output, 'Invalid MCP configuration in config/mcp.ts')
      assert.include(output, 'tools.sql.maxRows')
    } finally {
      await writeFile(configFile, mcpConfig(''))
    }
  })

  test('test processes do not load the package provider', async ({ assert }) => {
    const configFile = join(fixture.root, 'config', 'mcp.ts')
    await writeFile(configFile, mcpConfig('sql: { maxRows: 0 },'))
    try {
      const app = await fixture.start({ nodeEnv: 'test' })
      const home = await app.fetch('/')
      assert.equal(home.status, 200)
      await app.stop()
    } finally {
      await writeFile(configFile, mcpConfig(''))
    }
  })

  test('a pruned production deployment boots without the package or zod', async ({ assert }) => {
    const deployment = await fixture.buildProduction()

    assert.isFalse(existsSync(join(deployment.root, 'node_modules', '@rikology', 'adonisjs-mcp')))
    assert.isFalse(existsSync(join(deployment.root, 'node_modules', 'zod')))
    const builtConfig = await readFile(join(deployment.root, 'config', 'mcp.js'), 'utf8')
    assert.notInclude(builtConfig, '@rikology/adonisjs-mcp')
    assert.include(builtConfig, "import('#start/mcp_tools')")

    const app = await deployment.start()
    const home = await app.fetch('/')
    assert.equal(home.status, 200)
    assert.deepEqual(await home.json(), { hello: 'world' })
    const environment = await app.fetch('/__fixture/environment')
    assert.deepInclude(await environment.json(), {
      inProduction: true,
      inDev: false,
    })
    const endpoint = await app.fetch('/__custom/mcp', { method: 'POST' })
    assert.equal(endpoint.status, 404)
    assert.notInclude(app.logs.text(), 'ERR_MODULE_NOT_FOUND')
    await app.stop()

    const list = await deployment.ace(['list'])
    assert.equal(list.exitCode, 0, list.stderr)
    const status = await deployment.ace(['migration:status'])
    assert.equal(status.exitCode, 0, status.stdout + status.stderr)
    assert.match(status.stdout, /create_users_table.*completed/)
  })
})

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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { AppStartError, FixtureApp } from '../helpers/fixture_app.js'
import { packedPackage } from '../helpers/package_tarball.js'
import { DEV_HOOKS_GATEWAY, toolPayload, waitForMcp } from '../helpers/mcp_endpoint.js'
import { connectMcpClient } from '../helpers/mcp_client.js'

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
    const envFile = join(fixture.root, '.env')
    const environment = await readFile(envFile, 'utf8')
    const sentinel = 'mcp-configure-private-sentinel-7f19'
    await writeFile(envFile, `${environment}\nMCP_CONFIGURE_SENTINEL=${sentinel}\n`)
    const first = await fixture.ace(
      ['configure', '@rikology/adonisjs-mcp', '--instrument', '--vm-modules'],
      'development'
    )
    assert.equal(first.exitCode, 0, first.stdout + first.stderr)
    assert.notInclude(first.stdout + first.stderr, sentinel)

    const configFile = join(fixture.root, 'config', 'mcp.ts')
    const generatedConfig = await readFile(configFile, 'utf8')
    assert.include(generatedConfig, "import type { McpConfig } from '@rikology/adonisjs-mcp'")
    assert.include(generatedConfig, 'satisfies McpConfig')
    assert.notMatch(generatedConfig, /^import (?!type)/m)

    const wrapper = await readFile(join(fixture.root, 'providers', 'mcp_dev_provider.ts'), 'utf8')
    assert.include(wrapper, "await import('@rikology/adonisjs-mcp/providers/mcp_provider')")
    assert.include(wrapper, 'app.inDev')
    assert.equal(
      await readFile(join(fixture.root, 'start/mcp_dev_hooks.ts'), 'utf8'),
      DEV_HOOKS_GATEWAY
    )
    assert.isFalse(existsSync(join(fixture.root, '.claude')))
    const manifest = JSON.parse(await readFile(join(fixture.root, 'package.json'), 'utf8')) as {
      scripts: { dev: string }
    }
    assert.match(manifest.scripts.dev, /^NODE_OPTIONS=--experimental-vm-modules /)
    await writeFile(
      envFile,
      environment.replace(/^PORT=.*$/m, 'PORT=4343') + `\nMCP_CONFIGURE_SENTINEL=${sentinel}\n`
    )

    await writeFile(configFile, mcpConfig(''))
    await writeFile(join(fixture.root, 'start', 'mcp_tools.ts'), APP_TOOLS_MODULE)

    const paths = [
      'config/mcp.ts',
      'providers/mcp_dev_provider.ts',
      'start/mcp_dev_hooks.ts',
      'config/logger.ts',
      'app/exceptions/handler.ts',
      'package.json',
      'adonisrc.ts',
    ]
    const before = await Promise.all(
      paths.map((path) => readFile(join(fixture.root, path), 'utf8'))
    )
    const second = await fixture.ace(
      ['configure', '@rikology/adonisjs-mcp', '--instrument', '--vm-modules'],
      'development'
    )
    assert.equal(second.exitCode, 0, second.stdout + second.stderr)
    assert.deepEqual(
      await Promise.all(paths.map((path) => readFile(join(fixture.root, path), 'utf8'))),
      before
    )
    assert.include(second.stdout, 'http://localhost:4343/__custom/mcp')
    assert.notInclude(second.stdout + second.stderr, sentinel)
    assert.lengthOf(before[3].match(/import \{ streamWrite \}/g) ?? [], 1)
    assert.lengthOf(before[4].match(/observeException\(error, ctx\)/g) ?? [], 1)

    assert.equal(await readFile(configFile, 'utf8'), mcpConfig(''))
    const rcFile = await readFile(join(fixture.root, 'adonisrc.ts'), 'utf8')
    assert.lengthOf(rcFile.match(/#providers\/mcp_dev_provider/g) ?? [], 1)
    assert.match(
      rcFile,
      /file: \(\) => import\('#providers\/mcp_dev_provider'\),\s*environment: \['web'\]/
    )
    assert.notInclude(rcFile, '@rikology/adonisjs-mcp')
  })

  test('copies skills only into an existing .claude directory and keeps user skills', async ({
    assert,
  }) => {
    await mkdir(join(fixture.root, '.claude'))
    const configured = await fixture.ace(
      ['configure', '@rikology/adonisjs-mcp', '--no-instrument', '--no-vm-modules'],
      'development'
    )
    assert.equal(configured.exitCode, 0, configured.stdout + configured.stderr)
    const target = join(fixture.root, '.claude/skills/adonisjs-mcp/SKILL.md')
    const shipped = join(
      fixture.root,
      'node_modules/@rikology/adonisjs-mcp/skills/adonisjs-mcp/SKILL.md'
    )
    assert.equal(await readFile(target, 'utf8'), await readFile(shipped, 'utf8'))
    await writeFile(target, 'User skill')
    await fixture.ace(
      ['configure', '@rikology/adonisjs-mcp', '--no-instrument', '--no-vm-modules'],
      'development'
    )
    assert.equal(await readFile(target, 'utf8'), 'User skill')
  })

  test('missing start alias skips capture and unresolved endpoint values get instructions', async ({
    assert,
  }) => {
    const fresh = await FixtureApp.create('api')
    try {
      await fresh.npm(['install', '--save-dev', await packedPackage()])
      const manifestPath = join(fresh.root, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        imports: Record<string, string>
        scripts: { dev: string }
      }
      delete manifest.imports['#start/*']
      const originalScript = manifest.scripts.dev
      const loggerPath = join(fresh.root, 'config/logger.ts')
      const handlerPath = join(fresh.root, 'app/exceptions/handler.ts')
      const before = await Promise.all(
        [loggerPath, handlerPath].map((path) => readFile(path, 'utf8'))
      )
      const configPath = join(fresh.root, 'config/mcp.ts')
      await writeFile(configPath, 'export default { path: process.env.MCP_PATH }\n')
      await writeFile(join(fresh.root, '.env'), 'PORT=${APP_PORT}\n')
      for (const indentation of ['\t', '    ']) {
        manifest.scripts.dev = originalScript
        const newline = indentation === '\t' ? '' : '\n'
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, indentation)}${newline}`)
        const result = await fresh.ace(
          ['configure', '@rikology/adonisjs-mcp', '--instrument', '--vm-modules'],
          'development'
        )
        assert.equal(result.exitCode, 0, result.stdout + result.stderr)
        assert.include(result.stdout, 'Capture instrumentation skipped')
        assert.include(result.stdout, '"#start/*"')
        assert.include(result.stdout, 'http://localhost:3333/__adonis/mcp')
        assert.include(result.stdout, 'substitute the actual port')
        assert.include(result.stdout, 'substitute the actual MCP path')
        const updated = await readFile(manifestPath, 'utf8')
        manifest.scripts.dev = `NODE_OPTIONS=--experimental-vm-modules ${originalScript}`
        assert.equal(updated, `${JSON.stringify(manifest, null, indentation)}${newline}`)
      }
      assert.deepEqual(
        await Promise.all([loggerPath, handlerPath].map((path) => readFile(path, 'utf8'))),
        before
      )
      assert.isFalse(existsSync(join(fresh.root, 'start/mcp_dev_hooks.ts')))
      await writeFile(configPath, 'export default {}\n')
      await writeFile(join(fresh.root, '.env'), 'LOG_LEVEL=info\n')
      const defaults = await fresh.ace(
        ['configure', '@rikology/adonisjs-mcp', '--no-instrument', '--no-vm-modules'],
        'development'
      )
      assert.equal(defaults.exitCode, 0, defaults.stdout + defaults.stderr)
      assert.include(defaults.stdout, 'http://localhost:3333/__adonis/mcp')
      assert.include(defaults.stdout, 'default port 3333')
      assert.notInclude(defaults.stdout, 'substitute the actual')
    } finally {
      await fresh.dispose()
    }
  })

  test('non-interactive defaults and negated flags leave fresh source files untouched', async ({
    assert,
  }) => {
    const fresh = await FixtureApp.create('api')
    try {
      await fresh.npm(['install', '--save-dev', await packedPackage()])
      const paths = ['config/logger.ts', 'app/exceptions/handler.ts', 'package.json']
      const before = await Promise.all(
        paths.map((path) => readFile(join(fresh.root, path), 'utf8'))
      )
      const skipped = await fresh.ace(['configure', '@rikology/adonisjs-mcp'], 'development')
      assert.equal(skipped.exitCode, 0, skipped.stdout + skipped.stderr)
      assert.include(skipped.stdout, 'Capture instrumentation skipped')
      assert.include(skipped.stdout, 'VM modules skipped')
      const negated = await fresh.ace(
        ['configure', '@rikology/adonisjs-mcp', '--no-instrument', '--no-vm-modules'],
        'development'
      )
      assert.equal(negated.exitCode, 0, negated.stdout + negated.stderr)
      assert.deepEqual(
        await Promise.all(paths.map((path) => readFile(join(fresh.root, path), 'utf8'))),
        before
      )
      assert.isFalse(existsSync(join(fresh.root, 'start/mcp_dev_hooks.ts')))
      const loggerPath = join(fresh.root, 'config/logger.ts')
      await writeFile(
        loggerPath,
        before[0].replace(
          "level: env.get('LOG_LEVEL'),",
          "level: env.get('LOG_LEVEL'),\n      hooks: { streamWrite: (line: string) => line.replace('CONFIGURE_BEFORE', 'CONFIGURE_AFTER') },"
        )
      )
      const routesPath = join(fresh.root, 'start/routes.ts')
      const routes = await readFile(routesPath, 'utf8')
      await writeFile(
        routesPath,
        routes +
          "\nrouter.get('/__configure/log', ({ logger }) => { logger.info('CONFIGURE_BEFORE'); return { ok: true } })\nrouter.get('/__configure/error', () => { throw new Error('CONFIGURE_ERROR') })\n"
      )
      const captured = await fresh.ace(
        ['configure', '@rikology/adonisjs-mcp', '--instrument', '--no-vm-modules'],
        'development'
      )
      assert.equal(captured.exitCode, 0, captured.stdout + captured.stderr)
      const app = await fresh.start({ nodeEnv: 'development' })
      await waitForMcp(app)
      await app.fetch('/__configure/log')
      await app.fetch('/__configure/error')
      const client = await connectMcpClient(new URL('/__adonis/mcp', app.url), { era: 'modern' })
      try {
        const logs = await client.callTool({
          name: 'get_logs',
          arguments: { grep: 'CONFIGURE_AFTER' },
        })
        assert.notOk(logs.isError)
        assert.include(JSON.stringify(toolPayload(logs)), 'CONFIGURE_AFTER')
        assert.include(app.logs.text(), 'CONFIGURE_AFTER')
        assert.notInclude(app.logs.text(), 'CONFIGURE_BEFORE')
        const exceptions = await client.callTool({ name: 'get_last_exceptions', arguments: {} })
        assert.notOk(exceptions.isError)
        assert.include(JSON.stringify(toolPayload(exceptions)), 'CONFIGURE_ERROR')
      } finally {
        await client.close()
        await app.stop()
      }
    } finally {
      await fresh.dispose()
    }
  })

  test('configured capture and VM modules serve their tools in development', async ({ assert }) => {
    const manifest = JSON.parse(await readFile(join(fixture.root, 'package.json'), 'utf8')) as {
      scripts: { dev: string }
    }
    const nodeOptions = manifest.scripts.dev.match(/^NODE_OPTIONS=([^ ]+)/)![1]
    const configPath = join(fixture.root, 'config/mcp.ts')
    const original = await readFile(configPath, 'utf8')
    await writeFile(configPath, original.replace("disabled: ['project_eval']", 'disabled: []'))
    const app = await fixture.start({ nodeEnv: 'development', nodeOptions })
    try {
      await waitForMcp(app)
      const client = await connectMcpClient(new URL('/__custom/mcp', app.url), { era: 'modern' })
      try {
        const tools = await client.listTools()
        for (const name of ['get_logs', 'get_last_exceptions', 'project_eval']) {
          assert.include(
            tools.tools.map((tool) => tool.name),
            name
          )
        }
        for (const name of ['get_logs', 'get_last_exceptions']) {
          const result = await client.callTool({ name, arguments: {} })
          assert.notOk(result.isError, JSON.stringify(toolPayload(result)))
        }
      } finally {
        await client.close()
      }
    } finally {
      await app.stop()
      await writeFile(configPath, original)
    }
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

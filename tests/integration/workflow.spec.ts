/*
|--------------------------------------------------------------------------
| Agent workflow from a fresh install (M8 exit gate)
|--------------------------------------------------------------------------
|
| Tarball install → configure (capture instrumentation and the
| --experimental-vm-modules dev script) → development boot of the
| configured `dev` script → official MCP client → the debug_request and
| add_feature prompts, followed step by step the way an agent would: the
| test calls the tools the prompt names, in the order it names them, and
| checks that every step returns what the next one needs.
|
*/

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import { DEFAULT_PATH, toolPayload, waitForMcp } from '../helpers/mcp_endpoint.js'
import { packedPackage } from '../helpers/package_tarball.js'

const BROKEN_CONTROLLER = `import type { HttpContext } from '@adonisjs/core/http'

export default class InvoicesController {
  async index({ logger }: HttpContext) {
    logger.info('loading invoice totals')
    const report = undefined as unknown as { totals: number[] }
    return { totals: report.totals }
  }
}
`

const FIXED_CONTROLLER = `import type { HttpContext } from '@adonisjs/core/http'

export default class InvoicesController {
  async index({ logger }: HttpContext) {
    logger.info('loading invoice totals')
    return { totals: [] as number[] }
  }
}
`

interface Envelope<T> {
  data: T
}

interface HttpResult {
  response: { status: number }
  body: { kind: string; json?: unknown }
  requestIds: string[]
  exceptions: Array<{ message: string }> | null
  logs: { entries: Array<{ message: string | null }> } | null
}

interface ExceptionsResult {
  exceptions: Array<{ name: string; message: string; request: { id: string | null } | null }>
}

interface LogsResult {
  entries: Array<{ message: string | null; requestId: string | null }>
}

interface RoutesResult {
  routes: Array<{ pattern: string; methods: string[]; handler: unknown }>
}

interface AceResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function promptText(prompt: { messages: Array<{ content: unknown }> }): string {
  return prompt.messages
    .map((message) => {
      const content = message.content as { type?: string; text?: string }
      return content.type === 'text' ? (content.text ?? '') : ''
    })
    .join('\n')
}

/**
 * Asserts that `names` appear in the prompt, in that order.
 */
function assertOrder(
  assert: { isTrue(value: boolean, message?: string): void },
  text: string,
  names: string[]
) {
  let previous = -1
  for (const name of names) {
    const index = text.indexOf(`\`${name}\``)
    assert.isTrue(index > previous, `${name} after previous step in:\n${text}`)
    previous = index
  }
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
  }
  return toolPayload<Envelope<T>>(result).data
}

/**
 * Retries `probe` until it returns a value, for changes the dev server
 * applies asynchronously (hot swap, restart).
 */
async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== undefined) {
        return value
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`condition not met in ${timeoutMs} ms: ${String(lastError)}`)
}

test.group('Workflow | fresh install to agent workflow', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  let endpoint: URL

  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    try {
      await fixture.migrate()
      await fixture.npm(['install', '--save-dev', await packedPackage()])
      const configured = await fixture.ace(
        ['configure', '@rikology/adonisjs-mcp', '--instrument', '--vm-modules'],
        'development'
      )
      if (configured.exitCode !== 0) {
        throw new Error(`configure failed\n${configured.stdout}\n${configured.stderr}`)
      }

      await writeFile(
        join(fixture.root, 'app/controllers/invoices_controller.ts'),
        BROKEN_CONTROLLER
      )
      const routesFile = join(fixture.root, 'start/routes.ts')
      await writeFile(
        routesFile,
        `${await readFile(routesFile, 'utf8')}
router.get('/invoices', [() => import('#controllers/invoices_controller'), 'index'])
`
      )

      /**
       * The configured dev script is `node ace serve --hmr` with the flag
       * in NODE_OPTIONS; the hmr runner starts exactly that command.
       */
      const manifest = JSON.parse(await readFile(join(fixture.root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
      const dev = /^NODE_OPTIONS=(\S+) node ace serve --hmr$/.exec(manifest.scripts.dev)
      if (!dev) {
        throw new Error(`unexpected configured dev script: ${manifest.scripts.dev}`)
      }
      app = await fixture.start({ nodeEnv: 'development', runner: 'hmr', nodeOptions: dev[1] })
      await waitForMcp(app)
      endpoint = new URL(DEFAULT_PATH, app.url)
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return () => fixture.dispose()
  })

  test('debug_request: route, request, exception, logs, source, fix, verify', async ({
    assert,
  }) => {
    const client = await connectMcpClient(endpoint, { era: 'modern' })
    try {
      const prompt = promptText(
        await client.getPrompt({
          name: 'debug_request',
          arguments: { path: '/invoices', method: 'GET' },
        })
      )
      assert.include(prompt, '/invoices')
      assertOrder(assert, prompt, [
        'get_routes',
        'http_request',
        'get_last_exceptions',
        'get_logs',
        'get_source_location',
      ])

      const { routes } = await call<RoutesResult>(client, 'get_routes', { pattern: '/invoices' })
      const route = routes.find((entry) => entry.pattern === '/invoices')!
      assert.exists(route)
      assert.include(JSON.stringify(route.handler), 'invoices_controller')

      const failed = await call<HttpResult>(client, 'http_request', {
        method: 'GET',
        path: '/invoices',
      })
      assert.equal(failed.response.status, 500)
      const [requestId] = failed.requestIds

      const { exceptions } = await call<ExceptionsResult>(client, 'get_last_exceptions', {
        requestId,
      })
      assert.lengthOf(exceptions, 1)
      assert.equal(exceptions[0].name, 'TypeError')
      assert.include(exceptions[0].message, "reading 'totals'")

      const logs = await call<LogsResult>(client, 'get_logs', { requestId })
      assert.isTrue(logs.entries.some((entry) => entry.message === 'loading invoice totals'))
      assert.isTrue(logs.entries.every((entry) => entry.requestId === requestId))

      const location = await call<{ line: number | null }>(client, 'get_source_location', {
        reference: '#controllers/invoices_controller',
        symbol: 'InvoicesController.index',
      })
      assert.include(JSON.stringify(location), 'app/controllers/invoices_controller.ts')
      assert.isNumber(location.line)

      await writeFile(
        join(fixture.root, 'app/controllers/invoices_controller.ts'),
        FIXED_CONTROLLER
      )
      const fixed = await eventually(async () => {
        const result = await call<HttpResult>(client, 'http_request', {
          method: 'GET',
          path: '/invoices',
        })
        return result.response.status === 200 ? result : undefined
      })
      assert.deepEqual(fixed.body, { ...fixed.body, kind: 'json', json: { totals: [] } })
      assert.deepEqual(fixed.exceptions, [])
    } finally {
      await client.close()
    }
  }).timeout(180_000)

  test('add_feature: inspect, scaffold with Ace, wire, verify over HTTP', async ({ assert }) => {
    let client = await connectMcpClient(endpoint, { era: 'legacy' })
    try {
      const prompt = promptText(
        await client.getPrompt({ name: 'add_feature', arguments: { feature: 'list reports' } })
      )
      assertOrder(assert, prompt, ['get_models', 'run_ace_command', 'http_request'])
      assert.include(prompt, '`get_validators`')
      assert.notInclude(prompt, 'make:page')

      const models = await call<{ models: Array<{ name: string }> }>(client, 'get_models')
      assert.include(
        models.models.map((model) => model.name),
        'User'
      )
      const evaluated = await call<{ display: string }>(client, 'project_eval', {
        code: "const { default: User } = await import('#models/user'); return User.table",
      })
      assert.equal(evaluated.display, "'users'")

      const validator = await call<AceResult>(client, 'run_ace_command', {
        command: 'make:validator',
        args: ['report'],
      })
      assert.equal(validator.exitCode, 0, validator.stderr)
      const controller = await call<AceResult>(client, 'run_ace_command', {
        command: 'make:controller',
        args: ['reports'],
      })
      assert.equal(controller.exitCode, 0, controller.stderr)
      assert.include(
        await readFile(join(fixture.root, 'app/controllers/reports_controller.ts'), 'utf8'),
        'class ReportsController'
      )

      await writeFile(
        join(fixture.root, 'app/controllers/reports_controller.ts'),
        `export default class ReportsController {
  async index() {
    return { reports: ['weekly'] }
  }
}
`
      )
      const routesFile = join(fixture.root, 'start/routes.ts')
      await writeFile(
        routesFile,
        `${await readFile(routesFile, 'utf8')}
router.get('/reports', [() => import('#controllers/reports_controller'), 'index'])
`
      )
    } finally {
      await client.close()
    }

    /**
     * Editing start/routes.ts restarts the dev server; a new client sees
     * the restarted application.
     */
    const listed = await eventually(async () => {
      client = await connectMcpClient(endpoint, { era: 'modern' })
      try {
        const { routes } = await call<RoutesResult>(client, 'get_routes', { pattern: '/reports' })
        return routes.some((route) => route.pattern === '/reports') ? true : undefined
      } finally {
        await client.close()
      }
    }, 90_000)
    assert.isTrue(listed)

    client = await connectMcpClient(endpoint, { era: 'modern' })
    try {
      const response = await call<HttpResult>(client, 'http_request', {
        method: 'GET',
        path: '/reports',
      })
      assert.equal(response.response.status, 200)
      assert.deepEqual(response.body, {
        ...response.body,
        kind: 'json',
        json: { reports: ['weekly'] },
      })
    } finally {
      await client.close()
    }
  }).timeout(240_000)
})

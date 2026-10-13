/* Real application imports, HMR, cooperative deadlines and tenant isolation. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from '@japa/runner'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  instrumentCapture,
  setExtensionProviders,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

interface EvalResult {
  data: {
    display: string
    type: string
    callId: string
    console: { entries: Array<{ level: string; text: string }>; dropped: number }
  }
  limitations: string[]
}
interface Failure {
  code: string
  message: string
  details: { console: { entries: Array<{ text: string }> }; stack: string }
}

function failurePayload(result: { content?: unknown; isError?: boolean }): Failure {
  if (!result.isError) throw new Error(`Expected evaluation failure: ${JSON.stringify(result)}`)
  return toolPayload<{ error: Failure }>(result).error
}

const controller = (marker: string) => `import app from '@adonisjs/core/services/app'
export default class EvalProbeController {
  static marker = '${marker}'
  handle() {
    Object.assign(app, { evalController: EvalProbeController })
    return { marker: EvalProbeController.marker, pid: process.pid }
  }
}
`

test.group('project_eval | runtime capability', () => {
  for (const disabled of [false, true]) {
    test(
      disabled
        ? 'disabled configuration removes the callable tool'
        : 'missing VM flag gives remediation',
      async ({ assert }) => {
        const fixture = await FixtureApp.create('api-bare')
        try {
          await installPackage(fixture)
          await writeMcpConfig(fixture, disabled ? 'tools: { projectEval: false },' : '')
          const app = await fixture.start({ nodeEnv: 'development' })
          await waitForMcp(app)
          const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'legacy' })
          try {
            const listed = await client.listTools()
            assert.isFalse(listed.tools.some((tool) => tool.name === 'project_eval'))
            const profile = toolPayload<{
              data: {
                capabilities: { tools: Array<{ name: string; status: string; reason?: string }> }
              }
            }>(await client.callTool({ name: 'get_project_profile' }))
            const capability = profile.data.capabilities.tools.find(
              (tool) => tool.name === 'project_eval'
            )!
            assert.equal(capability.status, disabled ? 'disabled' : 'unavailable')
            if (!disabled)
              assert.include(capability.reason!, 'NODE_OPTIONS=--experimental-vm-modules')
            await assert.rejects(
              () => client.callTool({ name: 'project_eval', arguments: { code: 'return 1' } }),
              /Tool project_eval not found/
            )
          } finally {
            await client.close()
          }
        } finally {
          await fixture.dispose()
        }
      }
    ).timeout(240_000)
  }
})

test.group('project_eval | live application', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    try {
      await installPackage(fixture)
      await instrumentCapture(fixture)
      await writeMcpConfig(fixture, 'tools: { projectEval: { timeout: 2000 } },')
      await appendFile(join(fixture.root, '.env'), 'EVAL_SENTINEL_SECRET=eval-secret-9c2f7341\n')
      await writeFile(
        join(fixture.root, 'app/controllers/eval_probe_controller.ts'),
        controller('before')
      )
      await mkdir(join(fixture.root, 'app/services'), { recursive: true })
      await writeFile(
        join(fixture.root, 'app/services/eval_fresh.ts'),
        "export default { marker: 'fresh-service' }\n"
      )
      const routes = join(fixture.root, 'start/routes.ts')
      await appendFile(
        routes,
        `\nimport evalApp from '@adonisjs/core/services/app'
import User from '#models/user'
Object.assign(evalApp, { evalUser: User })
router.get('/eval-probe', [() => import('#controllers/eval_probe_controller'), 'handle'])
`
      )
      app = await fixture.start({
        nodeEnv: 'development',
        runner: 'hmr',
        nodeOptions: '--experimental-vm-modules',
      })
      await waitForMcp(app)
    } catch (error) {
      await fixture.dispose()
      throw error
    }
  })
  group.teardown(async () => fixture.dispose())

  test('framework imports preserve identity and same-PID controller hot replacement', async ({
    assert,
  }) => {
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const beforeResponse = await app.fetch('/eval-probe')
      const before = (await beforeResponse.json()) as {
        pid: number
        marker: string
      }
      const result = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: `const { default: User } = await import('#models/user')
const { default: Controller } = await import('#controllers/eval_probe_controller')
const fresh = await import('#services/eval_fresh')
return [User === app.evalUser, Controller === app.evalController, Controller.marker, fresh.default.marker, (await container.make('router')).constructor.name, 42n, new Map([['answer', 42n]])]`,
          },
        })
      )
      assert.include(result.data.display, 'true,')
      assert.include(result.data.display, 'fresh-service')
      assert.include(result.data.display, 'Router')
      assert.include(result.data.display, '42n')
      assert.include(result.data.display, 'Map(1)')
      await writeFile(
        join(fixture.root, 'app/controllers/eval_probe_controller.ts'),
        controller('after')
      )
      let after = before
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && after.marker !== 'after') {
        await sleep(100)
        const afterResponse = await app.fetch('/eval-probe')
        after = (await afterResponse.json()) as typeof before
      }
      assert.equal(after.marker, 'after')
      assert.equal(after.pid, before.pid)
      const swapped = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: "const { default: C } = await import('#controllers/eval_probe_controller'); return { same: C === app.evalController, marker: C.marker }",
          },
        })
      )
      assert.include(swapped.data.display, 'same: true')
      assert.include(swapped.data.display, "marker: 'after'")
    } finally {
      await client.close()
    }
  }).timeout(60_000)

  test('concurrent lexical console, bounded capture, errors and secrets', async ({ assert }) => {
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'legacy' })
    try {
      const results = await Promise.all(
        ['A', 'B'].map((id) =>
          client.callTool({
            name: 'project_eval',
            arguments: {
              code: `console.log('${id} start'); await new Promise(r => setTimeout(r, ${id === 'A' ? 90 : 20})); console.warn('${id} end'); return '${id}'`,
            },
          })
        )
      )
      for (const [index, raw] of results.entries()) {
        const result = toolPayload<EvalResult>(raw)
        assert.deepEqual(
          result.data.console.entries.map((entry) => entry.text),
          [`${index === 0 ? 'A' : 'B'} start`, `${index === 0 ? 'A' : 'B'} end`]
        )
      }
      const secret = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: 'console.log(process.env.EVAL_SENTINEL_SECRET); return process.env.EVAL_SENTINEL_SECRET',
          },
        })
      )
      assert.notInclude(JSON.stringify(secret), 'eval-secret-9c2f7341')
      const thrown = failurePayload(
        await client.callTool({
          name: 'project_eval',
          arguments: { code: "console.error('before failure');\nthrow new Error('eval boom')" },
        })
      )
      assert.equal(thrown.code, 'EXECUTION_FAILED')
      assert.include(thrown.message, 'eval boom')
      assert.include(thrown.details.stack, '__mcp_eval__.js:2:')
      assert.equal(thrown.details.console.entries[0].text, 'before failure')
      const bounded = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: { code: "for (let i=0; i<1000; i++) console.log('entry', i); return 1" },
        })
      )
      assert.equal(bounded.data.console.entries.length, 200)
      assert.equal(bounded.data.console.dropped, 800)
      const helpers = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: "console.count(); console.count(); console.time('t'); console.timeEnd('t'); console.group('g'); console.groupEnd(); console.assert(false, 'nope'); return 1",
          },
        })
      )
      const texts = helpers.data.console.entries.map((entry) => entry.text)
      assert.deepEqual(texts.slice(0, 2), ['default: 1', 'default: 2'])
      assert.match(texts[2], /^t: \d+\.\d{3}ms$/)
      assert.deepEqual(texts.slice(3), ['g', 'Assertion failed nope'])
      const tenant = failurePayload(
        await client.callTool({
          name: 'project_eval',
          arguments: { code: 'return tenant', tenant: 'a' },
        })
      )
      assert.equal(tenant.code, 'CAPABILITY_UNSUPPORTED')
    } finally {
      await client.close()
    }
  }).timeout(60_000)

  test('deadlines stop waiting, keep side effects and audit late work', async ({ assert }) => {
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const start = Date.now()
      const timeout = failurePayload(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: "console.log('late marker'); await new Promise(r => setTimeout(r, 200)); app.evalLate = signal.aborted; return true",
            timeout: 30,
          },
        })
      )
      assert.equal(timeout.code, 'TIMEOUT')
      assert.isBelow(Date.now() - start, 180)
      assert.equal(timeout.details.console.entries[0].text, 'late marker')
      await sleep(300)
      const marker = toolPayload<EvalResult>(
        await client.callTool({ name: 'project_eval', arguments: { code: 'return app.evalLate' } })
      )
      assert.equal(marker.data.display, 'true')
      const logs = toolPayload<{
        data: { entries: Array<{ callId: string; fields: { status?: string }; message: string }> }
      }>(await client.callTool({ name: 'get_logs', arguments: { grep: 'MCP project_eval audit' } }))
      const timeoutLog = logs.data.entries.find((log) => log.fields.status === 'timeout')!
      assert.exists(timeoutLog)
      const byCall = toolPayload<typeof logs>(
        await client.callTool({ name: 'get_logs', arguments: { callId: timeoutLog.callId } })
      )
      assert.includeMembers(
        byCall.data.entries.map((log) => log.fields.status),
        ['timeout', 'late-completed']
      )
      const cooperative = failurePayload(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: "await new Promise(resolve => { const timer = setTimeout(() => { app.evalUnwanted = true; resolve(); }, 200); signal.addEventListener('abort', () => { clearTimeout(timer); app.evalCooperated = true; resolve(); }, { once: true }); });",
            timeout: 30,
          },
        })
      )
      assert.equal(cooperative.code, 'TIMEOUT')
      await sleep(250)
      const state = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: { code: 'return [app.evalCooperated, app.evalUnwanted]' },
        })
      )
      assert.equal(state.data.display, '[ true, undefined ]')
      const invalid = failurePayload(
        await client.callTool({
          name: 'project_eval',
          arguments: { code: 'return 1', timeout: 2001 },
        })
      )
      assert.equal(invalid.code, 'INPUT_INVALID')
    } finally {
      await client.close()
    }
  }).timeout(60_000)

  test('client cancellation signals code and late failures remain audited', async ({ assert }) => {
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const cancellation = new AbortController()
      const cancelled = client.callTool(
        {
          name: 'project_eval',
          arguments: {
            code: "await new Promise(r => setTimeout(r, 500)); app.evalCancelledSignal = signal.aborted; throw new Error('late cancelled failure')",
          },
        },
        { signal: cancellation.signal }
      )
      setTimeout(() => cancellation.abort(), 100)
      await assert.rejects(() => cancelled)
      await sleep(600)
      const state = toolPayload<EvalResult>(
        await client.callTool({
          name: 'project_eval',
          arguments: { code: 'return app.evalCancelledSignal' },
        })
      )
      assert.equal(state.data.display, 'true')
      const logs = toolPayload<{
        data: {
          entries: Array<{ callId: string; fields: { status?: string; codeExcerpt?: string } }>
        }
      }>(await client.callTool({ name: 'get_logs', arguments: { grep: 'MCP project_eval audit' } }))
      const record = logs.data.entries.find((entry) => entry.fields.status === 'cancelled')!
      assert.exists(record)
      assert.includeMembers(
        logs.data.entries
          .filter((entry) => entry.callId === record.callId)
          .map((entry) => entry.fields.status),
        ['cancelled', 'late-failed']
      )
      assert.isAtMost(record.fields.codeExcerpt!.length, 200)
      assert.notInclude(record.fields.codeExcerpt!, '\n')
    } finally {
      await client.close()
    }
  }).timeout(60_000)
})

const tenantConfig = `export default { default: 'header', failOnMissing: true, tenants: { header: { resolver: 'header', options: { header: 'X-Tenant-ID', tenants: { a: { id: 'a', name: 'Tenant A' }, b: { id: 'b', name: 'Tenant B' } } } } } }`

test('project_eval | concurrent TenantScope and context isolation', async ({ assert }) => {
  const fixture = await FixtureApp.create('api')
  try {
    await fixture.npm(['install', '--save-exact', '@rikology/adonisjs-tenant@1.0.2'])
    await installPackage(fixture)
    await writeFile(join(fixture.root, 'config/tenancy.ts'), tenantConfig)
    await writeFile(
      join(fixture.root, 'providers/tenancy_fixture_provider.ts'),
      "export { default } from '@rikology/adonisjs-tenant/providers/tenancy_provider'\n"
    )
    await setExtensionProviders(fixture, ['tenancy_fixture_provider'])
    await writeFile(
      join(fixture.root, 'app/models/eval_note.ts'),
      `import { BaseModel, column } from '@adonisjs/lucid/orm'
import { TenantScope } from '@rikology/adonisjs-tenant'
export default class EvalNote extends TenantScope(BaseModel) {
  static table = 'eval_notes'
  @column({ isPrimary: true }) declare id: number
  @column() declare tenantId: string
  @column() declare body: string
}`
    )
    await writeFile(
      join(fixture.root, 'database/migrations/1790000000000_eval_notes.ts'),
      `import { BaseSchema } from '@adonisjs/lucid/schema'
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('eval_notes', table => { table.increments('id'); table.string('tenant_id'); table.string('body') })
    this.defer(async db => { await db.table('eval_notes').multiInsert([{ tenant_id: 'a', body: 'A-only' }, { tenant_id: 'b', body: 'B-only' }]) })
  }
}`
    )
    await fixture.migrate()
    const app = await fixture.start({
      nodeEnv: 'development',
      nodeOptions: '--experimental-vm-modules',
    })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const results = await Promise.all(
        ['a', 'b'].map((tenant) =>
          client.callTool({
            name: 'project_eval',
            arguments: {
              tenant,
              code: "const { getTenantContext } = await import('@rikology/adonisjs-tenant'); const { default: Note } = await import('#models/eval_note'); await new Promise(r => setTimeout(r, 50)); return { id: getTenantContext().id, bodies: (await Note.query()).map(n => n.body) }",
            },
          })
        )
      )
      for (const [index, raw] of results.entries()) {
        const display = toolPayload<EvalResult>(raw).data.display
        assert.include(display, index === 0 ? "id: 'a'" : "id: 'b'")
        assert.include(display, index === 0 ? 'A-only' : 'B-only')
        assert.notInclude(display, index === 0 ? 'B-only' : 'A-only')
      }
      const missing = failurePayload(
        await client.callTool({
          name: 'project_eval',
          arguments: { tenant: 'unknown', code: 'return tenant' },
        })
      )
      assert.equal(missing.code, 'NOT_FOUND')
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300_000)

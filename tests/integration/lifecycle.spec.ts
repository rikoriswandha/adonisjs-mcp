import { appendFile, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
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
import {
  installLifecycleProbe,
  sampleRuntime,
  awaitRuntime,
  probeController,
  RETAINED_HEAP_BYTES_PER_CALL,
  capacityViolations,
} from '../helpers/lifecycle.js'
import type { RuntimeSample } from '../helpers/lifecycle.js'

interface Models {
  data: {
    generation: string
    models: Array<{
      name: string
      changedSinceProcessStart: boolean
      columns: Array<{ property: string }>
    }>
  }
}
const model = (extra = '') => `import { BaseModel, column } from '@adonisjs/lucid/orm'
export default class LifecycleRecord extends BaseModel { @column({ isPrimary: true }) declare id: number; ${extra} }
`

test('Lifecycle | capacity oracle rejects restarts and retained per-call leaks', ({ assert }) => {
  const baseline: RuntimeSample = {
    pid: 1,
    marker: 0,
    gcAvailable: true,
    resources: {},
    memory: { rss: 0, heapUsed: 1024 },
    delay: { mean: 0, p95: 0, max: 0 },
    subscribers: { logs: 1, exceptions: 1 },
    emitterListeners: 1,
  }
  assert.deepEqual(capacityViolations(baseline, baseline, 240), [])
  assert.include(capacityViolations(baseline, { ...baseline, pid: 2 }, 240), 'process PID changed')
  assert.include(
    capacityViolations(
      baseline,
      {
        ...baseline,
        memory: { ...baseline.memory, heapUsed: 1024 + 240 * (RETAINED_HEAP_BYTES_PER_CALL + 1) },
      },
      240
    ),
    'retained heap growth exceeds 16 KiB per call after GC'
  )
  assert.include(
    capacityViolations(baseline, { ...baseline, gcAvailable: false }, 240),
    'GC is unavailable'
  )
})

test('Lifecycle | bounded mixed traffic, three same-PID swaps and route restart', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('api')
  try {
    await installPackage(fixture)
    await instrumentCapture(fixture)
    await installLifecycleProbe(fixture)
    await writeFile(join(fixture.root, 'app/models/lifecycle_record.ts'), model())
    await fixture.migrate()
    const app = await fixture.start({
      nodeEnv: 'development',
      runner: 'hmr',
      nodeOptions: '--experimental-vm-modules --expose-gc',
    })
    await waitForMcp(app)
    let client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      // Warm all metadata caches before measuring retained call growth.
      for (const name of [
        'get_routes',
        'get_models',
        'get_events',
        'get_logs',
        'get_config',
        'execute_sql_query',
        'project_eval',
      ])
        await client.callTool({
          name,
          arguments:
            name === 'project_eval'
              ? { code: 'return 42' }
              : name === 'execute_sql_query'
                ? { query: 'SELECT 1 AS value' }
                : {},
        })
      const before = await sampleRuntime(app, true)
      assert.isTrue(before.gcAvailable)
      const eventsBefore = toolPayload<{
        data: { mappedListeners: number; totalTransportListeners: number }
      }>(await client.callTool({ name: 'get_events', arguments: {} }))
      const initial = toolPayload<Models>(
        await client.callTool({ name: 'get_models', arguments: {} })
      )
      assert.exists(initial.data.models.find((item) => item.name === 'LifecycleRecord'))
      const windows: RuntimeSample[] = []
      for (let i = 0; i < 630; i++) {
        const names = [
          'get_routes',
          'get_models',
          'get_events',
          'get_logs',
          'get_config',
          'execute_sql_query',
          'project_eval',
        ]
        const name = names[i % names.length]
        const result = await client.callTool({
          name,
          arguments:
            name === 'project_eval'
              ? {
                  code: `const logger = await container.make('logger'); logger.info('lifecycle-unique-${i}'); return ${i}`,
                }
              : name === 'execute_sql_query'
                ? { query: 'SELECT 1 AS value' }
                : {},
        })
        assert.isNotTrue(result.isError)
        if ((i + 1) % 210 === 0) windows.push(await sampleRuntime(app, true))
      }
      const previousGrowth = windows[1].memory.heapUsed - windows[0].memory.heapUsed
      const steadyGrowth = windows[2].memory.heapUsed - windows[1].memory.heapUsed
      assert.isAtMost(steadyGrowth / 210, RETAINED_HEAP_BYTES_PER_CALL)
      assert.isAtMost((steadyGrowth - previousGrowth) / 210, 8 * 1024)
      for (let marker = 1; marker <= 3; marker++) {
        const generationStart = app.logs.lines.length
        await writeFile(
          join(fixture.root, 'app/controllers/lifecycle_probe_controller.ts'),
          probeController(marker)
        )
        const swapped = await awaitRuntime(app, (sample) => sample.marker === marker)
        assert.equal(swapped.pid, before.pid)
        // Finish this assembler/codegen cycle before the next file mutation.
        await app.logs.waitFor(
          (line) =>
            line.text.includes('tuyau: created') && app.logs.lines.indexOf(line) >= generationStart,
          30_000
        )
        const swapMarker = `lifecycle-after-swap-${marker}`
        const logged = await client.callTool({
          name: 'project_eval',
          arguments: {
            code: `const logger = await container.make('logger'); logger.info('${swapMarker}'); return 42`,
          },
        })
        assert.isNotTrue(logged.isError)
        const logs = toolPayload<{ data: { entries: Array<{ message: string }> } }>(
          await client.callTool({ name: 'get_logs', arguments: { grep: swapMarker } })
        )
        assert.lengthOf(
          logs.data.entries.filter((entry) => entry.message === swapMarker),
          1
        )
      }
      const after = await sampleRuntime(app, true)
      assert.notProperty(
        after.resources,
        'ProcessWrap',
        'SQLite readers must not survive completed calls'
      )
      assert.deepEqual(after.subscribers, before.subscribers)
      assert.equal(after.emitterListeners, before.emitterListeners)
      const eventsAfter = toolPayload<typeof eventsBefore>(
        await client.callTool({ name: 'get_events', arguments: {} })
      )
      assert.equal(eventsAfter.data.mappedListeners, eventsBefore.data.mappedListeners)
      assert.equal(
        eventsAfter.data.totalTransportListeners,
        eventsBefore.data.totalTransportListeners
      )
      for (const [name, count] of Object.entries(after.resources))
        assert.isAtMost(count, (before.resources[name] ?? 0) + 4, name)
      // HMR module retention is separate from the steady-state per-call leak oracle above.
      await writeFile(
        join(fixture.root, 'app/models/lifecycle_record.ts'),
        model('@column() declare added: string')
      )
      const modelRestart = await awaitRuntime(app, (sample) => sample.pid !== before.pid)
      await client.close()
      client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
      const changed = toolPayload<Models>(
        await client.callTool({ name: 'get_models', arguments: {} })
      )
      const record = changed.data.models.find((item) => item.name === 'LifecycleRecord')!
      assert.isFalse(record.changedSinceProcessStart)
      assert.include(JSON.stringify(record.columns), 'added')
      await rm(join(fixture.root, 'app/models/lifecycle_record.ts'))
      const removed = toolPayload<Models>(
        await client.callTool({ name: 'get_models', arguments: {} })
      )
      assert.notExists(removed.data.models.find((item) => item.name === 'LifecycleRecord'))
      await appendFile(
        join(fixture.root, 'start/routes.ts'),
        "\nrouter.get('/lifecycle-new-route', () => ({ fresh: true }))\n"
      )
      const restarted = await awaitRuntime(app, (sample) => sample.pid !== modelRestart.pid)
      await client.close()
      client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
      const routes = await client.callTool({ name: 'get_routes', arguments: {} })
      assert.include(JSON.stringify(routes), '/lifecycle-new-route')
      assert.notEqual(restarted.pid, before.pid)
      const evidence = join(fixture.root, 'shutdown-evidence.json')
      await rm(evidence, { force: true })
      const started = Date.now()
      process.kill(restarted.pid, 'SIGTERM')
      for (let attempt = 0; !existsSync(evidence) && attempt < 50; attempt++) await sleep(100)
      assert.isTrue(
        existsSync(evidence),
        'SIGTERM must finish package cleanup before app resources close'
      )
      assert.isBelow(Date.now() - started, 5000)
      const shutdown = JSON.parse(
        await readFile(join(fixture.root, 'shutdown-evidence.json'), 'utf8')
      ) as { database: boolean; logger: boolean; subscribers: { logs: number; exceptions: number } }
      assert.deepEqual(shutdown, {
        database: true,
        logger: true,
        subscribers: { logs: 0, exceptions: 0 },
      })
      let exited = false
      while (Date.now() - started < 5000) {
        try {
          process.kill(restarted.pid, 0)
        } catch {
          exited = true
          break
        }
        await sleep(50)
      }
      assert.isTrue(exited, 'HTTP child must exit promptly after SIGTERM')
      await app.stop()
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300_000)

test('Lifecycle | model/page additions and removals are visible in hybrid inventory', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('hybrid')
  try {
    await installPackage(fixture)
    await installLifecycleProbe(fixture)
    const app = await fixture.start({ nodeEnv: 'development', runner: 'hmr' })
    await waitForMcp(app)
    let client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    // Vite/codegen can restart the HTTP child between readiness and a read.
    // Only these read-only inventory calls may reconnect; mutations are never retried.
    const inventory = async (name: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await client.callTool({ name, arguments: {} })
        } catch (error) {
          if (attempt === 2) throw error
          await client.close()
          await awaitRuntime(app, () => true)
          client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
        }
      }
      throw new Error('Inventory reconnection attempts exhausted')
    }
    try {
      const file = join(fixture.root, 'inertia/pages/lifecycle_probe.tsx')
      await writeFile(
        file,
        'export default function LifecycleProbe() { return <p>lifecycle</p> }\n'
      )
      const added = await inventory('get_inertia_pages')
      assert.include(JSON.stringify(added), 'lifecycle_probe')
      await rm(file)
      const removed = await inventory('get_inertia_pages')
      const deletedInventory = toolPayload<{
        data: { pages: Array<{ name: string; existsOnDisk: boolean }> }
      }>(removed)
      const deletedPage = deletedInventory.data.pages.find(
        (page) => page.name === 'lifecycle_probe'
      )
      if (deletedPage)
        assert.isFalse(
          deletedPage.existsOnDisk,
          'Generated entries must not claim deleted source exists'
        )
      await writeFile(join(fixture.root, 'app/models/lifecycle_record.ts'), model())
      assert.include(JSON.stringify(await inventory('get_models')), 'LifecycleRecord')
      await rm(join(fixture.root, 'app/models/lifecycle_record.ts'))
      assert.notInclude(JSON.stringify(await inventory('get_models')), 'LifecycleRecord')
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300_000)

test('Lifecycle | large config, logs and eval have labeled byte bounds', async ({ assert }) => {
  const fixture = await FixtureApp.create('api')
  try {
    await installPackage(fixture)
    await instrumentCapture(fixture)
    await writeMcpConfig(fixture, 'limits: { maxResultBytes: 4096 },')
    await writeFile(
      join(fixture.root, 'config/lifecycle.ts'),
      `export default { payload: '${'z'.repeat(100000)}' }\n`
    )
    await writeFile(
      join(fixture.root, 'database/migrations/1790000000000_lifecycle_payload.ts'),
      `import { BaseSchema } from '@adonisjs/lucid/schema'
export default class extends BaseSchema { async up() {
this.schema.createTable('lifecycle_payload', table => { table.increments('id'); table.text('body') })
this.defer(async db => { await db.table('lifecycle_payload').insert({ body: 'z'.repeat(100000) }) })
} }`
    )
    await fixture.migrate()
    const docs = join(fixture.root, 'node_modules/@rikology/lifecycle-docs')
    await mkdir(docs, { recursive: true })
    await writeFile(
      join(docs, 'package.json'),
      JSON.stringify({ name: '@rikology/lifecycle-docs', version: '1.0.0' })
    )
    await writeFile(
      join(docs, 'README.md'),
      '# Lifecyclequokka\n' + 'Lifecyclequokka documentation\n'.repeat(50000)
    )
    await writeFile(join(fixture.root, 'app/models/lifecycle_record.ts'), model())
    const app = await fixture.start({
      nodeEnv: 'development',
      nodeOptions: '--experimental-vm-modules',
    })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const baseline = await client.callTool({ name: 'get_models', arguments: {} })
      assert.isNotTrue(baseline.isError)
      await writeFile(
        join(fixture.root, 'app/models/lifecycle_record.ts'),
        model('@column() declare added: string')
      )
      const stale = toolPayload<Models>(
        await client.callTool({ name: 'get_models', arguments: {} })
      )
      assert.isTrue(
        stale.data.models.find((item) => item.name === 'LifecycleRecord')!.changedSinceProcessStart
      )
      for (const [name, args] of [
        ['get_config', { key: 'lifecycle' }],
        [
          'project_eval',
          {
            code: "const logger = await container.make('logger'); for (let i=0;i<100;i++) logger.info('flood-'+i+'z'.repeat(500)); return 'z'.repeat(100000)",
          },
        ],
        ['get_logs', {}],
        ['execute_sql_query', { query: 'SELECT body FROM lifecycle_payload' }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args })
        assert.isNotTrue(result.isError)
        const payload = toolPayload<{
          truncated: boolean
          data: { displayTruncated?: boolean; truncated?: boolean }
        }>(result)
        if (name === 'project_eval') assert.isTrue(payload.data.displayTruncated, name)
        else assert.isTrue(payload.truncated || payload.data.truncated, name)
        const content = result.content as Array<{ type: string; text: string }>
        assert.isAtMost(Buffer.byteLength(content[0].text), 4096)
      }
      const resource = await client.readResource({ uri: 'adonis://config/lifecycle' })
      const contents = resource.contents as Array<{ text: string }>
      assert.isAtMost(Buffer.byteLength(contents[0].text), 4096)
      const encoded = JSON.parse(contents[0].text) as { truncated: boolean }
      assert.isTrue(encoded.truncated)
      const searched = await client.callTool({
        name: 'search_package_docs',
        arguments: { query: 'Lifecyclequokka', packages: ['@rikology/lifecycle-docs'] },
      })
      assert.isNotTrue(searched.isError)
      const searchedPayload = toolPayload<{ data: { indexed: Array<{ skipped: string[] }> } }>(
        searched
      )
      assert.isTrue(
        searchedPayload.data.indexed[0].skipped.some((file) => file.includes('README.md'))
      )
      const searchedContent = searched.content as Array<{ text: string }>
      assert.isAtMost(Buffer.byteLength(searchedContent[0].text), 4096)
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300_000)

test('Lifecycle | extraTools restart replaces the finalized registry, never half-registers', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('api')
  const toolModule = (name: string) => `import { z } from 'zod'
import { defineTool } from '@rikology/adonisjs-mcp'
export default defineTool({ name: '${name}', description: 'Lifecycle registry probe', inputSchema: z.object({}), handler: async () => ({ data: '${name}' }) })`
  try {
    await installPackage(fixture)
    await installLifecycleProbe(fixture)
    await writeFile(join(fixture.root, 'start/mcp_tools.ts'), toolModule('lifecycle_before'))
    await writeMcpConfig(fixture, "extraTools: [() => import('#start/mcp_tools')],")
    await writeFile(
      join(fixture.root, 'providers/lifecycle_provider.ts'),
      'export default class LifecycleProvider {}\n'
    )
    await setExtensionProviders(fixture, ['lifecycle_provider'])
    const app = await fixture.start({ nodeEnv: 'development', runner: 'hmr' })
    await waitForMcp(app)
    const before = await sampleRuntime(app)
    const first = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const listed = await first.listTools()
      assert.include(
        listed.tools.map((item) => item.name),
        'lifecycle_before'
      )
      await writeFile(join(fixture.root, 'start/mcp_tools.ts'), toolModule('lifecycle_after'))
      await awaitRuntime(app, (sample) => sample.pid !== before.pid)
    } finally {
      await first.close()
    }
    const second = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const listed = await second.listTools()
      assert.include(
        listed.tools.map((item) => item.name),
        'lifecycle_after'
      )
      assert.notInclude(
        listed.tools.map((item) => item.name),
        'lifecycle_before'
      )
      const called = await second.callTool({ name: 'lifecycle_after', arguments: {} })
      assert.isNotTrue(called.isError)
      assert.equal(toolPayload<{ data: string }>(called).data, 'lifecycle_after')
    } finally {
      await second.close()
    }
    const preProvider = await sampleRuntime(app)
    await writeFile(
      join(fixture.root, 'providers/lifecycle_provider.ts'),
      `import type { ApplicationService } from '@adonisjs/core/types'
import { z } from 'zod'
export default class LifecycleProvider {
constructor(private app: ApplicationService) {}
async boot() {
const registry = await this.app.container.make('mcp.registry')
registry.tool({ name: 'lifecycle_provider_added', description: 'Provider reload probe', inputSchema: z.object({}), handler: () => ({ data: 'provider' }) })
}
}`
    )
    await awaitRuntime(app, (sample) => sample.pid !== preProvider.pid)
    const third = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const listed = await third.listTools()
      assert.include(
        listed.tools.map((item) => item.name),
        'lifecycle_provider_added'
      )
      assert.include(
        listed.tools.map((item) => item.name),
        'lifecycle_after'
      )
      assert.equal(listed.tools.filter((item) => item.name === 'lifecycle_after').length, 1)
    } finally {
      await third.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300_000)

test('Lifecycle | assembler hard restart cleans in-flight Ace command, child and watchdog', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('api')
  try {
    await installPackage(fixture)
    await installLifecycleProbe(fixture)
    await writeMcpConfig(fixture, 'tools: { ace: { timeout: 15000 } },')
    await mkdir(join(fixture.root, 'commands'), { recursive: true })
    await writeFile(
      join(fixture.root, 'commands/lifecycle_sleep.ts'),
      `import { BaseCommand, args } from '@adonisjs/core/ace'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export default class extends BaseCommand {
static commandName = 'lifecycle:sleep'
@args.string() declare output: string
async run() {
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(this.output, JSON.stringify({ command: process.pid, child: child.pid, watchdog: process.ppid }))
const sleeping = Promise.withResolvers<void>()
setTimeout(sleeping.resolve, 60000)
await sleeping.promise
}
}`
    )
    const app = await fixture.start({ nodeEnv: 'development', runner: 'hmr' })
    await waitForMcp(app)
    const before = await sampleRuntime(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const path = join(fixture.root, 'lifecycle-pids.json')
      const pending = client
        .callTool({
          name: 'run_ace_command',
          arguments: { command: 'lifecycle:sleep', args: [path] },
        })
        .then(
          () => false,
          () => true
        )
      for (let attempt = 0; !existsSync(path) && attempt < 100; attempt++) await sleep(100)
      assert.isTrue(existsSync(path), 'Ace must have started before the restart')
      const pids = JSON.parse(await readFile(path, 'utf8')) as Record<string, number>
      await appendFile(
        join(fixture.root, 'start/routes.ts'),
        "\nrouter.get('/lifecycle-after-ace', () => 'restarted')\n"
      )
      await awaitRuntime(app, (sample) => sample.pid !== before.pid)
      assert.isTrue(await pending, 'Lost transport is not a successful/retried command')
      const surviving = new Set(Object.values(pids))
      for (let attempt = 0; surviving.size && attempt < 100; attempt++) {
        for (const pid of surviving) {
          try {
            process.kill(pid, 0)
          } catch {
            surviving.delete(pid)
          }
        }
        if (surviving.size) await sleep(100)
      }
      assert.equal(surviving.size, 0, JSON.stringify(pids))
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(120_000)

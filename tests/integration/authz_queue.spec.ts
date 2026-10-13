/*
|--------------------------------------------------------------------------
| Real optional authorization and queue adapters
|--------------------------------------------------------------------------
|
| Optional packages are installed only in the disposable fixture.
| Jobs are seeded physically, not dispatched. Independent HTTP observations
| prove handlers/loaders never run and full persisted rows remain unchanged.
|
*/
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
import type { RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  setExtensionProviders,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

interface PermissionsData {
  abilitiesFound: boolean
  policiesFound: boolean
  abilities: string[]
  policies: Array<{ name: string; reference: string; module: string | null }>
}
interface QueueData {
  jobs: Array<{ name: string; registered: boolean; changedSinceProcessStart: boolean }>
  rejected: Array<{ file: string; reason: string }>
  manualRegistrations: string
  pending: { meaning: string; queues: Array<{ queue: string; count: number | null }> }
  state: {
    available: boolean
    code?: string
    counts: Array<{ queue: string; status: string; count: number }>
    rows: Array<{ id: string; data: unknown }>
  }
  cwd: string
  appRoot: string
}
interface Envelope<T> {
  data: T
  error?: { code: string }
  limitations: string[]
}
interface Oracle {
  rows: unknown[]
  jobs: number
  abilities: number
  policies: number
  manual: boolean
}

const SECRET = 'queue-payload-sentinel-must-not-leak'

async function put(fixture: FixtureApp, path: string, content: string) {
  const destination = join(fixture.root, path)
  await mkdir(join(destination, '..'), { recursive: true })
  await writeFile(destination, content)
}

async function configure(fixture: FixtureApp) {
  await fixture.npm([
    'install',
    '--save-exact',
    '@adonisjs/bouncer@4.0.1',
    '@adonisjs/queue@0.6.2',
    '@boringnode/queue@0.6.0',
  ])
  await installPackage(fixture)
  await writeMcpConfig(fixture, '')
  await put(
    fixture,
    'providers/queue_provider.ts',
    "export { default } from '@adonisjs/queue/queue_provider'\n"
  )
  await put(
    fixture,
    'providers/bouncer_provider.ts',
    "export { default } from '@adonisjs/bouncer/bouncer_provider'\n"
  )
  await setExtensionProviders(fixture, ['queue_provider', 'bouncer_provider'])
  await put(
    fixture,
    'config/queue.ts',
    `import { defineConfig, drivers } from '@adonisjs/queue'
export default defineConfig({ default: 'database', adapters: { database: drivers.database({ connectionName: 'sqlite', tableName: 'fixture_queue_jobs' }) }, locations: ['./app/jobs/**/*.ts', './custom_jobs/**/*.ts'] })
`
  )
  await put(
    fixture,
    'app/abilities/main.ts',
    `import { Bouncer } from '@adonisjs/bouncer'
export const counters = { jobs: 0, abilities: 0, policies: 0 }
export const viewInvoice = Bouncer.ability(() => { counters.abilities++; throw new Error('must not execute') })
export const refundInvoice = Bouncer.ability({ allowGuest: true }, () => { counters.abilities++; return false })
export const notAnAbility = () => { throw new Error('not an ability') }
`
  )
  await put(
    fixture,
    'app/policies/main.ts',
    `export const policies = { InvoicePolicy: () => import('#policies/invoice_policy') }
`
  )
  await put(
    fixture,
    'app/policies/invoice_policy.ts',
    `import { counters } from '#abilities/main'
counters.policies++
throw new Error('Policy loader must not execute')
export default class InvoicePolicy {}
`
  )
  const job = (name: string, options = '') => `import { Job } from '@adonisjs/queue'
import { counters } from '#abilities/main'
export default class ${name} extends Job { ${options}
async execute() { counters.jobs++; throw new Error('must not execute') }
}
`
  await put(fixture, 'app/jobs/sentinel_job.ts', job('SentinelJob'))
  await put(
    fixture,
    'custom_jobs/external_job.ts',
    job('ExternalJob', "static options = { name: 'external.configured', queue: 'invoices' }")
  )
  await put(fixture, 'manual_jobs/manual_job.ts', job('ManualJob'))
  await put(
    fixture,
    'database/migrations/1791900000000_queue.ts',
    `import { BaseSchema } from '@adonisjs/lucid/schema'
import { QueueSchemaService } from '@adonisjs/queue'
export default class extends BaseSchema {
async up() { this.defer(async (db) => { const knex = db.getWriteClient(); await new QueueSchemaService(knex).createJobsTable('fixture_queue_jobs'); await knex('fixture_queue_jobs').insert([
{ id: 'fixture-pending', queue: 'default', status: 'pending', data: JSON.stringify({ id: 'fixture-pending', name: 'SentinelJob', payload: { password: '${SECRET}', label: 'visible' }, attempts: 0, createdAt: 1 }), score: 1 },
{ id: 'fixture-failed', queue: 'invoices', status: 'failed', data: JSON.stringify({ name: 'external.configured', payload: { apiToken: '${SECRET}' } }), error: 'fixture-only' }
]) }) }
async down() { this.schema.dropTable('fixture_queue_jobs') }
}
`
  )
  await appendFile(
    join(fixture.root, 'start/routes.ts'),
    `
import { Locator } from '@adonisjs/queue'
import queueDb from '@adonisjs/lucid/services/db'
import { counters } from '#abilities/main'
import ManualJob from '../manual_jobs/manual_job.js'
Locator.register('manual.explicit', ManualJob)
router.get('/__fixture/authz-oracle', async () => ({ ...counters, manual: Locator.get('manual.explicit') === ManualJob, rows: await queueDb.connection().query().from('fixture_queue_jobs').select('*').orderBy('id') }))
`
  )
  await fixture.migrate()
}

async function oracle(app: RunningApp): Promise<Oracle> {
  const response = await app.fetch('/__fixture/authz-oracle')
  return (await response.json()) as Oracle
}

test.group('Authorization and queue | real API fixture', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    await configure(fixture)
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
  })
  group.teardown(async () => fixture?.dispose())

  test('registered metadata and version-bound persisted state are read-only in both protocol eras', async ({
    assert,
  }) => {
    const before = await oracle(app)
    for (const era of ['modern', 'legacy'] as const) {
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
      try {
        const permissions = toolPayload<Envelope<PermissionsData>>(
          await client.callTool({ name: 'get_permissions', arguments: {} })
        )
        assert.isTrue(permissions.data.abilitiesFound)
        assert.isTrue(permissions.data.policiesFound)
        assert.deepEqual(permissions.data.abilities.sort(), ['refundInvoice', 'viewInvoice'])
        assert.deepEqual(
          permissions.data.policies.map((policy) => ({
            name: policy.name,
            module: policy.module,
          })),
          [{ name: 'InvoicePolicy', module: '#policies/invoice_policy' }]
        )
        const queue = toolPayload<Envelope<QueueData>>(
          await client.callTool({ name: 'get_queue_jobs', arguments: {} })
        )
        assert.deepEqual(queue.data.jobs.map((item) => item.name).sort(), [
          'SentinelJob',
          'external.configured',
        ])
        assert.isTrue(queue.data.jobs.every((item) => item.registered))
        assert.deepEqual(queue.data.rejected, [])
        assert.equal(queue.data.manualRegistrations, 'not-enumerable')
        assert.equal(queue.data.pending.meaning, 'pending-only')
        assert.deepEqual(queue.data.pending.queues, [
          { queue: 'default', count: 1 },
          { queue: 'invoices', count: 0 },
        ])
        assert.isTrue(queue.data.state.available, JSON.stringify(queue.data.state))
        assert.deepEqual(
          queue.data.state.counts
            .map((item) => ({ status: item.status, count: Number(item.count) }))
            .sort((a, b) => a.status.localeCompare(b.status)),
          [
            { status: 'failed', count: 1 },
            { status: 'pending', count: 1 },
          ]
        )
        assert.notInclude(JSON.stringify(queue), SECRET)
        const failed = toolPayload<Envelope<QueueData>>(
          await client.callTool({
            name: 'get_queue_jobs',
            arguments: { status: 'failed', queue: 'invoices', limit: 1 },
          })
        )
        assert.deepEqual(
          failed.data.state.rows.map((row) => row.id),
          ['fixture-failed']
        )
        const after = await oracle(app)
        assert.deepEqual(after, before)
        assert.equal(after.jobs + after.abilities + after.policies, 0)
        assert.isTrue(after.manual)
      } finally {
        await client.close()
      }
    }
  }).timeout(600_000)

  test('new unregistered classes and missing registries are explicit; dynamic config never guesses physical state', async ({
    assert,
  }) => {
    await put(fixture, 'app/jobs/late_job.ts', 'export default class LateJob {}\n')
    await put(fixture, 'app/jobs/non_function.ts', 'export default { nope: true }\n')
    await appendFile(join(fixture.root, 'config/queue.ts'), '\n// edited since process start\n')
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const queue = toolPayload<Envelope<QueueData>>(
        await client.callTool({ name: 'get_queue_jobs', arguments: {} })
      )
      assert.isFalse(queue.data.jobs.find((item) => item.name === 'LateJob')!.registered)
      assert.isTrue(
        queue.data.jobs.find((item) => item.name === 'LateJob')!.changedSinceProcessStart
      )
      assert.isTrue(queue.data.rejected.some((item) => item.file.endsWith('non_function.ts')))
      assert.equal(queue.data.state.code, 'CAPABILITY_UNSUPPORTED')
      const unknown = toolPayload<{ error: { code: string } }>(
        await client.callTool({ name: 'get_queue_jobs', arguments: { queue: 'unknown.queue' } })
      )
      assert.equal(unknown.error.code, 'NOT_FOUND')
    } finally {
      await client.close()
    }
    await app.stop()
    await put(fixture, 'app/policies/main.ts', 'export const unrelated = true\n')
    await put(
      fixture,
      'app/abilities/main.ts',
      "export const counters = { jobs: 0, abilities: 0, policies: 0 }\nexport const dynamic = () => { throw new Error('never execute') }\n"
    )
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const next = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const permissions = toolPayload<Envelope<PermissionsData>>(
        await next.callTool({ name: 'get_permissions', arguments: {} })
      )
      assert.isTrue(permissions.data.abilitiesFound)
      assert.deepEqual(permissions.data.abilities, [])
      assert.isFalse(permissions.data.policiesFound)
    } finally {
      await next.close()
    }
  }).timeout(600_000)
  test('sync driver exposes pending-only state and explicitly rejects status enumeration', async ({
    assert,
  }) => {
    await app.stop()
    await put(
      fixture,
      'config/queue.ts',
      `import { defineConfig, drivers } from '@adonisjs/queue'
export default defineConfig({ default: 'sync', adapters: { sync: drivers.sync() }, queues: { configuredEmpty: {} }, locations: [] })
`
    )
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const queue = toolPayload<Envelope<QueueData>>(
        await client.callTool({ name: 'get_queue_jobs', arguments: { status: 'failed' } })
      )
      assert.deepEqual(queue.data.jobs, [])
      assert.equal(queue.data.manualRegistrations, 'not-enumerable')
      assert.equal(queue.data.state.code, 'CAPABILITY_UNSUPPORTED')
      assert.deepEqual(queue.data.pending.queues, [
        { queue: 'configuredEmpty', count: 0 },
        { queue: 'default', count: 0 },
      ])
      const after = await oracle(app)
      assert.equal(after.jobs + after.abilities + after.policies, 0)
    } finally {
      await client.close()
    }
  }).timeout(600_000)
})

test.group('Authorization and queue | bare API dependencies', (group) => {
  let fixture: FixtureApp
  group.teardown(async () => fixture?.dispose())
  test('both capabilities fail clearly without optional packages', async ({ assert }) => {
    fixture = await FixtureApp.create('api-bare')
    await installPackage(fixture)
    await writeMcpConfig(fixture, '')
    const app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const profile = toolPayload<
        Envelope<{ capabilities: { tools: Array<{ name: string; code?: string }> } }>
      >(await client.callTool({ name: 'get_project_profile', arguments: {} }))
      for (const name of ['get_permissions', 'get_queue_jobs']) {
        assert.equal(
          profile.data.capabilities.tools.find((tool) => tool.name === name)?.code,
          'DEPENDENCY_UNAVAILABLE'
        )
      }
    } finally {
      await client.close()
    }
  }).timeout(600_000)
})

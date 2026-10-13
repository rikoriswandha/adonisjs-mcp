import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'
import db from '@adonisjs/lucid/services/db'
import { Bouncer } from '@adonisjs/bouncer'
import { Locator, QueueSchemaService } from '@adonisjs/queue'
import { TenantService } from '@rikology/adonisjs-tenant'
import { counters, observedJobs } from '#providers/s_k_probe_provider'
import { permissions } from '#start/permissions'
import ManualJob from '../manual_jobs/manual_job.js'
import { listConfiguredJobs } from '#start/s_k_config_listing'

Locator.register('manual.explicit', ManualJob)

const abilities = Bouncer.define('viewInvoice', () => { counters.policyExecutions++; return true })
  .define('refundInvoice', () => { counters.policyExecutions++; return false }).abilities
const policies = { InvoicePolicy: async () => { throw new Error('Policy loader must not execute') } }
const bouncer = new Bouncer(null, abilities, policies)
const knex = db.connection().getWriteClient()
if (!(await knex.schema.hasTable('queue_jobs'))) await new QueueSchemaService(knex).createJobsTable()
await knex('queue_jobs').where('id', 'like', 's-k-%').delete()
const data = { id: 's-k-pending', name: 'SentinelJob', payload: {}, attempts: 0, createdAt: Date.now() }
await knex('queue_jobs').insert([
  { id: data.id, queue: 'default', status: 'pending', data: JSON.stringify(data), score: 1 },
  { id: 's-k-failed', queue: 'default', status: 'failed', data: JSON.stringify({ ...data, id: 's-k-failed' }), error: 'fixture-only' },
])
router.get('/s-k/observe', async () => {
  const tenant = await app.container.make('tenant.service')
  const queue = await app.container.make('queue.manager')
  const adapter = queue.use()
  const before = await knex('queue_jobs').select('*').orderBy('id')
  const tenantObservation = await tenant.run({ id: 'fixture-tenant', name: 'Fixture', slug: 'fixture' }, () => tenant.get())
  const configuredListing = await listConfiguredJobs()
  const configuredNames = configuredListing.jobs.filter((job) => job.registered).map((job) => job.name).sort()
  const groundTruth = [...observedJobs].sort()
  const residualGroundTruth = groundTruth.filter((name) => !configuredNames.includes(name))
  const result = {
    tenant: { binding: app.container.hasBinding('tenant.service'), sameExport: tenant === TenantService, context: tenantObservation, outside: tenant.get() ?? null, runWithTenantMethod: typeof tenant.runWithTenant },
    permission: { globalBinding: app.container.hasBinding('bouncer'), abilities: Object.keys(bouncer.abilities ?? {}), policies: Object.keys(bouncer.policies ?? {}), policyExecutions: counters.policyExecutions },
    plusPermissions: { keys: permissions.keys(), active: permissions.active(), all: permissions.all(), abilities: Object.keys(permissions.abilities()) },
    queue: { binding: app.container.hasBinding('queue.manager'), registered: [...observedJobs], sentinelRegistered: !!Locator.get('SentinelJob'), nativeList: 'list' in Locator ? typeof Locator.list : 'undefined', pendingTotal: await adapter.size(), pendingDefault: await adapter.sizeOf('default'), failed: (await adapter.getJob('s-k-failed', 'default'))?.status, stateCountsFromPhysicalSchema: await knex('queue_jobs').select('status').count({ count: '*' }).groupBy('status'), jobExecutions: counters.jobExecutions },
    queueListing: { ...configuredListing, configuredNames, groundTruth, residualGroundTruth, expectedConfiguredCoverage: JSON.stringify(configuredNames) === JSON.stringify(['SentinelJob', 'external.configured']), manualRegisteredLookup: Locator.get('manual.explicit') === ManualJob },
    rowsUnchanged: JSON.stringify(before) === JSON.stringify(await knex('queue_jobs').select('*').orderBy('id')),
  }
  return result
})

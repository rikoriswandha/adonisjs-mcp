import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  setExtensionProviders,
  toolPayload,
  waitForMcp,
} from '../helpers/mcp_endpoint.js'
import { installLifecycleProbe, sampleRuntime, awaitRuntime } from '../helpers/lifecycle.js'

interface Envelope {
  data: {
    display?: string
    response?: { status: number }
    rows?: Array<{ body: string }>
    body?: { json: { tenant: string; bodies: string[]; user: number; activeCount: number } }
    abilities?: string[]
    jobs?: Array<{ name: string }>
  }
  error?: { code: string }
}

test('Matrix | hybrid domain surfaces and combined tenant/Bouncer/queue isolation', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('hybrid')
  try {
    await fixture.npm([
      'install',
      '--save-exact',
      '@rikology/adonisjs-tenant@1.0.2',
      '@adonisjs/bouncer@4.0.1',
      '@adonisjs/queue@0.6.2',
      '@boringnode/queue@0.6.0',
    ])
    await installPackage(fixture)
    for (const directory of ['app/abilities', 'app/policies', 'app/jobs'])
      await mkdir(join(fixture.root, directory), { recursive: true })
    await writeFile(
      join(fixture.root, 'config/tenancy.ts'),
      `export default { default: 'header', failOnMissing: true, tenants: { header: { resolver: 'header', options: { header: 'X-Tenant-ID', tenants: { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } } } } } }`
    )
    await writeFile(
      join(fixture.root, 'config/auth.ts'),
      `import { defineTenantAuthConfig, tenantGuards } from '@rikology/adonisjs-tenant/guards'
import { tokensUserProvider } from '@adonisjs/auth/access_tokens'
import { sessionUserProvider } from '@adonisjs/auth/session'
import { TenantUserProvider } from '@rikology/adonisjs-tenant/user_providers'
import User from '#models/user'
export default defineTenantAuthConfig({ default: 'web', guards: {
api: tenantGuards.accessTokens({ provider: tokensUserProvider({ tokens: 'accessTokens', model: () => import('#models/user') }), tenantTokenProvider: User.accessTokens }),
web: tenantGuards.session({ provider: sessionUserProvider({ model: () => import('#models/user') }), tenantProvider: new TenantUserProvider(User, { pivotTable: 'tenant_user' }) })
} })`
    )
    await writeFile(
      join(fixture.root, 'app/models/user.ts'),
      `import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { withTenantAuthFinder } from '@rikology/adonisjs-tenant/mixins'
export default class User extends withTenantAuthFinder(() => hash.use(), { uids: ['email'], passwordColumnName: 'password', membership: { pivotTable: 'tenant_user' } })(UserSchema) {}`
    )
    await writeFile(
      join(fixture.root, 'config/queue.ts'),
      `import { defineConfig, drivers } from '@adonisjs/queue'
export default defineConfig({ default: 'database', adapters: { database: drivers.database({ connectionName: 'sqlite', tableName: 'matrix_queue_jobs' }) }, locations: ['./app/jobs/**/*.ts'] })`
    )
    for (const [name, module] of [
      ['tenancy_fixture_provider', '@rikology/adonisjs-tenant/providers/tenancy_provider'],
      ['bouncer_fixture_provider', '@adonisjs/bouncer/bouncer_provider'],
      ['queue_fixture_provider', '@adonisjs/queue/queue_provider'],
    ])
      await writeFile(
        join(fixture.root, 'providers', `${name}.ts`),
        `export { default } from '${module}'\n`
      )
    await setExtensionProviders(fixture, [
      'tenancy_fixture_provider',
      'bouncer_fixture_provider',
      'queue_fixture_provider',
    ])
    await writeFile(
      join(fixture.root, 'app/abilities/main.ts'),
      `import { Bouncer } from '@adonisjs/bouncer'
export const inspectMatrix = Bouncer.ability(() => { throw new Error('must not execute') })`
    )
    await writeFile(join(fixture.root, 'app/policies/main.ts'), 'export const policies = {}\n')
    await writeFile(
      join(fixture.root, 'app/jobs/matrix_job.ts'),
      `import { Job } from '@adonisjs/queue'
export default class MatrixJob extends Job { async execute() { throw new Error('must not execute') } }`
    )
    await writeFile(
      join(fixture.root, 'app/models/matrix_note.ts'),
      `import { BaseModel, column } from '@adonisjs/lucid/orm'
import { TenantScope } from '@rikology/adonisjs-tenant'
export default class MatrixNote extends TenantScope(BaseModel) {
static table = 'matrix_notes'
@column({ isPrimary: true }) declare id: number
@column() declare tenantId: string
@column() declare body: string
}`
    )
    await writeFile(
      join(fixture.root, 'database/migrations/1790000000000_matrix.ts'),
      `import { BaseSchema } from '@adonisjs/lucid/schema'
import { QueueSchemaService } from '@adonisjs/queue'
import hash from '@adonisjs/core/services/hash'
export default class extends BaseSchema { async up() {
this.schema.alterTable('auth_access_tokens', table => { table.string('tenant_id').nullable() })
this.schema.createTable('tenant_user', table => { table.string('tenant_id'); table.integer('user_id'); table.unique(['tenant_id', 'user_id']) })
this.defer(async db => { const now = new Date().toISOString(); await db.table('users').multiInsert([{ id: 1, email: 'ada@example.com', full_name: 'Ada', password: await hash.make('ada-password'), created_at: now }, { id: 2, email: 'bob@example.com', full_name: 'Bob', password: await hash.make('bob-password'), created_at: now }]); await db.table('tenant_user').multiInsert([{ tenant_id: 'a', user_id: 1 }, { tenant_id: 'b', user_id: 2 }]) })
this.schema.createTable('matrix_notes', table => { table.increments('id'); table.string('tenant_id'); table.string('body') })
this.defer(async db => { await db.table('matrix_notes').multiInsert([{ tenant_id: 'a', body: 'A-only' }, { tenant_id: 'b', body: 'B-only' }]); await new QueueSchemaService(db.getWriteClient()).createJobsTable('matrix_queue_jobs') })
} }`
    )
    await appendFile(
      join(fixture.root, 'start/routes.ts'),
      `
import { getTenantContext } from '@rikology/adonisjs-tenant'
import { setTimeout as matrixSleep } from 'node:timers/promises'
import matrixDb from '@adonisjs/lucid/services/db'
import MatrixNote from '#models/matrix_note'
const matrixMiddleware = router.named({ matrixTenant: () => import('@rikology/adonisjs-tenant/middleware') })
router.group(() => {
router.get('/api/matrix/:speed', async ({ params, auth }) => { await auth.use('api').authenticate(); if (params.speed === 'slow') await matrixSleep(100); return { user: auth.use('api').user!.id, tenant: getTenantContext().id, bodies: (await MatrixNote.query()).map(note => note.body), activeCount: Number((await matrixDb.from('auth_access_tokens').count('* as total').first()).total) } })
router.get('/matrix-web', async ({ inertia }) => inertia.render('home', { tenant: getTenantContext().id, bodies: (await MatrixNote.query()).map(note => note.body) }))
}).domain('matrix.fixture.test').use(matrixMiddleware.matrixTenant())
router.get('/matrix-cleanup', async () => { const { default: db } = await import('@adonisjs/lucid/services/db'); return { tenant: getTenantContext()?.id ?? null, credentials: await db.from('auth_access_tokens').count('* as total').first() } })
`
    )
    await fixture.migrate()
    await installLifecycleProbe(fixture)
    const app = await fixture.start({
      nodeEnv: 'development',
      nodeOptions: '--experimental-vm-modules',
    })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const permissions = toolPayload<Envelope>(
        await client.callTool({ name: 'get_permissions', arguments: {} })
      )
      assert.include(permissions.data.abilities!, 'inspectMatrix')
      const queue = await client.callTool({ name: 'get_queue_jobs', arguments: {} })
      assert.isNotTrue(queue.isError)
      assert.include(JSON.stringify(queue), 'MatrixJob')
      const beforeResponse = await app.fetch('/matrix-cleanup')
      assert.equal(beforeResponse.status, 200)
      const before = (await beforeResponse.json()) as {
        tenant: null
        credentials: { total: number }
      }
      assert.isNull(before.tenant)
      const runtimeBefore = await sampleRuntime(app)
      const calls = ['a', 'b'].flatMap((tenant) => [
        { name: 'query_model', arguments: { model: 'MatrixNote', tenant } },
        {
          name: 'project_eval',
          arguments: {
            tenant,
            code: "const { default: Note } = await import('#models/matrix_note'); await new Promise(r => setTimeout(r, 75)); return (await Note.query()).map(n => n.body)",
          },
        },
        {
          name: 'http_request',
          arguments: {
            path: '/api/matrix/slow',
            domain: 'matrix.fixture.test',
            surface: 'api',
            tenant,
            as: { userId: tenant === 'a' ? 1 : 2 },
          },
        },
        {
          name: 'http_request',
          arguments: {
            path: '/api/matrix/fast',
            domain: 'matrix.fixture.test',
            surface: 'api',
            tenant,
            as: { userId: tenant === 'a' ? 1 : 2 },
          },
        },
        {
          name: 'http_request',
          arguments: { path: '/matrix-web', domain: 'matrix.fixture.test', surface: 'web', tenant },
        },
      ])
      const results = await Promise.all(calls.map((call) => client.callTool(call)))
      for (const [index, result] of results.entries()) {
        assert.isNotTrue(result.isError, JSON.stringify(result))
        const payload = toolPayload<Envelope>(result)
        if (calls[index].name === 'http_request') {
          assert.equal(payload.data.response?.status, 200)
          if (index % 5 === 2 || index % 5 === 3) {
            const body = payload.data.body!.json
            assert.equal(body.user, index < 5 ? 1 : 2)
            assert.isAbove(body.activeCount, Number(before.credentials.total))
          }
        }
        const text = JSON.stringify(payload.data)
        assert.include(text, index < 5 ? 'A-only' : 'B-only')
        assert.notInclude(text, index < 5 ? 'B-only' : 'A-only')
      }
      const afterResponse = await app.fetch('/matrix-cleanup')
      assert.equal(afterResponse.status, 200)
      const after = (await afterResponse.json()) as typeof before
      assert.equal(Number(after.credentials.total), Number(before.credentials.total))
      assert.deepEqual(after, before)
      // Concurrent SDK HTTP connections remain idle until the app's keep-alive deadline.
      const runtimeAfter = await awaitRuntime(
        app,
        (sample) =>
          (sample.resources.TCPSocketWrap ?? 0) <= (runtimeBefore.resources.TCPSocketWrap ?? 0) + 4
      )
      assert.deepEqual(runtimeAfter.subscribers, runtimeBefore.subscribers)
      assert.equal(runtimeAfter.emitterListeners, runtimeBefore.emitterListeners)
      assert.notProperty(runtimeAfter.resources, 'ProcessWrap')
      for (const [name, count] of Object.entries(runtimeAfter.resources))
        assert.isAtMost(count, (runtimeBefore.resources[name] ?? 0) + 4, name)
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300_000)

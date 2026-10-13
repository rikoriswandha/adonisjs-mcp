import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { TenantService, getTenantContext, runWithTenant } from '@rikology/adonisjs-tenant'
import { TenantDatabaseExecutor } from '@rikology/adonisjs-tenant/database'
import Post from '#models/probe_post'
import type { HttpContext } from '@adonisjs/core/http'
import { middleware } from '#start/kernel'
import { request as nodeRequest } from 'node:http'
import '#start/round2'

const tenants = [{ id: 'a', name: 'Tenant A', slug: 'a' }, { id: 'b', name: 'Tenant B', slug: 'b' }]
const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
const ids = (rows: { tenant_id: string | number }[]) => rows.map((row) => row.tenant_id)
const corpus = [
  'SELECT * FROM sh_posts WHERE tenant_id = ? ORDER BY id',
  'SELECT * FROM sh_posts WHERE tenant_id = ? OR 1=1 ORDER BY id',
  "SELECT * FROM sh_posts /* WHERE tenant_id = 'a' */ ORDER BY id",
  'SELECT * FROM sh_posts WHERE tenant_id = ? UNION SELECT * FROM sh_posts ORDER BY id',
]
const guarded = async (fn: () => Promise<unknown>) => {
  try { return { ok: true, value: await fn() } }
  catch (error: unknown) {
    return {
      ok: false,
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
const identity = async ({ tenant }: HttpContext) => {
  await delay(8)
  return { middlewareTenant: tenant?.id ?? null, alsTenant: getTenantContext()?.id ?? null, rows: ids(await Post.query().orderBy('id')) }
}
router.get('/identity', identity).use(middleware.tenant())
for (const domain of ['a.tenants.test', 'b.tenants.test']) {
  router.get('/domain', identity).domain(domain).use(middleware.tenant())
  router.get('/identity', identity).domain(domain).use(middleware.tenant())
  router.get('/no-middleware', async () => ({ alsTenant: getTenantContext()?.id ?? null })).domain(domain)
}
router.get('/no-middleware', async () => ({ alsTenant: getTenantContext()?.id ?? null }))
router.get('/health', () => ({ ready: true }))
router.get('/scenario', async () => {
  await db.rawQuery('DROP TABLE IF EXISTS sh_posts')
  await db.rawQuery('CREATE TABLE sh_posts (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, overlap INTEGER NOT NULL)')
  await db.table('sh_posts').insert([{ id: 1, tenant_id: 'a', title: 'A private', overlap: 7 }, { id: 2, tenant_id: 'b', title: 'B private', overlap: 7 }])
  const observations: Record<string, unknown> = {
    binding: app.container.hasBinding('tenant.service'),
    bindingMatchesExport: (await app.container.make('tenant.service')) === TenantService,
    modelMissing: await guarded(() => Post.query()),
    outsideBefore: getTenantContext()?.id ?? null,
  }
  observations.concurrent = await Promise.all(tenants.map((tenant, index) => runWithTenant(tenant, async () => {
    await delay(index === 0 ? 20 : 1)
    const model = ids(await Post.query().where('overlap', 7))
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const evalIds = await new AsyncFunction('get', 'delay', 'const before = get().id; await delay(15); await Promise.resolve(); return [before, get().id]')(getTenantContext, delay)
    const raw = []
    for (let n = 0; n < corpus.length; n++) {
      // Comment contains tenant text but no executable predicate or binding.
      const rows = await db.rawQuery(corpus[n], n === 2 ? [] : [tenant.id])
      raw.push({ sql: corpus[n], tenants: ids(rows) })
    }
    const headers: Record<string, string> = process.env.SH_RESOLVER === 'subdomain'
      ? { Host: `${tenant.id}.tenants.test` }
      : { 'X-Tenant-ID': tenant.id }
    const request = async (path: string, extra: Record<string, string>) => {
      const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: unknown }>()
      const outgoing = nodeRequest({ hostname: '127.0.0.1', port: Number(process.env.PORT), path, headers: extra }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: body.startsWith('{') ? JSON.parse(body) : body }))
        response.on('error', reject)
      })
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Loopback timed out')))
      outgoing.on('error', reject)
      outgoing.end()
      return promise
    }
    return {
      tenant: tenant.id, model, evalIds, raw,
      socketNoMiddleware: await request('/no-middleware', headers),
      socketMissing: await request('/identity', {}),
      socketWrong: await request('/identity', process.env.SH_RESOLVER === 'subdomain' ? { Host: 'unknown.tenants.test' } : { 'X-Tenant-ID': 'unknown' }),
      socketMapped: await request('/identity', headers),
      socketMappedOther: await request('/identity', process.env.SH_RESOLVER === 'subdomain' ? { Host: `${tenant.id === 'a' ? 'b' : 'a'}.tenants.test` } : { 'X-Tenant-ID': tenant.id === 'a' ? 'b' : 'a' }),
      socketDomain: process.env.SH_RESOLVER === 'subdomain' ? await request('/domain', headers) : null,
      after: getTenantContext()?.id ?? null,
    }
  })))
  observations.outsideAfter = getTenantContext()?.id ?? null
  // Identity APIs do not validate tenant existence; integration must resolve first.
  observations.unknownProgrammatic = await TenantService.run({ id: 'unknown', name: 'unknown', slug: 'unknown' }, async () => ({ active: TenantService.currentId(), rows: ids(await Post.query()) }))
  const executor = new TenantDatabaseExecutor(db.connection('tenant_pg'))
  observations.rls = await Promise.all(tenants.map((tenant, index) => TenantService.run(tenant, async () => executor.run(async (_tenant, trx) => {
    await delay(index === 0 ? 20 : 1)
    const queries = []
    for (let n = 0; n < corpus.length; n++) {
      const result = await trx.rawQuery(corpus[n], n === 2 ? [] : [tenant.id])
      queries.push({ sql: corpus[n], tenants: ids(result.rows) })
    }
    const session = await trx.rawQuery("SELECT current_user, current_setting('app.tenant_id', true) AS setting")
    return { tenant: tenant.id, queries, session: session.rows }
  }))))
  observations.rlsMissing = await guarded(() => executor.run(async () => true))
  observations.rlsOutside = (await db.connection('tenant_pg').rawQuery('SELECT * FROM sh_posts')).rows
  observations.rlsPoolSetting = (await db.connection('tenant_pg').rawQuery("SELECT nullif(current_setting('app.tenant_id', true), '') AS setting")).rows
  observations.rlsError = await guarded(() => TenantService.run(tenants[0], () => executor.run(async (_tenant, trx) => trx.rawQuery('SELECT * FROM nonexistent_sh_table'))))
  observations.rlsAfterError = await TenantService.run(tenants[1], () => executor.run(async (_tenant, trx) => ids((await trx.rawQuery('SELECT * FROM sh_posts')).rows)))
  observations.rlsContextOverride = await TenantService.run(tenants[0], () => executor.run(async (_tenant, trx) => {
    await trx.rawQuery("SELECT set_config('app.tenant_id', ?, true)", ['b'])
    return { alsTenant: TenantService.currentId(), rows: ids((await trx.rawQuery('SELECT * FROM sh_posts')).rows) }
  }))
  observations.outsideFinal = getTenantContext()?.id ?? null
  return observations
})

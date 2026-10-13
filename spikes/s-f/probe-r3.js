import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { configProvider } from '@adonisjs/core'
import { TenantService, getTenantContext, TenantUserProvider } from '@rikology/adonisjs-tenant'
import User from '#models/user'
import { middleware } from '#start/kernel'
import { writeFile } from 'node:fs/promises'
const named = router.named({ sfTenant: () => import('@rikology/adonisjs-tenant/middleware') })
const tenants = { a: { id: 'a', name: 'Tenant A', slug: 'a' }, b: { id: 'b', name: 'Tenant B', slug: 'b' } }
const tenantUsers = new TenantUserProvider(User, { pivotTable: 'tenant_user' })
const origin = `http://127.0.0.1:${process.env.PORT}`
const delay = async (ms) => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); await promise }
const identity = async (ctx) => {
  const guard = ctx.params.guard || 'api'
  const user = ctx.auth.use(guard).getUserOrFail()
  const tenant = getTenantContext()
  const rows = await db.from('sf3_data').where('tenant_id', tenant.id).select('value')
  const result = { id: user.id, email: user.email, tenant: tenant.id, rows: rows.map((row) => row.value), requestId: ctx.request.id() }
  ctx.logger.info(result, 'S-F3 tenant-aware normal auth middleware')
  if (ctx.params.mode === 'error') throw new Error('S-F3 deliberate app error')
  if (ctx.params.mode === 'slow') await delay(180)
  return result
}
for (const guard of ['api', 'web']) router.get(`/sf3/${guard}/:mode`, async (ctx) => { ctx.params.guard = guard; return identity(ctx) }).use([named.sfTenant(), middleware.auth({ guards: [guard] })])
router.get('/sf3/anonymous', async (ctx) => ({ authenticated: await ctx.auth.use('api').check(), tenant: getTenantContext()?.id ?? null }))
router.get('/sf3/health', () => ({ ready: true }))
router.get('/sf3/run', async (ctx) => {
  const columns = await db.rawQuery('PRAGMA table_info(auth_access_tokens)')
  if (!columns.some((column) => column.name === 'tenant_id')) await db.rawQuery('ALTER TABLE auth_access_tokens ADD COLUMN tenant_id TEXT NULL')
  await db.rawQuery('CREATE TABLE IF NOT EXISTS tenant_user (tenant_id TEXT NOT NULL, user_id INTEGER NOT NULL, UNIQUE(tenant_id,user_id))')
  await db.rawQuery('CREATE TABLE IF NOT EXISTS sf3_data (tenant_id TEXT NOT NULL, value TEXT NOT NULL)')
  await db.from('sf3_data').delete()
  await db.table('sf3_data').insert([{ tenant_id: 'a', value: 'A-private' }, { tenant_id: 'b', value: 'B-private' }])
  const users = {
    a: await User.create({ email: `sf3-a-${Date.now()}@example.test`, fullName: 'User A', password: 'probe-password' }),
    b: await User.create({ email: `sf3-b-${Date.now()}@example.test`, fullName: 'User B', password: 'probe-password' }),
  }
  await db.table('tenant_user').insert([{ tenant_id: 'a', user_id: users.a.id }, { tenant_id: 'b', user_id: users.b.id }])
  const secrets = []; const observations = []
  const call = async (path, headers = {}, signal) => {
    const response = await fetch(origin + path, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal })
    const body = await response.json()
    return { status: response.status, body: response.status === 500 ? { message: body.message } : body }
  }
  const select = async (tenantId, userId) => {
    const tenant = tenants[tenantId]
    if (!tenant) throw new Error('TENANT_NOT_FOUND')
    const user = await tenantUsers.findById(tenant, userId)
    if (!user) throw new Error('TENANT_MEMBERSHIP_DENIED')
    return { tenant, user }
  }
  const count = async () => Number((await db.from('auth_access_tokens').count('* as total').first()).total)
  try {
    try { await select('b', users.a.id) } catch (error) { observations.push({ mismatchBeforeMint: error.message, tokenRows: await count() }) }
    for (const [tenantId, mode] of [['a', 'success'], ['b', 'success'], ['a', 'error'], ['a', 'abort']]) {
      const before = await count()
      const selected = await select(tenantId, users[tenantId].id)
      const result = await TenantService.run(selected.tenant, async () => {
        const token = await User.accessTokens.create(selected.user, ['sf3:probe'], { expiresIn: '60 seconds' })
        const bearer = token.value.release(); secrets.push(bearer, `Bearer ${bearer}`)
        const row = await db.from('auth_access_tokens').where('id', token.identifier).first()
        try {
          let http
          const controller = new AbortController()
          if (mode === 'abort') setTimeout(() => controller.abort(), 40)
          try { http = await call(`/sf3/api/${mode === 'abort' ? 'slow' : mode}`, { Authorization: `Bearer ${bearer}`, 'X-Tenant-ID': tenantId }, mode === 'abort' ? controller.signal : undefined) }
          catch (error) { http = { error: error.name } }
          const crossTenant = mode === 'success' ? await call('/sf3/api/success', { Authorization: `Bearer ${bearer}`, 'X-Tenant-ID': tenantId === 'a' ? 'b' : 'a' }) : null
          return { tokenTenant: row.tenant_id, http, crossTenant }
        } finally { await User.accessTokens.delete(selected.user, token.identifier) }
      })
      observations.push({ guard: 'api', tenant: tenantId, mode, expectedId: selected.user.id, before, after: await count(), ...result })
    }
    const config = await configProvider.resolve(app, app.config.get('session'))
    for (const tenantId of ['a', 'b']) {
      const selected = await select(tenantId, users[tenantId].id)
      await TenantService.run(selected.tenant, async () => {
        const authData = await ctx.auth.use('web').authenticateAsClient(selected.user)
        const id = crypto.randomUUID(); const store = config.stores.cookie(ctx, config)
        await store.write(id, authData.session); ctx.response.cookie(config.cookieName, id, config.cookie)
        const header = ctx.response.getHeader('set-cookie')
        const cookies = (Array.isArray(header) ? header : [header]).map((cookie) => cookie.split(';')[0])
        const cookie = cookies.join('; '); secrets.push(cookie, ...cookies.map((pair) => pair.slice(pair.indexOf('=') + 1)))
        ctx.response.removeHeader('set-cookie')
        try {
          observations.push({ guard: 'web', tenant: tenantId, expectedId: selected.user.id, http: await call('/sf3/web/success', { Cookie: cookie, 'X-Tenant-ID': tenantId }), crossTenant: await call('/sf3/web/success', { Cookie: cookie, 'X-Tenant-ID': tenantId === 'a' ? 'b' : 'a' }) })
        } finally { await store.destroy(id); ctx.response.removeHeader('set-cookie') }
      })
    }
    await delay(220)
    const anonymous = await call('/sf3/anonymous')
    const anonymousProtected = await call('/sf3/api/success', { 'X-Tenant-ID': 'a' })
    await writeFile(app.makePath('sf3-sensitive.json'), JSON.stringify(secrets.filter((value) => value.length > 32)))
    return { expectedUsers: { a: users.a.id, b: users.b.id }, observations, anonymous, anonymousProtected, callerTenantAfter: getTenantContext()?.id ?? null, finalTokenRows: await count() }
  } finally {
    ctx.response.removeHeader('set-cookie')
    await db.from('tenant_user').whereIn('user_id', [users.a.id, users.b.id]).delete()
    await users.a.delete(); await users.b.delete()
  }
})

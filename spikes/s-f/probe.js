import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { configProvider } from '@adonisjs/core'
import { stores } from '@adonisjs/session'
import { middleware } from '#start/kernel'
import User from '#models/user'
import vine from '@vinejs/vine'
import { mkdir, readdir } from 'node:fs/promises'

const api = process.env.SF_KIT === 'api'
const origin = `http://127.0.0.1:${process.env.PORT}`
const validator = vine.compile(vine.object({ title: vine.string().minLength(3) }))
const events = []
const jar = new Map()
function absorb(headers) {
  for (const cookie of headers.getSetCookie()) {
    const pair = cookie.split(';')[0]; const at = pair.indexOf('=')
    jar.set(pair.slice(0, at), pair.slice(at + 1))
  }
}
async function call(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers }
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(origin + path, { ...options, headers, redirect: 'manual' })
  absorb(res.headers)
  const text = await res.text()
  let body; try { body = JSON.parse(text) } catch { body = text.slice(0, 100) }
  return { status: res.status, location: res.headers.get('location'), body }
}
router.get('/sf/identity/:mode', async (ctx) => {
  const user = ctx.auth.use(api ? 'api' : 'web').getUserOrFail()
  const event = { middleware: 'auth-passed', id: user.id, requestId: ctx.request.id(), mode: ctx.params.mode }
  events.push(event)
  ctx.logger.info(event, 'S-F normal protected middleware')
  if (ctx.params.mode === 'error') throw new Error('S-F deliberate application failure')
  if (ctx.params.mode === 'slow') { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, 180); await promise }
  return event
}).use(middleware.auth({ guards: [api ? 'api' : 'web'] }))
router.get('/sf/csrf', ({ request }) => ({ csrfToken: request.csrfToken }))
router.post('/sf/post', ({ auth }) => ({ id: auth.use('web').getUserOrFail().id })).use(middleware.auth({ guards: ['web'] }))
router.post('/sf/validate', async ({ request, response }) => {
  await request.validateUsing(validator)
  return response.redirect('/sf/page')
}).use(middleware.auth({ guards: ['web'] }))
router.get('/sf/page', (ctx) => ctx.inertia.render('home', { flashErrors: ctx.session.flashMessages.get('inputErrorsBag') })).use(middleware.auth({ guards: ['web'] }))

router.get('/sf/run', async (ctx) => {
  const user = await User.firstOrCreate({ email: 'sf-probe@example.test' }, { fullName: 'Spike F', password: 'probe-only-password' })
  const observations = []
  const selectUser = async (guard, id) => {
    if (!['web', ...(api ? ['api'] : [])].includes(guard)) throw new Error('CAPABILITY_UNSUPPORTED')
    const found = await User.find(id)
    if (!found) throw new Error('NOT_FOUND')
    return found
  }
  try {
    observations.push({ anonymous: await call('/sf/identity/success') })
    for (const [guard, id] of [['unsupported', user.id], [api ? 'api' : 'web', -1]]) {
      try { await selectUser(guard, id) } catch (error) { observations.push({ guard, error: error.message }) }
    }
    if (api) {
      for (const mode of ['success', 'error', 'timeout', 'abort']) {
        const before = Number((await db.from('auth_access_tokens').count('* as total').first()).total)
        const token = await User.accessTokens.create(user, ['sf:probe'], { expiresIn: '60 seconds', name: 'sf-disposable' })
        let result
        try {
          const controller = new AbortController()
          if (mode === 'abort') setTimeout(() => controller.abort(), 40)
          result = await call(`/sf/identity/${['timeout', 'abort'].includes(mode) ? 'slow' : mode}`, {
            headers: { Authorization: `Bearer ${token.value.release()}` },
            signal: mode === 'timeout' ? AbortSignal.timeout(40) : mode === 'abort' ? controller.signal : undefined,
          })
        } catch (error) { result = { error: error.name } }
        finally { await User.accessTokens.delete(user, token.identifier) }
        const after = Number((await db.from('auth_access_tokens').count('* as total').first()).total)
        observations.push({ guard: 'api', mode, result, before, after, tokenRemoved: !await db.from('auth_access_tokens').where('id', token.identifier).first() })
      }
    } else {
      const config = await configProvider.resolve(app, app.config.get('session'))
      const authData = await ctx.auth.use('web').authenticateAsClient(user)
      for (const mode of ['success', 'error', 'timeout', 'abort']) {
        jar.clear()
        const id = crypto.randomUUID()
        const store = config.stores.cookie(ctx, config)
        await store.write(id, authData.session)
        ctx.response.cookie(config.cookieName, id, config.cookie)
        const minted = ctx.response.getHeader('set-cookie')
        for (const cookie of minted) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)) }
        ctx.response.removeHeader('set-cookie')
        let result
        let replayCookie
        try {
          const controller = new AbortController()
          if (mode === 'abort') setTimeout(() => controller.abort(), 40)
          result = await call(`/sf/identity/${['timeout', 'abort'].includes(mode) ? 'slow' : mode}`, { signal: mode === 'timeout' ? AbortSignal.timeout(40) : mode === 'abort' ? controller.signal : undefined })
          if (mode === 'success') {
            const csrf = await call('/sf/csrf')
            observations.push({ csrfMissing: await call('/sf/post', { method: 'POST' }) })
            const token = csrf.body.csrfToken
            observations.push({ csrfValid: await call('/sf/post', { method: 'POST', headers: { 'x-csrf-token': token } }) })
            const xsrf = jar.get('XSRF-TOKEN')
            observations.push({ xsrfValid: await call('/sf/post', { method: 'POST', headers: { 'x-xsrf-token': xsrf } }) })
            const invalid = await call('/sf/validate', { method: 'POST', headers: { 'X-Inertia': 'true', Accept: 'text/html', 'Content-Type': 'application/json', 'x-csrf-token': token, Referer: origin + '/sf/page' }, body: JSON.stringify({ title: '' }) })
            const page = invalid.location ? await call(new URL(invalid.location, origin).pathname, { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': ctx.inertia.getVersion(), Accept: 'text/html' } }) : null
            observations.push({ invalid: { status: invalid.status, location: invalid.location }, validation: page ? { status: page.status, errors: page.body.props?.errors, flashErrors: page.body.props?.flashErrors } : null })
            replayCookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
          }
        } catch (error) { result = { error: error.name } }
        finally { await store.destroy(id); jar.clear(); ctx.response.removeHeader('set-cookie') }
        observations.push({ guard: 'web', mode, result, jarSizeAfter: jar.size, serverStore: 'cookie: no server-side record' })
        if (replayCookie) { observations.push({ cookieReplayAfterDiscard: await call('/sf/identity/replay', { headers: { Cookie: replayCookie } }) }); jar.clear(); replayCookie = undefined }
      }
      for (const kind of ['memory', 'file']) {
        const location = app.makePath('tmp/sf-sessions'); await mkdir(location, { recursive: true })
        const factory = kind === 'memory' ? config.stores.memory : await configProvider.resolve(app, stores.file({ location }))
        const store = factory(ctx, config); const id = crypto.randomUUID()
        await store.write(id, authData.session)
        const before = await store.read(id)
        await store.destroy(id)
        observations.push({ store: kind, existed: !!before, after: await store.read(id), filesAfter: kind === 'file' ? await readdir(location) : undefined })
      }
    }
    const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, 220); await promise
    return { kit: process.env.SF_KIT, expectedId: user.id, observations, middlewareEvents: events }
  } finally { jar.clear(); ctx.response.removeHeader('set-cookie'); await user.delete() }
})

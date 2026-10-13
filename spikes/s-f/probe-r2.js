import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import encryption from '@adonisjs/core/services/encryption'
import { configProvider } from '@adonisjs/core'
import User from '#models/user'
import { writeFile } from 'node:fs/promises'
const delay = async (ms) => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); await promise }
router.get('/sf/inspect', ({ request, session }) => {
  const id = request.cookie('adonis-session')
  const value = id ? request.encryptedCookie(id) : undefined
  return { idFound: !!id, valueType: typeof value, keys: value ? Object.keys(value) : [], sessionKeys: Object.keys(session.all()) }
})
router.get('/sf/round2', async (ctx) => {
  const user = await User.create({ email: `sf-r2-${Date.now()}@example.test`, fullName: 'Round Two', password: 'sf-real-login-password' })
  const config = await configProvider.resolve(app, app.config.get('session'))
  const origin = `http://127.0.0.1:${process.env.PORT}`
  const jar = new Map(); const secrets = []
  const remember = (value) => { if (typeof value === 'string' && value.length > 32) secrets.push(value); return value }
  const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
  const capture = () => {
    const header = ctx.response.getHeader('set-cookie')
    for (const cookie of Array.isArray(header) ? header : [header]) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); jar.set(pair.slice(0, at), remember(pair.slice(at + 1))) }
    ctx.response.removeHeader('set-cookie')
  }
  const call = async (path, options = {}) => {
    const response = await fetch(origin + path, { ...options, redirect: 'manual', headers: { Accept: 'application/json', Cookie: cookieHeader(), ...options.headers } })
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); jar.set(pair.slice(0, at), remember(pair.slice(at + 1))) }
    const text = await response.text(); let body; try { body = JSON.parse(text) } catch { body = text.slice(0, 80) }
    return { status: response.status, location: response.headers.get('location'), body }
  }
  const mint = (key, value, ttl) => {
    const packed = remember(`e:${encryption.encrypt(value, ttl, key)}`)
    ctx.response.plainCookie(key, packed, { ...config.cookie, stringify: false })
    capture()
  }
  try {
    const id = crypto.randomUUID()
    const authData = await ctx.auth.use('web').authenticateAsClient(user)
    mint(id, authData.session, '2 seconds')
    ctx.response.cookie(config.cookieName, id, config.cookie)
    capture()
    const original = remember(cookieHeader())
    const inspection = await call('/sf/inspect', { headers: { Cookie: original } })
    const during = await call('/sf/identity/bounded-before', { headers: { Cookie: original } })
    const csrf = await call('/sf/csrf')
    const xsrfValue = jar.get('XSRF-TOKEN')
    const decodedXsrf = decodeURIComponent(xsrfValue).slice(2)
    const csrfPlain = encryption.decrypt(decodedXsrf, 'XSRF-TOKEN')
    const boundedXsrf = remember(encodeURIComponent(`e:${encryption.encrypt(csrfPlain, '2 seconds', 'XSRF-TOKEN')}`))
    const xsrfDuring = await call('/sf/post', { method: 'POST', headers: { 'x-xsrf-token': boundedXsrf } })
    // Server normal session commit rewrites the session cookie without embedded expiry.
    const refreshed = remember(cookieHeader())
    await delay(2200)
    jar.clear()
    const expiredOriginal = await call('/sf/identity/bounded-after', { headers: { Cookie: original } })
    jar.clear()
    const refreshedReplay = await call('/sf/identity/refreshed-after', { headers: { Cookie: refreshed } })
    const xsrfAfter = await call('/sf/post', { method: 'POST', headers: { Cookie: refreshed, 'x-xsrf-token': boundedXsrf } })
    // Rewrap the authenticated response session value, using the original cookie-purpose ID.
    const refreshedPairs = new Map(refreshed.split('; ').map((pair) => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)] }))
    const sessionBag = encryption.decrypt(decodeURIComponent(refreshedPairs.get(id)).slice(2), id)
    jar.clear(); mint(id, sessionBag, '1 second')
    const clampedData = jar.get(id)
    refreshedPairs.set(id, clampedData)
    const clampedHeader = remember([...refreshedPairs].map(([key, value]) => `${key}=${value}`).join('; '))
    const clampedBefore = await call('/sf/identity/clamped-before', { headers: { Cookie: clampedHeader } })
    await delay(1200); jar.clear()
    const clampedAfter = await call('/sf/identity/clamped-after', { headers: { Cookie: clampedHeader } })
    // Kit's actual credential-based login/logout, not authenticateAsClient.
    jar.clear()
    const loginCsrf = await call('/sf/csrf')
    const login = await call('/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': loginCsrf.body.csrfToken }, body: JSON.stringify({ email: user.email, password: 'sf-real-login-password' }) })
    const loggedIn = await call('/sf/identity/real-login')
    const logoutCsrf = await call('/sf/csrf')
    const copiedLogin = remember(cookieHeader())
    const logout = await call('/logout', { method: 'POST', headers: { 'x-csrf-token': logoutCsrf.body.csrfToken } })
    const afterLogout = await call('/sf/identity/real-logout')
    jar.clear()
    const logoutReplay = await call('/sf/identity/logout-replay', { headers: { Cookie: copiedLogin } })
    await writeFile(app.makePath('sf-sensitive-r2.json'), JSON.stringify(secrets))
    return { inspection, expectedId: user.id, during, expiredOriginal, refreshedReplay, xsrfDuring, xsrfAfter, clampedBefore, clampedAfter, login: { status: login.status, location: login.location }, loggedIn, logout: { status: logout.status, location: logout.location }, afterLogout, logoutReplay, csrfReadSucceeded: typeof csrf.body.csrfToken === 'string', returnedCredentialHeaders: false }
  } finally { jar.clear(); ctx.response.removeHeader('set-cookie'); await user.delete() }
})

router.get('/sf/round2-token', async (ctx) => {
  const user = await User.create({ email: `sf-r2-token-${Date.now()}@example.test`, fullName: 'Round Two Token', password: 'sf-probe-password' })
  const token = await User.accessTokens.create(user, ['sf:probe'], { expiresIn: '10 seconds' })
  const bearer = token.value.release()
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/sf/identity/token-exposure`, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, redirect: 'manual' })
    const body = await response.json()
    await writeFile(app.makePath('sf-sensitive-r2.json'), JSON.stringify([bearer, `Bearer ${bearer}`]))
    return { expectedId: user.id, result: { status: response.status, body }, returnedCredentialHeaders: false }
  } finally { await User.accessTokens.delete(user, token.identifier); await user.delete() }
})

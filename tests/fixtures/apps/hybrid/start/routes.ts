/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

router.on('/').renderInertia('home', {}).as('home')

router
  .group(() => {
    router.get('signup', [controllers.NewAccount, 'create'])
    router.post('signup', [controllers.NewAccount, 'store'])

    router.get('login', [controllers.Session, 'create'])
    router.post('login', [controllers.Session, 'store'])
  })
  .use(middleware.guest())

router
  .group(() => {
    router.on('/dashboard').renderInertia('dashboard', {}).as('dashboard')
    router.post('logout', [controllers.Session, 'destroy'])
  })
  .use(middleware.auth())

/*
|--------------------------------------------------------------------------
| Fixture routes (adonisjs-mcp http_request)
|--------------------------------------------------------------------------
|
| A hybrid surface: Inertia pages behind the session guard, JSON routes
| behind the token guard, the same path on two methods and on two domains,
| an Edge page, validation through the session flash, failures, slow
| handlers and an echo of the request headers.
|
*/

import app from '@adonisjs/core/services/app'
import vine from '@vinejs/vine'
import { setTimeout as sleep } from 'node:timers/promises'

const noteValidator = vine.compile(vine.object({ title: vine.string().minLength(3) }))

router.get('/__fixture/environment', () => ({ nodeEnv: app.nodeEnvironment, inDev: app.inDev }))

router.get('/__fixture/whoami', async ({ auth }) => ({
  web: (await auth.use('web').check()) ? auth.use('web').user!.id : null,
  api: (await auth.use('api').check()) ? auth.use('api').user!.id : null,
}))

router.get('/__fixture/echo', ({ request }) => ({
  headers: request.headers(),
  seen: Object.values(request.headers()),
}))

router
  .post('/__fixture/notes', async ({ request, response, session }) => {
    const { title } = await request.validateUsing(noteValidator)
    session.flash('success', `Saved ${title}`)
    return response.redirect().toPath('/dashboard')
  })
  .use(middleware.auth())

router
  .get('/__fixture/reports', ({ inertia }) => inertia.render('dashboard', { report: 'web' }))
  .use(middleware.auth({ guards: ['web'] }))
router
  .post('/__fixture/reports', ({ auth }) => ({ report: 'api', userId: auth.use('api').user!.id }))
  .use(middleware.auth({ guards: ['api'] }))

router.get('/status', ({ inertia }) => inertia.render('home', { status: 'root' }))
router.get('/status', () => ({ status: 'api-domain' })).domain('api.fixture.test')

router.get('/__fixture/html', ({ view }) => view.render('fixture_page'))

router.get('/__fixture/big', ({ response }) => {
  response.type('text/plain').send('x'.repeat(4 * 1024 * 1024))
})

router.get('/__fixture/fail/:id', ({ params, logger }) => {
  logger.info({ failure: params.id }, 'fixture failure requested')
  throw new Error(`Fixture failure ${params.id}`)
})

router.get('/__fixture/redirect/:target', ({ params, response }) => {
  const targets: Record<string, string> = {
    mcp: '/__adonis/mcp',
    encoded: '/__adonis/%6Dcp',
    external: 'http://evil.test/steal',
    whoami: '/__fixture/whoami',
  }
  return response.redirect(targets[params.target] ?? '/')
})

router
  .group(() => {
    router.get('me', ({ auth }) => {
      const user = auth.use('api').user!
      return { id: user.id, email: user.email }
    })
    router.get('slow', async ({ auth }) => {
      await sleep(3000)
      return { id: auth.use('api').user!.id }
    })
    router.get('fail', () => {
      throw new Error('Fixture API failure')
    })
  })
  .prefix('/api/v1')
  .use(middleware.auth({ guards: ['api'] }))

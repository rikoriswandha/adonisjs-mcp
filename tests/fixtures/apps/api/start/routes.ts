/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'
import db from '@adonisjs/lucid/services/db'
import { controllers } from '#generated/controllers'

router.get('/', () => {
  return { hello: 'world' }
})

/**
 * Fixture harness probe: reports how the process was classified and which
 * database connection it uses.
 */
router.get('/__fixture/environment', () => {
  return {
    nodeEnv: app.nodeEnvironment,
    inDev: app.inDev,
    inTest: app.inTest,
    inProduction: app.inProduction,
    dbConnection: db.primaryConnectionName,
  }
})

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.post('login', [controllers.AccessTokens, 'store'])
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())
  })
  .prefix('/api/v1')

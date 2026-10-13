import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'

router.get('/', () => {
  return { hello: 'world' }
})

/** Fixture harness probe for the process environment classification. */
router.get('/__fixture/environment', () => {
  return {
    nodeEnv: app.nodeEnvironment,
    inDev: app.inDev,
    inTest: app.inTest,
    inProduction: app.inProduction,
  }
})

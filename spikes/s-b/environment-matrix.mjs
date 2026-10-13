import { Ignitor } from '@adonisjs/core'
const root = new URL('./', import.meta.url)
for (const environment of ['web','console','repl','test']) {
  const app = new Ignitor(root, { importer: (specifier) => specifier.startsWith('.') ? import(new URL(specifier,root).href) : import(specifier) }).createApp(environment)
  await app.init()
  app.booting(() => import('#start/env'))
  await app.boot()
  console.log('SB_ENVIRONMENT', JSON.stringify({NODE_ENV:process.env.NODE_ENV, environment:app.getEnvironment(), inDev:app.inDev, inProduction:app.inProduction, inTest:app.inTest}))
  await app.terminate()
}

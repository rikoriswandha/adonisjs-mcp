import type { ApplicationService } from '@adonisjs/core/types'
import { channel } from 'node:diagnostics_channel'
import { attach, detach, snapshot } from './capture.js'

export default class CaptureProvider {
  private diagnostic = channel('tracing:adonisjs.http.exception.handler:start')
  private diagnosticCount = 0
  private diagnosticKeys: string[] = []
  private listener = (message: unknown) => {
    this.diagnosticCount++
    this.diagnosticKeys = Object.keys(message as object)
  }
  constructor(private app: ApplicationService) {}
  async boot() {
    attach(); attach()
    this.diagnostic.subscribe(this.listener)
    const router = await this.app.container.make('router')
    const logger = await this.app.container.make('logger')
    router.get('/probe/work/:id', async (ctx) => {
      const id = ctx.params.id
      ctx.logger.info({ probe: true, id, event: 'request' }, 'probe request')
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, Number(id) % 5)
      await promise
      ctx.logger.child({ component: 'probe-child' }).info({ probe: true, id, event: 'child' }, 'probe child')
      logger.info({ probe: true, id, event: 'root' }, 'probe root')
      if (Number(id) % 3 === 0) throw new Error(`probe-error-${id}`)
      return { id, request_id: ctx.request.id() }
    })
    router.get('/probe/state', () => ({ ...snapshot(), diagnosticCount: this.diagnosticCount, diagnosticKeys: this.diagnosticKeys }))
    router.get('/probe/detach', () => {
      detach(); detach(); this.diagnostic.unsubscribe(this.listener)
      return { ...snapshot(), diagnosticSubscribers: this.diagnostic.hasSubscribers }
    })
  }
  shutdown() {
    detach(); this.diagnostic.unsubscribe(this.listener)
    process.stdout.write('SC_SHUTDOWN ' + JSON.stringify({ ...snapshot(), diagnosticSubscribers: this.diagnostic.hasSubscribers }) + '\n')
  }
}

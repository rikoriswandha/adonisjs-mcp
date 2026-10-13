import { BaseCommand, args } from '@adonisjs/core/ace'
import { setTimeout as delay } from 'node:timers/promises'

export default class HmrProbe extends BaseCommand {
  static commandName = 'spike:hmr'
  @args.string() declare name: string
  async run() {
    console.log(JSON.stringify({ phase: 'before-generator', pid: process.pid, time: Date.now() }))
    await this.kernel.exec('make:controller', [this.name])
    console.log(JSON.stringify({ phase: 'after-generator', pid: process.pid, time: Date.now() }))
    await delay(12000)
    console.log(JSON.stringify({ phase: 'after-delay', pid: process.pid, time: Date.now() }))
  }
}

import { BaseCommand, args } from '@adonisjs/core/ace'
import { spawn } from 'node:child_process'

export default class SpikeProbe extends BaseCommand {
  static commandName = 'spike:probe'
  static description = 'Disposable S-J observation command'
  @args.string() declare mode: string
  @args.string({ required: false }) declare value?: string
  async run() {
    if (this.mode === 'prompt') {
      const answer = await this.prompt.confirm('Continue spike?')
      console.log(JSON.stringify({ answer }))
      return
    }
    if (this.mode === 'large') {
      process.stdout.write('O'.repeat(100000))
      process.stderr.write('E'.repeat(100000))
      return
    }
    if (this.mode === 'sleep') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log(JSON.stringify({ childPid: child.pid, pid: process.pid }))
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 60000)
      await promise
      return
    }
    if (this.mode === 'state') {
      process.env.SJ_SENTINEL = 'changed-by-command'
      console.log('COMMAND_STDOUT')
      console.error('COMMAND_STDERR')
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 600)
      await promise
      return
    }
    console.log(JSON.stringify({ cwd: process.cwd(), root: this.app.appRoot.href, value: this.value,
      port: process.env.PORT, host: process.env.HOST, nodeEnv: process.env.NODE_ENV,
      stdinTTY: Boolean(process.stdin.isTTY), pid: process.pid }))
    console.error('SEPARATE_STDERR')
  }
}

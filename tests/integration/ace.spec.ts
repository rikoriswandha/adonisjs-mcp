import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import type { AceResult } from '../../src/ace/ace_watchdog.js'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

const PROBE = `import { BaseCommand, args } from '@adonisjs/core/ace'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export default class extends BaseCommand {
  static commandName = 'fixture:probe'
  @args.string() declare mode: string
  @args.string({ required: false }) declare value: string
  async run() {
    if (this.mode === 'echo') console.log(JSON.stringify({ value: this.value }))
    if (this.mode === 'large') {
      process.stdout.write('é'.repeat(600000))
      process.stderr.write('界'.repeat(400000))
    }
    if (this.mode === 'prompt') {
      const answer = await this.prompt.confirm('Continue fixture?')
      console.log(JSON.stringify({ answer }))
    }
    if (this.mode === 'sleep') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      const pids = { command: process.pid, child: child.pid, watchdog: process.ppid }
      writeFileSync(this.value, JSON.stringify(pids))
      console.log(JSON.stringify(pids))
      const sleeping = Promise.withResolvers<void>()
      setTimeout(sleeping.resolve, 60000)
      await sleeping.promise
    }
    if (this.mode === 'escape') {
      const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'inherit',
      })
      escaped.unref()
      writeFileSync(this.value, JSON.stringify({ escaped: escaped.pid }))
      console.log('escaped started')
    }
  }
}
`
interface Envelope {
  data: AceResult & { argv: string[] }
  limitations: string[]
}
interface Pids {
  command: number
  child: number
  watchdog: number
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function pidsAt(path: string): Promise<Pids> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8')) as Pids
    await delay(100)
  }
  throw new Error('Probe did not start')
}
async function waitGone(pids: Pids) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (Object.values(pids).every((pid) => !alive(pid))) return
    await delay(100)
  }
  throw new Error(`Owned processes survived: ${JSON.stringify(pids)}`)
}
async function prepare() {
  const fixture = await FixtureApp.create('api')
  try {
    await mkdir(join(fixture.root, 'commands'), { recursive: true })
    await writeFile(join(fixture.root, 'commands/probe.ts'), PROBE)
    await installPackage(fixture)
    await writeMcpConfig(fixture, 'tools: { ace: { timeout: 15000 } },')
    const app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    return { fixture, app, client }
  } catch (error) {
    await fixture.dispose()
    throw error
  }
}
async function call(client: Client, arguments_: Record<string, unknown>) {
  return client.callTool({ name: 'run_ace_command', arguments: arguments_ })
}

test.group('Ace | owned console subprocess', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  let client: Client
  group.setup(async () => {
    ;({ fixture, app, client } = await prepare())
    return async () => {
      await client.close()
      await fixture.dispose()
    }
  })
  test('routes, generator, failures and literal argv preserve real console behavior', async ({
    assert,
  }) => {
    const routes = toolPayload<Envelope>(
      await call(client, { command: 'list:routes', flags: { json: true } })
    )
    assert.equal(routes.data.exitCode, 0)
    assert.isArray(JSON.parse(routes.data.stdout))
    assert.include(routes.data.stdout, '/')
    assert.deepEqual(routes.data.argv, ['list:routes', '--json'])
    const generated = toolPayload<Envelope>(
      await call(client, { command: 'make:controller', args: ['ace_fixture'] })
    )
    assert.equal(generated.data.exitCode, 0)
    assert.include(
      await readFile(join(fixture.root, 'app/controllers/ace_fixtures_controller.ts'), 'utf8'),
      'class'
    )
    const unknown = toolPayload<Envelope>(await call(client, { command: 'does:not:exist' }))
    assert.equal(unknown.data.exitCode, 1)
    assert.include(unknown.data.stderr, 'does:not:exist')
    const missing = toolPayload<Envelope>(await call(client, { command: 'make:controller' }))
    assert.notEqual(missing.data.exitCode, 0)
    const literal = '; touch X $(echo bad) | cat & > file'
    const echoed = toolPayload<Envelope>(
      await call(client, { command: 'fixture:probe', args: ['echo', literal] })
    )
    assert.equal(JSON.parse(echoed.data.stdout).value, literal)
    assert.isFalse(existsSync(join(fixture.root, 'X')))
  }).timeout(60000)
  test('deadline kills the command and child while HTTP remains responsive', async ({ assert }) => {
    const path = join(fixture.root, 'timeout-pids.json')
    const pending = call(client, { command: 'fixture:probe', args: ['sleep', path], timeout: 2000 })
    const pids = await pidsAt(path)
    const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) })
    assert.isBelow(response.status, 500)
    const result = await pending
    assert.isTrue(result.isError)
    assert.include(JSON.stringify(result.content), 'TIMEOUT')
    assert.include(JSON.stringify(result.content), String(pids.command))
    await waitGone(pids)
  }).timeout(20000)
  test('large pipes drain with UTF-8-safe bounded retained output', async ({ assert }) => {
    const raw = await call(client, { command: 'fixture:probe', args: ['large'] })
    const result = toolPayload<Envelope>(raw)
    assert.equal(result.data.exitCode, 0)
    assert.isTrue(result.data.truncated.stdout)
    assert.isTrue(result.data.truncated.stderr)
    assert.isAbove(result.data.bytes.stdout, 1000000)
    assert.isAbove(result.data.bytes.stderr, 1000000)
    assert.notInclude(result.data.stdout + result.data.stderr, '\uFFFD')
    assert.isBelow(Buffer.byteLength(JSON.stringify(raw)), 262144)
  }).timeout(20000)
  test('closed stdin prompt exits zero without claiming completion', async ({ assert }) => {
    const result = toolPayload<Envelope>(
      await call(client, { command: 'fixture:probe', args: ['prompt'], timeout: 5000 })
    )
    assert.equal(result.data.exitCode, 0)
    assert.include(result.data.stdout, 'Continue fixture?')
    assert.notInclude(result.data.stdout, '"answer"')
    assert.isTrue(result.limitations.some((item) => item.includes('exit 0')))
  }).timeout(15000)
  test('rejects invalid names, option-like positionals and excessive timeout', async ({
    assert,
  }) => {
    for (const input of [
      { command: '../ace' },
      { command: 'list', flags: { 'x;touch': true } },
      { command: 'list', args: ['--json'] },
      { command: 'list', timeout: 15001 },
    ]) {
      const result = await call(client, input)
      assert.isTrue(result.isError)
      assert.include(JSON.stringify(result.content), 'INPUT_INVALID')
    }
  })
  test('cancellation kills the owned process tree', async ({ assert }) => {
    const path = join(fixture.root, 'cancel-pids.json')
    const controller = new AbortController()
    const pending = client
      .callTool(
        { name: 'run_ace_command', arguments: { command: 'fixture:probe', args: ['sleep', path] } },
        { signal: controller.signal }
      )
      .catch((error: unknown) => error)
    const pids = await pidsAt(path)
    controller.abort()
    assert.exists(await pending)
    await waitGone(pids)
  }).timeout(20000)
  test('a process escaping the group cannot hold the result past the command exit', async ({
    assert,
  }) => {
    const path = join(fixture.root, 'escape-pid.json')
    const started = Date.now()
    const raw = await call(client, {
      command: 'fixture:probe',
      args: ['escape', path],
      timeout: 10000,
    })
    const { escaped } = JSON.parse(await readFile(path, 'utf8')) as { escaped: number }
    try {
      const result = toolPayload<Envelope>(raw)
      assert.equal(result.data.exitCode, 0)
      assert.equal(result.data.outcome, 'exited')
      assert.isTrue(result.data.streamsForcedClosed)
      assert.include(result.data.stdout, 'escaped started')
      assert.isBelow(Date.now() - started, 9000)
    } finally {
      process.kill(escaped, 'SIGKILL')
    }
  }).timeout(20000)
})

test('Ace | HTTP SIGKILL interrupts transport but watchdog independently cleans up', async ({
  assert,
}) => {
  const { fixture, app, client } = await prepare()
  try {
    const path = join(fixture.root, 'death-pids.json')
    const pending = call(client, { command: 'fixture:probe', args: ['sleep', path] }).then(
      () => false,
      () => true
    )
    const pids = await pidsAt(path)
    process.kill(app.pid, 'SIGKILL')
    assert.isTrue(await pending)
    await waitGone(pids)
  } finally {
    await client.close()
    await fixture.dispose()
  }
}).timeout(120000)

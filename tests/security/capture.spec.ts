import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import { installPackage, waitForMcp, DEFAULT_PATH, toolPayload } from '../helpers/mcp_endpoint.js'

test('Security | configured logger seams compose and exception report failures have an explicit boundary', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('api')
  const sentinel = 'capture-secret-30fc9caa5fa04051'
  try {
    await installPackage(fixture)
    const env = join(fixture.root, '.env')
    await writeFile(env, `${await readFile(env, 'utf8')}CAPTURE_PASSWORD=${sentinel}\n`)
    const envSchema = join(fixture.root, 'start', 'env.ts')
    const envSource = await readFile(envSchema, 'utf8')
    await writeFile(
      envSchema,
      envSource.replace(/\}\)\s*$/, '  CAPTURE_PASSWORD: Env.schema.string(),\n})\n')
    )
    await writeFile(
      join(fixture.root, 'config', 'logger.ts'),
      `import { defineConfig, syncDestination, targets } from '@adonisjs/core/logger'
const destination = await syncDestination()
const loggerConfig = defineConfig({ default: 'app', loggers: {
  app: { enabled: true, name: 'app', level: 'info', destination, hooks: { streamWrite: (line: string) => line.replaceAll('seamprobe', 'composed-seamprobe') } },
  named: { enabled: true, name: 'named', level: 'info', destination, hooks: { streamWrite: (line: string) => streamWrite(line) } },
  worker: { enabled: true, name: 'worker', level: 'info', transport: { targets: [targets.file({ destination: 1 })] }, hooks: { streamWrite: (line: string) => streamWrite(line) } },
  isolated: { enabled: true, name: 'isolated', level: 'info', destination },
} })
export default loggerConfig
declare module '@adonisjs/core/types' { export interface LoggersList extends InferLoggers<typeof loggerConfig> {} }
`
    )
    await writeFile(
      join(fixture.root, 'app', 'exceptions', 'handler.ts'),
      `import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'
export default class Handler extends ExceptionHandler {
  protected ignoreStatuses = [409]
  protected ignoreExceptions = [TypeError]
  async handle(error: unknown, ctx: HttpContext) { return super.handle(error, ctx) }
  async report(error: unknown, ctx: HttpContext) {
    if (error instanceof Error && error.message.startsWith('reportprobe')) throw new Error('report-failed ${sentinel}')
    return super.report(error, ctx)
  }
}`
    )
    const configured = await fixture.ace(
      ['configure', '@rikology/adonisjs-mcp', '--instrument'],
      'development'
    )
    assert.equal(configured.exitCode, 0, configured.stderr)
    const routes = join(fixture.root, 'start', 'routes.ts')
    await writeFile(
      routes,
      `${await readFile(routes, 'utf8')}
import service from '@adonisjs/core/services/logger'
router.get('/__security/capture', ({ logger }) => {
  logger.child({ child: true }).info('seamprobe child ${sentinel}')
  service.use('named').info('seamprobe named ${sentinel}')
  service.use('worker').info('seamprobe worker ${sentinel}')
  service.use('isolated').info('seamprobe isolated ${sentinel}')
  return { ok: true }
})
router.get('/__security/ignored-status', () => { const error = new Error('ignored-status ${sentinel}'); Object.assign(error, { status: 409 }); throw error })
router.get('/__security/ignored-exception', () => { throw new TypeError('ignored-exception ${sentinel}') })
router.get('/__security/report-failed', () => { throw new Error('reportprobe ${sentinel}') })
`
    )
    const app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const capturedResponse = await app.fetch('/__security/capture')
    const ignoredStatusResponse = await app.fetch('/__security/ignored-status')
    const ignoredExceptionResponse = await app.fetch('/__security/ignored-exception')
    const reportResponse = await app.fetch('/__security/report-failed')
    assert.equal(capturedResponse.status, 200)
    assert.equal(ignoredStatusResponse.status, 409)
    assert.equal(ignoredExceptionResponse.status, 500)
    assert.equal(reportResponse.status, 500)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const logs = JSON.stringify(
        await client.callTool({ name: 'get_logs', arguments: { grep: 'seamprobe' } })
      )
      assert.include(logs, 'composed-seamprobe child')
      assert.include(logs, 'seamprobe named')
      assert.notInclude(
        logs,
        'seamprobe isolated',
        'uninstrumented named loggers are intentionally outside capture'
      )
      assert.notInclude(logs, sentinel)
      assert.include(
        logs,
        'seamprobe worker',
        'a configured hook captures before worker-transport delivery'
      )
      const errors = toolPayload<{ data: { exceptions: Array<{ message: string }> } }>(
        await client.callTool({ name: 'get_last_exceptions', arguments: {} })
      )
      const serialized = JSON.stringify(errors)
      assert.include(serialized, 'ignored-status')
      assert.include(serialized, 'ignored-exception')
      assert.notInclude(
        serialized,
        'reportprobe',
        'a report() failure bypasses the app handle() capture seam'
      )
      assert.notInclude(serialized, sentinel)
      assert.include(
        app.logs.text(),
        'composed-seamprobe child',
        'existing streamWrite output is preserved'
      )
      assert.include(
        app.logs.text(),
        'seamprobe isolated',
        'lack of capture does not suppress app output'
      )
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(180000)

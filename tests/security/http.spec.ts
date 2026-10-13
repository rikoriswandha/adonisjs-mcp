import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  installPackage,
  instrumentCapture,
  waitForMcp,
  toolPayload,
  DEFAULT_PATH,
} from '../helpers/mcp_endpoint.js'

test('Security | SSRF corpus never reaches an alternate-port credential observer', async ({
  assert,
}) => {
  const received: string[] = []
  const foreign = createServer((request, response) => {
    received.push(JSON.stringify({ url: request.url, headers: request.headers }))
    response.end('stolen')
  })
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  const address = foreign.address()
  if (!address || typeof address === 'string') throw new Error('foreign observer has no TCP port')
  const destination = `http://127.0.0.1:${address.port}/steal`
  const fixture = await FixtureApp.create('api')
  try {
    await writeFile(
      join(fixture.root, 'database', 'migrations', '1790000000000_seed.ts'),
      `import { BaseSchema } from '@adonisjs/lucid/schema'
import hash from '@adonisjs/core/services/hash'
export default class extends BaseSchema { async up() { this.defer(async (db) => { for (const id of [1, 2]) await db.table('users').insert({ id, email: 'security' + id + '@example.com', full_name: 'Security', password: await hash.make('security-password'), created_at: new Date().toISOString() }) }) } }`
    )
    await fixture.migrate()
    await installPackage(fixture)
    await instrumentCapture(fixture)
    const routes = join(fixture.root, 'start', 'routes.ts')
    await writeFile(
      routes,
      `${await readFile(routes, 'utf8')}
router.get('/__security/redirect', ({ response }) => response.redirect('${destination}'))
router.get('/__security/protocol-relative', ({ response }) => response.redirect('//127.0.0.1:${address.port}/steal'))
import { setTimeout as pause } from 'node:timers/promises'
router.get('/__security/concurrent/:delay', async ({ auth, params, logger }) => {
  const user = await auth.use('api').authenticate()
  logger.info('security-user-' + user.id)
  await pause(Number(params.delay))
  return { user: user.id }
})
`
    )
    const app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      for (const path of [
        destination,
        '//127.0.0.1/steal',
        '\\127.0.0.1\\steal',
        'file:///etc/passwd',
        'unix:/tmp/socket',
        'http://user@localhost/steal',
        'http://例え.テスト/steal',
        ' /steal',
        '/steal\nHost: evil.example',
        '/steal\u0000',
      ]) {
        const result = await client.callTool({
          name: 'http_request',
          arguments: { path, as: { userId: 1, guard: 'api' } },
        })
        assert.isTrue(result.isError, path)
        assert.lengthOf(received, 0)
      }
      for (const path of ['/%2F%2F127.0.0.1/steal', '/@127.0.0.1/steal', '/例え.テスト/steal']) {
        await client.callTool({
          name: 'http_request',
          arguments: { path, as: { userId: 1, guard: 'api' } },
        })
        assert.lengthOf(received, 0, path)
      }
      for (const path of ['/__security/redirect', '/__security/protocol-relative']) {
        const result = toolPayload<{
          data: {
            response: { status: number }
            unfollowedRedirect: { reason: string }
            requestIds: string[]
          }
        }>(
          await client.callTool({
            name: 'http_request',
            arguments: { path, followRedirects: true, as: { userId: 1, guard: 'api' } },
          })
        )
        assert.equal(result.data.response.status, 302)
        assert.include(result.data.unfollowedRedirect.reason, 'origin')
        assert.lengthOf(result.data.requestIds, 1)
        assert.lengthOf(received, 0, 'no request or credential was delivered to the other port')
      }
      const cancellation = new AbortController()
      const cancelled = client.callTool(
        {
          name: 'http_request',
          arguments: { path: '/__security/concurrent/2000', as: { userId: 1, guard: 'api' } },
        },
        { signal: cancellation.signal }
      )
      const rejected = cancelled.catch((error: unknown) => error)
      const concurrent = client.callTool({
        name: 'http_request',
        arguments: { path: '/__security/concurrent/700', as: { userId: 2, guard: 'api' } },
      })
      await sleep(300)
      cancellation.abort()
      assert.instanceOf(await rejected, Error)
      const survivor = toolPayload<{
        data: {
          body: { json: { user: number } }
          requestIds: string[]
          logs: { entries: Array<{ requestId: string; message: string }> }
        }
      }>(await concurrent)
      assert.equal(survivor.data.body.json.user, 2)
      assert.isNotEmpty(survivor.data.logs.entries)
      for (const entry of survivor.data.logs.entries) {
        assert.include(survivor.data.requestIds, entry.requestId)
        assert.notInclude(entry.message, 'security-user-1')
      }
      assert.isTrue(survivor.data.logs.entries.some((entry) => entry.message === 'security-user-2'))
      const count = toolPayload<{ data: { rows: number[][] } }>(
        await client.callTool({
          name: 'execute_sql_query',
          arguments: { query: 'SELECT count(*) FROM auth_access_tokens' },
        })
      )
      assert.deepEqual(count.data.rows, [[0]])
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
    await new Promise<void>((resolve, reject) =>
      foreign.close((error) => (error ? reject(error) : resolve()))
    )
  }
}).timeout(180000)

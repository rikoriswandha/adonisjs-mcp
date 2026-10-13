import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import type { ViewEntry } from '../../src/introspection/views.js'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  setExtensionProviders,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

interface Envelope<T> {
  data: T
  limitations: string[]
}
interface Inventory {
  views: ViewEntry[]
  disks: { disk: string; outsideRoot: number }[]
  truncated: boolean
}
interface Rendered {
  name: string
  html: string
  bytes: number
  truncated: boolean
}
interface HttpData {
  request: { surface: { renderer: string }; as: { guard: string; driver: string } | null }
  response: { status: number }
  body: {
    kind: string
    html: { title: string; headings: { level: number; text: string }[]; text: string }
  }
}
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(JSON.stringify(result.content))
  }
  return toolPayload<Envelope<T>>(result)
}

const PROVIDER = `import type { ApplicationService } from '@adonisjs/core/types'
import edge from 'edge.js'
export default class {
  constructor(private app: ApplicationService) {}
  boot() {
    edge.mount('extra', this.app.makePath('extra_views'))
    edge.registerTemplate('memory', { template: '<p>Memory {{ label }}</p>' })
    let counter = 0
    edge.global('incrementCounter', () => ++counter)
    edge.global('explodeFixture', () => { throw new Error('fixture template exploded') })
  }
}
`
const ROUTES = `
router.get('/__edge/echo', ({ request, response }) => {
  response.type('text/html')
  return '<html><title>Edge echo</title><h1>' + request.header('accept') + '</h1><h2>' + (request.header('x-inertia') ?? 'absent') + '</h2></html>'
})
router.get('/__edge/page', ({ view }) => view.render('fixture_page', { label: 'HTTP Edge' }))
router.get('/__edge/counter', ({ view }) => view.render('counter'))
router.get('/__edge/protected', ({ auth, response }) => {
  response.type('text/html')
  return '<h1>User ' + auth.user!.id + '</h1>'
}).use(middleware.auth())
`

test.group('Edge | real views and Edge-only HTTP surface', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  let client: Client
  group.setup(async () => {
    fixture = await FixtureApp.create('edge')
    try {
      const views = join(fixture.root, 'resources/views')
      await mkdir(join(views, 'nested'), { recursive: true })
      await mkdir(join(views, 'components/fixture-panel'), { recursive: true })
      await mkdir(join(fixture.root, 'extra_views/components'), { recursive: true })
      for (const [name, source] of Object.entries({
        'fixture_page.edge':
          "<html><title>Fixture Edge</title>\n@component('components/fixture-panel/index', { label })\n@slot('header')\n<h1>{{ label }}</h1>\n@endslot\n<p>Body</p>\n@endcomponent\n</html>",
        'components/fixture-panel/index.edge':
          '<section>{{{ await $slots.header() }}}{{{ await $slots.main() }}}</section>',
        'components/dynamic.edge': '{{ await $slots[slotName]() }}',
        'nested/greeting.edge': '<p>{{ label }}</p>',
        'counter.edge': '<p>{{ incrementCounter() }}</p>',
        'throwing.edge': '{{ explodeFixture() }}',
        'big.edge': "{{ 'é'.repeat(100000) }}",
      })) {
        await writeFile(join(views, name), source)
      }
      await writeFile(join(fixture.root, 'extra_views/hello.edge'), '<p>Extra {{ label }}</p>')
      await writeFile(
        join(fixture.root, 'extra_views/components/foo_bar.edge'),
        '<p>Extra component</p>'
      )
      await writeFile(
        join(fixture.root, 'sentinel.edge'),
        '{{ incrementCounter() }} SENTINEL_DO_NOT_READ'
      )
      await symlink(join(fixture.root, 'sentinel.edge'), join(views, 'escape.edge'))
      await writeFile(
        join(fixture.root, 'database/migrations/1790000000000_seed_users.ts'),
        `import { BaseSchema } from '@adonisjs/lucid/schema'
import hash from '@adonisjs/core/services/hash'
export default class extends BaseSchema {
  async up() { this.defer(async (db) => { await db.table('users').insert({ id: 1, email: 'ada@example.com', full_name: 'Ada', password: await hash.make('ada-password'), created_at: new Date().toISOString() }) }) }
}
`
      )
      await fixture.migrate()
      await installPackage(fixture)
      await writeMcpConfig(fixture, 'limits: { maxResultBytes: 16384 },')
      await writeFile(join(fixture.root, 'providers/edge_fixture_provider.ts'), PROVIDER)
      await setExtensionProviders(fixture, ['edge_fixture_provider'])
      const routes = join(fixture.root, 'start/routes.ts')
      await writeFile(routes, `${await readFile(routes, 'utf8')}${ROUTES}`)
      app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
      client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return async () => {
      await client.close()
      await fixture.dispose()
    }
  })

  test('inventory includes mounted roots, nested names, raw templates and source slots', async ({
    assert,
  }) => {
    const { data } = await call<Inventory>(client, 'get_views')
    assert.isFalse(data.truncated)
    const panel = data.views.find((view) => view.name === 'components/fixture-panel/index')!
    assert.equal(panel.component!.tag, '@fixturePanel')
    assert.equal(panel.component!.evidence, 'runtime')
    assert.isNull(data.views.find((view) => view.name === 'nested/greeting')!.component)
    assert.equal(data.views.find((view) => view.name === 'memory')!.component!.tag, '@memory')
    assert.equal(data.views.find((view) => view.name === 'memory')!.component!.evidence, 'runtime')
    assert.deepEqual(panel.slots, { names: ['header', 'main'], completeness: 'complete' })
    assert.equal(
      data.views.find((view) => view.name === 'components/dynamic')!.slots.completeness,
      'unknown'
    )
    assert.exists(data.views.find((view) => view.name === 'nested/greeting'))
    assert.equal(
      data.views.find((view) => view.name === 'extra::components/foo_bar')!.component!.tag,
      '@extra.fooBar'
    )
    assert.equal(data.views.find((view) => view.name === 'memory')!.file, null)
    assert.isFalse(data.views.some((view) => view.name === 'escape'))
    assert.equal(data.disks.find((disk) => disk.disk === 'default')!.outsideRoot, 1)
    const unknown = await client.callTool({ name: 'get_views', arguments: { name: 'missing' } })
    assert.isTrue(unknown.isError)
    assert.equal(toolPayload<{ error: { code: string } }>(unknown).error.code, 'NOT_FOUND')
  })

  test('render executes the application singleton, escapes JSON state and bounds HTML', async ({
    assert,
  }) => {
    const page = await call<Rendered>(client, 'render_view', {
      name: 'fixture_page',
      state: { label: '<b>' },
    })
    assert.include(page.data.html, '<h1>&lt;b&gt;</h1>')
    assert.include(page.data.html, '<p>Body</p>')
    const memory = await call<Rendered>(client, 'render_view', {
      name: 'memory',
      state: { label: 'live' },
    })
    assert.include(memory.data.html, 'Memory live')
    const extra = await call<Rendered>(client, 'render_view', {
      name: 'extra::hello',
      state: { label: 'disk' },
    })
    assert.include(extra.data.html, 'Extra disk')
    const first = await call<Rendered>(client, 'render_view', { name: 'counter' })
    for (const name of [
      '../../sentinel',
      join(fixture.root, 'sentinel.edge'),
      'escape',
      'unknown',
    ]) {
      const result = await client.callTool({ name: 'render_view', arguments: { name } })
      assert.isTrue(result.isError)
      assert.equal(toolPayload<{ error: { code: string } }>(result).error.code, 'NOT_FOUND')
      assert.notInclude(JSON.stringify(result.content), 'SENTINEL_DO_NOT_READ')
    }
    const second = await call<Rendered>(client, 'render_view', { name: 'counter' })
    assert.include(first.data.html, '>1<')
    assert.include(second.data.html, '>2<')
    // HttpContext.view and render_view share the same registered global closure.
    const requestCounter = await call<HttpData>(client, 'http_request', { path: '/__edge/counter' })
    assert.equal(requestCounter.data.response.status, 200)
    assert.include(requestCounter.data.body.html.text, '3')
    const third = await call<Rendered>(client, 'render_view', { name: 'counter' })
    assert.include(third.data.html, '>4<')
    const big = await call<Rendered>(client, 'render_view', { name: 'big' })
    assert.isTrue(big.data.truncated)
    assert.isAbove(big.data.bytes, 16384)
    assert.isAtMost(Buffer.byteLength(big.data.html), 16384)
    assert.notInclude(big.data.html, '�')
    const failure = await client.callTool({ name: 'render_view', arguments: { name: 'throwing' } })
    const error = toolPayload<{
      error: { code: string; details: { location: { file: string; line: number } } }
    }>(failure).error
    assert.equal(error.code, 'EXECUTION_FAILED')
    assert.include(error.details.location.file, 'throwing.edge')
    assert.equal(error.details.location.line, 1)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.find((tool) => tool.name === 'render_view')!.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    })
  })

  test('Edge-only profile and HTTP requests use HTML without Inertia and impersonate web sessions', async ({
    assert,
  }) => {
    const profile = await call<{
      kind: string
      surfaces: { web: { renderer: string } }
      inertia: unknown
    }>(client, 'get_project_profile')
    assert.equal(profile.data.kind, 'edge')
    assert.equal(profile.data.surfaces.web.renderer, 'edge')
    assert.isNull(profile.data.inertia)
    const echo = await call<HttpData>(client, 'http_request', { path: '/__edge/echo' })
    assert.equal(echo.data.request.surface.renderer, 'edge')
    assert.equal(echo.data.body.kind, 'html')
    assert.deepEqual(echo.data.body.html.headings, [
      { level: 1, text: 'text/html,application/xhtml+xml' },
      { level: 2, text: 'absent' },
    ])
    const page = await call<HttpData>(client, 'http_request', { path: '/__edge/page' })
    assert.equal(page.data.response.status, 200)
    assert.equal(page.data.body.html.title, 'Fixture Edge')
    const protectedPage = await call<HttpData>(client, 'http_request', {
      path: '/__edge/protected',
      as: { userId: 1 },
    })
    assert.equal(protectedPage.data.response.status, 200)
    assert.equal(protectedPage.data.request.as!.guard, 'web')
    assert.equal(protectedPage.data.request.as!.driver, 'session')
    assert.deepEqual(protectedPage.data.body.html.headings, [{ level: 1, text: 'User 1' }])
  })
})

test.group('Edge | active alongside Inertia', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  group.setup(async () => {
    fixture = await FixtureApp.create('hybrid')
    try {
      await installPackage(fixture)
      await writeMcpConfig(fixture, '')
      app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return () => fixture.dispose()
  })
  test('hybrid inventory lists inertia_layout', async ({ assert }) => {
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const result = await call<Inventory>(client, 'get_views')
      assert.exists(result.data.views.find((view) => view.name === 'inertia_layout'))
    } finally {
      await client.close()
    }
  })
})

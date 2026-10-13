import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

interface Envelope<T> {
  data: T
  evidence: string[]
  limitations: string[]
}
interface Render {
  component: string | null
  componentEvidence: string
  props: { keys: string[]; completeness: string }
  location: { file: string; line: number }
}
interface Pages {
  exists: boolean
  pages: {
    name: string
    file: string
    inGenerated: boolean
    existsOnDisk: boolean
    referenced: boolean
    changedSinceProcessStart: boolean
  }[]
  generated: { exists: boolean; absentEntries: string[]; missingFiles: string[] }
  routes: { pattern: string; status: string; reason: string | null; renders: Render[] }[]
}
interface Shared {
  middleware: {
    file: string
    share: { returns: { keys: string[]; fields: { name: string; kind: string }[] }[] }
    flash: { returns: { keys: string[] }[] }
  }[]
  generated: { exists: boolean; aliases: string[] }
}
interface Transformers {
  exists: boolean
  transformers: {
    name: string
    resource: string
    inGenerated: boolean
    methods: { name: string; output: { keys: string[]; completeness: string }[] }[]
  }[]
  generated: { exists: boolean; absentEntries: string[] }
}
async function call<T>(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(JSON.stringify(result.content))
  }
  return toolPayload<Envelope<T>>(result)
}

for (const kit of ['hybrid', 'vue'] as const) {
  test.group(`Inertia | ${kit} real kit`, (group) => {
    let fixture: FixtureApp
    let client: Client
    let initialCalls: number
    group.setup(async () => {
      fixture = await FixtureApp.create(kit)
      try {
        await writeFile(
          join(fixture.root, 'app/controllers/introspection_controller.ts'),
          `import type { HttpContext } from '@adonisjs/core/http'
export default class IntrospectionController {
  staticRender({ inertia }: HttpContext) { process.env.INTROSPECTION_CALLED = String(Number(process.env.INTROSPECTION_CALLED ?? 0) + 1); return inertia.render('home', { greeting: 'hello' }) }
  dynamic(ctx: HttpContext) { process.env.INTROSPECTION_CALLED = String(Number(process.env.INTROSPECTION_CALLED ?? 0) + 1); return ctx.inertia.render(ctx.request.input('component'), { known: true, ...ctx.request.all() }) }
  none() { return 'no inertia' }
}`
        )
        await writeFile(
          join(fixture.root, 'app/transformers/extra_transformer.ts'),
          `import { BaseTransformer } from '@adonisjs/core/transformers'
export default class ExtraTransformer extends BaseTransformer<{ id: number }> {
  toObject() { return { id: this.resource.id, ...this.resource } }
  compact() { return this.pick(this.resource, ['id']) }
  dynamic() { return this.resource }
}`
        )
        const routesPath = join(fixture.root, 'start/routes.ts')
        const routes = await readFile(routesPath, 'utf8')
        await writeFile(
          routesPath,
          routes +
            `
const Introspection = () => import('#controllers/introspection_controller')
router.get('/inspect/static', [Introspection, 'staticRender'])
router.get('/inspect/dynamic', [Introspection, 'dynamic'])
router.get('/inspect/none', [Introspection, 'none'])
router.get('/inspect/closure', ({ inertia }) => inertia.render('home', { closure: true }))
router.group(() => { router.group(() => { router.on('/macro').renderInertia('dashboard', { nested: true }) }).prefix('/inner') }).prefix('/outer')
`
        )
        const middlewarePath = join(fixture.root, 'app/middleware/inertia_middleware.ts')
        const middleware = await readFile(middlewarePath, 'utf8')
        await writeFile(
          middlewarePath,
          middleware
            .replace(
              'share(ctx: HttpContext) {',
              'share(ctx: HttpContext) { process.env.INTROSPECTION_CALLED = String(Number(process.env.INTROSPECTION_CALLED ?? 0) + 1);'
            )
            .replace(
              'flash(ctx: HttpContext) {',
              'flash(ctx: HttpContext) { process.env.INTROSPECTION_CALLED = String(Number(process.env.INTROSPECTION_CALLED ?? 0) + 1);'
            )
        )
        await writeFile(
          join(fixture.root, `inertia/pages/extra.${kit === 'vue' ? 'vue' : 'tsx'}`),
          kit === 'vue'
            ? '<template><p>Extra</p></template>'
            : 'export default function Extra() { return null }'
        )
        await fixture.migrate()
        await installPackage(fixture)
        await writeFile(
          join(fixture.root, 'start/mcp_counter.ts'),
          `import { defineTool } from '@rikology/adonisjs-mcp'
import { z } from 'zod'
export default defineTool({ name: 'fixture_counter', description: 'Reads callback execution counter without HTTP middleware', inputSchema: z.object({}), handler: () => ({ data: { called: Number(process.env.INTROSPECTION_CALLED ?? 0) } }) })`
        )
        await writeMcpConfig(fixture, "extraTools: [() => import('#start/mcp_counter')],")
        const app = await fixture.start({ nodeEnv: 'development' })
        await waitForMcp(app)
        client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
        const baseline = await call<{ called: number }>(client, 'fixture_counter')
        initialCalls = baseline.data.called
      } catch (error) {
        await fixture.dispose()
        throw error
      }
      return async () => {
        await client.close()
        await fixture.dispose()
      }
    })
    test('pages, controller and macro mappings are static and adapter-independent', async ({
      assert,
    }) => {
      const result = await call<Pages>(client, 'get_inertia_pages')
      assert.isTrue(result.data.exists)
      const extra = result.data.pages.find((page) => page.name === 'extra')!
      assert.isTrue(extra.existsOnDisk)
      assert.isFalse(extra.inGenerated)
      assert.isFalse(extra.referenced)
      assert.include(extra.file, kit === 'vue' ? '.vue' : '.tsx')
      assert.include(result.data.generated.absentEntries, 'extra')
      const staticRoute = result.data.routes.find((route) => route.pattern === '/inspect/static')!
      assert.equal(staticRoute.renders[0].component, 'home')
      assert.deepEqual(staticRoute.renders[0].props.keys, ['greeting'])
      assert.equal(
        staticRoute.renders[0].location.file,
        'app/controllers/introspection_controller.ts'
      )
      const login = result.data.routes.find((route) => route.pattern === '/login')!
      assert.equal(login.renders[0].component, 'auth/login')
      const dynamic = result.data.routes.find((route) => route.pattern === '/inspect/dynamic')!
      assert.isNull(dynamic.renders[0].component)
      assert.equal(dynamic.renders[0].componentEvidence, 'dynamic')
      assert.equal(dynamic.renders[0].props.completeness, 'partial')
      assert.equal(
        result.data.routes.find((route) => route.pattern === '/inspect/closure')!.renders[0]
          .component,
        'home'
      )
      assert.equal(
        result.data.routes.find((route) => route.pattern === '/outer/inner/macro')!.renders[0]
          .component,
        'dashboard'
      )
      assert.isUndefined(result.data.routes.find((route) => route.pattern === '/inspect/none'))
      const none = await call<Pages>(client, 'get_inertia_pages', { route: '/inspect/none' })
      assert.equal(none.data.routes[0].status, 'none')
      const unknown = await client.callTool({
        name: 'get_inertia_pages',
        arguments: { route: '/missing' },
      })
      assert.isTrue(unknown.isError)
      const profile = await call<{ inertia: { adapter: string } }>(client, 'get_project_profile')
      assert.equal(profile.data.inertia.adapter, kit === 'vue' ? 'vue' : 'react')
    })
    test('mounted shared props and transformer variants never run callbacks', async ({
      assert,
    }) => {
      const shared = await call<Shared>(client, 'get_shared_props')
      const mounted = shared.data.middleware.find(
        (entry) => entry.file === 'app/middleware/inertia_middleware.ts'
      )!
      assert.deepEqual(mounted.share.returns[0].keys, ['errors', 'user', 'preferences'])
      assert.deepEqual(
        mounted.share.returns[0].fields.map((field) => field.kind),
        ['always', 'always', 'always']
      )
      assert.deepEqual(mounted.flash.returns[0].keys, ['success', 'error'])
      assert.sameMembers(shared.data.generated.aliases, ['SharedProps', 'FlashMessages'])
      const transformers = await call<Transformers>(client, 'get_transformers')
      const user = transformers.data.transformers.find((entry) => entry.name === 'UserTransformer')!
      assert.equal(user.resource, 'User')
      assert.isTrue(user.inGenerated)
      assert.sameMembers(user.methods[0].output[0].keys, [
        'id',
        'fullName',
        'email',
        'createdAt',
        'updatedAt',
        'initials',
      ])
      const extra = transformers.data.transformers.find(
        (entry) => entry.name === 'ExtraTransformer'
      )!
      assert.isFalse(extra.inGenerated)
      assert.equal(
        extra.methods.find((method) => method.name === 'toObject')!.output[0].completeness,
        'partial'
      )
      assert.equal(
        extra.methods.find((method) => method.name === 'dynamic')!.output[0].completeness,
        'unknown'
      )
      assert.include(transformers.data.generated.absentEntries, 'ExtraTransformer')
      const unknown = await client.callTool({
        name: 'get_transformers',
        arguments: { name: 'Missing' },
      })
      assert.isTrue(unknown.isError)
      const counter = await call<{ called: number }>(client, 'fixture_counter')
      assert.equal(counter.data.called, initialCalls, 'introspection must not execute callbacks')
    })
    test('literal route renders decide web surface without an override', async ({ assert }) => {
      const result = await call<{
        request: { surface: { name: string; source: string } }
        body: { kind: string }
      }>(client, 'http_request', { path: '/' })
      assert.equal(result.data.request.surface.name, 'web')
      assert.equal(result.data.request.surface.source, 'route-render')
      assert.equal(result.data.body.kind, 'inertia')
    })
    test('missing generated artifacts and missing source directories are distinct from empty inventories', async ({
      assert,
    }) => {
      const extension = kit === 'vue' ? 'vue' : 'tsx'
      await writeFile(
        join(fixture.root, `inertia/pages/extra.${extension}`),
        kit === 'vue'
          ? '<template><p>Changed</p></template>'
          : 'export default function Extra() { return null }'
      )
      const changed = await call<Pages>(client, 'get_inertia_pages')
      assert.isTrue(
        changed.data.pages.find((page) => page.name === 'extra')!.changedSinceProcessStart
      )
      await unlink(join(fixture.root, `inertia/pages/home.${extension}`))
      const stale = await call<Pages>(client, 'get_inertia_pages')
      assert.include(stale.data.generated.missingFiles, 'home')
      await unlink(join(fixture.root, '.adonisjs/server/pages.d.ts'))
      await unlink(join(fixture.root, '.adonisjs/client/data.d.ts'))
      const missing = await call<Pages>(client, 'get_inertia_pages')
      assert.isFalse(missing.data.generated.exists)
      const shared = await call<Shared>(client, 'get_shared_props')
      assert.isFalse(shared.data.generated.exists)
      const transformers = await call<Transformers>(client, 'get_transformers')
      assert.isFalse(transformers.data.generated.exists)
      await rename(
        join(fixture.root, 'app/transformers'),
        join(fixture.root, 'app/transformers_hidden')
      )
      const absent = await call<Transformers>(client, 'get_transformers')
      assert.isFalse(absent.data.exists)
      assert.isEmpty(absent.data.transformers)
    })
  })
}

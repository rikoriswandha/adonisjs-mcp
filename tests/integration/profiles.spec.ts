/*
|--------------------------------------------------------------------------
| Profile fixtures and their tool sets (M6 exit gate)
|--------------------------------------------------------------------------
|
| Each starter kit, configured with the tarball and nothing else, serves
| exactly the framework tools its integrations support; every other tool
| is reported unavailable with the reason a dependency or capability is
| missing. The API kit without Lucid/auth/views is covered by
| endpoint.spec.ts.
|
*/

import { test } from '@japa/runner'
import type { CapabilityReport, ProjectProfile } from '../../src/types.js'
import { FixtureApp, type FixtureKit } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

interface ProfilePayload {
  data: ProjectProfile & {
    capabilities: Record<'tools' | 'resources' | 'prompts', CapabilityReport[]>
  }
}

const FRAMEWORK_TOOLS = [
  'get_validators',
  'get_inertia_pages',
  'get_shared_props',
  'get_transformers',
  'get_tuyau_schema',
  'get_views',
  'render_view',
  'get_permissions',
  'get_queue_jobs',
] as const

type Status = 'served' | 'DEPENDENCY_UNAVAILABLE' | 'CAPABILITY_UNSUPPORTED'

const DEP = 'DEPENDENCY_UNAVAILABLE'

const EXPECTED: Record<
  Exclude<FixtureKit, 'api-bare'>,
  {
    kind: ProjectProfile['kind']
    renderer: 'inertia' | 'edge' | null
    adapter: 'react' | 'vue' | null
    tools: Record<(typeof FRAMEWORK_TOOLS)[number], Status>
  }
> = {
  api: {
    kind: 'api',
    renderer: null,
    adapter: null,
    tools: {
      get_validators: 'served',
      get_inertia_pages: DEP,
      get_shared_props: DEP,
      get_transformers: 'served',
      get_tuyau_schema: 'served',
      get_views: DEP,
      render_view: DEP,
      get_permissions: DEP,
      get_queue_jobs: DEP,
    },
  },
  hybrid: {
    kind: 'hybrid',
    renderer: 'inertia',
    adapter: 'react',
    tools: {
      get_validators: 'served',
      get_inertia_pages: 'served',
      get_shared_props: 'served',
      get_transformers: 'served',
      get_tuyau_schema: 'served',
      get_views: 'served',
      render_view: 'served',
      get_permissions: DEP,
      get_queue_jobs: DEP,
    },
  },
  edge: {
    kind: 'edge',
    renderer: 'edge',
    adapter: null,
    tools: {
      get_validators: 'served',
      get_inertia_pages: DEP,
      get_shared_props: DEP,
      get_transformers: 'served',
      get_tuyau_schema: DEP,
      get_views: 'served',
      render_view: 'served',
      get_permissions: DEP,
      get_queue_jobs: DEP,
    },
  },
  vue: {
    kind: 'inertia',
    renderer: 'inertia',
    adapter: 'vue',
    tools: {
      get_validators: 'served',
      get_inertia_pages: 'served',
      get_shared_props: 'served',
      get_transformers: 'served',
      get_tuyau_schema: 'served',
      get_views: 'served',
      render_view: 'served',
      get_permissions: DEP,
      get_queue_jobs: DEP,
    },
  },
}

test.group('Profiles | starter kits serve their framework tools', () => {
  for (const [kit, expected] of Object.entries(EXPECTED) as Array<
    [keyof typeof EXPECTED, (typeof EXPECTED)[keyof typeof EXPECTED]]
  >) {
    test(`${kit} kit`, async ({ assert }) => {
      const fixture = await FixtureApp.create(kit)
      try {
        await installPackage(fixture)
        await writeMcpConfig(fixture, '')
        const app = await fixture.start({ nodeEnv: 'development' })
        await waitForMcp(app)
        const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
        let profile: ProfilePayload
        try {
          profile = toolPayload<ProfilePayload>(
            await client.callTool({ name: 'get_project_profile', arguments: {} })
          )
          const { tools } = await client.listTools()
          const listed = new Set(tools.map((tool) => tool.name))
          for (const name of FRAMEWORK_TOOLS) {
            assert.equal(listed.has(name), expected.tools[name] === 'served', name)
          }
        } finally {
          await client.close()
        }

        assert.equal(profile.data.kind, expected.kind)
        assert.equal(profile.data.surfaces.web?.renderer ?? null, expected.renderer)
        assert.equal(profile.data.inertia?.adapter ?? null, expected.adapter)
        const statuses = Object.fromEntries(
          profile.data.capabilities.tools
            .filter((entry) => (FRAMEWORK_TOOLS as readonly string[]).includes(entry.name))
            .map((entry) => [entry.name, entry.code ?? entry.status])
        )
        assert.deepEqual(statuses, expected.tools)
        for (const entry of profile.data.capabilities.tools) {
          if (entry.status === 'unavailable') {
            assert.isString(entry.reason, entry.name)
          }
        }
      } finally {
        await fixture.dispose()
      }
    }).timeout(600_000)
  }
})

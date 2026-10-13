/*
|--------------------------------------------------------------------------
| Profile fixtures, their tool sets and prompts (M6, M7 and M8 exit gates)
|--------------------------------------------------------------------------
|
| Each starter kit, configured with the tarball and nothing else, serves
| exactly the framework tools its integrations support; every other tool
| is reported unavailable with the reason a dependency or capability is
| missing. The profile-independent M7 tools are served on every kit, except
| project_eval, which needs --experimental-vm-modules (the kits start
| without it). The workflow prompts only reference tools served on the kit,
| and add_feature on the hybrid kit asks for the surface first. The API kit
| without Lucid/auth/views is covered by endpoint.spec.ts.
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

/**
 * Text of every message of a prompt.
 */
function promptText(prompt: { messages: Array<{ content: unknown }> }): string {
  return prompt.messages
    .map((message) => {
      const content = message.content as { type?: string; text?: string }
      return content.type === 'text' ? (content.text ?? '') : ''
    })
    .join('\n')
}

/**
 * Registered tool names the prompt text references in backticks.
 */
function referencedTools(text: string, registered: ReadonlySet<string>): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)]
    .map((match) => match[1])
    .filter((name) => registered.has(name))
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

/**
 * Profile-independent tools and their status on every kit started without
 * --experimental-vm-modules.
 */
const CORE_M7_TOOLS: Record<string, Status> = {
  project_eval: 'CAPABILITY_UNSUPPORTED',
  run_ace_command: 'served',
  get_source_location: 'served',
  search_package_docs: 'served',
}

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
        const prompts: Record<string, string> = {}
        try {
          profile = toolPayload<ProfilePayload>(
            await client.callTool({ name: 'get_project_profile', arguments: {} })
          )
          const { tools } = await client.listTools()
          const listed = new Set(tools.map((tool) => tool.name))
          for (const name of FRAMEWORK_TOOLS) {
            assert.equal(listed.has(name), expected.tools[name] === 'served', name)
          }

          const { prompts: listedPrompts } = await client.listPrompts()
          assert.includeMembers(
            listedPrompts.map((prompt) => prompt.name),
            ['add_feature', 'debug_request']
          )
          const requests: Record<string, Record<string, string>> = {
            'debug_request': { path: '/', method: 'GET' },
            'add_feature': { feature: 'list invoices' },
            'add_feature:web': { feature: 'list invoices', surface: 'web' },
            'add_feature:api': { feature: 'list invoices', surface: 'api' },
          }
          for (const [key, args] of Object.entries(requests)) {
            const name = key.split(':')[0]
            prompts[key] = promptText(await client.getPrompt({ name, arguments: args }))
          }
        } finally {
          await client.close()
        }

        const registered = new Set(profile.data.capabilities.tools.map((entry) => entry.name))
        const served = new Set(
          profile.data.capabilities.tools
            .filter((entry) => entry.status === 'served')
            .map((entry) => entry.name)
        )
        for (const [key, text] of Object.entries(prompts)) {
          assert.notInclude(text, 'not registered', key)
          const referenced = referencedTools(text, registered)
          assert.isAbove(referenced.length, 0, key)
          for (const name of referenced) {
            assert.isTrue(served.has(name), `${key} references unserved ${name}`)
          }
        }
        if (expected.kind === 'hybrid') {
          assert.match(prompts.add_feature, /\bask\b/i)
          assert.match(prompts.add_feature, /\bboth\b/i)
          assert.include(prompts['add_feature:web'], '`get_inertia_pages`')
          assert.notInclude(prompts['add_feature:api'], '`get_inertia_pages`')
        }
        if (expected.kind === 'api' || expected.kind === 'edge') {
          assert.notInclude(prompts.add_feature, 'make:page')
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
        const core = Object.fromEntries(
          profile.data.capabilities.tools
            .filter((entry) => entry.name in CORE_M7_TOOLS)
            .map((entry) => [entry.name, entry.code ?? entry.status])
        )
        assert.deepEqual(core, CORE_M7_TOOLS)
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

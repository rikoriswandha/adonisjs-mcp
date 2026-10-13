import assert from 'node:assert/strict'
import { FixtureApp } from '../tests/helpers/fixture_app.js'
import { packedPackage } from '../tests/helpers/package_tarball.js'
import { connectMcpClient } from '../tests/helpers/mcp_client.js'
import { resourcePayload, toolPayload, waitForMcp } from '../tests/helpers/mcp_endpoint.js'

const fixture = await FixtureApp.create('api')
try {
  const artifact = await packedPackage()
  await fixture.npm(['install', '--save-dev', artifact])
  await fixture.migrate()
  const configured = await fixture.ace(
    ['configure', '@rikology/adonisjs-mcp', '--instrument', '--vm-modules'],
    'development'
  )
  assert.equal(configured.exitCode, 0, configured.stdout + configured.stderr)
  const app = await fixture.start({
    nodeEnv: 'development',
    nodeOptions: '--experimental-vm-modules',
  })
  await waitForMcp(app)
  for (const era of ['modern', 'legacy'] as const) {
    const client = await connectMcpClient(new URL('/__adonis/mcp', app.url), { era })
    try {
      const listed = await client.listTools()
      for (const name of ['get_project_profile', 'get_routes', 'get_models']) {
        assert.ok(listed.tools.some((tool) => tool.name === name))
        const result = await client.callTool({ name, arguments: {} })
        assert.ok(!result.isError, JSON.stringify(toolPayload(result)))
        assert.ok(toolPayload(result))
      }
      const source = await client.callTool({
        name: 'get_source_location',
        arguments: { reference: '#models/user', symbol: 'User' },
      })
      assert.ok(!source.isError)
      assert.ok(JSON.stringify(toolPayload(source)).includes('user.ts'))
      const docs = await client.callTool({
        name: 'search_package_docs',
        arguments: { query: 'preload', packages: ['@adonisjs/lucid'] },
      })
      assert.ok(!docs.isError)
      assert.ok(JSON.stringify(toolPayload(docs)).includes('@adonisjs/lucid'))
      const failure = await client.callTool({
        name: 'search_package_docs',
        arguments: { query: 'DateTime', packages: ['luxon'] },
      })
      assert.equal(failure.isError, true)
      assert.ok(JSON.stringify(toolPayload(failure)).includes('INPUT_INVALID'))
      const resources = await client.listResources()
      assert.ok(resources.resources.some((resource) => resource.uri === 'adonis://profile'))
      assert.ok(resourcePayload(await client.readResource({ uri: 'adonis://profile' })))
      const prompts = await client.listPrompts()
      assert.ok(prompts.prompts.some((prompt) => prompt.name === 'debug_request'))
      const prompt = await client.getPrompt({
        name: 'debug_request',
        arguments: { path: '/', method: 'GET' },
      })
      assert.ok(
        prompt.messages.some(
          (message) =>
            message.content.type === 'text' && message.content.text.includes('get_routes')
        )
      )
      console.log(
        `smoke:clients ok: ${era} (${era === 'modern' ? '2026-07-28' : '2025-11-25'}), discovery/tools/error/resources/prompts/offline source and docs`
      )
    } finally {
      await client.close()
    }
  }
} finally {
  await fixture.dispose()
}

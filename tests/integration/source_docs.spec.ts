import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
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

interface Location {
  file: { absolute: string; appRelative: string }
  via: string
  line: number | null
  package?: { version: string; root: string }
  types?: { exists: boolean }
}
interface Search {
  snippets: { package: string; file: string; text: string; startLine: number; endLine: number }[]
  indexed: { package: string; cacheHit: boolean; skipped: string[] }[]
}
async function call<T>(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return toolPayload<{ data: T }>(result).data
}

for (const narrowed of [false, true]) {
  test.group(`Source and docs | real app ${narrowed ? 'narrowed' : 'default'} include`, (group) => {
    let fixture: FixtureApp
    let client: Client
    group.setup(async () => {
      fixture = await FixtureApp.create('api')
      try {
        await installPackage(fixture)
        await writeMcpConfig(
          fixture,
          narrowed ? "tools: { docs: { include: ['@rikology/*'] } }," : ''
        )
        await mkdir(join(fixture.root, 'demo-docs'), { recursive: true })
        await mkdir(join(fixture.root, 'node_modules/@rikology'), { recursive: true })
        await writeFile(
          join(fixture.root, 'demo-docs/package.json'),
          JSON.stringify({ name: '@rikology/demo-docs', version: '1.0.0' })
        )
        await writeFile(
          join(fixture.root, 'demo-docs/README.md'),
          '# Uniquequokka\nUniquequokka documentation for integration.\n'
        )
        await writeFile(
          join(fixture.root, 'demo-docs/.env'),
          'ENV_SENTINEL_NEVER_INDEXED=Uniquequokka'
        )
        await writeFile(
          join(fixture.root, 'escaped.d.ts'),
          '/** Uniquequokka ESCAPE_SENTINEL_NEVER_INDEXED */\nexport declare const escaped: string'
        )
        await symlink(
          join(fixture.root, 'escaped.d.ts'),
          join(fixture.root, 'demo-docs/escape.d.ts')
        )
        await symlink(
          join(fixture.root, 'demo-docs'),
          join(fixture.root, 'node_modules/@rikology/demo-docs')
        )
        await writeFile(
          join(fixture.root, 'app/controllers/source_probe_controller.ts'),
          [
            "import { inject } from '@adonisjs/core'",
            'export default class SourceProbeController {',
            '  async store() { return true }',
            '  @inject()',
            '  async update() { return true }',
            '}',
            '',
          ].join('\n')
        )
        await symlink('/etc/hosts', join(fixture.root, 'app/models/escaped_source.ts'))
        const app = await fixture.start({ nodeEnv: 'development' })
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
    test('resolves app aliases, symbol lines, app package exports and rejects traversal', async ({
      assert,
    }) => {
      const user = await call<Location>(client, 'get_source_location', {
        reference: '#models/user',
        symbol: 'User',
      })
      assert.equal(user.file.appRelative, 'app/models/user.ts')
      assert.equal(user.via, 'ts-exec')
      const source = await readFile(user.file.absolute, 'utf8')
      assert.equal(
        user.line,
        source.split('\n').findIndex((line) => line.includes('class User')) + 1
      )
      const controller = await call<Location>(client, 'get_source_location', {
        reference: '#controllers/source_probe_controller',
        symbol: 'SourceProbeController.store',
      })
      assert.equal(controller.line, 3)
      const decorated = await call<Location & { symbolFile: string | null }>(
        client,
        'get_source_location',
        {
          reference: '#controllers/source_probe_controller',
          symbol: 'SourceProbeController.update',
        }
      )
      assert.equal(decorated.line, 5)
      assert.equal(decorated.symbolFile, decorated.file.absolute)
      const generated = await call<Location>(client, 'get_source_location', {
        reference: '#generated/controllers',
      })
      assert.equal(generated.file.appRelative, '.adonisjs/server/controllers.ts')
      assert.equal(generated.via, 'ts-exec')
      const configPath = await call<Location>(client, 'get_source_location', {
        reference: 'config/database',
      })
      assert.equal(configPath.file.appRelative, 'config/database.ts')
      assert.equal(configPath.via, 'extension')
      const unknownSymbol = await call<Location>(client, 'get_source_location', {
        reference: '#models/user',
        symbol: 'MissingDeclaration',
      })
      assert.isNull(unknownSymbol.line)
      const orm = await call<Location>(client, 'get_source_location', {
        reference: '@adonisjs/lucid/orm',
      })
      assert.isTrue(
        orm.file.absolute.startsWith(join(fixture.root, 'node_modules/@adonisjs/lucid'))
      )
      const manifest = JSON.parse(
        await readFile(join(fixture.root, 'node_modules/@adonisjs/lucid/package.json'), 'utf8')
      )
      assert.equal(orm.package!.version, manifest.version)
      assert.isTrue(orm.types!.exists)
      for (const [reference, code] of [
        ['@adonisjs/lucid/nonexistent-private', 'NOT_FOUND'],
        ['../../etc/passwd', 'INPUT_INVALID'],
        ['app/models/escaped_source.ts', 'INPUT_INVALID'],
      ]) {
        const result = await client.callTool({
          name: 'get_source_location',
          arguments: { reference },
        })
        assert.isTrue(result.isError)
        assert.include(JSON.stringify(result.content), code)
      }
    })
    test('indexes symlinked allowed packages with exact snippets, safe files and cache transparency', async ({
      assert,
    }) => {
      const result = await call<Search>(client, 'search_package_docs', {
        query: 'Uniquequokka',
        packages: ['@rikology/demo-docs'],
      })
      assert.isAtMost(result.snippets.length, 5)
      assert.isAbove(result.snippets.length, 0)
      for (const snippet of result.snippets) {
        const text = await readFile(join(fixture.root, 'demo-docs', snippet.file), 'utf8')
        const lines = text.split('\n')
        assert.equal(snippet.text, lines.slice(snippet.startLine - 1, snippet.endLine).join('\n'))
      }
      assert.notInclude(JSON.stringify(result), 'ENV_SENTINEL_NEVER_INDEXED')
      assert.notInclude(JSON.stringify(result), 'ESCAPE_SENTINEL_NEVER_INDEXED')
      assert.isTrue(result.indexed[0].skipped.some((file) => file.includes('escape.d.ts')))
      const again = await call<Search>(client, 'search_package_docs', {
        query: 'Uniquequokka',
        packages: ['@rikology/demo-docs'],
      })
      assert.isTrue(again.indexed[0].cacheHit)
      const disallowed = await client.callTool({
        name: 'search_package_docs',
        arguments: { query: 'DateTime', packages: ['luxon'] },
      })
      assert.isTrue(disallowed.isError)
      assert.include(JSON.stringify(disallowed.content), 'INPUT_INVALID')
      if (narrowed) {
        const excluded = await client.callTool({
          name: 'search_package_docs',
          arguments: { query: 'preload', packages: ['@adonisjs/lucid'] },
        })
        assert.isTrue(excluded.isError)
      } else {
        const documented = await call<Search>(client, 'search_package_docs', {
          query: 'preload',
          packages: ['@adonisjs/lucid'],
        })
        assert.isAbove(documented.snippets.length, 0)
        for (const snippet of documented.snippets) {
          const text = await readFile(
            join(fixture.root, 'node_modules', snippet.package, snippet.file),
            'utf8'
          )
          const lines = text.split(/\r?\n/)
          assert.equal(snippet.text, lines.slice(snippet.startLine - 1, snippet.endLine).join('\n'))
        }
      }
    })
  })
}

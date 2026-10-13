import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  instrumentCapture,
  waitForMcp,
  toolPayload,
  setExtensionProviders,
} from '../helpers/mcp_endpoint.js'

const SENTINEL = 'm9-secret-9e86b1c4909e4c70'
const ESCAPED_SECRET =
  "-----BEGIN PRIVATE KEY-----\nMIIE-security-'quoted'-\\backslash-42\n-----END PRIVATE KEY-----"

const inputs: Record<string, Record<string, unknown>> = {
  get_config: { key: 'security' },
  query_model: { model: 'SecurityRow' },
  execute_sql_query: { query: 'SELECT * FROM security_rows' },
  http_request: { path: '/__security/secrets', surface: 'api' },
  project_eval: {
    code: 'console.log(process.env.SECURITY_PASSWORD); return { neutral: process.env.SECURITY_PASSWORD }',
  },
  run_ace_command: { command: 'list' },
  get_source_location: { reference: '#models/security_row' },
  search_package_docs: { query: 'securityprobe', packages: ['@rikology/security-probe'] },
  get_queue_jobs: { status: 'pending' },
  render_view: { name: 'security' },
}

test('Security | both protocol eras redact every served tool, resource and prompt including failures', async ({
  assert,
}) => {
  const fixture = await FixtureApp.create('hybrid')
  try {
    const envFile = join(fixture.root, '.env')
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}SECURITY_PASSWORD=${SENTINEL}\nSECURITY_PRIVATE_KEY="${ESCAPED_SECRET}"\n`
    )
    const envSchema = join(fixture.root, 'start', 'env.ts')
    const envSource = await readFile(envSchema, 'utf8')
    await writeFile(
      envSchema,
      envSource.replace(
        /\}\)\s*$/,
        '  SECURITY_PASSWORD: Env.schema.string(),\n  SECURITY_PRIVATE_KEY: Env.schema.string(),\n})\n'
      )
    )
    await fixture.migrate()
    await installPackage(fixture)
    await instrumentCapture(fixture)
    await fixture.npm([
      'install',
      '--save-exact',
      '@adonisjs/bouncer@4.0.1',
      '@adonisjs/queue@0.6.2',
      '@boringnode/queue@0.6.0',
    ])
    await writeFile(
      join(fixture.root, 'providers', 'security_queue_provider.ts'),
      "export { default } from '@adonisjs/queue/queue_provider'\n"
    )
    await writeFile(
      join(fixture.root, 'providers', 'security_bouncer_provider.ts'),
      "export { default } from '@adonisjs/bouncer/bouncer_provider'\n"
    )
    await writeFile(
      join(fixture.root, 'providers', 'security_prompt_provider.ts'),
      `import type { ApplicationService } from '@adonisjs/core/types'
export default class SecurityPromptProvider {
  constructor(protected app: ApplicationService) {}
  async boot() {
    if (!this.app.inDev || !this.app.container.hasBinding('mcp.registry')) return
    const registry = await this.app.container.make('mcp.registry')
    registry.prompt({ name: 'security_failure', description: 'App-derived prompt failure', get() { throw new Error('prompt-failure ' + process.env.SECURITY_PASSWORD) } })
  }
}`
    )
    await setExtensionProviders(fixture, [
      'security_queue_provider',
      'security_bouncer_provider',
      'security_prompt_provider',
    ])
    await writeFile(
      join(fixture.root, 'config', 'queue.ts'),
      `import { defineConfig, drivers } from '@adonisjs/queue'
export default defineConfig({ default: 'database', adapters: { database: drivers.database({ connectionName: 'sqlite', tableName: 'security_queue_jobs' }) }, locations: ['./app/jobs/**/*.ts'] })`
    )
    await mkdir(join(fixture.root, 'app', 'abilities'), { recursive: true })
    await mkdir(join(fixture.root, 'app', 'policies'), { recursive: true })
    await mkdir(join(fixture.root, 'app', 'jobs'), { recursive: true })
    await writeFile(
      join(fixture.root, 'app', 'abilities', 'main.ts'),
      `import { Bouncer } from '@adonisjs/bouncer'
export const securityRead = Bouncer.ability(() => true)`
    )
    await writeFile(join(fixture.root, 'app', 'policies', 'main.ts'), 'export const policies = {}')
    await writeFile(
      join(fixture.root, 'app', 'jobs', 'security_job.ts'),
      `import { Job } from '@adonisjs/queue'
export default class SecurityJob extends Job { async execute() { throw new Error('the metadata tool must not execute this job') } }`
    )
    await writeFile(
      join(fixture.root, 'database', 'migrations', '1790000000001_security_queue.ts'),
      `import { BaseSchema } from '@adonisjs/lucid/schema'
import { QueueSchemaService } from '@adonisjs/queue'
export default class extends BaseSchema { async up() { this.defer(async (db) => { const knex = db.getWriteClient(); await new QueueSchemaService(knex).createJobsTable('security_queue_jobs'); await knex('security_queue_jobs').insert({ id: 'security-pending', queue: 'default', status: 'pending', data: JSON.stringify({ name: 'SecurityJob', payload: { neutral: '${SENTINEL}', label: 'queue-sentinel-visible' } }), score: 1 }) }) } }`
    )
    await mkdir(join(fixture.root, 'resources', 'views'), { recursive: true })
    await writeFile(
      join(fixture.root, 'resources', 'views', 'security.edge'),
      `<p>securityprobe ${SENTINEL}</p>`
    )
    await writeFile(
      join(fixture.root, 'config', 'security.ts'),
      `export default { password: '${SENTINEL}', neutral: '${SENTINEL}' }`
    )
    await writeFile(
      join(fixture.root, 'database', 'migrations', '1790000000000_security.ts'),
      `import { BaseSchema } from '@adonisjs/lucid/schema'
export default class extends BaseSchema { async up() { this.schema.createTable('security_rows', (table) => { table.increments('id'); table.string('neutral') }); this.schema.createTable('security_observer', (table) => { table.increments('id') }); this.defer(async (db) => { await db.table('security_rows').insert({ neutral: '${SENTINEL}' }) }) } }`
    )
    await fixture.migrate()
    await writeFile(
      join(fixture.root, 'app', 'models', 'security_row.ts'),
      `import { BaseModel, column, beforeFetch } from '@adonisjs/lucid/orm'
import db from '@adonisjs/lucid/services/db'
export default class SecurityRow extends BaseModel {
  static table = 'security_rows'
  @column({ isPrimary: true }) declare id: number
  @column() declare neutral: string
  @beforeFetch() static async observer() { await db.table('security_observer').insert({}) }
}`
    )
    const routes = join(fixture.root, 'start', 'routes.ts')
    await writeFile(
      routes,
      `${await readFile(routes, 'utf8')}
import rootLogger from '@adonisjs/core/services/logger'
router.get('/__security/secrets', ({ logger }) => {
  logger.info({ neutral: '${SENTINEL}' }, 'securityprobe child ${SENTINEL}')
  rootLogger.info('securityprobe root ${SENTINEL}')
  return { neutral: '${SENTINEL}' }
})
router.get('/__security/error', () => { throw new Error('securityprobe ${SENTINEL}') })
`
    )
    const packageFile = join(fixture.root, 'package.json')
    const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as {
      scripts: Record<string, string>
    }
    manifest.scripts.securityprobe = `SECURITY_PASSWORD=${SENTINEL} node ace list`
    await writeFile(packageFile, JSON.stringify(manifest, null, 2))
    const docs = join(fixture.root, 'node_modules', '@rikology', 'security-probe')
    await mkdir(docs, { recursive: true })
    await writeFile(
      join(docs, 'package.json'),
      JSON.stringify({ name: '@rikology/security-probe', version: '1.0.0' })
    )
    await writeFile(join(docs, 'README.md'), `# securityprobe\n\n${SENTINEL}\n`)
    await writeFile(join(docs, '.env'), `INVISIBLE_PASSWORD=${SENTINEL}\n`)
    const app = await fixture.start({
      nodeEnv: 'development',
      nodeOptions: '--experimental-vm-modules',
    })
    await waitForMcp(app)
    await app.fetch('/__security/secrets')
    await app.fetch('/__security/error')
    const checkedTools = new Set<string>()
    for (const era of ['modern', 'legacy'] as const) {
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
      try {
        const listed = await client.listTools()
        assert.notInclude(JSON.stringify(listed), SENTINEL)
        assert.lengthOf(listed.tools, 28, `${era} full hybrid, queue and Bouncer catalog`)
        for (const tool of listed.tools) {
          checkedTools.add(tool.name)
          assert.exists(
            inputs[tool.name] ?? ((tool.inputSchema.required ?? []).length === 0 ? {} : undefined),
            `supply deliberate input for ${tool.name}`
          )
          const success = await client.callTool({
            name: tool.name,
            arguments: inputs[tool.name] ?? {},
          })
          assert.notOk(success.isError, `${era} ${tool.name}: ${JSON.stringify(success)}`)
          if (tool.name === 'get_queue_jobs')
            assert.include(
              JSON.stringify(success),
              'queue-sentinel-visible',
              'the seeded queue payload was actually read'
            )
          assert.notInclude(JSON.stringify(success), SENTINEL, `${era} ${tool.name} success`)
        }
        const listedResources = await client.listResources()
        assert.lengthOf(listedResources.resources, 4)
        for (const resource of listedResources.resources) {
          const result = await client.readResource({ uri: resource.uri })
          assert.notInclude(JSON.stringify(result), SENTINEL, `${era} ${resource.uri}`)
        }
        const config = await client.readResource({ uri: 'adonis://config/security' })
        assert.notInclude(JSON.stringify(config), SENTINEL)
        const prompts = await client.listPrompts()
        assert.lengthOf(prompts.prompts, 3)
        for (const prompt of prompts.prompts) {
          if (prompt.name === 'security_failure') {
            await assert.rejects(
              () => client.getPrompt({ name: prompt.name }),
              /prompt-failure \[REDACTED\]/
            )
            continue
          }
          const result = await client.getPrompt({
            name: prompt.name,
            arguments:
              prompt.name === 'add_feature'
                ? { feature: SENTINEL }
                : { path: '/__security/secrets' },
          })
          assert.notInclude(JSON.stringify(result), SENTINEL, `${era} ${prompt.name}`)
        }
        const thrown = await client.callTool({
          name: 'project_eval',
          arguments: { code: 'throw new Error(process.env.SECURITY_PASSWORD)' },
        })
        assert.isTrue(thrown.isError)
        assert.notInclude(JSON.stringify(thrown), SENTINEL)
        const escaped = toolPayload<{
          data: { display: string; console: { entries: Array<{ text: string }> } }
        }>(
          await client.callTool({
            name: 'project_eval',
            arguments: {
              code: "const secret = process.env.SECURITY_PRIVATE_KEY; console.dir({ secret }); console.table([secret]); console.log('%o %j %s', { secret }, { secret }, secret); return { secret }",
            },
          })
        )
        assert.include(escaped.data.display, '[REDACTED]')
        assert.notInclude(escaped.data.display, 'MIIE-security')
        assert.lengthOf(escaped.data.console.entries, 3)
        for (const entry of escaped.data.console.entries) {
          assert.include(entry.text, '[REDACTED]')
          assert.notInclude(entry.text, 'MIIE-security')
        }
        const captured = await client.callTool({
          name: 'get_logs',
          arguments: { grep: 'securityprobe' },
        })
        assert.include(JSON.stringify(captured), 'securityprobe')
        assert.notInclude(JSON.stringify(captured), SENTINEL)
      } finally {
        await client.close()
      }
    }
    assert.equal(checkedTools.size, 28, 'exercise the complete built-in catalog')
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const count = toolPayload<{ data: { rows: number[][] } }>(
        await client.callTool({
          name: 'execute_sql_query',
          arguments: { query: 'SELECT count(*) FROM security_observer' },
        })
      )
      assert.isAbove(count.data.rows[0][0], 0, 'model read hooks actually mutate state')
      const catalog = await client.listTools()
      const query = catalog.tools.find((tool) => tool.name === 'query_model')!
      assert.deepInclude(query.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      })
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(300000)

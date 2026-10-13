/*
|--------------------------------------------------------------------------
| Real compiled Vine validator discovery (M6 / WP-23)
|--------------------------------------------------------------------------
|
| Both MCP eras read the API kit's own validators and specimen exports.
| A route exposes callback execution count independently of MCP results.
|
*/

import { appendFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { ValidatorNode, ValidatorSnapshot } from '../../src/introspection/validators.js'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient, type ProtocolEra } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  toolPayload,
  waitForMcp,
  writeMcpConfig,
} from '../helpers/mcp_endpoint.js'

const SPECIMEN = `import vine, { SimpleMessagesProvider } from '@vinejs/vine'
export const counter = { value: 0 }
const custom = vine.createRule(function minLength() { counter.value++ }, { name: 'minLength' })
export const direct = vine.create({
  title: vine.string().minLength(3),
  nested: vine.object({ age: vine.number().min(18) }).allowUnknownProperties(),
  rows: vine.array(vine.object({ value: vine.string().nullable() })).minLength(1),
  optional: vine.string().optional(),
  custom: vine.string().use(custom({ apiSecret: 'fixture-secret-value', check: () => { counter.value++ } })),
  email: vine.string().unique(async () => { counter.value++; return true }),
  tuple: vine.tuple([vine.string(), vine.number()]),
  record: vine.record(vine.string()),
})
direct.messagesProvider = new SimpleMessagesProvider({ 'title.minLength': 'TITLE_TOO_SHORT' }, { title: 'Judul' })
export const grouped = vine.compile(vine.object({ kind: vine.string() }).merge(vine.group([
  vine.group.if((value) => { counter.value++; return value.kind === 'company' }, { company: vine.string() }),
  vine.group.else({ person: vine.string() }),
])))
export const conditional = vine.create({ choice: vine.union([
  vine.union.if((value) => { counter.value++; return typeof value === 'string' }, vine.string().minLength(2)),
  vine.union.else(vine.number()),
]) })
export const dynamic = vine.compile(vine.object({ value: vine.string() }))
dynamic.messagesProvider = { getMessage() { counter.value++; return 'DYNAMIC' } }
export const notValidator = { validate() {}, toJSON() { counter.value++; return {} } }
export { direct as aliased }
export default dynamic
`

function flatten(node: ValidatorNode | null): ValidatorNode[] {
  if (!node) {
    return []
  }
  return [
    node,
    ...node.properties.flatMap(flatten),
    ...flatten(node.each),
    ...node.groups.flatMap(flatten),
    ...node.branches.flatMap((branch) => flatten(branch.schema)),
  ]
}

interface Envelope {
  data: ValidatorSnapshot
  limitations: string[]
}

test.group('Validators | real API kit compiled AST', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    await fixture.migrate()
    await installPackage(fixture)
    await writeMcpConfig(fixture, '')
    await mkdir(join(fixture.root, 'app/validators/nested'), { recursive: true })
    await writeFile(join(fixture.root, 'app/validators/nested/specimen.ts'), SPECIMEN)
    await writeFile(
      join(fixture.root, 'app/validators/failure.ts'),
      "throw new Error('fixture-import-failure')\nexport {}\n"
    )
    await writeFile(join(fixture.root, 'app/validators/empty.js'), 'export const ignored = 42\n')
    await appendFile(
      join(fixture.root, 'start/routes.ts'),
      `\nimport { counter } from '#validators/nested/specimen'\nrouter.get('/__fixture/validator-counter', () => counter)\n`
    )
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    return () => fixture.dispose()
  })

  for (const era of ['modern', 'legacy'] as ProtocolEra[]) {
    test(`compiled AST, callbacks and failures (${era})`, async ({ assert }) => {
      const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
      try {
        const response = await client.callTool({ name: 'get_validators', arguments: {} })
        assert.isNotTrue(response.isError, JSON.stringify(response.content))
        const result = toolPayload<Envelope>(response)
        assert.isTrue(result.data.exists)
        assert.equal(result.data.directory, 'app/validators')
        assert.includeMembers(
          result.data.validators.map((validator) => validator.id),
          [
            'user#signupValidator',
            'user#loginValidator',
            'nested/specimen#direct',
            'nested/specimen#grouped',
            'nested/specimen#conditional',
            'nested/specimen#dynamic',
          ]
        )
        assert.isFalse(
          result.data.validators.some(
            (validator) => validator.name === 'notValidator' || validator.file.endsWith('empty.js')
          )
        )
        assert.deepEqual(result.data.failures, [
          { file: 'app/validators/failure.ts', message: 'fixture-import-failure' },
        ])
        const direct = result.data.validators.find((validator) => validator.name === 'direct')!
        assert.deepEqual(direct.location, {
          file: 'app/validators/nested/specimen.ts',
          line: 4,
          evidence: 'source',
        })
        for (const exportName of ['aliased', 'default']) {
          const validator = result.data.validators.find((entry) => entry.name === exportName)!
          const line =
            SPECIMEN.split('\n').findIndex(
              (text) =>
                text ===
                (exportName === 'aliased'
                  ? 'export { direct as aliased }'
                  : 'export default dynamic')
            ) + 1
          assert.deepEqual(validator.location, {
            file: 'app/validators/nested/specimen.ts',
            line,
            evidence: 'source',
          })
        }
        assert.notProperty(direct, 'refs')
        const nodes = flatten(direct.schema)
        for (const node of nodes) {
          assert.notProperty(node.metadata, 'properties')
          assert.notProperty(node.metadata, 'each')
          assert.notProperty(node.metadata, 'groups')
          assert.notProperty(node.metadata, 'conditions')
          assert.notProperty(node.metadata, 'validations')
        }
        const nullable = nodes.find((node) => node.path === 'rows.*.value')!
        assert.equal(nullable.type, 'literal')
        assert.equal(nullable.subtype, 'string')
        assert.isTrue(nullable.nullable)
        assert.isFalse(nullable.optional)
        assert.isTrue(nodes.find((node) => node.path === 'optional')!.optional)
        assert.isTrue(nodes.find((node) => node.path === 'nested')!.allowUnknownProperties)
        const title = nodes.find((node) => node.path === 'title')!
        assert.deepEqual(
          title.rules.map((rule) => rule.name),
          ['minLength']
        )
        assert.deepEqual(title.rules[0].options, { min: 3 })
        assert.equal(title.rules[0].origin, 'vine-definition-match')
        assert.isFalse(title.rules[0].implicit)
        assert.isFalse(title.rules[0].async)
        assert.deepEqual(nodes.find((node) => node.path === 'nested.age')!.rules[0].options, {
          min: 18,
        })
        const custom = nodes.find((node) => node.path === 'custom')!.rules[0]
        assert.equal(custom.name, 'minLength')
        assert.equal(custom.meaning, 'unknown')
        assert.equal(custom.origin, 'custom-or-unknown')
        assert.deepEqual(custom.options, {
          apiSecret: '[REDACTED]',
          check: { kind: 'function', name: 'check' },
        })
        const unique = nodes.find((node) => node.path === 'email')!.rules[0]
        assert.deepEqual(unique.options, { kind: 'function', name: '' })
        assert.equal(unique.meaning, 'unknown')
        assert.isTrue(unique.async)
        assert.equal(nodes.find((node) => node.path === 'tuple')!.type, 'tuple')
        assert.equal(nodes.find((node) => node.path === 'tuple.1')!.subtype, 'number')
        assert.equal(nodes.find((node) => node.path === 'record.*')!.subtype, 'string')
        assert.deepEqual(direct.messages, {
          status: 'serialized',
          value: { messages: { 'title.minLength': 'TITLE_TOO_SHORT' }, fields: { title: 'Judul' } },
        })
        assert.equal(
          result.data.validators.find((validator) => validator.name === 'dynamic')!.messages.status,
          'unknown'
        )
        const grouped = result.data.validators.find((validator) => validator.name === 'grouped')!
        const branches = grouped.schema!.groups[0].branches
        assert.lengthOf(branches, 2)
        assert.deepEqual(
          branches.map((branch) => branch.schema!.properties[0].path),
          ['company', 'person']
        )
        for (const branch of branches) {
          assert.equal(branch.condition.kind, 'callback')
          assert.isFalse(branch.condition.executed)
          assert.isNull(branch.condition.function)
          assert.isString(branch.condition.reference)
        }
        const union = result.data.validators.find((validator) => validator.name === 'conditional')!
          .schema!.properties[0]
        assert.equal(union.type, 'union')
        assert.deepEqual(
          union.branches.map((branch) => branch.schema!.subtype),
          ['string', 'number']
        )
        assert.isTrue(union.branches.every((branch) => branch.condition.executed === false))
        assert.isString(union.otherwise!.reference)
        assert.isString(union.otherwise!.function)
        assert.deepEqual(
          await app.fetch('/__fixture/validator-counter').then((reply) => reply.json()),
          { value: 0 }
        )
        const filtered = await client.callTool({
          name: 'get_validators',
          arguments: { name: 'nested/specimen#direct' },
        })
        assert.deepEqual(
          toolPayload<Envelope>(filtered).data.validators.map((validator) => validator.name),
          ['direct']
        )
        const byExport = await client.callTool({
          name: 'get_validators',
          arguments: { name: 'loginValidator' },
        })
        assert.lengthOf(toolPayload<Envelope>(byExport).data.validators, 1)
        const missing = await client.callTool({
          name: 'get_validators',
          arguments: { name: 'unknown' },
        })
        assert.isTrue(missing.isError)
        const error = toolPayload<{ error: { code: string; message: string } }>(missing).error
        assert.equal(error.code, 'NOT_FOUND')
        assert.include(error.message, 'user#loginValidator')
      } finally {
        await client.close()
      }
    })
  }

  test('modified source is flagged without cache-busting imports', async ({ assert }) => {
    const file = join(fixture.root, 'app/validators/nested/specimen.ts')
    const now = new Date()
    await utimes(file, now, now)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    try {
      const response = await client.callTool({
        name: 'get_validators',
        arguments: { name: 'direct' },
      })
      const result = toolPayload<Envelope>(response)
      assert.isTrue(result.data.validators[0].changedSinceProcessStart)
      assert.isTrue(
        result.limitations.some((limitation) => limitation.includes('previous version'))
      )
      assert.deepEqual(
        await app.fetch('/__fixture/validator-counter').then((reply) => reply.json()),
        { value: 0 }
      )
    } finally {
      await client.close()
    }
  })
})

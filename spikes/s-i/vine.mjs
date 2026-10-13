import { createRequire } from 'node:module'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
const root = process.argv[2]
const require = createRequire(join(root, 'package.json'))
const { default: vine, SimpleMessagesProvider } = await import(require.resolve('@vinejs/vine'))
const custom = vine.createRule((value, _options, field) => { if (value !== 'allowed') field.report('CUSTOM_DENIED', 'customAllowed', field) }, { name: 'customAllowed' })
const schemas = {
  direct: vine.object({ title: vine.string().minLength(3), nested: vine.object({ age: vine.number().min(18) }), rows: vine.array(vine.object({ value: vine.string().nullable() })).minLength(1), optional: vine.string().optional() }),
  conditional: vine.object({ kind: vine.string() }).merge(vine.group([vine.group.if((value) => value.kind === 'company', { company: vine.string() }), vine.group.else({ person: vine.string() })])),
  union: vine.object({ choice: vine.union([vine.union.if((value) => typeof value === 'string', vine.string().minLength(2)), vine.union.else(vine.number())]) }),
  custom: vine.object({ value: vine.string().use(custom()) }),
}
const observations = {}
for (const [name, schema] of Object.entries(schemas)) {
  const validator = vine.compile(schema)
  observations[name] = { rawSchema: schema.toJSONSchema(), compiled: validator.toJSON(), jsonSchema: validator.toJSONSchema() }
}
observations.actualValidation = {}
for (const [name, input] of [
  ['direct', { title: 'valid', nested: { age: 18 }, rows: [{}] }],
  ['conditional', { kind: 'company', person: 'not-company' }],
  ['union', { choice: 'x' }],
  ['custom', { value: 'denied' }],
]) {
  const [error, output] = await vine.compile(schemas[name]).tryValidate(input)
  observations.actualValidation[name] = { input, errors: error?.messages ?? null, output }
}
const messages = vine.compile(vine.object({ title: vine.string().minLength(3) }))
messages.messagesProvider = new SimpleMessagesProvider({ 'title.minLength': 'TITLE_TOO_SHORT' }, { title: 'Judul' })
const [error] = await messages.tryValidate({ title: 'x' })
observations.messages = { metadata: messages.messagesProvider.toJSON(), actualError: error.messages }
messages.messagesProvider = { getMessage(_message, rule) { return `DYNAMIC_${rule}` } }
const [dynamicError] = await messages.tryValidate({ title: 'x' })
observations.dynamicProvider = { enumerableKeys: Object.keys(messages.messagesProvider), hasToJSON: typeof messages.messagesProvider.toJSON === 'function', actualError: dynamicError.messages, introspection: 'unknown-without-execution' }
const json = JSON.stringify(observations, (_key, value) => typeof value === 'function' ? { kind: 'function', name: value.name } : value, 2)
if (process.argv[3]) await writeFile(process.argv[3], json + '\n')
else console.log(json)

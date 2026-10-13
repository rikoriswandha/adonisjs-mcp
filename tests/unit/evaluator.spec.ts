import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { ProjectEvaluator } from '../../src/eval/evaluator.js'
import { Redactor } from '../../src/redaction.js'
import { resolveConfig } from '../../src/define_config.js'

const pem = '-----BEGIN PRIVATE KEY-----\nMIIEsecretbody42\n-----END PRIVATE KEY-----'
// Only the evaluator's application dependencies are needed in this focused test.
const app = {
  makePath: (name: string) => name,
  container: { hasBinding: () => false, make: async () => ({ info() {} }) },
} as unknown as ApplicationService
const context = {
  app,
  config: resolveConfig({ limits: { maxResultBytes: 32768 } }),
  callId: 'regression',
  signal: new AbortController().signal,
  logs: null,
  exceptions: null,
  tenancy: null,
  profile: () => Promise.reject(new Error('profile not requested')),
}

test('Evaluator | nested multiline Errors are masked in display and console', async ({
  assert,
}) => {
  const evaluator = new ProjectEvaluator(app, new Redactor([pem]))
  for (const expression of [
    '({ reason: err })',
    '[err]',
    'await Promise.allSettled([Promise.reject(err)])',
    "new Error('x', { cause: err })",
    "new AggregateError([err], 'aggregate')",
  ]) {
    const result = await evaluator.run(
      `const err = new Error(${JSON.stringify(pem)}); const value = ${expression}; console.log(value); return value`,
      10000,
      null,
      context
    )
    const encoded = JSON.stringify(result)
    assert.notInclude(encoded, 'MIIEsecretbody42')
    assert.include(encoded, '[REDACTED]')
  }
})

test('Evaluator | large string arrays are inspected with a bounded per-string cap', async ({
  assert,
}) => {
  const evaluator = new ProjectEvaluator(app, new Redactor([]))
  const started = performance.now()
  const result = await evaluator.run(
    "return Array(100).fill('x'.repeat(6_000_000))",
    10000,
    null,
    context
  )
  assert.isBelow(performance.now() - started, 2000)
  const data = result.data as { displayTruncated: boolean }
  assert.isTrue(data.displayTruncated)
}).timeout(15000)

test('Evaluator | a small result limit never shows a secret prefix in failures', async ({
  assert,
}) => {
  const secret = 'Str0ngSecret-abcdefghijklmnop'
  const redactor = new Redactor([secret])
  const evaluator = new ProjectEvaluator(app, redactor)
  const small = { ...context, config: resolveConfig({ limits: { maxResultBytes: 4096 } }) }
  // Former per-string cap for this limit: the secret straddles it at every offset.
  const formerCap = 2048 + redactor.longestEscapedSecretLength
  for (let offset = 8; offset < secret.length; offset += 7) {
    const result = await evaluator
      .run(
        `throw { body: 'x'.repeat(${formerCap - offset}) + ${JSON.stringify(secret)} }`,
        10000,
        null,
        small
      )
      .catch((error: unknown) => error)
    const encoded = JSON.stringify(result, Object.getOwnPropertyNames(result as object))
    assert.notInclude(encoded, secret.slice(0, 8), `offset ${offset}`)
  }
})

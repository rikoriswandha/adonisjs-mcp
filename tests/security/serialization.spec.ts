import { test } from '@japa/runner'
import { Redactor } from '../../src/redaction.js'
import { encodeOutput } from '../../src/result.js'

test('Security | success scrubbing preserves requested data semantics and JSON conversion', ({
  assert,
}) => {
  const secret = 'sentinel-escaped-"\\\n-secret-value'
  const circular: Record<string, unknown> = {
    password: 'visible-password',
    token: 'visible-token',
    key: 'visible-key',
    neutral: secret,
    [secret]: 'dynamic-key',
  }
  circular.self = circular
  const result = encodeOutput(
    {
      data: {
        circular,
        date: new Date('2026-10-13T00:00:00Z'),
        map: new Map([
          ['neutral', secret],
          [secret, 'map-key'],
        ]),
        set: new Set([secret]),
        custom: { toJSON: () => ({ neutral: secret }) },
        error: new Error(secret),
        rows: [[1, secret, 'visible-password']],
      },
      limitations: [secret],
    },
    { maxBytes: 64000, durationMs: 0, redactor: new Redactor([secret]) }
  )
  const output = JSON.parse(result.text) as {
    data: {
      circular: Record<string, unknown>
      date: string
      map: Record<string, string>
      set: string[]
      custom: { neutral: string }
      error: { message: string }
      rows: unknown[][]
    }
    limitations: string[]
  }
  assert.deepInclude(output.data.circular, {
    password: 'visible-password',
    token: 'visible-token',
    key: 'visible-key',
    neutral: '[REDACTED]',
    self: '[Circular]',
  })
  assert.equal(output.data.date, '2026-10-13T00:00:00.000Z')
  assert.equal(output.data.circular['[REDACTED]'], 'dynamic-key')
  assert.notProperty(output.data.circular, secret)
  assert.deepEqual(output.data.map, { 'neutral': '[REDACTED]', '[REDACTED]': 'map-key' })
  assert.deepEqual(output.data.set, ['[REDACTED]'])
  assert.equal(output.data.custom.neutral, '[REDACTED]')
  assert.equal(output.data.error.message, '[REDACTED]')
  assert.deepEqual(output.data.rows, [[1, '[REDACTED]', 'visible-password']])
  assert.deepEqual(output.limitations, ['[REDACTED]'])
  assert.isFalse(result.truncated)
})

test('Security | scrubbing runs before shrinking and byte accounting', ({ assert }) => {
  const secret = 'CutPointSecret-123456789'
  const prefix = 'x'.repeat(16_380)
  const result = encodeOutput(
    { data: prefix + secret + 'y'.repeat(1000) },
    { maxBytes: 16_600, durationMs: 0, redactor: new Redactor([secret]) }
  )
  assert.isAtMost(Buffer.byteLength(result.text), 16_600)
  assert.isTrue(result.truncated)
  const parsed = JSON.parse(result.text) as { data: string }
  assert.include(parsed.data, prefix)
  assert.notInclude(
    parsed.data,
    'CutP',
    'no secret prefix survives a cut through the original value'
  )
})

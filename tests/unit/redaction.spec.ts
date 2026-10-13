import { test } from '@japa/runner'
import { inspect } from 'node:util'
import { HTTP_SENSITIVE_WORDS, isSensitiveKey, project, Redactor } from '../../src/redaction.js'
import { toJsonValue } from '../../src/result.js'

const SECRET = 'sentinel-env-secret-value-42'
const redactor = Redactor.fromEnvironment({ PAYMENT_SECRET: SECRET, LOG_LEVEL: 'informational' })

test.group('Redaction | sensitive keys', () => {
  test('masks credential key names in any casing style', ({ assert }) => {
    for (const key of [
      'password',
      'dbPassword',
      'client_secret',
      'apiToken',
      'appKey',
      'API_KEY',
      'private-key',
      'credentials',
      'Authorization',
      'keys',
      'password2',
      'secret1',
      'apiKey2',
      'key_2',
    ]) {
      assert.isTrue(isSensitiveKey(key), key)
    }
  })

  test('leaves neutral key names visible', ({ assert }) => {
    for (const key of ['keyPrefix', 'host', 'port', 'cookie', 'tokenizer', 'monkey', 'passive']) {
      assert.isFalse(isSensitiveKey(key), key)
    }
    assert.isTrue(isSensitiveKey('cookie', HTTP_SENSITIVE_WORDS))
  })
})

test.group('Redaction | project', () => {
  test('masks sensitive keys, secret env values and URL credentials', ({ assert }) => {
    const projected = project(
      {
        connection: { host: 'db.local', password: 'hunter2-literal', ssl: false },
        credentials: { user: 'admin', pass: 'x' },
        note: `uses ${SECRET} inline`,
        url: 'postgres://app:supersecretpw@db.local/app',
        enabled: true,
        token: null,
      },
      { redactor }
    )
    assert.deepEqual(projected, {
      connection: { host: 'db.local', password: '[REDACTED]', ssl: false },
      credentials: '[REDACTED]',
      note: 'uses [REDACTED] inline',
      url: 'postgres://app:[REDACTED]@db.local/app',
      enabled: true,
      token: null,
    })
  })

  test('summarizes non-data values without invoking them', ({ assert }) => {
    let getterCalls = 0
    let resolverCalls = 0
    class Secret {
      release() {
        return SECRET
      }
    }
    const source: Record<string, unknown> = {
      handler: function namedHandler() {},
      instance: new Secret(),
      lazy: {
        type: 'provider',
        resolver: () => {
          resolverCalls++
        },
      },
      when: new Date(0),
      pattern: /a+/g,
    }
    Object.defineProperty(source, 'computed', {
      enumerable: true,
      get() {
        getterCalls++
        return SECRET
      },
    })
    source.self = source

    const projected = project(source, { redactor }) as Record<string, unknown>
    assert.equal(projected.handler, '[Function namedHandler]')
    assert.equal(projected.instance, '[Secret]')
    assert.match(String(projected.lazy), /^\[ConfigProvider/)
    assert.equal(projected.computed, '[Getter]')
    assert.equal(projected.self, '[Circular]')
    assert.equal(projected.when, '1970-01-01T00:00:00.000Z')
    assert.equal(projected.pattern, '/a+/g')
    assert.equal(getterCalls, 0)
    assert.equal(resolverCalls, 0)
  })
})

test('Redaction | success scrub distinguishes low entropy from strong registered values', ({
  assert,
}) => {
  const scrubber = new Redactor(['postgres', 'abcdefgh', 'Abcdef12', 'abcdefghijklmnop'])
  assert.equal(
    scrubber.knownSecrets('postgres abcdefgh Abcdef12 abcdefghijklmnop'),
    'postgres abcdefgh [REDACTED] [REDACTED]'
  )
  assert.equal(
    scrubber.text('postgres abcdefgh Abcdef12 abcdefghijklmnop'),
    '[REDACTED] [REDACTED] [REDACTED] [REDACTED]'
  )
  assert.deepEqual(toJsonValue({ postgres: 'postgres', Abcdef12: 'Abcdef12' }, scrubber), {
    'postgres': 'postgres',
    '[REDACTED]': '[REDACTED]',
  })
})

test('Redaction | nested Error stacks mask multiline secrets without mutating errors', ({
  assert,
}) => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEsecretbody42\n-----END PRIVATE KEY-----'
  const scrubber = new Redactor([pem])
  const error = new Error(pem)
  const values = [
    { reason: error },
    [error],
    [{ status: 'rejected', reason: error }],
    new Error('x', { cause: error }),
    new AggregateError([error], 'aggregate'),
  ]
  for (const value of values) {
    const display = scrubber.inspectedText(inspect(value, { breakLength: Infinity }))
    assert.notInclude(display, 'MIIEsecretbody42')
    assert.include(display, '[REDACTED]')
  }
  assert.equal(error.message, pem)
})

test('Redaction | colliding scrubbed object and Map keys retain every entry', ({ assert }) => {
  const other = 'AnotherStrongSecret-123'
  const scrubber = redactor.withSecrets([other])
  const entries: Array<[string, number]> = [
    [SECRET, 1],
    [other, 2],
    ['[REDACTED]', 3],
  ]
  for (const value of [Object.fromEntries(entries), new Map(entries)]) {
    assert.deepEqual(toJsonValue(value, scrubber), {
      '[REDACTED]': 1,
      '[REDACTED]#2': 2,
      '[REDACTED]#3': 3,
    })
  }
})

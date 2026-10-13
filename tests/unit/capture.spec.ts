import { EventEmitter } from 'node:events'
import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { callScope } from '../../src/call_scope.js'
import { ExceptionCapture } from '../../src/buffers/exception_capture.js'
import { LogCapture } from '../../src/buffers/log_capture.js'
import { Redactor } from '../../src/redaction.js'

const SECRET = 'sentinel-env-secret-value-42'
const redactor = Redactor.fromEnvironment({ PAYMENT_SECRET: SECRET })

function line(record: Record<string, unknown>) {
  return `${JSON.stringify({ level: 30, time: 1_700_000_000_000, pid: 1, hostname: 'h', ...record })}\n`
}

function logs(capacity = 100, maxBytes = 1024 * 1024) {
  return new LogCapture({ capacity, maxBytes, redactor })
}

test.group('LogCapture', () => {
  test('stores redacted records with request and call correlation', async ({ assert }) => {
    const capture = logs()
    capture.handleLine(
      line({ msg: `charging with ${SECRET}`, request_id: 'req-1', user: { password: 'pw-123456' } })
    )
    await callScope.run({ callId: 'call-1' }, async () => {
      await Promise.resolve()
      capture.handleLine(line({ level: 50, msg: 'inside call' }))
    })
    capture.handleLine(line({ msg: 'after call' }))

    const [first, second, third] = capture.query().entries
    assert.deepInclude(first, {
      message: 'charging with [REDACTED]',
      requestId: 'req-1',
      callId: null,
      levelName: 'info',
      time: '2023-11-14T22:13:20.000Z',
    })
    assert.deepEqual(first.fields, { user: { password: '[REDACTED]' } })
    assert.deepInclude(second, { callId: 'call-1', levelName: 'error', requestId: null })
    assert.isNull(third.callId)
    assert.notInclude(JSON.stringify(capture.query()), SECRET)
  })

  test('filters by level, literal text, request, call and cursor', ({ assert }) => {
    const capture = logs()
    capture.handleLine(line({ level: 20, msg: 'debug noise', request_id: 'a' }))
    capture.handleLine(line({ level: 40, msg: 'Disk (almost) FULL', request_id: 'a' }))
    capture.handleLine(
      line({ level: 50, msg: 'failed', request_id: 'b', detail: 'disk (almost) full' })
    )

    const messages = (query: Parameters<LogCapture['query']>[0]) =>
      capture.query(query).entries.map((entry) => entry.message)
    assert.deepEqual(messages({ level: 'warn' }), ['Disk (almost) FULL', 'failed'])
    assert.deepEqual(messages({ grep: 'disk (almost)' }), ['Disk (almost) FULL', 'failed'])
    assert.deepEqual(messages({ requestId: 'a' }), ['debug noise', 'Disk (almost) FULL'])
    assert.deepEqual(messages({ afterSeq: 2 }), ['failed'])
    assert.deepEqual(messages({ tail: 1 }), ['failed'])
    assert.equal(capture.query({ tail: 1 }).matched, 3)
    assert.equal(capture.query().lastSeq, 3)
  })

  test('keeps non-JSON lines and shortens oversized records within the budget', ({ assert }) => {
    const capture = logs(10, 64 * 1024)
    capture.handleLine('plain text line\n')
    capture.handleLine(line({ msg: 'big', payload: 'x'.repeat(40_000) }))
    capture.handleLine(line({ level: 50, msg: 'huge', payload: 'y'.repeat(200_000) }))

    const [plain, big, huge] = capture.query().entries
    assert.equal(plain.message, 'plain text line')
    assert.isNull(plain.level)
    assert.isTrue(big.truncated)
    assert.equal(big.message, 'big')
    assert.isBelow(Buffer.byteLength(JSON.stringify(big)), 16 * 1024 + 1)
    assert.deepInclude(huge, { levelName: 'error', truncated: true })
    assert.match(huge.message!, /not captured: over the parse limit/)
    assert.isBelow(capture.query().stats.retainedBytes, 64 * 1024)
  })

  test('a cursor read returns every record after it, page by page', ({ assert }) => {
    const capture = logs()
    capture.handleLine(line({ msg: 'seen' }))
    const cursor = capture.query().lastSeq
    for (let index = 0; index < 5; index++) {
      capture.handleLine(line({ msg: `new-${index}` }))
    }

    const read: string[] = []
    let afterSeq = cursor
    for (let page = 0; page < 5; page++) {
      const result = capture.query({ afterSeq, tail: 2 })
      read.push(...result.entries.map((entry) => entry.message!))
      afterSeq = result.lastSeq
      if (!result.hasMore) {
        break
      }
    }
    assert.deepEqual(read, ['new-0', 'new-1', 'new-2', 'new-3', 'new-4'])
    assert.deepEqual(capture.query({ afterSeq }).entries, [])
  })

  test('a cursor read reports records evicted before it ran', ({ assert }) => {
    const capture = logs(2)
    capture.handleLine(line({ msg: 'm1' }))
    const cursor = capture.query().lastSeq
    for (let index = 2; index <= 5; index++) {
      capture.handleLine(line({ msg: `m${index}` }))
    }
    const page = capture.query({ afterSeq: cursor })
    assert.deepEqual(
      page.entries.map((entry) => entry.message),
      ['m4', 'm5']
    )
    assert.equal(page.missed, 2)
  })

  test('grep matches field text literally and fields named __proto__ are kept', ({ assert }) => {
    const capture = logs()
    const record = JSON.stringify({
      level: 30,
      msg: 'paths',
      file: 'C:\\tmp\\say "hi"',
      user: 'ana',
    })
    capture.handleLine(`${record.replace('"user"', '"__proto__":{"x":1},"user"')}\n`)
    capture.handleLine(line({ msg: 'other' }))

    assert.deepEqual(
      capture.query({ grep: 'c:\\tmp\\say "hi"' }).entries.map((entry) => entry.message),
      ['paths']
    )
    assert.lengthOf(capture.query({ grep: '":' }).entries, 0)
    const [entry] = capture.query({ grep: 'paths' }).entries
    assert.equal(entry.fields.user, 'ana')
    assert.deepEqual(Object.getOwnPropertyDescriptor(entry.fields, '__proto__')?.value, { x: 1 })
  })

  test('evicts by count and reports it', ({ assert }) => {
    const capture = logs(3)
    for (let index = 0; index < 5; index++) {
      capture.handleLine(line({ msg: `m${index}` }))
    }
    const page = capture.query()
    assert.deepEqual(
      page.entries.map((entry) => entry.message),
      ['m2', 'm3', 'm4']
    )
    assert.deepInclude(page.stats, { observed: 5, retained: 3, evicted: 2 })
  })
})

function fakeContext(options: { id: string; url: string; pattern?: string }) {
  const response = Object.assign(new EventEmitter(), { statusCode: 200 })
  const ctx = {
    request: { id: () => options.id, method: () => 'GET', url: () => options.url },
    route: options.pattern ? { pattern: options.pattern, name: 'items.show' } : undefined,
    response: { response },
  }
  return { ctx: ctx as unknown as HttpContext, response }
}

test.group('ExceptionCapture', () => {
  const appRoot = '/srv/app'

  test('records one entry per error object with the final response status', ({ assert }) => {
    const capture = new ExceptionCapture({
      capacity: 10,
      maxBytes: 1024 * 1024,
      redactor,
      appRoot,
    })
    const error = Object.assign(new Error(`lookup failed with ${SECRET}`), { code: 'E_LOOKUP' })
    error.stack = `Error: lookup failed\n    at show (file:///srv/app/app/controllers/items_controller.ts:12:5)\n    at run (/srv/app/node_modules/x/index.js:1:1)`
    const { ctx, response } = fakeContext({ id: 'req-9', url: '/items/9', pattern: '/items/:id' })

    capture.handle(error, ctx)
    capture.handle(error, ctx)
    response.statusCode = 503
    response.emit('finish')

    const page = capture.query()
    assert.lengthOf(page.exceptions, 1)
    const [entry] = page.exceptions
    assert.deepInclude(entry, {
      name: 'Error',
      code: 'E_LOOKUP',
      message: 'lookup failed with [REDACTED]',
      status: 503,
      statusSource: 'response',
      occurrences: 1,
    })
    assert.deepEqual(entry.request, {
      id: 'req-9',
      method: 'GET',
      url: '/items/9',
      route: { pattern: '/items/:id', name: 'items.show' },
    })
    assert.deepEqual(entry.stack, [
      'at show (./app/controllers/items_controller.ts:12:5)',
      'at run (./node_modules/x/index.js:1:1)',
    ])
    assert.equal(page.stats.observed, 2)
  })

  test('groups repeated failures by fingerprint and filters by request', ({ assert }) => {
    const capture = new ExceptionCapture({ capacity: 10, maxBytes: 1024 * 1024, redactor, appRoot })
    for (const id of ['1', '2', '3']) {
      const { ctx } = fakeContext({ id: `req-${id}`, url: `/items/${id}` })
      capture.handle(new Error(`item ${id} not found`), ctx)
    }
    const { ctx } = fakeContext({ id: 'req-x', url: '/other' })
    capture.handle(new TypeError('other failure'), ctx)

    const all = capture.query()
    assert.deepEqual(
      all.exceptions.map((entry) => [entry.request?.id, entry.occurrences]),
      [
        ['req-x', 1],
        ['req-3', 3],
        ['req-2', 3],
        ['req-1', 3],
      ]
    )
    assert.deepEqual(
      capture.query({ distinct: true }).exceptions.map((entry) => entry.request?.id),
      ['req-x', 'req-3']
    )
    assert.deepEqual(
      capture.query({ requestId: 'req-2' }).exceptions.map((entry) => entry.message),
      ['item 2 not found']
    )
  })

  test('a cursor read returns every exception after it, page by page', ({ assert }) => {
    const capture = new ExceptionCapture({ capacity: 10, maxBytes: 1024 * 1024, redactor, appRoot })
    const fail = (id: string) => capture.handle(new Error(id), fakeContext({ id, url: '/' }).ctx)
    fail('old')
    const cursor = capture.query().lastSeq
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      fail(id)
    }

    const pages: string[][] = []
    let afterSeq = cursor
    for (let page = 0; page < 5; page++) {
      const result = capture.query({ afterSeq, limit: 2 })
      pages.push(result.exceptions.map((entry) => entry.message))
      afterSeq = result.lastSeq
      if (!result.hasMore) {
        break
      }
    }
    assert.deepEqual(pages, [['b', 'a'], ['d', 'c'], ['e']])
  })
})

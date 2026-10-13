import { test } from '@japa/runner'
import { z } from 'zod'
import type { ApplicationService } from '@adonisjs/core/types'
import { resolveConfig } from '../../src/define_config.js'
import { defineTool } from '../../src/define_tool.js'
import { ToolError } from '../../src/errors.js'
import { invokeTool, type InvocationOptions } from '../../src/invocation.js'
import { Redactor } from '../../src/redaction.js'
import { encodeFailure, encodeOutput } from '../../src/result.js'
import type { AnyToolDefinition, ToolCallWrapper, ToolContext } from '../../src/types.js'

const SECRET = 'sk_live_0123456789abcdef'

function context(signal = new AbortController().signal): ToolContext {
  return {
    app: {} as ApplicationService,
    config: resolveConfig({}),
    profile: () => Promise.reject(new Error('not used')),
    callId: 'call-1',
    signal,
    logs: null,
    exceptions: null,
    tenancy: null,
  }
}

function options(wrappers: ToolCallWrapper[] = []): InvocationOptions {
  return {
    wrappers,
    redactor: Redactor.fromEnvironment({ STRIPE_SECRET_KEY: SECRET, LOG_LEVEL: 'informational' }),
    maxResultBytes: 256 * 1024,
  }
}

function tool(handler: AnyToolDefinition['handler']): AnyToolDefinition {
  return defineTool({
    name: 'fixture_tool',
    description: 'Fixture via the running AdonisJS app',
    inputSchema: z.object({}),
    handler,
  })
}

test.group('invokeTool', () => {
  test('runs wrappers once each, outermost first, around the handler', async ({ assert }) => {
    const order: string[] = []
    const wrapper =
      (label: string): ToolCallWrapper =>
      async (call, next) => {
        order.push(`${label}:${call.name}`)
        const output = await next()
        order.push(`${label}:after`)
        return output
      }
    const result = await invokeTool(
      tool(() => {
        order.push('handler')
        return { data: { ok: true }, evidence: ['runtime'] }
      }),
      {},
      context(),
      options([wrapper('outer'), wrapper('inner')])
    )

    assert.deepEqual(order, [
      'outer:fixture_tool',
      'inner:fixture_tool',
      'handler',
      'inner:after',
      'outer:after',
    ])
    assert.isFalse(result.isError)
    assert.deepInclude(JSON.parse(result.text), {
      data: { ok: true },
      evidence: ['runtime'],
      truncated: false,
    })
  })

  test('a wrapper may answer without calling the handler', async ({ assert }) => {
    let handled = false
    const result = await invokeTool(
      tool(() => {
        handled = true
        return { data: 1 }
      }),
      {},
      context(),
      options([
        () => Promise.reject(new ToolError('CAPABILITY_UNSUPPORTED', 'blocked in this project')),
      ])
    )
    assert.isFalse(handled)
    assert.isTrue(result.isError)
    assert.deepEqual(JSON.parse(result.text).error, {
      code: 'CAPABILITY_UNSUPPORTED',
      message: 'blocked in this project',
    })
  })

  test('calling next twice fails the call instead of running the handler twice', async ({
    assert,
  }) => {
    let runs = 0
    const result = await invokeTool(
      tool(() => ({ data: ++runs })),
      {},
      context(),
      options([
        async (_call, next) => {
          await next()
          return next()
        },
      ])
    )
    assert.equal(runs, 1)
    assert.isTrue(result.isError)
    assert.equal(JSON.parse(result.text).error.code, 'EXECUTION_FAILED')
    assert.match(JSON.parse(result.text).error.message, /more than once/)
  })

  test('keeps ToolError codes and redacts messages and details', async ({ assert }) => {
    const result = await invokeTool(
      tool(() => {
        throw new ToolError('NOT_FOUND', `no row for key ${SECRET}`, {
          details: { url: 'postgres://app:hunter2secret@db.local/app', key: SECRET },
        })
      }),
      {},
      context(),
      options()
    )
    assert.isTrue(result.isError)
    assert.notInclude(result.text, SECRET)
    assert.notInclude(result.text, 'hunter2secret')
    assert.deepEqual(JSON.parse(result.text).error, {
      code: 'NOT_FOUND',
      message: 'no row for key [REDACTED]',
      details: { url: 'postgres://app:[REDACTED]@db.local/app', key: '[REDACTED]' },
    })
  })

  test('maps unexpected errors, aborts and malformed outputs to stable codes', async ({
    assert,
  }) => {
    const failed = await invokeTool(
      tool(() => {
        throw new TypeError('Bearer eyJhbGciOiJIUzI1NiJ9.payload')
      }),
      {},
      context(),
      options()
    )
    assert.deepEqual(JSON.parse(failed.text).error, {
      code: 'EXECUTION_FAILED',
      message: 'Bearer [REDACTED]',
      details: { name: 'TypeError' },
    })

    const controller = new AbortController()
    const cancelled = await invokeTool(
      tool(() => {
        controller.abort()
        throw new Error('aborted')
      }),
      {},
      context(controller.signal),
      options()
    )
    assert.equal(JSON.parse(cancelled.text).error.code, 'CANCELLED')

    const malformed = await invokeTool(tool((() => 'plain') as never), {}, context(), options())
    assert.equal(JSON.parse(malformed.text).error.code, 'EXECUTION_FAILED')
  })
})

test.group('Result envelope', () => {
  test('serializes values JSON cannot represent directly', ({ assert }) => {
    const cyclic: Record<string, unknown> = { name: 'node' }
    cyclic.self = cyclic
    const { text } = encodeOutput(
      {
        data: {
          id: 10n,
          tags: new Set(['a']),
          index: new Map([[1, 'one']]),
          at: new Date('2026-10-13T00:00:00.000Z'),
          missing: undefined,
          ratio: Number.NaN,
          cyclic,
          model: { toJSON: () => ({ serialized: true }) },
        },
      },
      { maxBytes: 4096, durationMs: 1.4 }
    )
    assert.deepEqual(JSON.parse(text), {
      data: {
        id: '10',
        tags: ['a'],
        index: { 1: 'one' },
        at: '2026-10-13T00:00:00.000Z',
        ratio: null,
        cyclic: { name: 'node', self: '[Circular]' },
        model: { serialized: true },
      },
      durationMs: 1,
      truncated: false,
    })
  })

  test('shortens oversized results to valid JSON within the limit', ({ assert }) => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ index, body: 'x'.repeat(200) }))
    const maxBytes = 16 * 1024
    const { text, truncated } = encodeOutput(
      { data: rows, limitations: ['rows come from a fixture'] },
      { maxBytes, durationMs: 0 }
    )
    const parsed = JSON.parse(text)

    assert.isTrue(truncated)
    assert.isAtMost(Buffer.byteLength(text), maxBytes)
    assert.isTrue(parsed.truncated)
    assert.isAbove(parsed.data.length, 0)
    assert.isBelow(parsed.data.length, rows.length)
    assert.deepEqual(parsed.data[0].index, 0)
    assert.lengthOf(parsed.limitations, 2)
    assert.match(parsed.limitations[1], /maxResultBytes \(16384 bytes\)/)
  })

  test('drops failure details that do not fit', ({ assert }) => {
    const text = encodeFailure(
      { code: 'EXECUTION_FAILED', message: 'boom', details: { dump: 'x'.repeat(10_000) } },
      { maxBytes: 1024, durationMs: 0 }
    )
    assert.deepEqual(JSON.parse(text), {
      error: { code: 'EXECUTION_FAILED', message: 'boom' },
      durationMs: 0,
    })
  })
})

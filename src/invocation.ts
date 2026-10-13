/*
|--------------------------------------------------------------------------
| Tool invocation
|--------------------------------------------------------------------------
|
| Runs one tool call through the `extend()` wrappers and the handler, then
| turns the outcome into the result envelope. Every failure, including
| failures raised by wrappers, becomes an `isError` result with a stable
| code and a redacted message.
|
*/

import { ToolError } from './errors.js'
import { isPlainObject } from './define_tool.js'
import { encodeFailure, encodeOutput, type ToolFailure } from './result.js'
import type { Redactor } from './redaction.js'
import type {
  AnyToolDefinition,
  ToolCall,
  ToolCallWrapper,
  ToolContext,
  ToolOutput,
} from './types.js'

export interface InvocationResult {
  isError: boolean
  text: string
  truncated: boolean
}

export interface InvocationOptions {
  wrappers: readonly ToolCallWrapper[]
  redactor: Redactor
  maxResultBytes: number
}

function assertOutput(value: unknown): asserts value is ToolOutput {
  if (!isPlainObject(value) || !('data' in value)) {
    throw new Error('Tool handler must return an object with a "data" property')
  }
}

/**
 * Runs wrappers outermost first, then the handler. Each `next` can be
 * called once; a second call rejects.
 */
function dispatch(
  definition: AnyToolDefinition,
  call: ToolCall,
  wrappers: readonly ToolCallWrapper[],
  index: number
): Promise<ToolOutput> {
  if (index === wrappers.length) {
    // `input` is the output of the tool's own schema, validated by the SDK.
    const input = call.input as Parameters<AnyToolDefinition['handler']>[0]
    return Promise.resolve().then(() => definition.handler(input, call.context))
  }
  let called = false
  const next = () => {
    if (called) {
      return Promise.reject(
        new Error('next() was called more than once by a registry.extend() wrapper')
      )
    }
    called = true
    return dispatch(definition, call, wrappers, index + 1)
  }
  return Promise.resolve().then(() => wrappers[index](call, next))
}

export function describeFailure(error: unknown, signal: AbortSignal | undefined): ToolFailure {
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: { ...error.details } } : {}),
    }
  }
  if (signal?.aborted) {
    return { code: 'CANCELLED', message: 'The call was cancelled before it completed' }
  }
  if (error instanceof Error) {
    return {
      code: 'EXECUTION_FAILED',
      message: error.message,
      ...(error.name && error.name !== 'Error' ? { details: { name: error.name } } : {}),
    }
  }
  return { code: 'EXECUTION_FAILED', message: String(error) }
}

export function redactFailure(failure: ToolFailure, redactor: Redactor): ToolFailure {
  return {
    code: failure.code,
    message: redactor.text(failure.message),
    ...(failure.details
      ? { details: redactor.value(failure.details) as Record<string, unknown> }
      : {}),
  }
}

export async function invokeTool(
  definition: AnyToolDefinition,
  input: unknown,
  context: ToolContext,
  options: InvocationOptions
): Promise<InvocationResult> {
  const started = performance.now()
  const call: ToolCall = Object.freeze({ name: definition.name, input, context })
  try {
    const output: unknown = await dispatch(definition, call, options.wrappers, 0)
    assertOutput(output)
    const encoded = encodeOutput(output, {
      maxBytes: options.maxResultBytes,
      durationMs: performance.now() - started,
    })
    return { isError: false, ...encoded }
  } catch (error) {
    const failure = redactFailure(describeFailure(error, context.signal), options.redactor)
    return {
      isError: true,
      text: encodeFailure(failure, {
        maxBytes: options.maxResultBytes,
        durationMs: performance.now() - started,
      }),
      truncated: false,
    }
  }
}

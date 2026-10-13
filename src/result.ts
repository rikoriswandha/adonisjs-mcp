/*
|--------------------------------------------------------------------------
| Result envelope
|--------------------------------------------------------------------------
|
| Tool and resource payloads are JSON text. Values are first converted to
| JSON-safe data (BigInt, Map, Set, cycles, toJSON), then bounded by
| `limits.maxResultBytes`: oversized results are shortened structurally so
| the text stays valid JSON, and the envelope says so.
|
*/

import type { ToolErrorCode, ToolOutput } from './types.js'
import type { Redactor } from './redaction.js'

const MAX_DEPTH = 32
const MAX_MESSAGE_LENGTH = 4096

/**
 * Successively tighter bounds tried when a result exceeds the byte limit.
 * `items` caps arrays and object keys, `chars` caps strings.
 */
const SHRINK_STEPS: ReadonlyArray<{ items: number; chars: number }> = [
  { items: 1000, chars: 16_384 },
  { items: 500, chars: 8192 },
  { items: 200, chars: 4096 },
  { items: 100, chars: 2048 },
  { items: 50, chars: 1024 },
  { items: 20, chars: 512 },
  { items: 10, chars: 256 },
  { items: 5, chars: 128 },
  { items: 2, chars: 64 },
  { items: 1, chars: 32 },
  { items: 0, chars: 16 },
]

export interface EncodedResult {
  text: string
  truncated: boolean
}

export interface ToolFailure {
  code: ToolErrorCode
  message: string
  details?: Record<string, unknown>
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function convert(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  redactor?: Redactor
): unknown {
  switch (typeof value) {
    case 'string':
      return redactor ? redactor.knownSecrets(value) : value
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return convert(value.toString(), depth, ancestors, redactor)
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  if (value === null) {
    return null
  }

  const object = value as object
  if (ancestors.has(object)) {
    return '[Circular]'
  }
  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]'
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime())
      ? null
      : convert(object.toISOString(), depth, ancestors, redactor)
  }
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    return `[Binary ${object.byteLength} bytes]`
  }

  ancestors.add(object)
  try {
    if ('toJSON' in object && typeof object.toJSON === 'function') {
      try {
        return convert(object.toJSON(), depth + 1, ancestors, redactor)
      } catch (error) {
        return convert(
          `[toJSON failed: ${error instanceof Error ? error.message : String(error)}]`,
          depth + 1,
          ancestors,
          redactor
        )
      }
    }
    if (object instanceof Error) {
      return {
        name: convert(object.name, depth + 1, ancestors, redactor),
        message: convert(object.message, depth + 1, ancestors, redactor),
      }
    }
    if (object instanceof Map) {
      const names = new Set<string>()
      return Object.fromEntries(
        [...object.entries()].flatMap(([key, item]) => {
          const converted = convert(item, depth + 1, ancestors, redactor)
          const name = uniqueName(
            redactor ? redactor.knownSecrets(String(key)) : String(key),
            names
          )
          return converted === undefined ? [] : [[name, converted]]
        })
      )
    }
    if (object instanceof Set || Array.isArray(object)) {
      return [...object].map((item) => convert(item, depth + 1, ancestors, redactor) ?? null)
    }
    const names = new Set<string>()
    return Object.fromEntries(
      Object.entries(object).flatMap(([key, item]) => {
        const converted = convert(item, depth + 1, ancestors, redactor)
        return converted === undefined
          ? []
          : [[uniqueName(redactor ? redactor.knownSecrets(key) : key, names), converted]]
      })
    )
  } finally {
    ancestors.delete(object)
  }
}

function uniqueName(name: string, names: Set<string>): string {
  let unique = name
  let suffix = 2
  while (names.has(unique)) unique = `${name}#${suffix++}`
  names.add(unique)
  return unique
}

/**
 * Converts any value to data `JSON.stringify` represents faithfully.
 * `undefined` at the top level becomes `null`.
 */
export function toJsonValue(value: unknown, redactor?: Redactor): unknown {
  return convert(value, 0, new Set(), redactor) ?? null
}

/**
 * Shortens a JSON value produced by `toJsonValue`.
 */
function shrink(value: unknown, limits: { items: number; chars: number }): unknown {
  if (typeof value === 'string') {
    return value.length > limits.chars ? `${value.slice(0, limits.chars)}…` : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, limits.items).map((item) => shrink(item, limits))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, limits.items)
        .map(([key, item]) => [key, shrink(item, limits)])
    )
  }
  return value
}

/**
 * Returns `value` unchanged when `fits(value)`, otherwise the first
 * successively shortened copy that fits, or `undefined` when none does.
 */
export function shrinkToFit(
  value: unknown,
  fits: (candidate: unknown) => boolean
): { value: unknown; truncated: boolean } | undefined {
  if (fits(value)) {
    return { value, truncated: false }
  }
  for (const limits of SHRINK_STEPS) {
    const candidate = shrink(value, limits)
    if (fits(candidate)) {
      return { value: candidate, truncated: true }
    }
  }
  return undefined
}

/**
 * Serializes a successful tool or resource payload within `maxBytes`.
 */
export function encodeOutput(
  output: ToolOutput,
  options: { maxBytes: number; durationMs: number; redactor?: Redactor }
): EncodedResult {
  const data = toJsonValue(output.data, options.redactor)
  const evidence = output.evidence?.map((item) =>
    options.redactor ? options.redactor.knownSecrets(item) : item
  )
  const limitations =
    output.limitations?.map((item) =>
      options.redactor ? options.redactor.knownSecrets(item) : item
    ) ?? []
  const durationMs = Math.round(options.durationMs)

  const render = (payload: unknown, truncated: boolean, notes: string[]) =>
    JSON.stringify({
      data: payload,
      ...(evidence ? { evidence } : {}),
      ...(notes.length > 0 ? { limitations: notes } : {}),
      durationMs,
      truncated,
    })

  const full = render(data, false, limitations)
  if (byteLength(full) <= options.maxBytes) {
    return { text: full, truncated: false }
  }

  const notes = [
    ...limitations,
    `Result exceeded limits.maxResultBytes (${options.maxBytes} bytes); arrays, objects and strings were shortened.`,
  ]
  for (const limits of SHRINK_STEPS) {
    const candidate = render(shrink(data, limits), true, notes)
    if (byteLength(candidate) <= options.maxBytes) {
      return { text: candidate, truncated: true }
    }
  }
  return { text: render(null, true, notes), truncated: true }
}

/**
 * Serializes a failed call. Details are dropped when they would exceed
 * `maxBytes`.
 */
export function encodeFailure(
  failure: ToolFailure,
  options: { maxBytes: number; durationMs: number }
): string {
  const message =
    failure.message.length > MAX_MESSAGE_LENGTH
      ? `${failure.message.slice(0, MAX_MESSAGE_LENGTH)}…`
      : failure.message
  const durationMs = Math.round(options.durationMs)
  const details = failure.details === undefined ? undefined : toJsonValue(failure.details)
  const withDetails = JSON.stringify({
    error: { code: failure.code, message, ...(details === undefined ? {} : { details }) },
    durationMs,
  })
  if (details === undefined || byteLength(withDetails) <= options.maxBytes) {
    return withDetails
  }
  return JSON.stringify({ error: { code: failure.code, message }, durationMs })
}

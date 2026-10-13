/*
|--------------------------------------------------------------------------
| Exception capture
|--------------------------------------------------------------------------
|
| Receives errors from the single observer call in the application's
| `HttpExceptionHandler.handle()`, once per handled request failure (an
| error object seen twice is kept once). Entries are redacted before they
| are stored; stack paths inside the application root become relative.
| The response status is filled in when the response finishes.
|
*/

import { createHash } from 'node:crypto'
import { sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HttpContext } from '@adonisjs/core/http'
import { callScope } from '../call_scope.js'
import type { Redactor } from '../redaction.js'
import { RingBuffer } from './ring_buffer.js'
import type { CapturedException, ExceptionPage, ExceptionQuery, ExceptionReader } from '../types.js'

const MAX_MESSAGE_CHARS = 4096
const MAX_FRAMES = 30
const MAX_FRAME_CHARS = 512
const MAX_ENTRY_BYTES = 32 * 1024

export const DEFAULT_EXCEPTION_LIMIT = 10

export interface ExceptionCaptureOptions {
  capacity: number
  maxBytes: number
  redactor: Redactor

  /**
   * Absolute application root, without trailing separator.
   */
  appRoot: string
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function errorName(error: unknown): string {
  const name = property(error, 'name')
  if (typeof name === 'string' && name.length > 0) {
    return name
  }
  const constructorName = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name
  return typeof constructorName === 'string' && constructorName.length > 0
    ? constructorName
    : typeof error
}

function errorMessage(error: unknown): string {
  const message = property(error, 'message')
  if (typeof message === 'string') {
    return message
  }
  try {
    return String(error)
  } catch {
    return '[unprintable error]'
  }
}

export class ExceptionCapture implements ExceptionReader {
  readonly #buffer: RingBuffer<CapturedException>
  readonly #redactor: Redactor
  readonly #maxEntryBytes: number
  readonly #rootPath: string
  readonly #rootUrl: string
  readonly #seen = new WeakSet<object>()
  #seq = 0
  #observed = 0

  constructor(options: ExceptionCaptureOptions) {
    this.#buffer = new RingBuffer(options.capacity, options.maxBytes)
    this.#redactor = options.redactor
    this.#maxEntryBytes = Math.min(MAX_ENTRY_BYTES, Math.floor(options.maxBytes / 4))
    this.#rootPath = options.appRoot.endsWith(sep) ? options.appRoot : `${options.appRoot}${sep}`
    this.#rootUrl = pathToFileURL(this.#rootPath).href
  }

  #relativize(frame: string): string {
    return frame.split(this.#rootUrl).join('./').split(this.#rootPath).join('./')
  }

  #frames(error: unknown): string[] {
    const stack = property(error, 'stack')
    if (typeof stack !== 'string') {
      return []
    }
    return stack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .slice(0, MAX_FRAMES)
      .map((line) => cap(this.#redactor.text(this.#relativize(line)), MAX_FRAME_CHARS))
  }

  /**
   * Exception subscriber for the capture gateway.
   */
  readonly handle = (error: unknown, ctx: HttpContext) => {
    this.#observed++
    if (typeof error === 'object' && error !== null) {
      if (this.#seen.has(error)) {
        return
      }
      this.#seen.add(error)
    }

    const name = errorName(error)
    const code = property(error, 'code')
    const status = property(error, 'status')
    const message = cap(this.#redactor.text(errorMessage(error)), MAX_MESSAGE_CHARS)
    const stack = this.#frames(error)
    const cause = property(error, 'cause')
    const route = ctx.route

    const fingerprint = createHash('sha1')
      .update(
        [
          name,
          typeof code === 'string' ? code : '',
          message.replace(/\d+/g, '#'),
          stack.find((frame) => frame.includes('./') && !frame.includes('node_modules')) ??
            stack[0] ??
            '',
        ].join('\n')
      )
      .digest('hex')
      .slice(0, 12)

    const entry: CapturedException = {
      seq: ++this.#seq,
      time: new Date().toISOString(),
      name,
      code: typeof code === 'string' ? code : null,
      message,
      status: typeof status === 'number' ? status : null,
      statusSource: typeof status === 'number' ? 'error' : null,
      stack,
      cause:
        cause === undefined || cause === null
          ? null
          : {
              name: errorName(cause),
              message: cap(this.#redactor.text(errorMessage(cause)), MAX_MESSAGE_CHARS),
            },
      request: {
        id: ctx.request.id() ?? null,
        method: ctx.request.method(),
        url: this.#redactor.text(ctx.request.url()),
        route: route ? { pattern: route.pattern, name: route.name ?? null } : null,
      },
      callId: callScope.getStore()?.callId ?? null,
      fingerprint,
      truncated: false,
    }

    let size = byteLength(entry)
    if (size > this.#maxEntryBytes) {
      entry.stack = entry.stack.slice(0, 5)
      entry.message = cap(entry.message, 512)
      entry.truncated = true
      size = byteLength(entry)
    }
    this.#buffer.push(entry, size)

    const response = ctx.response.response
    response.once('finish', () => {
      entry.status = response.statusCode
      entry.statusSource = 'response'
    })
  }

  query(query: ExceptionQuery = {}): ExceptionPage {
    const limit = query.limit ?? DEFAULT_EXCEPTION_LIMIT
    const all = this.#buffer.toArray()
    const occurrences = new Map<string, number>()
    for (const entry of all) {
      occurrences.set(entry.fingerprint, (occurrences.get(entry.fingerprint) ?? 0) + 1)
    }

    const seen = new Set<string>()
    const matches: CapturedException[] = []
    for (let index = all.length - 1; index >= 0; index--) {
      const entry = all[index]
      if (query.afterSeq !== undefined && entry.seq <= query.afterSeq) {
        continue
      }
      if (query.requestId !== undefined && entry.request?.id !== query.requestId) {
        continue
      }
      if (query.distinct) {
        if (seen.has(entry.fingerprint)) {
          continue
        }
        seen.add(entry.fingerprint)
      }
      matches.push(entry)
    }

    /**
     * Following a cursor returns the oldest matches after it (still newest
     * first), so more than `limit` new exceptions are read over several
     * calls instead of skipped.
     */
    const following = query.afterSeq !== undefined
    const hasMore = following && matches.length > limit
    const selected = following ? matches.slice(-limit) : matches.slice(0, limit)
    const oldest = all[0]?.seq ?? this.#seq + 1
    return {
      exceptions: selected.map((entry) => ({
        ...entry,
        occurrences: occurrences.get(entry.fingerprint) ?? 1,
      })),
      matched: matches.length,
      lastSeq: hasMore ? (selected[0]?.seq ?? query.afterSeq!) : this.#seq,
      hasMore,
      missed: following ? Math.max(0, oldest - query.afterSeq! - 1) : 0,
      stats: {
        observed: this.#observed,
        retained: this.#buffer.length,
        retainedBytes: this.#buffer.bytes,
        evicted: this.#buffer.evicted,
      },
    }
  }

  clear() {
    this.#buffer.clear()
  }
}

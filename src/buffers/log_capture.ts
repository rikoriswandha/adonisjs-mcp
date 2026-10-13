/*
|--------------------------------------------------------------------------
| Log capture
|--------------------------------------------------------------------------
|
| Receives every serialized Pino record written by the instrumented
| logger (root and child loggers alike, since children share the stream),
| redacts it, and keeps it in a ring buffer bounded by entry count and
| bytes. Records are redacted before they are stored, so nothing secret is
| retained in memory by this package.
|
*/

import { callScope } from '../call_scope.js'
import { HTTP_SENSITIVE_WORDS, project, type Redactor } from '../redaction.js'
import { shrinkToFit } from '../result.js'
import { RingBuffer } from './ring_buffer.js'
import type { CapturedLog, LogLevelName, LogPage, LogQuery, LogReader } from '../types.js'

export const LOG_LEVELS: Readonly<Record<LogLevelName, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const LEVEL_NAMES = new Map<number, LogLevelName>(
  Object.entries(LOG_LEVELS).map(([name, value]) => [value, name as LogLevelName])
)

/**
 * Record keys represented by dedicated entry fields or not useful to an
 * agent (`pid`, `hostname` are the same for every record).
 */
const OMITTED_FIELDS = new Set(['level', 'time', 'msg', 'request_id', 'pid', 'hostname', 'v'])

/**
 * Lines longer than this are not parsed: their size is recorded instead,
 * so one huge record cannot cost an unbounded parse and projection.
 */
const MAX_PARSED_LINE_CHARS = 64 * 1024
const MAX_MESSAGE_CHARS = 4096
const MAX_ENTRY_BYTES = 16 * 1024

export const DEFAULT_LOG_TAIL = 100

export interface LogCaptureOptions {
  capacity: number
  maxBytes: number
  redactor: Redactor
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncateMessage(message: string): { text: string; truncated: boolean } {
  return message.length > MAX_MESSAGE_CHARS
    ? { text: `${message.slice(0, MAX_MESSAGE_CHARS)}…`, truncated: true }
    : { text: message, truncated: false }
}

function isoTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return typeof value === 'string' ? value : null
}

/**
 * Message, field names and scalar field values of an entry, unescaped,
 * for literal search.
 */
function searchableText(entry: CapturedLog): string {
  const parts: string[] = [entry.message ?? '']
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        parts.push(key)
        visit(item)
      }
    } else if (value !== null && value !== undefined) {
      parts.push(String(value))
    }
  }
  visit(entry.fields)
  return parts.join('\n')
}

export class LogCapture implements LogReader {
  readonly #buffer: RingBuffer<CapturedLog>
  readonly #redactor: Redactor
  readonly #maxEntryBytes: number
  #seq = 0
  #observed = 0

  constructor(options: LogCaptureOptions) {
    this.#buffer = new RingBuffer(options.capacity, options.maxBytes)
    this.#redactor = options.redactor
    this.#maxEntryBytes = Math.min(MAX_ENTRY_BYTES, Math.floor(options.maxBytes / 4))
  }

  /**
   * Log subscriber for the capture gateway.
   */
  readonly handleLine = (line: string) => {
    this.#observed++
    const callId = callScope.getStore()?.callId ?? null
    const entry = this.#entry(line, callId)
    const size = byteLength(entry)
    if (size <= this.#maxEntryBytes) {
      this.#buffer.push(entry, size)
      return
    }
    this.#pushShortened(entry)
  }

  #entry(line: string, callId: string | null): CapturedLog {
    const seq = ++this.#seq
    if (line.length > MAX_PARSED_LINE_CHARS) {
      const level = /"level":(\d+)/.exec(line.slice(0, 256))
      const value = level ? Number(level[1]) : null
      return {
        seq,
        time: null,
        level: value,
        levelName: value === null ? null : (LEVEL_NAMES.get(value) ?? null),
        message: `[log record of ${Buffer.byteLength(line, 'utf8')} bytes not captured: over the parse limit]`,
        requestId: null,
        callId,
        fields: {},
        truncated: true,
      }
    }

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      record = undefined
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      const message = truncateMessage(this.#redactor.text(line.trimEnd()))
      return {
        seq,
        time: null,
        level: null,
        levelName: null,
        message: message.text,
        requestId: null,
        callId,
        fields: {},
        truncated: message.truncated,
      }
    }

    const data = record as Record<string, unknown>
    const level = typeof data.level === 'number' ? data.level : null
    const message =
      typeof data.msg === 'string' ? truncateMessage(this.#redactor.text(data.msg)) : null
    const rest: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      if (!OMITTED_FIELDS.has(key)) {
        Object.defineProperty(rest, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    return {
      seq,
      time: isoTime(data.time),
      level,
      levelName: level === null ? null : (LEVEL_NAMES.get(level) ?? null),
      message: message?.text ?? null,
      requestId: typeof data.request_id === 'string' ? this.#redactor.text(data.request_id) : null,
      callId,
      fields: project(rest, {
        redactor: this.#redactor,
        sensitiveWords: HTTP_SENSITIVE_WORDS,
      }) as Record<string, unknown>,
      truncated: message?.truncated ?? false,
    }
  }

  #pushShortened(entry: CapturedLog) {
    let base: CapturedLog = { ...entry, fields: {}, truncated: true }
    if (byteLength(base) > this.#maxEntryBytes && base.message !== null) {
      base = { ...base, message: `${base.message.slice(0, 512)}…` }
    }
    const budget = this.#maxEntryBytes - byteLength(base)
    const fitted =
      budget > 0
        ? shrinkToFit(entry.fields, (candidate) => byteLength(candidate) <= budget)
        : undefined
    const shortened: CapturedLog = {
      ...base,
      fields: (fitted?.value as Record<string, unknown> | undefined) ?? {},
    }
    this.#buffer.push(shortened, byteLength(shortened))
  }

  query(query: LogQuery = {}): LogPage {
    const tail = query.tail ?? DEFAULT_LOG_TAIL
    const minimum = query.level ? LOG_LEVELS[query.level] : undefined
    const needle = query.grep?.toLowerCase()
    const retained = this.#buffer.toArray()
    const matches = retained.filter((entry) => {
      if (query.afterSeq !== undefined && entry.seq <= query.afterSeq) {
        return false
      }
      if (minimum !== undefined && (entry.level === null || entry.level < minimum)) {
        return false
      }
      if (query.requestId !== undefined && entry.requestId !== query.requestId) {
        return false
      }
      if (query.callId !== undefined && entry.callId !== query.callId) {
        return false
      }
      if (needle !== undefined) {
        return searchableText(entry).toLowerCase().includes(needle)
      }
      return true
    })

    /**
     * Following a cursor returns the oldest entries after it, so a burst
     * larger than `tail` is read over several calls instead of skipped.
     */
    const following = query.afterSeq !== undefined
    const hasMore = following && matches.length > tail
    const entries = following ? matches.slice(0, tail) : tail > 0 ? matches.slice(-tail) : []
    const oldest = retained[0]?.seq ?? this.#seq + 1
    return {
      entries,
      matched: matches.length,
      lastSeq: hasMore ? (entries.at(-1)?.seq ?? query.afterSeq!) : this.#seq,
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

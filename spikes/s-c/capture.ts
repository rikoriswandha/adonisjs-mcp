import type { HttpContext } from '@adonisjs/core/http'

class Ring {
  private entries: ({ value: object; bytes: number } | undefined)[] = new Array(128)
  private head = 0
  private count = 0
  bytes = 0
  dropped = 0
  push(value: object) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes > 32768) { this.dropped++; return }
    while (this.count && (this.count === 128 || this.bytes + bytes > 32768)) {
      this.bytes -= this.entries[this.head]!.bytes
      this.entries[this.head] = undefined
      this.head = (this.head + 1) % 128
      this.count--; this.dropped++
    }
    this.entries[(this.head + this.count) % 128] = { value, bytes }
    this.bytes += bytes; this.count++
  }
  values() { return Array.from({ length: this.count }, (_, i) => this.entries[(this.head + i) % 128]!.value) }
}
const logSinks = new Set<(entry: object) => void>()
const exceptionSinks = new Set<(entry: object) => void>()
export const logs = new Ring()
export const exceptions = new Ring()
export const custom = { reports: 0, handles: 0 }
export const streamWrite = (line: string) => {
  const entry = JSON.parse(line)
  for (const sink of logSinks) sink(entry)
  return line
}
// Opt-in seam called ONLY from handle: report can suppress errors or report externally.
export function observeException(error: unknown, ctx: HttpContext) {
  const e = error as Error
  const entry = { message: e.message, request_id: ctx.request.id(), route: ctx.request.url() }
  for (const sink of exceptionSinks) sink(entry)
}
const appendLog = (entry: object) => logs.push(entry)
const appendException = (entry: object) => exceptions.push(entry)
export function attach() { logSinks.add(appendLog); exceptionSinks.add(appendException) }
export function detach() { logSinks.delete(appendLog); exceptionSinks.delete(appendException) }
export function snapshot() {
  return { logs: logs.values(), exceptions: exceptions.values(), bytes: logs.bytes, dropped: logs.dropped,
    logSubscribers: logSinks.size, exceptionSubscribers: exceptionSinks.size, custom }
}

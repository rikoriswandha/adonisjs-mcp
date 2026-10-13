/*
|--------------------------------------------------------------------------
| Capture gateway
|--------------------------------------------------------------------------
|
| Process-wide meeting point between the instrumentation hooks the
| application calls (`@rikology/adonisjs-mcp/hooks`, loaded by its
| app-local dev gateway) and the buffers owned by the MCP provider.
|
| Hooks only forward to subscribers. Without a subscriber (console
| processes, `enabled: false`, after shutdown) a hook does nothing but
| count, and keeps no data. A failing subscriber never breaks the
| application's logging or error handling.
|
*/

import type { HttpContext } from '@adonisjs/core/http'
import type { ContainerObserver } from '../introspection/container_observer.js'

export type LogSubscriber = (line: string) => void
export type ExceptionSubscriber = (error: unknown, ctx: HttpContext) => void

const state = {
  hooksLoaded: false,
  logLines: 0,
  exceptions: 0,
  logSubscribers: new Set<LogSubscriber>(),
  exceptionSubscribers: new Set<ExceptionSubscriber>(),
  containerObserver: undefined as ContainerObserver | undefined,
}

/**
 * Called once when the hooks module is evaluated.
 */
export function markHooksLoaded() {
  state.hooksLoaded = true
}

export function dispatchLogLine(line: string) {
  state.logLines++
  for (const subscriber of state.logSubscribers) {
    try {
      subscriber(line)
    } catch {
      // Capture must never break application logging.
    }
  }
}

export function dispatchException(error: unknown, ctx: HttpContext) {
  state.exceptions++
  for (const subscriber of state.exceptionSubscribers) {
    try {
      subscriber(error, ctx)
    } catch {
      // Capture must never break exception handling.
    }
  }
}

/**
 * Adds a log subscriber. The returned function removes it; calling it more
 * than once is harmless.
 */
export function subscribeLogs(subscriber: LogSubscriber): () => void {
  state.logSubscribers.add(subscriber)
  return () => state.logSubscribers.delete(subscriber)
}

export function subscribeExceptions(subscriber: ExceptionSubscriber): () => void {
  state.exceptionSubscribers.add(subscriber)
  return () => state.exceptionSubscribers.delete(subscriber)
}

export function setContainerObserver(observer: ContainerObserver | undefined) {
  state.containerObserver = observer
}

export function containerObserver(): ContainerObserver | undefined {
  return state.containerObserver
}

export interface CaptureStatus {
  /**
   * The application loaded the hooks module (its dev gateway ran).
   */
  hooksLoaded: boolean

  /**
   * Log lines and exceptions delivered by the hooks so far.
   */
  logLines: number
  exceptions: number
  subscribers: { logs: number; exceptions: number }
  containerObservation: boolean
}

export function captureStatus(): CaptureStatus {
  return {
    hooksLoaded: state.hooksLoaded,
    logLines: state.logLines,
    exceptions: state.exceptions,
    subscribers: {
      logs: state.logSubscribers.size,
      exceptions: state.exceptionSubscribers.size,
    },
    containerObservation: state.containerObserver?.active ?? false,
  }
}

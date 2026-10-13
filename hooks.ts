/*
|--------------------------------------------------------------------------
| Instrumentation hooks
|--------------------------------------------------------------------------
|
| Opt-in seams for log and exception capture (spike S-C: AdonisJS has no
| public observer for log records or handled errors). Applications never
| import this module directly: an app-local gateway imports it only in
| development, so production installs without this package keep booting.
|
|   // start/mcp_dev_hooks.ts
|   import app from '@adonisjs/core/services/app'
|   import type { HttpContext } from '@adonisjs/core/http'
|
|   const hooks = app.inDev ? await import('@rikology/adonisjs-mcp/hooks') : undefined
|   hooks?.observeContainer()
|   export const streamWrite = hooks?.streamWrite ?? ((line: string) => line)
|   export const observeException =
|     hooks?.observeException ?? ((_error: unknown, _ctx: HttpContext) => {})
|
| `config/logger.ts` passes `hooks: { streamWrite }` to its logger, and the
| application's `HttpExceptionHandler.handle()` calls
| `observeException(error, ctx)` once before delegating. Neither changes
| what the application logs or responds.
|
*/

import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import {
  captureStatus,
  containerObserver,
  dispatchException,
  dispatchLogLine,
  markHooksLoaded,
  setContainerObserver,
  type CaptureStatus,
} from './src/buffers/gateway.js'
import { ContainerObserver } from './src/introspection/container_observer.js'

markHooksLoaded()

/**
 * Pino `hooks.streamWrite`: forwards each serialized record to the MCP log
 * buffer and returns it unchanged.
 */
export function streamWrite(line: string): string {
  dispatchLogLine(line)
  return line
}

/**
 * Call once from `HttpExceptionHandler.handle()`, before delegating.
 */
export function observeException(error: unknown, ctx: HttpContext): void {
  dispatchException(error, ctx)
}

/**
 * Starts recording container registrations for `get_container_bindings`.
 * Call it at config load, before providers register. Only the HTTP server
 * process (`web` environment) is observed; elsewhere this does nothing.
 */
export function observeContainer(): void {
  if (containerObserver() || !app || app.getEnvironment() !== 'web') {
    return
  }
  const observer = new ContainerObserver()
  observer.start(app.container)
  setContainerObserver(observer)
}

/**
 * Diagnostic snapshot of the instrumentation state.
 */
export function instrumentationStatus(): CaptureStatus {
  return captureStatus()
}

export type { CaptureStatus }

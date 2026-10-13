import { captureStatus } from '../../buffers/gateway.js'
import { ToolError } from '../../errors.js'
import type { Availability, ResolvedMcpConfig } from '../../types.js'

const REASONS = {
  log: 'The application is not instrumented for log capture: start/mcp_dev_hooks.ts must load @rikology/adonisjs-mcp/hooks in development and config/logger.ts must pass hooks: { streamWrite } from it.',
  exception:
    'The application is not instrumented for exception capture: start/mcp_dev_hooks.ts must load @rikology/adonisjs-mcp/hooks in development and HttpExceptionHandler.handle() must call observeException(error, ctx) from it.',
} as const

/**
 * Whether the application loaded the opt-in capture hooks, checked on
 * every request.
 */
export class CaptureSource {
  constructor(readonly config: ResolvedMcpConfig) {}

  availability(kind: keyof typeof REASONS): Availability {
    return captureStatus().hooksLoaded
      ? { available: true }
      : { available: false, code: 'CAPABILITY_UNSUPPORTED', reason: REASONS[kind] }
  }

  unavailableError(kind: keyof typeof REASONS): ToolError {
    return new ToolError('CAPABILITY_UNSUPPORTED', REASONS[kind])
  }
}

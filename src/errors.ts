import type { ToolErrorCode } from './types.js'

/**
 * Error thrown by tool handlers to fail a call with a stable code. The
 * server turns it into an `isError` result; the message is redacted
 * before it reaches the client.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: ToolErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ToolError'
    this.code = code
    if (options?.details) {
      this.details = Object.freeze({ ...options.details })
    }
  }
}

/**
 * `config/mcp.ts` does not satisfy the config contract.
 */
export class InvalidMcpConfigError extends Error {
  readonly code = 'E_INVALID_MCP_CONFIG'
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(
      [
        'Invalid MCP configuration in config/mcp.ts:',
        ...issues.map((issue) => `  - ${issue}`),
      ].join('\n')
    )
    this.name = 'InvalidMcpConfigError'
    this.issues = issues
  }
}

/**
 * A tool, resource or prompt definition does not satisfy its contract.
 */
export class InvalidDefinitionError extends Error {
  readonly code = 'E_INVALID_MCP_DEFINITION'
  readonly issues: readonly string[]

  constructor(subject: string, issues: readonly string[], options?: { cause?: unknown }) {
    super([`Invalid ${subject}:`, ...issues.map((issue) => `  - ${issue}`)].join('\n'), options)
    this.name = 'InvalidDefinitionError'
    this.issues = issues
  }
}

/**
 * A definition was registered after the registry was finalized.
 */
export class RegistryClosedError extends Error {
  readonly code = 'E_MCP_REGISTRY_CLOSED'

  constructor(action: string) {
    super(
      `Cannot ${action}: the MCP registry is finalized once the application is ready. Register MCP definitions from your provider boot() method.`
    )
    this.name = 'RegistryClosedError'
  }
}

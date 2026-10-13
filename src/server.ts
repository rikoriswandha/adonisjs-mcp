/*
|--------------------------------------------------------------------------
| MCP server factory
|--------------------------------------------------------------------------
|
| Builds one `McpServer` per MCP request from the finalized registry
| snapshot. Availability is evaluated per request, so a definition whose
| integration breaks is withheld with a diagnostic instead of failing the
| whole endpoint. The project profile is computed at most once per request,
| and only when a definition asks for it.
|
*/

import { randomUUID } from 'node:crypto'
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type ServerContext,
} from '@modelcontextprotocol/server'
import type { ApplicationService } from '@adonisjs/core/types'
import { captureStatus } from './buffers/gateway.js'
import { callScope } from './call_scope.js'
import { ToolError } from './errors.js'
import { isPlainObject } from './define_tool.js'
import { describeFailure, invokeTool, redactFailure } from './invocation.js'
import { encodeOutput, toJsonValue } from './result.js'
import type { Redactor } from './redaction.js'
import type { RegistrySnapshot } from './registry.js'
import type {
  Availability,
  AvailabilityContext,
  CapabilityReport,
  ExceptionReader,
  LogReader,
  ProjectProfile,
  ResolvedMcpConfig,
  TenantAccess,
  ToolContext,
  UnavailableCode,
} from './types.js'

/**
 * Identity announced to clients. Clients name the server `adonis`.
 */
export const SERVER_NAME = 'adonis'

const UNAVAILABLE_CODES: ReadonlySet<UnavailableCode> = new Set([
  'DEPENDENCY_UNAVAILABLE',
  'CAPABILITY_UNSUPPORTED',
  'INTEGRATION_FAILED',
])

const INSTRUCTIONS =
  'Tools of this server inspect and operate the running AdonisJS application. Read the adonis://profile resource (or call get_project_profile) first: it reports the project kind, surfaces, active integrations and why a tool is not served.'

/**
 * Everything the factory needs, owned by the provider for the lifetime of
 * the application.
 */
export interface ServerRuntime {
  app: ApplicationService
  config: ResolvedMcpConfig
  snapshot: RegistrySnapshot
  redactor: Redactor
  version: string
  logs: LogReader | null
  exceptions: ExceptionReader | null

  /**
   * `@rikology/adonisjs-tenant` integration, when its binding exists.
   */
  tenancy: TenantAccess | null
  detectProfile(): Promise<ProjectProfile>
}

interface Availabilities {
  tools: CapabilityReport[]
  resources: CapabilityReport[]
  prompts: CapabilityReport[]
}

/**
 * Availability context for one MCP request. The profile is memoized.
 */
export function availabilityContext(runtime: ServerRuntime): AvailabilityContext {
  let profile: Promise<ProjectProfile> | undefined
  return {
    app: runtime.app,
    config: runtime.config,
    profile: () => (profile ??= runtime.detectProfile()),
  }
}

/**
 * Runs `available()`. A throwing or malformed check marks the integration
 * as broken rather than absent.
 */
async function evaluate(
  definition: { available?(context: AvailabilityContext): Availability | Promise<Availability> },
  context: AvailabilityContext,
  redactor: Redactor
): Promise<Availability> {
  if (!definition.available) {
    return { available: true }
  }
  try {
    const verdict: unknown = await definition.available(context)
    if (isPlainObject(verdict) && verdict.available === true) {
      return { available: true }
    }
    if (
      isPlainObject(verdict) &&
      verdict.available === false &&
      UNAVAILABLE_CODES.has(verdict.code as UnavailableCode) &&
      typeof verdict.reason === 'string'
    ) {
      return {
        available: false,
        code: verdict.code as UnavailableCode,
        reason: redactor.text(verdict.reason),
      }
    }
    return {
      available: false,
      code: 'INTEGRATION_FAILED',
      reason: 'available() returned an invalid value',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      available: false,
      code: 'INTEGRATION_FAILED',
      reason: redactor.text(`available() threw: ${message}`),
    }
  }
}

function report(name: string, verdict: Availability): CapabilityReport {
  return verdict.available
    ? { name, status: 'served' }
    : { name, status: 'unavailable', code: verdict.code, reason: verdict.reason }
}

/**
 * Whether each registered tool, resource and prompt is served for
 * `context`, and why not.
 */
export async function describeCapabilities(
  runtime: ServerRuntime,
  context: AvailabilityContext
): Promise<Availabilities> {
  const { snapshot, redactor } = runtime
  const [tools, resources, prompts] = await Promise.all([
    Promise.all(
      snapshot.tools.map(async (tool) => report(tool.name, await evaluate(tool, context, redactor)))
    ),
    Promise.all(
      snapshot.resources.map(async (resource) =>
        report(resource.name, await evaluate(resource, context, redactor))
      )
    ),
    Promise.all(
      snapshot.prompts.map(async (prompt) =>
        report(prompt.name, await evaluate(prompt, context, redactor))
      )
    ),
  ])
  return {
    tools: [
      ...tools,
      ...snapshot.disabledTools.map((name): CapabilityReport => ({
        name,
        status: 'disabled',
        reason: 'disabled by tools.disabled or registry.disable()',
      })),
    ].sort((left, right) => (left.name < right.name ? -1 : 1)),
    resources,
    prompts,
  }
}

function toolContext(
  base: AvailabilityContext,
  runtime: ServerRuntime,
  request: ServerContext
): ToolContext {
  const instrumented = captureStatus().hooksLoaded
  return {
    ...base,
    callId: randomUUID(),
    signal: request.mcpReq.signal,
    logs: instrumented ? runtime.logs : null,
    exceptions: instrumented ? runtime.exceptions : null,
    tenancy: runtime.tenancy,
  }
}

/**
 * Creates the server for one MCP request.
 */
export async function createServer(runtime: ServerRuntime): Promise<McpServer> {
  const { snapshot, redactor, config } = runtime
  const context = availabilityContext(runtime)
  const served = await describeCapabilities(runtime, context)
  const isServed = (list: CapabilityReport[], name: string) =>
    list.some((entry) => entry.name === name && entry.status === 'served')

  const server = new McpServer(
    { name: SERVER_NAME, version: runtime.version },
    { instructions: INSTRUCTIONS }
  )

  for (const tool of snapshot.tools) {
    if (!isServed(served.tools, tool.name)) {
      continue
    }
    server.registerTool(
      tool.name,
      {
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      },
      async (input, request) => {
        const result = await invokeTool(tool, input, toolContext(context, runtime, request), {
          wrappers: snapshot.wrappers,
          redactor,
          maxResultBytes: config.limits.maxResultBytes,
        })
        return {
          content: [{ type: 'text', text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        }
      }
    )
  }

  for (const resource of snapshot.resources) {
    if (!isServed(served.resources, resource.name)) {
      continue
    }
    const metadata = {
      ...(resource.title === undefined ? {} : { title: resource.title }),
      ...(resource.description === undefined ? {} : { description: resource.description }),
      mimeType: 'application/json',
    }
    const read = async (
      uri: URL,
      variables: Record<string, string | string[]>,
      request: ServerContext
    ) => {
      const started = performance.now()
      const callContext = toolContext(context, runtime, request)
      try {
        const output = await callScope.run({ callId: callContext.callId }, () =>
          resource.read({ uri, variables }, callContext)
        )
        const encoded = encodeOutput(output, {
          maxBytes: config.limits.maxResultBytes,
          durationMs: performance.now() - started,
          redactor,
        })
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: encoded.text }],
        }
      } catch (error) {
        if (error instanceof ToolError && error.code === 'NOT_FOUND') {
          throw new ResourceNotFoundError(uri.href, redactor.text(error.message))
        }
        const failure = redactFailure(describeFailure(error, callContext.signal), redactor)
        throw new ProtocolError(
          failure.code === 'INPUT_INVALID'
            ? ProtocolErrorCode.InvalidParams
            : ProtocolErrorCode.InternalError,
          `${failure.code}: ${failure.message}`,
          { code: failure.code }
        )
      }
    }
    if (resource.uri.includes('{')) {
      server.registerResource(
        resource.name,
        new ResourceTemplate(resource.uri, { list: undefined }),
        metadata,
        (uri, variables, request) => read(uri, variables, request)
      )
    } else {
      server.registerResource(resource.name, resource.uri, metadata, (uri, request) =>
        read(uri, {}, request)
      )
    }
  }

  for (const prompt of snapshot.prompts) {
    if (!isServed(served.prompts, prompt.name)) {
      continue
    }
    const build = async (args: unknown) => {
      try {
        const output = await prompt.get(args as never, context)
        return {
          ...(output.description === undefined
            ? {}
            : { description: redactor.knownSecrets(output.description) }),
          messages: output.messages.map((message) => ({
            role: message.role,
            content: { type: 'text' as const, text: redactor.knownSecrets(message.text) },
          })),
        }
      } catch (error) {
        const code =
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          Number.isInteger(error.code)
            ? Number(error.code)
            : ProtocolErrorCode.InternalError
        // toJsonValue scrubs keys and normalizes BigInt/cycles; value() masks every string.
        const data =
          error !== null && typeof error === 'object' && 'data' in error
            ? redactor.value(toJsonValue(error.data, redactor))
            : undefined
        throw new ProtocolError(
          code,
          redactor.text(error instanceof Error ? error.message : String(error)),
          data
        )
      }
    }
    const metadata = {
      ...(prompt.title === undefined ? {} : { title: prompt.title }),
      description: prompt.description,
    }
    if (prompt.argsSchema) {
      server.registerPrompt(prompt.name, { ...metadata, argsSchema: prompt.argsSchema }, (args) =>
        build(args)
      )
    } else {
      server.registerPrompt(prompt.name, metadata, () => build({}))
    }
  }

  return server
}

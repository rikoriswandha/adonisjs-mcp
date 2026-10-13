/*
|--------------------------------------------------------------------------
| Public types
|--------------------------------------------------------------------------
|
| Type-only contracts shared by the provider, builtin tools, extension
| packages and the application's `config/mcp.ts`. This module has no
| runtime imports, so consumers can depend on it with `import type`.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import type { z } from 'zod'

/**
 * Request surfaces an application can expose. A `web` surface is rendered
 * by Inertia or Edge; an `api` surface answers JSON.
 */
export type SurfaceName = 'web' | 'api'

/**
 * Correction for an auto-detected surface. Only fill the fields that the
 * detection gets wrong.
 */
export interface SurfaceConfig {
  /**
   * URL path prefix owned by the surface, e.g. `/api`.
   */
  prefix?: string

  /**
   * Auth guard used when impersonating a user on this surface.
   */
  guard?: string
}

export interface ProjectEvalConfig {
  /**
   * Default and maximum cooperative timeout for `project_eval`, in
   * milliseconds. A call may ask for less, never for more. The timeout
   * stops waiting; it does not preempt synchronous code or undo side
   * effects that already happened.
   */
  timeout?: number
}

/**
 * Dedicated PostgreSQL login used by `execute_sql_query` in read-only mode.
 * It must be a least-privilege role: not a superuser, without write
 * privileges, and without BYPASSRLS when tenant-scoped SQL is used. Fields
 * not set here are inherited from the Lucid connection config.
 */
export type PostgresReaderConfig =
  | {
      user: string
      password?: string
      host?: string
      port?: number
      database?: string
      ssl?: boolean | Record<string, unknown>
    }
  | {
      /**
       * Full connection string; nothing is inherited.
       */
      connectionString: string
    }

export interface SqlToolConfig {
  /**
   * Run raw SQL with database-enforced read-only boundaries. `false` runs
   * statements on the application connection pool and can change data.
   */
  readOnly?: boolean

  /**
   * Maximum rows returned by `execute_sql_query` and `query_model`.
   */
  maxRows?: number

  /**
   * Allow tenant-scoped tools to read across tenants. Every result
   * produced this way is labelled as cross-tenant.
   */
  allowCrossTenant?: boolean

  /**
   * Default and maximum deadline of one SQL statement, in milliseconds.
   */
  timeout?: number

  /**
   * Read-only logins for PostgreSQL connections, keyed by Lucid
   * connection name. Without one, read-only raw SQL is not available on
   * that PostgreSQL connection.
   */
  readers?: Readonly<Record<string, PostgresReaderConfig>>
}

export interface LogsToolConfig {
  /**
   * Number of log entries kept in the ring buffer.
   */
  bufferSize?: number

  /**
   * Serialized bytes kept in the log ring buffer. The oldest entries are
   * evicted first; one oversized entry is shortened instead of growing
   * the buffer.
   */
  bufferBytes?: number

  /**
   * Number of handled exceptions kept in the ring buffer.
   */
  exceptionBufferSize?: number

  /**
   * Serialized bytes kept in the exception ring buffer.
   */
  exceptionBufferBytes?: number
}

export interface DocsToolConfig {
  /**
   * Installed packages indexed by `search_package_docs`. Accepts exact
   * package names and `@scope/*` patterns.
   */
  include?: readonly string[]
}

export interface DeadlineToolConfig {
  /**
   * Deadline in milliseconds.
   */
  timeout?: number
}

export interface HttpToolConfig extends DeadlineToolConfig {
  /**
   * Parent domain of tenant hosts when `@rikology/adonisjs-tenant` resolves
   * tenants by subdomain, e.g. `'tenants.test'`: `http_request` with
   * `tenant: 'acme'` sends `Host: acme.tenants.test:<port>` to the
   * application socket. Not needed for the header and path resolvers.
   */
  tenantDomain?: string | null
}

export interface McpLimitsConfig {
  /**
   * Maximum accepted MCP request body, in bytes.
   */
  maxRequestBytes?: number

  /**
   * Maximum serialized tool/resource result, in bytes. Larger results
   * are truncated to valid JSON and flagged as truncated.
   */
  maxResultBytes?: number
}

/**
 * Module shape accepted by `extraTools` loaders. The default export is a
 * single tool definition or a list of them.
 */
export interface ExtraToolsModule {
  default: AnyToolDefinition | readonly AnyToolDefinition[]
}

/**
 * Lazy loader for application-owned tools, e.g.
 * `() => import('#start/mcp_tools')`.
 *
 * Tools are always referenced lazily because `config/mcp.ts` is loaded
 * in production, where this package and `zod` are not installed. The
 * loader only runs in development.
 */
export type ExtraToolLoader = () => Promise<ExtraToolsModule>

/**
 * Input accepted by `config/mcp.ts`. Every key is optional; the provider
 * applies defaults and validates the result in development.
 *
 * Keep `config/mcp.ts` free of runtime imports from this package:
 * `import type { McpConfig } from '@rikology/adonisjs-mcp'` together
 * with `satisfies McpConfig`.
 */
export interface McpConfig {
  /**
   * Kill switch. When `false`, no endpoint is registered.
   *
   * @default true
   */
  enabled?: boolean

  /**
   * Exact URL path of the MCP endpoint.
   *
   * @default '/__adonis/mcp'
   */
  path?: string

  /**
   * Accept peers outside the loopback interface. Host and Origin checks
   * still apply. Only enable behind a trusted network boundary.
   *
   * @default false
   */
  allowRemoteAccess?: boolean

  /**
   * Extra exact `Host` header values (`hostname` or `hostname:port`)
   * accepted besides loopback names on the listening port. Wildcards
   * are not supported.
   *
   * @default []
   */
  allowedHosts?: readonly string[]

  /**
   * Extra exact browser origins (`scheme://host[:port]`) accepted besides
   * loopback origins. Requests without an `Origin` header are accepted;
   * `null` is never accepted.
   *
   * @default []
   */
  allowedOrigins?: readonly string[]

  limits?: McpLimitsConfig

  profile?: {
    /**
     * Corrections for auto-detected surfaces. Leave empty to rely on
     * detection.
     */
    surfaces?: {
      web?: SurfaceConfig
      api?: SurfaceConfig
      default?: SurfaceName
    }
  }

  tools?: {
    /**
     * Names of tools that must never be served, including tools
     * registered by other packages.
     *
     * @default []
     */
    disabled?: readonly string[]

    /**
     * `false` disables `project_eval`.
     */
    projectEval?: false | ProjectEvalConfig

    sql?: SqlToolConfig
    logs?: LogsToolConfig
    docs?: DocsToolConfig
    http?: HttpToolConfig
    ace?: DeadlineToolConfig
  }

  /**
   * Lazy loaders for application-owned tools.
   *
   * @default []
   */
  extraTools?: readonly ExtraToolLoader[]
}

/**
 * Config after defaults and validation. Frozen at runtime.
 */
export interface ResolvedMcpConfig {
  readonly enabled: boolean
  readonly path: string
  readonly allowRemoteAccess: boolean
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly limits: {
    readonly maxRequestBytes: number
    readonly maxResultBytes: number
  }
  readonly profile: {
    readonly surfaces: {
      readonly web?: Readonly<SurfaceConfig>
      readonly api?: Readonly<SurfaceConfig>
      readonly default?: SurfaceName
    }
  }
  readonly tools: {
    readonly disabled: readonly string[]
    readonly projectEval: false | { readonly timeout: number }
    readonly sql: {
      readonly readOnly: boolean
      readonly maxRows: number
      readonly allowCrossTenant: boolean
      readonly timeout: number
      readonly readers: Readonly<Record<string, Readonly<PostgresReaderConfig>>>
    }
    readonly logs: {
      readonly bufferSize: number
      readonly bufferBytes: number
      readonly exceptionBufferSize: number
      readonly exceptionBufferBytes: number
    }
    readonly docs: {
      readonly include: readonly string[]
    }
    readonly http: { readonly timeout: number; readonly tenantDomain: string | null }
    readonly ace: { readonly timeout: number }
  }
  readonly extraTools: readonly ExtraToolLoader[]
}

/**
 * Stable error codes returned by failing tool calls.
 */
export type ToolErrorCode =
  | 'DEPENDENCY_UNAVAILABLE'
  | 'CAPABILITY_UNSUPPORTED'
  | 'INPUT_INVALID'
  | 'NOT_FOUND'
  | 'READ_ONLY_VIOLATION'
  | 'TENANT_SCOPE_REQUIRED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXECUTION_FAILED'

/**
 * Why a definition is not served.
 *
 * - `DEPENDENCY_UNAVAILABLE`: the optional package is not installed.
 * - `CAPABILITY_UNSUPPORTED`: installed, but this setup is not supported.
 * - `INTEGRATION_FAILED`: installed and expected to work, but broken.
 */
export type UnavailableCode =
  'DEPENDENCY_UNAVAILABLE' | 'CAPABILITY_UNSUPPORTED' | 'INTEGRATION_FAILED'

export type Availability =
  { available: true } | { available: false; code: UnavailableCode; reason: string }

/**
 * Where the information in a result comes from.
 *
 * - `runtime`: observed from the running application.
 * - `generated`: read from generated artifacts (e.g. `.adonisjs/`).
 * - `source`: derived from source files without executing them.
 */
export type EvidenceKind = 'runtime' | 'generated' | 'source'

/**
 * Optional integrations reported by the project profile.
 */
export type PackageKey =
  | 'lucid'
  | 'auth'
  | 'session'
  | 'shield'
  | 'vine'
  | 'edge'
  | 'inertia'
  | 'vite'
  | 'tuyau'
  | 'transmit'
  | 'tenant'
  | 'permissions'
  | 'bouncer'
  | 'queue'

/**
 * What the running process reveals about one optional package.
 */
export interface PackageReport {
  /**
   * npm package name.
   */
  name: string

  /**
   * Where the application `package.json` declares the package, if anywhere.
   * Transitive installs are `null`.
   */
  declared: 'dependencies' | 'devDependencies' | null

  /**
   * Installed version resolved from the application root, or `null` when
   * the package is not installed.
   */
  version: string | null

  /**
   * Whether the integration is wired into this process. `null` means no
   * verified runtime signal exists for this package, so activity is
   * unknown rather than false.
   */
  active: boolean | null

  /**
   * The runtime signal `active` was derived from, e.g. a container binding.
   */
  signal: string | null

  /**
   * Set when inspecting an installed integration failed. The integration is
   * broken, not absent.
   */
  error?: string
}

/**
 * One fact supporting a profile inference.
 */
export interface ProfileEvidence {
  kind: EvidenceKind | 'config'
  detail: string
}

export interface SurfaceReport {
  /**
   * Renderer of a `web` surface. Absent on `api` surfaces.
   */
  renderer?: 'inertia' | 'edge'

  /**
   * URL prefix owned by the surface, when configured or observed.
   */
  prefix: string | null

  /**
   * Auth guard used on the surface, when configured.
   */
  guard: string | null
  evidence: readonly ProfileEvidence[]
}

/**
 * The kind of application and the integrations active in the running
 * process. Unknown facts are `null`, never guessed.
 */
export interface ProjectProfile {
  /**
   * `hybrid` means both a web and an api surface are configured or
   * observed; an installed package alone never makes a project hybrid.
   */
  kind: 'api' | 'inertia' | 'edge' | 'hybrid'
  app: {
    name: string | null
    root: string
    environment: string
    nodeVersion: string
    coreVersion: string | null
  }
  surfaces: {
    web: SurfaceReport | null
    api: SurfaceReport | null

    /**
     * Surface assumed for requests that match neither surface. `null` when
     * the project is hybrid and `profile.surfaces.default` is not set.
     */
    default: SurfaceName | null
  }
  inertia: {
    adapter: 'react' | 'vue' | 'svelte' | null
    ssr: boolean | null
  } | null
  auth: {
    guards: readonly string[]
    default: string | null
  } | null
  packages: Readonly<Record<PackageKey, PackageReport>>
  generated: {
    controllers: boolean
    data: boolean
    tuyauRegistry: boolean
  }
  endpoint: {
    path: string
    allowRemoteAccess: boolean
  }
  limitations: readonly string[]
}

/**
 * Whether one registered definition is served, and why not.
 */
export interface CapabilityReport {
  name: string
  status: 'served' | 'disabled' | 'unavailable'
  code?: UnavailableCode
  reason?: string
}

/**
 * Context available when deciding whether a definition is served.
 */
export interface AvailabilityContext {
  app: ApplicationService
  config: ResolvedMcpConfig

  /**
   * Profile of the running application. Computed on first use and shared
   * by every definition served for the same MCP request.
   */
  profile(): Promise<ProjectProfile>
}

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * One log record captured from the application logger, redacted before
 * it was stored.
 */
export interface CapturedLog {
  /**
   * Capture order, increasing across log entries of the process.
   */
  seq: number
  time: string | null
  level: number | null
  levelName: LogLevelName | null
  message: string | null

  /**
   * `request_id` bound by `ctx.logger`. Records written with the root
   * logger during a request have none.
   */
  requestId: string | null

  /**
   * MCP call whose async context wrote the record, if any.
   */
  callId: string | null

  /**
   * Remaining record fields and bindings (without pid, hostname, time).
   */
  fields: Record<string, unknown>

  /**
   * The record was shortened to fit the per-entry byte budget.
   */
  truncated: boolean
}

export interface LogQuery {
  /**
   * Number of most recent matching entries.
   *
   * @default 100
   */
  tail?: number

  /**
   * Minimum level.
   */
  level?: LogLevelName

  /**
   * Case-insensitive literal text searched in the message and fields.
   */
  grep?: string
  requestId?: string
  callId?: string

  /**
   * Only entries with a greater `seq`; pass a previous `lastSeq` to read
   * what was logged since.
   */
  afterSeq?: number
}

export interface CaptureStats {
  /**
   * Items delivered by the instrumentation hook since the process started,
   * captured or not.
   */
  observed: number
  retained: number
  retainedBytes: number

  /**
   * Items evicted by the count or byte budget.
   */
  evicted: number
}

export interface LogPage {
  entries: CapturedLog[]

  /**
   * Matching entries in the buffer, before `tail` was applied.
   */
  matched: number

  /**
   * Cursor to pass as `afterSeq` next time. When `hasMore`, it is the last
   * returned entry; otherwise the latest captured `seq`.
   */
  lastSeq: number

  /**
   * More entries after the cursor than `tail` allowed (cursor reads only).
   */
  hasMore: boolean

  /**
   * Entries after `afterSeq` that were evicted before they could be read.
   */
  missed: number
  stats: CaptureStats
}

export interface LogReader {
  query(query?: LogQuery): LogPage
}

/**
 * One exception handled by the application's HTTP exception handler,
 * redacted before it was stored.
 */
export interface CapturedException {
  seq: number
  time: string
  name: string
  code: string | null
  message: string

  /**
   * Response status once the response finished (`statusSource:
   * 'response'`), otherwise the status the error declares.
   */
  status: number | null
  statusSource: 'response' | 'error' | null

  /**
   * Stack frames, paths inside the application root made relative.
   */
  stack: string[]
  cause: { name: string; message: string } | null
  request: {
    id: string | null
    method: string

    /**
     * Path without the query string.
     */
    url: string
    route: { pattern: string; name: string | null } | null
  } | null
  callId: string | null

  /**
   * Same name, code, message shape and first stack frame.
   */
  fingerprint: string
  truncated: boolean
}

export interface ExceptionQuery {
  /**
   * Most recent exceptions to return.
   *
   * @default 10
   */
  limit?: number
  requestId?: string

  /**
   * Only the most recent exception of each fingerprint.
   */
  distinct?: boolean
  afterSeq?: number
}

export interface ExceptionPage {
  /**
   * Newest first. `occurrences` counts buffered exceptions with the same
   * fingerprint.
   */
  exceptions: Array<CapturedException & { occurrences: number }>
  matched: number
  /**
   * Same cursor semantics as `LogPage.lastSeq`, with `limit`.
   */
  lastSeq: number
  hasMore: boolean
  missed: number
  stats: CaptureStats
}

export interface ExceptionReader {
  query(query?: ExceptionQuery): ExceptionPage
}

/**
 * Per-call context handed to tool handlers. Nothing in it outlives the
 * call.
 */
export interface ToolContext extends AvailabilityContext {
  /**
   * Unique identifier of this call, used to correlate logs.
   */
  callId: string

  /**
   * Aborted when the client cancels the call or disconnects.
   */
  signal: AbortSignal

  /**
   * Captured application logs, or `null` when the application is not
   * instrumented (see `@rikology/adonisjs-mcp/hooks`).
   */
  logs: LogReader | null

  /**
   * Captured handled exceptions, or `null` when the application is not
   * instrumented.
   */
  exceptions: ExceptionReader | null

  /**
   * Tenant lookup and context of `@rikology/adonisjs-tenant`, or `null`
   * when that integration is not active.
   */
  tenancy: TenantAccess | null
}

/**
 * Tenant identity, as `@rikology/adonisjs-tenant` defines it.
 */
export interface TenantIdentity {
  id: string | number
  name: string
  slug: string
}

export interface TenantAccess {
  /**
   * Looks a tenant up with the application's configured resolver: its
   * trusted `lookup` callback or its `tenants` allowlist. Unknown keys
   * fail with `NOT_FOUND`; the identity is never invented.
   */
  resolve(key: string): Promise<TenantIdentity>

  /**
   * Runs `callback` inside the tenant context (`TenantService.run`).
   */
  run<T>(tenant: TenantIdentity, callback: () => T | Promise<T>): Promise<T>
}

/**
 * Successful tool/resource payload. Serialized as JSON text content by
 * the server, together with `durationMs` and `truncated` metadata.
 */
export interface ToolOutput {
  data: unknown
  evidence?: readonly EvidenceKind[]
  limitations?: readonly string[]
}

/**
 * MCP tool annotations. Hints describe actual behavior; they are not
 * enforcement.
 */
export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * Zod v4 object schema describing a tool input.
 */
export type ToolInputSchema = z.ZodObject

export interface ToolDefinition<Schema extends ToolInputSchema = ToolInputSchema> {
  /**
   * snake_case name, unique across the registry. Prefix it with your
   * package domain, e.g. `audit_list_entries`.
   */
  name: string
  title?: string

  /**
   * What the tool does via the running AdonisJS application, and any
   * side effects it can have.
   */
  description: string
  inputSchema: Schema
  annotations?: ToolAnnotations
  available?(context: AvailabilityContext): Availability | Promise<Availability>
  handler(input: z.output<Schema>, context: ToolContext): ToolOutput | Promise<ToolOutput>
}

/**
 * Tool definition with any input schema. Used for heterogeneous lists.
 */
export type AnyToolDefinition = ToolDefinition<ToolInputSchema>

/**
 * A tool call flowing through `registry.extend()` wrappers.
 */
export interface ToolCall {
  readonly name: string
  readonly input: unknown
  readonly context: ToolContext
}

/**
 * Wraps every tool handler. `next` runs the remaining wrappers and the
 * handler, and can be called at most once.
 */
export type ToolCallWrapper = (
  call: ToolCall,
  next: () => Promise<ToolOutput>
) => Promise<ToolOutput>

export interface ResourceReadRequest {
  uri: URL

  /**
   * Values of URI template variables, e.g. `{ key: 'database' }` for
   * `adonis://config/{key}`. Empty for static URIs.
   */
  variables: Readonly<Record<string, string | readonly string[]>>
}

export interface ResourceDefinition {
  /**
   * Registry identity, unique across resources.
   */
  name: string

  /**
   * Static URI (`adonis://profile`) or RFC 6570 URI template
   * (`adonis://config/{key}`).
   */
  uri: string
  title?: string
  description?: string
  available?(context: AvailabilityContext): Availability | Promise<Availability>
  read(request: ResourceReadRequest, context: ToolContext): ToolOutput | Promise<ToolOutput>
}

export interface PromptMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface PromptOutput {
  description?: string
  messages: readonly PromptMessage[]
}

export interface PromptDefinition<Schema extends ToolInputSchema = ToolInputSchema> {
  name: string
  title?: string
  description: string
  argsSchema?: Schema

  available?(context: AvailabilityContext): Availability | Promise<Availability>

  /**
   * Builds messages only. Must not run queries, HTTP requests or eval.
   */
  get(args: z.output<Schema>, context: AvailabilityContext): PromptOutput | Promise<PromptOutput>
}

/**
 * Registry bound to the container as `mcp.registry` in development.
 * Other packages register definitions from their provider `boot()`:
 *
 * ```ts
 * if (this.app.inDev && this.app.container.hasBinding('mcp.registry')) {
 *   const registry = await this.app.container.make('mcp.registry')
 *   registry.tool(...)
 * }
 * ```
 *
 * Registration closes when the application is ready; later calls throw.
 */
export interface McpRegistry {
  /**
   * Registers a tool. A name already registered as a tool throws, so
   * collisions fail the boot instead of replacing a definition.
   */
  tool<Schema extends ToolInputSchema>(definition: ToolDefinition<Schema>): void

  /**
   * Registers a resource. Names and URIs are unique across resources.
   */
  resource(definition: ResourceDefinition): void

  /**
   * Registers a prompt. Names are unique across prompts.
   */
  prompt<Schema extends ToolInputSchema>(definition: PromptDefinition<Schema>): void

  /**
   * Adds a wrapper around every tool handler. Wrappers run in
   * registration order, outermost first.
   */
  extend(wrapper: ToolCallWrapper): void

  /**
   * Never serve the named tool, whether it is registered before or after
   * this call.
   */
  disable(name: string): void
}

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'mcp.registry': McpRegistry
  }
}

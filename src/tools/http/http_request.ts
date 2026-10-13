/*
|--------------------------------------------------------------------------
| http_request
|--------------------------------------------------------------------------
|
| Real HTTP against the running application, from inside its process,
| over its own listening socket (plan D12, D27; spikes S-F, S-H). Every
| request runs the application's full middleware stack, appears in its
| logs and exceptions under a request id the tool chooses, and is
| summarized for the agent.
|
| - Target: the loopback address the server listens on; the caller gives
|   a path. Redirects are reported, and only followed on request, within
|   the same origin, never to the MCP endpoint.
| - Surface: decides API vs web (Inertia/Edge) headers (src/http/surface).
| - Impersonation: credentials minted through the app's auth guards for
|   this call only, removed or expired when it ends (src/http/auth,
|   src/http/session).
| - Tenant: the trusted mapping of config/tenancy.ts (header, subdomain or
|   path) selects the tenant in the application's own tenant middleware;
|   the caller's async context never crosses the socket.
| - Output: minted credentials and secret values are redacted from
|   everything returned, including echoes of request headers.
|
*/

import { Server as HttpsServer } from 'node:https'
import { z } from 'zod'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import { MCP_CALL_HEADER } from '../../guards/network.js'
import {
  AuthAccess,
  observeAuthentication,
  TOKEN_NAME,
  type GuardEntry,
  type GuardList,
  type MintedToken,
} from '../../http/auth.js'
import { exchange, type ExchangeResult } from '../../http/client.js'
import { CookieJar, type JarUpdate } from '../../http/cookie_jar.js'
import { SessionAccess } from '../../http/session.js'
import { summarizeBody, validationErrors } from '../../http/summary.js'
import type { InertiaIntrospection } from '../../introspection/inertia.js'
import { typescriptAvailability } from '../../introspection/integrations.js'
import {
  decideSurface,
  guardSurface,
  inertiaVersion,
  routeAuth,
  surfaceHeaders,
  type RouteAuth,
  type SurfaceDecision,
} from '../../http/surface.js'
import {
  loopbackAddress,
  normalizeDomain,
  parseRequestPath,
  redirectTarget,
  validateHeaders,
  type LoopbackAddress,
  type RequestPath,
} from '../../http/target.js'
import { HTTP_SENSITIVE_WORDS, project, type Redactor } from '../../redaction.js'
import { tenantRequestMapping, type TenantRequestMapping } from '../../tenant.js'
import type { ModelCatalog } from '../../database/models.js'
import type {
  AnyToolDefinition,
  Availability,
  AvailabilityContext,
  CapturedException,
  CapturedLog,
  ProjectProfile,
  TenantIdentity,
  ToolContext,
  ToolOutput,
} from '../../types.js'

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const LOG_TAIL = 100
const EXCEPTION_LIMIT = 10

/**
 * Response headers never returned: they carry credentials.
 */
const HIDDEN_RESPONSE_HEADERS = new Set(['set-cookie', 'authorization', 'proxy-authorization'])

const inputSchema = z.object({
  method: z.enum(METHODS).default('GET'),
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      "Path of the running application with an optional query, e.g. '/api/v1/posts?page=2'. Never a URL."
    ),
  headers: z
    .record(z.string().min(1).max(200), z.string().max(8192))
    .optional()
    .describe(
      'Extra request headers. Host, Cookie, Authorization, Inertia, CSRF, proxy and framing headers are set by the tool.'
    ),
  body: z.unknown().optional().describe('JSON request body'),
  form: z
    .record(z.string().min(1).max(200), z.union([z.string(), z.array(z.string())]))
    .optional()
    .describe('URL-encoded form body, instead of a JSON body'),
  as: z
    .object({
      userId: z.union([z.string().min(1).max(200), z.int()]),
      guard: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Auth guard; defaults to the guard of the request surface'),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('User model (get_models id) when several models could be the user model'),
    })
    .optional()
    .describe(
      'Act as this user through the app auth guard (temporary credential, removed after the call)'
    ),
  surface: z
    .enum(['web', 'api'])
    .optional()
    .describe(
      'Send as a web (Inertia/Edge) or api (JSON) client; detected from the route when omitted'
    ),
  tenant: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Tenant key of @rikology/adonisjs-tenant, mapped through config/tenancy.ts'),
  domain: z
    .string()
    .min(1)
    .max(253)
    .optional()
    .describe('Host name of a route domain registered in the router, e.g. api.example.test'),
  csrf: z
    .boolean()
    .optional()
    .describe(
      'Send a valid Shield CSRF token (default: on for web requests); false to observe CSRF rejection'
    ),
  followRedirects: z
    .boolean()
    .optional()
    .describe(`Follow same-origin redirects (at most ${MAX_REDIRECTS}); off by default`),
  timeout: z
    .int()
    .positive()
    .optional()
    .describe('Deadline in milliseconds, at most tools.http.timeout'),
})

type Input = z.output<typeof inputSchema>
type Method = (typeof METHODS)[number]

interface StoredRouteLike {
  pattern: string
  name?: string
  domain: string
  methods: string[]
  handler: unknown
  middleware: { all(): Iterable<unknown> }
}

interface RouterLike {
  usingDomains: boolean
  match(
    url: string,
    method: string,
    shouldDecodeParam: boolean,
    hostname?: string
  ): { route: StoredRouteLike } | null
  toJSON(): Record<string, unknown>
}

interface ServerLike {
  getNodeServer(): { address(): unknown } | undefined
}

interface TenantSelection {
  key: string
  identity: TenantIdentity
  mapping: TenantRequestMapping
}

interface Hop {
  requestId: string
  method: Method
  path: string
  status: number
  location: string | null
  durationMs: number
  cookies: JarUpdate
}

function domainMatches(pattern: string, hostname: string): boolean {
  const patternLabels = pattern.toLowerCase().split('.')
  const labels = hostname.split('.')
  return (
    patternLabels.length === labels.length &&
    patternLabels.every((label, index) => label.startsWith(':') || label === labels[index])
  )
}

function hostLabel(value: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nextMethod(status: number, method: Method): Method {
  if (status === 307 || status === 308) {
    return method
  }
  if (status === 303) {
    return method === 'HEAD' ? 'HEAD' : 'GET'
  }
  return method === 'POST' ? 'GET' : method
}

function safeHeaders(result: ExchangeResult): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(result.headers)) {
    if (value === undefined || HIDDEN_RESPONSE_HEADERS.has(name)) {
      continue
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

export class HttpRequestService {
  readonly #app: ApplicationService
  readonly #redactor: Redactor
  readonly #auth: AuthAccess
  readonly #session: SessionAccess
  readonly #inertia: InertiaIntrospection

  constructor(options: {
    app: ApplicationService
    redactor: Redactor
    catalog: ModelCatalog
    inertia: InertiaIntrospection
  }) {
    this.#app = options.app
    this.#redactor = options.redactor
    this.#auth = new AuthAccess(options.app, options.catalog)
    this.#session = new SessionAccess(options.app)
    this.#inertia = options.inertia
  }

  async #target(): Promise<LoopbackAddress | { reason: string }> {
    const server = (await this.#app.container.make('server')) as unknown as ServerLike
    const nodeServer = server.getNodeServer()
    if (nodeServer instanceof HttpsServer) {
      return {
        reason: 'the application serves HTTPS; http_request only speaks plain HTTP over loopback',
      }
    }
    return loopbackAddress(nodeServer)
  }

  async availability(_context: AvailabilityContext): Promise<Availability> {
    const target = await this.#target()
    return 'reason' in target
      ? { available: false, code: 'CAPABILITY_UNSUPPORTED', reason: target.reason }
      : { available: true }
  }

  async #tenant(input: Input, context: ToolContext): Promise<TenantSelection | null> {
    if (input.tenant === undefined) {
      return null
    }
    if (!context.tenancy) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        'The tenant option requires @rikology/adonisjs-tenant (binding "tenant.service"), which is not active'
      )
    }
    const identity = await context.tenancy.resolve(input.tenant)
    const mapping = tenantRequestMapping(this.#app)
    if (mapping.kind === 'unsupported') {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `Tenant "${input.tenant}" cannot be selected over HTTP: ${mapping.reason}`
      )
    }
    return { key: input.tenant, identity, mapping }
  }

  #hostname(
    input: Input,
    tenant: TenantSelection | null,
    router: RouterLike,
    tenantDomain: string | null
  ): string | null {
    let hostname: string | null = null
    if (input.domain !== undefined) {
      const domain = normalizeDomain(input.domain)
      if (domain === undefined) {
        throw new ToolError(
          'INPUT_INVALID',
          `domain "${input.domain}" is not a host name without port`
        )
      }
      const domains = Object.keys(router.toJSON()).filter((name) => name !== 'root')
      if (!domains.some((pattern) => domainMatches(pattern, domain))) {
        throw new ToolError(
          'INPUT_INVALID',
          `domain "${domain}" matches no route domain registered in the router${
            domains.length > 0
              ? ` (${domains.join(', ')})`
              : ' (the application has no domain routes)'
          }`
        )
      }
      hostname = domain
    }
    if (tenant?.mapping.kind === 'subdomain') {
      if (!tenantDomain) {
        throw new ToolError(
          'CAPABILITY_UNSUPPORTED',
          'The tenant resolver reads the subdomain: set tools.http.tenantDomain in config/mcp.ts to the parent domain of tenant hosts'
        )
      }
      const labels = tenant.key.split('.')
      if (labels.length !== tenant.mapping.levels || !labels.every(hostLabel)) {
        throw new ToolError(
          'INPUT_INVALID',
          `tenant "${tenant.key}" is not a subdomain of ${tenant.mapping.levels} label(s)`
        )
      }
      const tenantHost = `${tenant.key}.${tenantDomain}`.toLowerCase()
      if (hostname !== null && hostname !== tenantHost) {
        throw new ToolError(
          'INPUT_INVALID',
          `domain "${hostname}" contradicts the host of tenant "${tenant.key}" (${tenantHost})`
        )
      }
      hostname = tenantHost
    }
    return hostname
  }

  #guardFor(
    input: Input,
    surface: SurfaceDecision,
    guards: GuardList,
    auth: RouteAuth | null,
    context: ToolContext,
    profile: ProjectProfile
  ): GuardEntry {
    const configured = context.config.profile.surfaces[surface.name]?.guard
    const declared = auth?.guards.length === 1 ? auth.guards[0] : undefined
    const bySurface = [...guards.guards.values()].filter(
      (guard) =>
        guardSurface(guard.name, guard.driver, profile, context.config)?.name === surface.name
    )
    const name =
      input.as?.guard ??
      configured ??
      declared ??
      (bySurface.length === 1 ? bySurface[0].name : undefined) ??
      guards.default
    const guard = name === null ? undefined : guards.guards.get(name)
    if (!guard) {
      throw new ToolError(
        'INPUT_INVALID',
        `Unknown auth guard "${name ?? '(none)'}"; configured guards: ${[...guards.guards.keys()].join(', ') || 'none'}`
      )
    }
    this.#auth.assertSupported(guard)
    return guard
  }

  async run(input: Input, context: ToolContext): Promise<ToolOutput> {
    const app = this.#app
    const config = context.config
    const method: Method = input.method
    const timeout = input.timeout ?? config.tools.http.timeout
    if (timeout > config.tools.http.timeout) {
      throw new ToolError(
        'INPUT_INVALID',
        `timeout ${timeout} exceeds tools.http.timeout (${config.tools.http.timeout} ms)`
      )
    }
    const deadline = Date.now() + timeout
    if (input.body !== undefined && input.form !== undefined) {
      throw new ToolError('INPUT_INVALID', 'Pass either body (JSON) or form, not both')
    }
    if (
      SAFE_METHODS.has(method) &&
      method !== 'OPTIONS' &&
      (input.body !== undefined || input.form)
    ) {
      throw new ToolError('INPUT_INVALID', `${method} requests cannot carry a body`)
    }

    const target = await this.#target()
    if ('reason' in target) {
      throw new ToolError('CAPABILITY_UNSUPPORTED', `http_request is unavailable: ${target.reason}`)
    }
    let current: RequestPath = parseRequestPath(input.path, config.path)

    const tenant = await this.#tenant(input, context)
    const reserved = new Map<string, string>()
    const mapping = context.tenancy ? tenantRequestMapping(app) : null
    if (mapping?.kind === 'header') {
      reserved.set(
        mapping.header.toLowerCase(),
        'the tenant header is set from the validated "tenant" option'
      )
    }
    const userHeaders = validateHeaders(input.headers ?? {}, reserved)
    if (tenant?.mapping.kind === 'path' && current.pathname.split('/')[1] !== tenant.key) {
      throw new ToolError(
        'INPUT_INVALID',
        `The tenant resolver reads the first path segment: path must start with /${tenant.key}/ for tenant "${tenant.key}"`
      )
    }

    const router = (await app.container.make('router')) as unknown as RouterLike
    const hostname = this.#hostname(input, tenant, router, config.tools.http.tenantDomain)
    const host = hostname === null ? target.host : `${hostname}:${target.port}`
    const matched = router.match(
      current.pathname,
      method,
      false,
      router.usingDomains ? (hostname ?? target.connect) : undefined
    )
    const route = matched
      ? {
          pattern: matched.route.pattern,
          name: matched.route.name ?? null,
          domain: matched.route.domain,
          methods: [...matched.route.methods],
        }
      : null
    const auth = matched ? routeAuth(matched.route.middleware.all()) : null

    const profile = await context.profile()
    if (input.as && !this.#auth.active) {
      throw new ToolError(
        profile.packages.auth.version === null
          ? 'DEPENDENCY_UNAVAILABLE'
          : 'CAPABILITY_UNSUPPORTED',
        'Acting as a user requires @adonisjs/auth (binding "auth.manager"), which is not active'
      )
    }
    const guards = this.#auth.active ? await this.#auth.guards() : null
    if (input.as?.guard !== undefined && !guards?.guards.has(input.as.guard)) {
      throw new ToolError(
        'INPUT_INVALID',
        `Unknown auth guard "${input.as.guard}"; configured guards: ${[...(guards?.guards.keys() ?? [])].join(', ') || 'none'}`
      )
    }
    /**
     * A matched route whose handler renders a literal Inertia component is
     * a web route (static source evidence; the handler is not executed).
     */
    let render: { component: string; location: { file: string; line: number } } | null = null
    if (matched && profile.surfaces.web?.renderer === 'inertia') {
      const staticSource = await typescriptAvailability(context)
      if (staticSource.available) {
        const report = await this.#inertia.routeRender(matched.route)
        const literal = report.renders.find((item) => item.component !== null)
        if (literal?.component) {
          render = { component: literal.component, location: literal.location }
        }
      }
    }
    const surface = decideSurface({
      explicit: input.surface,
      guard: input.as?.guard,
      route,
      render,
      pathname: current.pathname,
      auth,
      defaultGuard: guards?.default ?? null,
      profile,
      config,
      driverOf: (name) => guards?.guards.get(name)?.driver,
    })
    const guard =
      input.as && guards ? this.#guardFor(input, surface, guards, auth, context, profile) : null

    const limitations = [
      "The request ran through the application's real HTTP stack: handlers, hooks and side effects are real, are not rolled back, and the tool never retries.",
    ]
    let version: string | null = null
    if (surface.renderer === 'inertia') {
      try {
        version = await inertiaVersion(app)
      } catch (error) {
        limitations.push(
          `The Inertia asset version could not be read (${message(error)}); the request was sent without X-Inertia-Version, so a GET may answer 409.`
        )
      }
    }
    const csrf = (input.csrf ?? surface.name === 'web') && !SAFE_METHODS.has(method)
    const csrfApplies = csrf && this.#session.csrfApplies(method)

    const secrets: string[] = []
    const jar = new CookieJar(await this.#session.boundedCookies(deadline))
    const requestIds = new Set<string>()
    const observation = await observeAuthentication(app, requestIds)
    const hops: Hop[] = []
    let last: ExchangeResult | undefined
    let token: MintedToken | null = null
    let impersonation: Record<string, unknown> | null = null
    let redirect: { location: string; followed: false; reason: string } | null = null
    let failure: unknown
    let cleanupError: string | null = null
    let tokenDeleted: boolean | null = null
    let sessionMinted = false

    try {
      const sessionValues: Record<string, unknown> = {}
      let needsSession = false
      if (input.as && guard) {
        const found = await this.#auth.userModel(guard, input.as.model)
        const tenantScope = tenant ? { ...tenant, access: context.tenancy! } : null
        const user = await this.#auth.findUser(
          found,
          input.as.userId,
          tenantScope,
          context.tenancy !== null
        )
        impersonation = {
          guard: guard.name,
          driver: guard.driver,
          model: found.summary.id,
          userId: input.as.userId,
        }
        if (guard.driver === 'access_tokens') {
          token = await this.#auth.mintToken(guard, found, user, deadline, tenantScope)
          secrets.push(...token.secrets)
          impersonation.kind = 'access-token'
          impersonation.name = TOKEN_NAME
          impersonation.expiresAt = token.expiresAt
        } else {
          Object.assign(
            sessionValues,
            await this.#auth.sessionValues(guard, user, found.summary.name)
          )
          needsSession = true
          impersonation.kind = 'session-cookie'
          impersonation.expiresAt = new Date(deadline).toISOString()
        }
      }
      let csrfToken: string | null = null
      if (csrfApplies) {
        const reason = await this.#session.unsupportedReason()
        if (reason) {
          throw new ToolError(
            'CAPABILITY_UNSUPPORTED',
            `Shield expects a CSRF token for ${method}, but no session can be minted: ${reason}. Pass csrf: false to send the request without one.`
          )
        }
        const pair = await this.#session.csrfPair()
        sessionValues['csrf-secret'] = pair.secret
        csrfToken = pair.token
        secrets.push(pair.secret, pair.token)
        needsSession = true
      }
      if (needsSession) {
        sessionMinted = true
        const minted = await this.#session.mint(sessionValues, deadline)
        for (const [name, value] of minted.cookies) {
          jar.set(name, value)
        }
        secrets.push(...minted.secrets)
      }

      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ])
      let hopMethod: Method = method
      let body: Buffer | undefined
      let contentType: string | undefined
      if (input.form) {
        const form = new URLSearchParams()
        for (const [name, value] of Object.entries(input.form)) {
          for (const item of Array.isArray(value) ? value : [value]) {
            form.append(name, item)
          }
        }
        body = Buffer.from(form.toString())
        contentType = 'application/x-www-form-urlencoded'
      } else if (input.body !== undefined) {
        body = Buffer.from(JSON.stringify(input.body))
        contentType = 'application/json'
      }

      for (let hop = 0; ; hop++) {
        const requestId = `mcp-${context.callId}-${hop}`
        requestIds.add(requestId)
        const headers: Record<string, string> = {
          ...surfaceHeaders(surface, version),
          ...userHeaders,
          'host': host,
          'x-request-id': requestId,
          [MCP_CALL_HEADER]: context.callId,
        }
        if (tenant?.mapping.kind === 'header') {
          headers[tenant.mapping.header.toLowerCase()] = tenant.key
        }
        if (token) {
          headers.authorization = token.authorization
        }
        const cookie = jar.header()
        if (cookie) {
          headers.cookie = cookie
        }
        if (csrfToken && !SAFE_METHODS.has(hopMethod)) {
          headers['x-csrf-token'] = csrfToken
        }
        if (body !== undefined && contentType) {
          headers['content-type'] = contentType
        }

        const result = await exchange({
          connect: target.connect,
          port: target.port,
          method: hopMethod,
          path: current.path,
          headers,
          body,
          signal,
          maxBodyBytes: config.limits.maxResultBytes,
        })
        last = result
        const cookies = jar.absorb(result.setCookies)
        const location =
          typeof result.headers.location === 'string' ? result.headers.location : null
        hops.push({
          requestId,
          method: hopMethod,
          path: current.path,
          status: result.status,
          location,
          durationMs: Math.round(result.durationMs),
          cookies,
        })
        if (!REDIRECT_STATUSES.has(result.status) || location === null) {
          break
        }
        if (!input.followRedirects) {
          redirect = { location, followed: false, reason: 'followRedirects is off' }
          break
        }
        const next = redirectTarget(location, { host, path: current.path }, config.path)
        if (!next.followable) {
          redirect = { location, followed: false, reason: next.reason }
          break
        }
        if (hop + 1 > MAX_REDIRECTS) {
          redirect = { location, followed: false, reason: `more than ${MAX_REDIRECTS} redirects` }
          break
        }
        const followed = nextMethod(result.status, hopMethod)
        if (followed !== hopMethod) {
          body = undefined
          contentType = undefined
        }
        hopMethod = followed
        current = next.path
      }
    } catch (error) {
      failure = error
    } finally {
      observation.stop()
      jar.clear()
      if (token) {
        try {
          tokenDeleted = await token.revoke()
        } catch (error) {
          cleanupError = message(error)
        }
      }
    }

    secrets.push(...jar.secrets())
    const redactor = this.#redactor.withSecrets(secrets)
    const cleanupNote =
      cleanupError !== null
        ? ` Deleting the temporary access token failed (${redactor.text(cleanupError)}); it expires at ${String(impersonation?.expiresAt)}.`
        : ''
    if (failure !== undefined) {
      throw this.#failure(failure, context, cleanupNote)
    }
    const final = last!

    if (token) {
      limitations.push(
        `A temporary access token "${TOKEN_NAME}" was created through guard "${String(impersonation?.guard)}" and ${
          tokenDeleted ? 'deleted' : 'could not be deleted'
        } when the call ended.${cleanupNote}`
      )
    }
    if (sessionMinted) {
      limitations.push(
        'Session cookies used by the call carried an encrypted expiry at the call deadline and were discarded; a copy stays valid until that deadline, it is not revoked on the server.'
      )
    }
    if (redirect) {
      limitations.push(`The redirect to ${redirect.location} was not followed: ${redirect.reason}.`)
    }
    const body = summarizeBody(final)
    if (body.kind !== 'empty' && body.truncated) {
      limitations.push(
        `The response body was cut at limits.maxResultBytes (${config.limits.maxResultBytes} bytes) and the connection closed.`
      )
    }
    if (body.kind === 'html') {
      limitations.push('The HTML outline is a lightweight extraction, not a DOM parse.')
    }
    if (final.status === 409 && final.headers['x-inertia-location']) {
      limitations.push(
        'The application answered an Inertia version conflict (409): the page asks for a full reload.'
      )
    }

    const logs = this.#logs(context, requestIds)
    if (!logs) {
      limitations.push(
        'Logs and exceptions of the request are not available: the application is not instrumented (see get_logs).'
      )
    }

    const data = {
      request: {
        method,
        path: hops[0]?.path ?? current.path,
        host,
        route,
        surface,
        tenant: tenant
          ? {
              requested: tenant.key,
              id: tenant.identity.id,
              name: tenant.identity.name,
              mapping:
                tenant.mapping.kind === 'header'
                  ? { kind: 'header', header: tenant.mapping.header }
                  : tenant.mapping.kind === 'subdomain'
                    ? { kind: 'subdomain', host }
                    : { kind: 'path' },
            }
          : null,
        as: impersonation,
        csrf: csrfApplies,
        inertiaVersion: version,
      },
      response: {
        status: final.status,
        statusText: final.statusText,
        headers: safeHeaders(final),
        jar: hops.at(-1)?.cookies ?? null,
        durationMs: Math.round(final.durationMs),
      },
      body,
      validation: validationErrors(body, final.status),
      redirects: hops.slice(0, -1).map((hop) => ({
        requestId: hop.requestId,
        method: hop.method,
        path: hop.path,
        status: hop.status,
        location: hop.location,
        followed: true,
      })),
      unfollowedRedirect: redirect,
      requestIds: [...requestIds],
      auth: this.#auth.active ? observation.events : null,
      logs: logs?.logs ?? null,
      exceptions: logs?.exceptions ?? null,
    }
    return {
      data: project(data, { redactor, sensitiveWords: HTTP_SENSITIVE_WORDS, maxDepth: 32 }),
      evidence: ['runtime'],
      limitations,
    }
  }

  #logs(
    context: ToolContext,
    requestIds: ReadonlySet<string>
  ): { logs: { entries: CapturedLog[]; matched: number }; exceptions: CapturedException[] } | null {
    if (!context.logs || !context.exceptions) {
      return null
    }
    const entries: CapturedLog[] = []
    let matched = 0
    const exceptions: CapturedException[] = []
    for (const requestId of requestIds) {
      const page = context.logs.query({ requestId, tail: LOG_TAIL })
      entries.push(...page.entries)
      matched += page.matched
      exceptions.push(...context.exceptions.query({ requestId, limit: EXCEPTION_LIMIT }).exceptions)
    }
    entries.sort((left, right) => left.seq - right.seq)
    return { logs: { entries: entries.slice(-LOG_TAIL), matched }, exceptions }
  }

  #failure(error: unknown, context: ToolContext, cleanupNote: string): ToolError {
    const unfinished =
      ' The application may still be processing the request: closing the connection does not stop handler code or roll back side effects, and the tool does not retry.'
    if (context.signal.aborted) {
      return new ToolError('CANCELLED', `The call was cancelled.${unfinished}${cleanupNote}`)
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new ToolError(
        'TIMEOUT',
        `The request exceeded its deadline and was aborted.${unfinished}${cleanupNote}`
      )
    }
    if (error instanceof ToolError) {
      return cleanupNote
        ? new ToolError(error.code, `${error.message}${cleanupNote}`, { cause: error })
        : error
    }
    return new ToolError(
      'EXECUTION_FAILED',
      `The request to the application failed: ${message(error)}${cleanupNote}`,
      { cause: error }
    )
  }
}

export function httpRequestTool(service: HttpRequestService): AnyToolDefinition {
  return defineTool({
    name: 'http_request',
    title: 'HTTP request to the running app',
    description:
      "Sends a real HTTP request to the running AdonisJS application over its own loopback socket, through all its middleware (bodyparser, session, Shield CSRF, auth, tenant), and returns status, safe headers, a body summary (JSON, Inertia page, HTML outline), validation errors, and the logs and exceptions of that request. Can act as a user (as: { userId, guard? }) with a temporary credential minted through the app's auth guard and removed after the call, select a tenant (tenant) or route domain (domain), and send as an api or web client (surface; detected from the route). Takes a path, never a URL, and never calls the MCP endpoint. Runs real handlers: requests can change data, are not rolled back and never retried.",
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    available: (context) => service.availability(context),
    handler: (input, context) => service.run(input, context),
  })
}

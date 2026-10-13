/*
|--------------------------------------------------------------------------
| Routes and middleware
|--------------------------------------------------------------------------
|
| Reads the committed router (final once the HTTP server booted; spike
| S-D) and the server middleware list. Nothing is imported, constructed
| or executed: handlers and middleware are described from the references
| the framework stores.
|
| What the framework does not keep is labelled instead of guessed:
| anonymous handlers have no name, the router-level stack is derived from
| route stacks, and named middleware no route uses is only known when a
| preload module exports the `router.named()` collection.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import { describeReference, type ReferenceReport } from './references.js'
import { project, type Redactor } from '../redaction.js'
import type { ProjectProfile, ResolvedMcpConfig, SurfaceName } from '../types.js'

export interface MiddlewareReport extends ReferenceReport {
  /**
   * `global`: server or router level (`server.use`, `router.use`);
   * `named`: from a `router.named()` collection, with its args;
   * `closure`: inline function.
   */
  type: 'global' | 'named' | 'closure'
  args?: unknown

  /**
   * Set for middleware registered by this package.
   */
  owner?: '@rikology/adonisjs-mcp'
}

export type RouteHandlerReport =
  { type: 'closure'; name: string | null } | ({ type: 'controller' } & ReferenceReport)

export interface RouteSurface {
  name: SurfaceName | null

  /**
   * `config`: a `profile.surfaces.*.prefix` in config/mcp.ts matched;
   * `inferred`: an observed `/api` prefix or `api.*` domain matched;
   * `default`: no prefix matched, the profile default surface applies.
   */
  source: 'config' | 'inferred' | 'default' | null
  detail: string
}

export interface RouteParam {
  name: string
  optional: boolean
  wildcard: boolean
}

export interface RouteReport {
  methods: string[]
  pattern: string
  name: string | null
  domain: string
  params: RouteParam[]
  handler: RouteHandlerReport
  middleware: MiddlewareReport[]
  surface: RouteSurface
}

export interface RouteFilter {
  pattern?: string
  method?: string
  name?: string
  domain?: string
}

interface StoredRoute {
  name?: string
  pattern: string
  methods: string[]
  domain: string
  handler: unknown
  middleware: { all(): Iterable<unknown> }
}

interface RouterLike {
  commited: boolean
  toJSON(): Record<string, StoredRoute[]>
}

interface ServerLike {
  getMiddlewareList(): unknown[]
}

export interface IntrospectionDeps {
  app: ApplicationService
  config: ResolvedMcpConfig
  redactor: Redactor

  /**
   * Recognizes the middleware reference mounted by this package.
   */
  isOwnMiddleware(reference: unknown): boolean
}

function params(pattern: string): RouteParam[] {
  return pattern.split('/').flatMap((segment): RouteParam[] => {
    if (segment === '*') {
      return [{ name: '*', optional: false, wildcard: true }]
    }
    if (!segment.startsWith(':')) {
      return []
    }
    const optional = segment.endsWith('?')
    return [{ name: segment.slice(1, optional ? -1 : undefined), optional, wildcard: false }]
  })
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function sourceOf(value: unknown): string | undefined {
  if (typeof value !== 'function') {
    return undefined
  }
  try {
    return Function.prototype.toString.call(value)
  } catch {
    return undefined
  }
}

export async function describeMiddleware(
  middleware: unknown,
  deps: IntrospectionDeps
): Promise<MiddlewareReport> {
  if (typeof middleware === 'function') {
    return {
      type: 'closure',
      reference: 'function',
      module: null,
      name: middleware.name || null,
      method: null,
    }
  }
  const reference = property(middleware, 'reference')
  const name = property(middleware, 'name')
  const described = await describeReference(reference)
  const report: MiddlewareReport = {
    ...described,
    type:
      typeof middleware === 'object' && middleware !== null && 'args' in middleware
        ? 'named'
        : 'global',
    name: typeof name === 'string' && name.length > 0 ? name : described.name,
    method: described.method ?? 'handle',
  }
  if (report.type === 'named') {
    const args = property(middleware, 'args')
    if (args !== undefined) {
      report.args = project(args, { redactor: deps.redactor, maxDepth: 6 })
    }
  }
  if (deps.isOwnMiddleware(reference)) {
    report.owner = '@rikology/adonisjs-mcp'
  }
  return report
}

async function describeHandler(handler: unknown): Promise<RouteHandlerReport> {
  if (typeof handler === 'function') {
    return { type: 'closure', name: handler.name || null }
  }
  const reference = property(handler, 'reference')
  if (Array.isArray(reference)) {
    return {
      type: 'controller',
      ...(await describeReference(reference[0], reference[1] ?? 'handle')),
    }
  }
  const described = await describeReference(reference)
  const method = property(handler, 'method')
  return {
    type: 'controller',
    ...described,
    method: described.method ?? (typeof method === 'string' ? method : null),
  }
}

function prefixMatches(prefix: string, pattern: string): boolean {
  if (prefix === '/') {
    return true
  }
  return pattern === prefix || pattern.startsWith(`${prefix}/`)
}

/**
 * Surface of one route from the profile: the longest matching surface
 * prefix, then an `api.*` domain, then the default surface.
 */
export function routeSurface(
  route: { pattern: string; domain: string },
  profile: ProjectProfile,
  config: ResolvedMcpConfig
): RouteSurface {
  let best: { name: SurfaceName; prefix: string } | undefined
  for (const name of ['web', 'api'] as const) {
    const prefix = profile.surfaces[name]?.prefix
    if (
      prefix &&
      prefixMatches(prefix, route.pattern) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      best = { name, prefix }
    }
  }
  if (best) {
    const configured = config.profile.surfaces[best.name]?.prefix === best.prefix
    return {
      name: best.name,
      source: configured ? 'config' : 'inferred',
      detail: configured
        ? `matches profile.surfaces.${best.name}.prefix '${best.prefix}'`
        : `matches the observed ${best.name} prefix '${best.prefix}'`,
    }
  }
  if (profile.surfaces.api && route.domain.startsWith('api.')) {
    return { name: 'api', source: 'inferred', detail: `domain '${route.domain}' starts with api.` }
  }
  if (profile.surfaces.default) {
    return {
      name: profile.surfaces.default,
      source: 'default',
      detail: `no surface prefix matches; the profile default surface is ${profile.surfaces.default}`,
    }
  }
  return {
    name: null,
    source: null,
    detail:
      'no surface prefix matches and the project has no default surface (set profile.surfaces.default)',
  }
}

export class RouteIntrospection {
  constructor(readonly deps: IntrospectionDeps) {}

  async #router(): Promise<RouterLike> {
    return (await this.deps.app.container.make('router')) as unknown as RouterLike
  }

  async routes(
    profile: ProjectProfile,
    filter: RouteFilter = {}
  ): Promise<{ committed: boolean; routes: RouteReport[] }> {
    const router = await this.#router()
    const method = filter.method?.toUpperCase()
    const reports: RouteReport[] = []
    for (const [domain, list] of Object.entries(router.toJSON())) {
      for (const route of list) {
        if (filter.pattern !== undefined && !route.pattern.includes(filter.pattern)) {
          continue
        }
        if (method !== undefined && !route.methods.includes(method)) {
          continue
        }
        if (filter.name !== undefined && !(route.name ?? '').includes(filter.name)) {
          continue
        }
        if (filter.domain !== undefined && domain !== filter.domain) {
          continue
        }
        const middleware: MiddlewareReport[] = []
        for (const entry of route.middleware.all()) {
          middleware.push(await describeMiddleware(entry, this.deps))
        }
        reports.push({
          methods: [...route.methods],
          pattern: route.pattern,
          name: route.name ?? null,
          domain,
          params: params(route.pattern),
          handler: await describeHandler(route.handler),
          middleware,
          surface: routeSurface({ pattern: route.pattern, domain }, profile, this.deps.config),
        })
      }
    }
    return { committed: router.commited, routes: reports }
  }

  /**
   * Server stack, router stack (derived from route stacks) and named
   * middleware.
   */
  async middleware() {
    const server = (await this.deps.app.container.make('server')) as unknown as ServerLike
    const serverStack: MiddlewareReport[] = []
    for (const entry of server.getMiddlewareList()) {
      serverStack.push(await describeMiddleware(entry, this.deps))
    }

    const router = await this.#router()
    const routes = Object.values(router.toJSON()).flat()
    const stacks: MiddlewareReport[][] = []
    for (const route of routes) {
      const stack: MiddlewareReport[] = []
      for (const entry of route.middleware.all()) {
        stack.push(await describeMiddleware(entry, this.deps))
      }
      stacks.push(stack)
    }

    const limitations: string[] = []
    const globalKey = (entry: MiddlewareReport) => `${entry.module ?? ''}|${entry.name ?? ''}`
    const leading = (stack: MiddlewareReport[]) => {
      const end = stack.findIndex((entry) => entry.type !== 'global')
      return end === -1 ? stack : stack.slice(0, end)
    }
    let routerStack: MiddlewareReport[] | null = null
    if (stacks.length === 0) {
      limitations.push('No route is registered, so the router middleware stack cannot be derived.')
    } else {
      routerStack = leading(stacks[0])
      const signature = routerStack.map(globalKey).join('\n')
      if (stacks.some((stack) => leading(stack).map(globalKey).join('\n') !== signature)) {
        limitations.push(
          'Routes do not share the same leading global middleware; the router stack shown is the one of the first route.'
        )
      }
    }

    type NamedReport = Omit<MiddlewareReport, 'args'> & { usedByRoutes: number; source: string }
    const withoutArgs = (entry: MiddlewareReport): Omit<MiddlewareReport, 'args'> => {
      const copy = { ...entry }
      delete copy.args
      return copy
    }
    const named = new Map<string, NamedReport>()
    for (const stack of stacks) {
      for (const entry of stack) {
        if (entry.type !== 'named' || entry.name === null) {
          continue
        }
        const existing = named.get(entry.name)
        if (existing) {
          existing.usedByRoutes++
        } else {
          named.set(entry.name, { ...withoutArgs(entry), usedByRoutes: 1, source: 'route stacks' })
        }
      }
    }
    const exported = await this.#exportedNamedMiddleware()
    for (const entry of exported.entries) {
      if (entry.name !== null && !named.has(entry.name)) {
        named.set(entry.name, {
          ...withoutArgs(entry),
          usedByRoutes: 0,
          source: 'preload export `middleware`',
        })
      }
    }
    if (!exported.found) {
      limitations.push(
        'No preload module exports a `middleware` collection from router.named(); named middleware that no route uses is not listed.'
      )
    }

    return {
      server: serverStack,
      router: routerStack,
      named: [...named.values()].sort((left, right) => (left.name! < right.name! ? -1 : 1)),
      limitations,
    }
  }

  /**
   * Named middleware collections exported as `middleware` by preload
   * modules of this environment (the `start/kernel.ts` convention). The
   * modules are already loaded, so importing them again evaluates nothing.
   * Only functions with the source of the framework's named-middleware
   * factory are called; that only builds a descriptor.
   */
  async #exportedNamedMiddleware(): Promise<{ found: boolean; entries: MiddlewareReport[] }> {
    const environment = this.deps.app.getEnvironment()
    const router = (await this.#router()) as RouterLike & {
      named(collection: Record<string, unknown>): Record<string, unknown>
    }
    const signature = sourceOf(router.named({ probe: async () => ({}) }).probe)
    const isNamedFactory = (value: unknown) =>
      signature !== undefined && sourceOf(value) === signature

    const entries: MiddlewareReport[] = []
    let found = false
    for (const preload of this.deps.app.rcFile.preloads) {
      if (!(preload.environment as readonly string[]).includes(environment)) {
        continue
      }
      let module: unknown
      try {
        module = await preload.file()
      } catch {
        continue
      }
      const collection = property(module, 'middleware')
      if (typeof collection !== 'object' || collection === null) {
        continue
      }
      const factories = Object.values(collection)
      if (factories.length === 0 || !factories.every(isNamedFactory)) {
        continue
      }
      found = true
      for (const factory of factories as Array<() => unknown>) {
        entries.push(await describeMiddleware(factory(), this.deps))
      }
    }
    return { found, entries }
  }
}

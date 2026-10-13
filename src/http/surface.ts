/*
|--------------------------------------------------------------------------
| Request surface
|--------------------------------------------------------------------------
|
| Decides whether a request is sent like a JSON API client or like the web
| surface (Inertia or Edge), in this order (plan §4.5): explicit `surface`
| → explicit `as.guard` → the auth guards the matched route declares → the
| matched route handler statically renders a literal Inertia component →
| `profile.surfaces.*.prefix` in config/mcp.ts → an observed `/api` prefix
| or `api.*` domain → a route protected by the default auth guard → the
| default surface. Explicit inputs that contradict each other are
| rejected, never silently resolved.
|
| A JSON request never carries Inertia headers. Inertia requests carry the
| asset version the application's own Inertia manager computes, so the
| server answers the page instead of a 409 version conflict.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import { ToolError } from '../errors.js'
import { routeSurface } from '../introspection/routes.js'
import type { ProjectProfile, ResolvedMcpConfig, SurfaceName } from '../types.js'

export type SurfaceSource =
  'input' | 'guard' | 'route-guard' | 'route-render' | 'config' | 'inferred' | 'default'

export interface SurfaceDecision {
  name: SurfaceName
  renderer: 'inertia' | 'edge' | null
  source: SurfaceSource
  detail: string
}

export interface RouteAuth {
  /**
   * Guards declared with `middleware.auth({ guards })` on the route.
   */
  guards: string[]

  /**
   * The route uses a named `auth` middleware without guards, so it
   * authenticates with the default guard.
   */
  defaultGuard: boolean
}

/**
 * Auth guards declared by the middleware of a matched route.
 */
export function routeAuth(middleware: Iterable<unknown>): RouteAuth {
  const result: RouteAuth = { guards: [], defaultGuard: false }
  for (const entry of middleware) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { name, args } = entry as { name?: unknown; args?: unknown }
    const guards = (args as { guards?: unknown } | undefined)?.guards
    if (Array.isArray(guards) && guards.every((guard) => typeof guard === 'string')) {
      result.guards.push(...guards)
    } else if (name === 'auth') {
      result.defaultGuard = true
    }
  }
  return result
}

export interface SurfaceInput {
  explicit?: SurfaceName
  guard?: string
  route: { pattern: string; domain: string } | null
  render?: { component: string; location: { file: string; line: number } } | null
  pathname: string
  auth: RouteAuth | null
  defaultGuard: string | null
  profile: ProjectProfile
  config: ResolvedMcpConfig

  /**
   * Driver of a configured guard, or `undefined` when unknown.
   */
  driverOf(guard: string): string | undefined
}

function rendererOf(name: SurfaceName, profile: ProjectProfile): SurfaceDecision['renderer'] {
  return name === 'web' ? (profile.surfaces.web?.renderer ?? null) : null
}

/**
 * Surface a guard belongs to: the surface whose `profile.surfaces.*.guard`
 * names it, otherwise its driver (session → web, others → api).
 */
export function guardSurface(
  guard: string,
  driver: string | undefined,
  profile: ProjectProfile,
  config: ResolvedMcpConfig
): { name: SurfaceName; detail: string } | null {
  for (const name of ['web', 'api'] as const) {
    if (config.profile.surfaces[name]?.guard === guard) {
      return { name, detail: `profile.surfaces.${name}.guard is "${guard}"` }
    }
  }
  if (driver === 'session') {
    return profile.surfaces.web
      ? { name: 'web', detail: `guard "${guard}" uses the session driver` }
      : null
  }
  if (driver !== undefined && driver !== 'unknown') {
    return { name: 'api', detail: `guard "${guard}" uses the ${driver} driver` }
  }
  return null
}

export function decideSurface(input: SurfaceInput): SurfaceDecision {
  const { profile, config } = input
  const decision = (name: SurfaceName, source: SurfaceSource, detail: string): SurfaceDecision => {
    if (name === 'web' && !profile.surfaces.web) {
      throw new ToolError(
        'INPUT_INVALID',
        'The project has no web surface (neither Inertia nor Edge is active); use surface "api"'
      )
    }
    return { name, renderer: rendererOf(name, profile), source, detail }
  }

  const fromGuard = input.guard
    ? guardSurface(input.guard, input.driverOf(input.guard), profile, config)
    : null
  if (input.explicit) {
    if (fromGuard && fromGuard.name !== input.explicit) {
      throw new ToolError(
        'INPUT_INVALID',
        `surface "${input.explicit}" contradicts as.guard "${input.guard}" (${fromGuard.detail}, so it belongs to the ${fromGuard.name} surface)`
      )
    }
    return decision(input.explicit, 'input', 'surface given in the request')
  }
  if (fromGuard) {
    return decision(fromGuard.name, 'guard', `as.guard: ${fromGuard.detail}`)
  }

  if (input.auth && input.auth.guards.length > 0) {
    const surfaces = new Set(
      input.auth.guards.map(
        (guard) => guardSurface(guard, input.driverOf(guard), profile, config)?.name ?? null
      )
    )
    if (surfaces.size === 1 && !surfaces.has(null)) {
      const [name] = surfaces as Set<SurfaceName>
      return decision(
        name,
        'route-guard',
        `the route authenticates with ${input.auth.guards.map((guard) => `"${guard}"`).join(', ')}`
      )
    }
  }
  if (input.render) {
    return decision(
      'web',
      'route-render',
      `the route renders Inertia component "${input.render.component}" at ${input.render.location.file}:${input.render.location.line}`
    )
  }

  const byRoute = routeSurface(
    input.route ?? { pattern: input.pathname, domain: 'root' },
    profile,
    config
  )
  if (byRoute.name && (byRoute.source === 'config' || byRoute.source === 'inferred')) {
    return decision(byRoute.name, byRoute.source, byRoute.detail)
  }
  if (input.auth?.defaultGuard && input.defaultGuard) {
    const fromDefault = guardSurface(
      input.defaultGuard,
      input.driverOf(input.defaultGuard),
      profile,
      config
    )
    if (fromDefault) {
      return decision(
        fromDefault.name,
        'inferred',
        `the route uses the auth middleware with the default guard "${input.defaultGuard}" (${fromDefault.detail})`
      )
    }
  }
  if (byRoute.name) {
    return decision(byRoute.name, 'default', byRoute.detail)
  }
  throw new ToolError(
    'INPUT_INVALID',
    `Cannot decide whether ${input.pathname} is a web or an api request in this hybrid project: ${byRoute.detail}. Pass surface: 'web' or 'api'.`
  )
}

/**
 * Headers a client of the surface sends.
 */
export function surfaceHeaders(
  decision: SurfaceDecision,
  version: string | null
): Record<string, string> {
  if (decision.name === 'api') {
    return { accept: 'application/json' }
  }
  if (decision.renderer === 'inertia') {
    return {
      'accept': 'text/html, application/xhtml+xml',
      'x-requested-with': 'XMLHttpRequest',
      'x-inertia': 'true',
      ...(version === null ? {} : { 'x-inertia-version': version }),
    }
  }
  return { accept: 'text/html,application/xhtml+xml' }
}

interface InertiaManagerLike {
  createForRequest(ctx: unknown): { getVersion(): string }
}

/**
 * Asset version of the application's Inertia manager. The manager needs an
 * HTTP context only to construct a per-request instance; the framework's
 * own context factory provides it.
 */
export async function inertiaVersion(app: ApplicationService): Promise<string> {
  const { InertiaManager } = (await app.import('@adonisjs/inertia')) as {
    InertiaManager: abstract new (...args: never[]) => unknown
  }
  const { HttpContextFactory } = (await app.import('@adonisjs/core/factories/http')) as {
    HttpContextFactory: new () => { create(): unknown }
  }
  const manager = (await app.container.make(InertiaManager as never)) as InertiaManagerLike
  return manager.createForRequest(new HttpContextFactory().create()).getVersion()
}

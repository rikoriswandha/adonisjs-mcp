/*
|--------------------------------------------------------------------------
| Tenant integration
|--------------------------------------------------------------------------
|
| Integration with `@rikology/adonisjs-tenant` (binding `tenant.service`).
| Tenants are looked up with the application's own resolver config before
| any context is entered: the trusted `lookup` callback, or the `tenants`
| allowlist of the default resolver. `TenantService.run()` itself accepts
| any identity, so an unknown key is an explicit `NOT_FOUND`, never an
| invented context that silently matches no rows.
|
| A lookup verifies that the tenant exists for the application; it does not
| authorize a user. MCP calls act as the developer running the server.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import { z } from 'zod'
import { ToolError } from './errors.js'
import type { TenantAccess, TenantIdentity } from './types.js'

export const TENANT_BINDING = 'tenant.service'

interface TenantServiceStatic {
  run<T>(tenant: TenantIdentity, callback: () => T | Promise<T>): Promise<T>
}

type Lookup = (key: string) => unknown

/**
 * Extra fields returned by a lookup callback are kept: the application may
 * read them from the tenant context.
 */
const tenantIdentity = z.looseObject({
  id: z.union([z.string().min(1), z.number().finite()]),
  name: z.string(),
  slug: z.string(),
})

/**
 * The part of `config/tenancy.ts` read here. Unknown fields are kept out
 * of the result; functions are only called through `lookup`.
 */
const tenancyConfig = z.object({
  default: z.string(),
  tenants: z.record(
    z.string(),
    z.object({
      resolver: z.string(),
      options: z
        .object({
          lookup: z.custom<Lookup>((value) => typeof value === 'function').optional(),
          tenants: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
  ),
})

/**
 * How the default resolver maps a key to a tenant.
 */
type Strategy =
  | { kind: 'lookup'; resolver: string; lookup: Lookup }
  | { kind: 'allowlist'; resolver: string; tenants: Record<string, unknown> }
  | { kind: 'none'; resolver: string | null; reason: string }

/**
 * Reads the default resolver from the `tenancy` config.
 */
function strategy(app: ApplicationService): Strategy {
  const parsed = tenancyConfig.safeParse(app.config.get('tenancy', undefined))
  if (!parsed.success) {
    return {
      kind: 'none',
      resolver: null,
      reason: 'config/tenancy.ts has no "default" resolver with configured "tenants"',
    }
  }
  const name = parsed.data.default
  const entry = parsed.data.tenants[name]
  if (!entry) {
    return { kind: 'none', resolver: name, reason: `resolver "${name}" is not configured` }
  }
  if (entry.resolver === 'jwt') {
    return {
      kind: 'none',
      resolver: name,
      reason:
        'the jwt resolver decodes tenant claims without a lookup, so tenant keys cannot be verified',
    }
  }
  if (entry.options?.lookup) {
    return { kind: 'lookup', resolver: name, lookup: entry.options.lookup }
  }
  if (entry.options?.tenants) {
    return { kind: 'allowlist', resolver: name, tenants: entry.options.tenants }
  }
  return {
    kind: 'none',
    resolver: name,
    reason: `resolver "${name}" has neither a lookup callback nor a tenants allowlist`,
  }
}

/**
 * Tenant lookup and context for one application. Created only when the
 * `tenant.service` binding exists.
 */
export class TenantIntegration implements TenantAccess {
  readonly #app: ApplicationService
  #service?: Promise<TenantServiceStatic>

  constructor(app: ApplicationService) {
    this.#app = app
  }

  static detect(app: ApplicationService): TenantIntegration | null {
    return app.container.hasBinding(TENANT_BINDING) ? new TenantIntegration(app) : null
  }

  #tenantService(): Promise<TenantServiceStatic> {
    this.#service ??= (async () => {
      const service: unknown = await this.#app.container.make(TENANT_BINDING as never)
      if (typeof (service as Partial<TenantServiceStatic>)?.run !== 'function') {
        throw new Error(`The "${TENANT_BINDING}" binding does not expose run()`)
      }
      return service as TenantServiceStatic
    })()
    return this.#service
  }

  async resolve(key: string): Promise<TenantIdentity> {
    const current = strategy(this.#app)
    if (current.kind === 'none') {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `Tenant "${key}" cannot be looked up: ${current.reason}. Configure a lookup callback or a tenants allowlist on the default resolver in config/tenancy.ts.`
      )
    }
    const candidate =
      current.kind === 'lookup'
        ? await current.lookup(key)
        : Object.hasOwn(current.tenants, key)
          ? { ...(current.tenants[key] as object), slug: key }
          : undefined
    const parsed = candidate === undefined ? undefined : tenantIdentity.safeParse(candidate)
    const found = parsed?.success ? parsed.data : undefined
    if (!found) {
      throw new ToolError(
        'NOT_FOUND',
        `Unknown tenant "${key}": the "${current.resolver}" resolver of config/tenancy.ts does not resolve it`
      )
    }
    return found
  }

  async run<T>(tenant: TenantIdentity, callback: () => T | Promise<T>): Promise<T> {
    const service = await this.#tenantService()
    return service.run(tenant, callback)
  }
}

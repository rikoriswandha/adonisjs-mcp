/*
|--------------------------------------------------------------------------
| Impersonation
|--------------------------------------------------------------------------
|
| `http_request` acts as a user through the application's own auth guards
| (spike S-F, plan D27):
|
| - Guards are created with `authManager.createAuthenticatorClient()`, the
|   documented client-side API the Japa plugin uses. Supported drivers are
|   `access_tokens` and `session`; others fail explicitly.
| - The user is looked up before anything is minted. With a tenant, the
|   lookup runs inside the tenant context and must prove membership
|   (tenant auth finder of `@rikology/adonisjs-tenant`, or a TenantScope
|   user model); an unknown or foreign user never falls back to anonymous.
| - Access tokens are created by the guard (tenant-bound when the tenant
|   token provider is used), expire with the call deadline, and are deleted
|   by identifier in `finally`, whatever the outcome. Only the token of the
|   call is deleted.
| - Sessions only carry the values `authenticateAsClient()` returns; the
|   session adapter turns them into cookies.
|
| The guard decides on every request; the tool only reports what the
| application's auth events say happened for its own request ids.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import { ToolError } from '../errors.js'
import type { DiscoveredModel, LucidModelClass, ModelCatalog } from '../database/models.js'
import type { TenantAccess, TenantIdentity } from '../types.js'

/**
 * Name given to the access tokens minted by the tool.
 */
export const TOKEN_NAME = 'adonisjs-mcp http_request'

const SUPPORTED_DRIVERS = new Set(['access_tokens', 'session'])

interface AccessTokenLike {
  identifier: string | number | bigint
  type: string
  value?: { release(): string }
  expiresAt?: Date | null
}

interface GuardClient {
  driverName?: unknown
  createToken?(
    user: unknown,
    abilities?: string[],
    options?: { expiresIn?: string | number; name?: string }
  ): Promise<AccessTokenLike>
  authenticateAsClient(user: unknown): Promise<{ session?: Record<string, unknown> }>
}

interface AuthManagerLike {
  config?: { default?: unknown; guards?: Record<string, unknown> }
  createAuthenticatorClient(): { use(name: string): GuardClient }
}

interface TokenProviderLike {
  type: string
  create(...args: unknown[]): Promise<unknown>
  delete(user: unknown, identifier: unknown): Promise<unknown>
  options?: { tokenableModel?: unknown }
}

interface UserStatics {
  primaryKey: string
  find(id: unknown): Promise<unknown>
  findForAuth?(uids: string[], value: unknown): Promise<unknown>
  forTenant?: unknown
  withoutTenantScope?: unknown
}

export interface GuardEntry {
  name: string
  driver: string
  client: GuardClient
}

export interface GuardList {
  default: string | null
  guards: Map<string, GuardEntry>
}

export interface MintedToken {
  authorization: string
  secrets: string[]
  expiresAt: string | null

  /**
   * Deletes the token; resolves whether a row was deleted.
   */
  revoke(): Promise<boolean>
}

function isTokenProvider(value: unknown, model: LucidModelClass): value is TokenProviderLike {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<TokenProviderLike>
  const tokenable = candidate.options?.tokenableModel
  return (
    typeof candidate.create === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.type === 'string' &&
    (tokenable === model ||
      (typeof tokenable === 'function' && Object.prototype.isPrototypeOf.call(tokenable, model)))
  )
}

/**
 * Access token providers of a user model: the conventional `accessTokens`
 * static (also the tenant mixin's getter) and other static data properties
 * holding a provider bound to the model.
 */
export function tokenProviders(model: LucidModelClass): TokenProviderLike[] {
  const found: TokenProviderLike[] = []
  const conventional: unknown = Reflect.get(model, 'accessTokens')
  if (isTokenProvider(conventional, model)) {
    found.push(conventional)
  }
  let current: object | null = model
  while (current && current !== Function.prototype) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (name === 'accessTokens' || !('value' in descriptor)) {
        continue
      }
      if (isTokenProvider(descriptor.value, model) && !found.includes(descriptor.value)) {
        found.push(descriptor.value)
      }
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return found
}

function isTenantScoped(model: LucidModelClass): boolean {
  const statics = model as unknown as UserStatics
  return typeof statics.forTenant === 'function' && typeof statics.withoutTenantScope === 'function'
}

/**
 * The tenant auth finder of `@rikology/adonisjs-tenant`: `findForAuth`
 * restricted to the members of the current tenant, and a tenant-bound
 * token provider.
 */
function hasTenantAuthFinder(model: LucidModelClass): boolean {
  const statics = model as unknown as UserStatics
  const tokens: unknown = Reflect.get(model, 'accessTokens')
  return (
    typeof statics.findForAuth === 'function' &&
    typeof (tokens as { verifyForCurrentTenant?: unknown } | undefined)?.verifyForCurrentTenant ===
      'function'
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AuthAccess {
  readonly #app: ApplicationService
  readonly #catalog: ModelCatalog

  constructor(app: ApplicationService, catalog: ModelCatalog) {
    this.#app = app
    this.#catalog = catalog
  }

  get active(): boolean {
    return this.#app.container.hasBinding('auth.manager' as never)
  }

  /**
   * Configured guards with their driver, from fresh client-side guard
   * instances.
   */
  async guards(): Promise<GuardList> {
    const manager = (await this.#app.container.make('auth.manager' as never)) as AuthManagerLike
    const client = manager.createAuthenticatorClient()
    const guards = new Map<string, GuardEntry>()
    for (const name of Object.keys(manager.config?.guards ?? {})) {
      const instance = client.use(name)
      const driver = typeof instance.driverName === 'string' ? instance.driverName : 'unknown'
      guards.set(name, { name, driver, client: instance })
    }
    const fallback = manager.config?.default
    return { default: typeof fallback === 'string' ? fallback : null, guards }
  }

  /**
   * Validates that `guard` can be impersonated.
   */
  assertSupported(guard: GuardEntry) {
    if (!SUPPORTED_DRIVERS.has(guard.driver)) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `Guard "${guard.name}" uses the "${guard.driver}" driver; http_request can act as a user only through access_tokens and session guards`
      )
    }
  }

  /**
   * The user model the guard authenticates: `reference` (a get_models id or
   * class name) when given, otherwise the only model shaped for the guard.
   * The guard itself verifies the model when the credential is minted.
   */
  async userModel(guard: GuardEntry, reference: string | undefined): Promise<DiscoveredModel> {
    if (!this.#app.container.hasBinding('lucid.db' as never)) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        'Acting as a user looks the user up through a Lucid model, and @adonisjs/lucid is not active'
      )
    }
    if (reference !== undefined) {
      const lookup = await this.#catalog.find(reference)
      if (!lookup.found) {
        throw new ToolError(
          'INPUT_INVALID',
          lookup.candidates.length > 1
            ? `Model name "${reference}" is ambiguous; use one of the ids: ${lookup.candidates.join(', ')}`
            : `Unknown model "${reference}". Call get_models for the available models.`
        )
      }
      return lookup.found
    }
    const snapshot = await this.#catalog.snapshot()
    const candidates: DiscoveredModel[] = []
    for (const summary of snapshot.models) {
      const lookup = await this.#catalog.find(summary.id)
      if (!lookup.found) {
        continue
      }
      const model = lookup.found.model
      const statics = model as unknown as UserStatics
      const shaped =
        guard.driver === 'access_tokens'
          ? tokenProviders(model).length > 0
          : typeof statics.findForAuth === 'function'
      if (shaped) {
        candidates.push(lookup.found)
      }
    }
    if (candidates.length === 1) {
      return candidates[0]
    }
    const shape =
      guard.driver === 'access_tokens'
        ? 'with an access token provider (static accessTokens)'
        : 'with an auth finder (withAuthFinder)'
    throw new ToolError(
      'INPUT_INVALID',
      candidates.length === 0
        ? `No model ${shape} was found for guard "${guard.name}"; pass as.model with the get_models id of the user model`
        : `Several models ${shape} match guard "${guard.name}" (${candidates
            .map((candidate) => candidate.summary.id)
            .join(', ')}); pass as.model`
    )
  }

  /**
   * Finds the user, inside the tenant when one is given. A tenant lookup
   * must prove membership; otherwise the call fails before anything is
   * minted.
   */
  async findUser(
    found: DiscoveredModel,
    userId: string | number,
    tenant: { identity: TenantIdentity; key: string; access: TenantAccess } | null,
    tenancyActive: boolean
  ): Promise<unknown> {
    const { model, summary } = found
    const statics = model as unknown as UserStatics
    let user: unknown
    if (tenant) {
      const membership = hasTenantAuthFinder(model)
      if (!membership && !isTenantScoped(model)) {
        throw new ToolError(
          'CAPABILITY_UNSUPPORTED',
          `Membership of user model ${summary.name} in tenant "${tenant.key}" cannot be verified: it neither uses the tenant auth finder (withTenantAuthFinder) nor TenantScope`
        )
      }
      user = await tenant.access.run(tenant.identity, () =>
        membership ? statics.findForAuth!([model.primaryKey], userId) : statics.find(userId)
      )
      if (!user) {
        throw new ToolError(
          'NOT_FOUND',
          `User ${userId} (${summary.name}) does not exist or is not a member of tenant "${tenant.key}"`
        )
      }
      return user
    }
    if (tenancyActive && (isTenantScoped(model) || hasTenantAuthFinder(model))) {
      throw new ToolError(
        'TENANT_SCOPE_REQUIRED',
        `User model ${summary.name} is tenant-bound (@rikology/adonisjs-tenant); pass "tenant" to act as one of its users`
      )
    }
    user = await statics.find(userId)
    if (!user) {
      throw new ToolError('NOT_FOUND', `User ${userId} (${summary.name}) does not exist`)
    }
    return user
  }

  /**
   * Creates an access token through the guard, bound to the tenant context
   * when given, expiring shortly after `deadline`.
   */
  async mintToken(
    guard: GuardEntry,
    found: DiscoveredModel,
    user: unknown,
    deadline: number,
    tenant: { identity: TenantIdentity; access: TenantAccess } | null
  ): Promise<MintedToken> {
    const providers = tokenProviders(found.model)
    if (providers.length === 0 || typeof guard.client.createToken !== 'function') {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `Model ${found.summary.name} exposes no access token provider the tool could delete its token with`
      )
    }
    const seconds = Math.ceil(Math.max(0, deadline - Date.now()) / 1000) + 1
    const create = () =>
      guard.client.createToken!(user, ['*'], { expiresIn: `${seconds} seconds`, name: TOKEN_NAME })
    let token: AccessTokenLike
    try {
      token = tenant ? await tenant.access.run(tenant.identity, create) : await create()
    } catch (error) {
      throw new ToolError(
        'EXECUTION_FAILED',
        `Guard "${guard.name}" could not create an access token for ${found.summary.name}: ${message(error)}`
      )
    }
    const provider = providers.find((candidate) => candidate.type === token.type) ?? providers[0]
    const revoke = async () => Number(await provider.delete(user, token.identifier)) > 0
    const value = token.value?.release()
    if (!value) {
      await revoke()
      throw new ToolError('EXECUTION_FAILED', 'The created access token exposes no value')
    }
    return {
      authorization: `Bearer ${value}`,
      secrets: [value],
      expiresAt: token.expiresAt instanceof Date ? token.expiresAt.toISOString() : null,
      revoke,
    }
  }

  /**
   * Session values marking `user` as logged in on a session guard.
   */
  async sessionValues(guard: GuardEntry, user: unknown, model: string) {
    try {
      const result = await guard.client.authenticateAsClient(user)
      if (!result.session) {
        throw new Error('authenticateAsClient() returned no session values')
      }
      return result.session
    } catch (error) {
      throw new ToolError(
        'EXECUTION_FAILED',
        `Guard "${guard.name}" could not authenticate a ${model} user: ${message(error)}`
      )
    }
  }
}

export interface AuthObservation {
  requestId: string
  guard: string | null
  outcome: 'succeeded' | 'failed'
  userId: string | number | null
}

const AUTH_EVENTS: ReadonlyArray<[string, AuthObservation['outcome']]> = [
  ['access_tokens_auth:authentication_succeeded', 'succeeded'],
  ['access_tokens_auth:authentication_failed', 'failed'],
  ['session_auth:authentication_succeeded', 'succeeded'],
  ['session_auth:authentication_failed', 'failed'],
]

interface EmitterLike {
  on(event: string, listener: (payload: unknown) => void): unknown
  off(event: string, listener: (payload: unknown) => void): unknown
}

/**
 * Records the authentication events the application emits for the given
 * request ids. Listening has no effect on the application.
 */
export async function observeAuthentication(
  app: ApplicationService,
  requestIds: ReadonlySet<string>
): Promise<{ events: AuthObservation[]; stop(): void }> {
  const events: AuthObservation[] = []
  if (!app.container.hasBinding('emitter')) {
    return { events, stop() {} }
  }
  const emitter = (await app.container.make('emitter')) as unknown as EmitterLike
  const listeners = AUTH_EVENTS.map(([event, outcome]) => {
    const listener = (payload: unknown) => {
      const data = payload as {
        ctx?: { request?: { header?(name: string): unknown } }
        guardName?: unknown
        user?: { $primaryKeyValue?: unknown; id?: unknown }
      }
      const requestId = data?.ctx?.request?.header?.('x-request-id')
      if (typeof requestId !== 'string' || !requestIds.has(requestId)) {
        return
      }
      const id = data.user?.$primaryKeyValue ?? data.user?.id
      events.push({
        requestId,
        guard: typeof data.guardName === 'string' ? data.guardName : null,
        outcome,
        userId: typeof id === 'string' || typeof id === 'number' ? id : null,
      })
    }
    emitter.on(event, listener)
    return [event, listener] as const
  })
  return {
    events,
    stop() {
      for (const [event, listener] of listeners) {
        emitter.off(event, listener)
      }
    },
  }
}

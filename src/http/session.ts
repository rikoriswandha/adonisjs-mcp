/*
|--------------------------------------------------------------------------
| Session cookies and CSRF
|--------------------------------------------------------------------------
|
| Sessions for `http_request` are minted with the application's own
| session config, encryption service and cookie format (spike S-F, plan
| D27), only for the stateless `cookie` store: nothing is written on the
| server, so nothing is left behind.
|
| - The data cookie (named after a fresh session id) carries the session
|   values encrypted with the session id as purpose and an embedded expiry
|   at the deadline of the call. The signed id cookie goes with it.
| - Every encrypted cookie the application sends back (refreshed session,
|   `XSRF-TOKEN`) is re-encrypted with the remaining lifetime of the same
|   deadline before the next hop; the application's own cookies carry no
|   expiry of their own.
| - CSRF follows Shield's documented test recipe: a `csrf-secret` in the
|   session and an `x-csrf-token` derived from it with the `csrf` package
|   Shield itself uses.
|
| A copy of these cookies stays valid until the deadline; it is not revoked
| on the server. Stateful stores (memory, file, redis, database) are not
| supported: their cleanup after the application's own session commit is
| not proven (obligation OB-22).
|
*/

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import { ToolError } from '../errors.js'
import type { CookieTransform } from './cookie_jar.js'

interface Encrypter {
  encrypt(value: unknown, expiresIn?: string | number, purpose?: string): string
  decrypt<T = unknown>(value: string, purpose?: string): T | null
}

interface CookieClientLike {
  sign(key: string, value: unknown): string | null
}

interface ResolvedSession {
  enabled?: boolean
  cookieName: string
  store: string
}

interface CsrfConfig {
  enabled: boolean
  methods: readonly string[]
}

interface Tokens {
  secret(): Promise<string>
  create(secret: string): string
}

export interface MintedSession {
  /**
   * Cookie name/value pairs, URL-encoded as a browser would send them.
   */
  cookies: Array<[string, string]>
  secrets: string[]
}

function isProvider(
  value: unknown
): value is { type: 'provider'; resolver(app: unknown): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'provider' &&
    typeof (value as { resolver?: unknown }).resolver === 'function'
  )
}

export class SessionAccess {
  readonly #app: ApplicationService
  #session?: Promise<ResolvedSession | null>
  #tokens?: Promise<Tokens>

  constructor(app: ApplicationService) {
    this.#app = app
  }

  /**
   * Resolved session config, or `null` when `@adonisjs/session` is not
   * configured.
   */
  #config(): Promise<ResolvedSession | null> {
    this.#session ??= (async () => {
      const raw: unknown = this.#app.config.get('session', undefined)
      const resolved: unknown = isProvider(raw) ? await raw.resolver(this.#app) : raw
      if (
        typeof resolved !== 'object' ||
        resolved === null ||
        typeof (resolved as ResolvedSession).cookieName !== 'string' ||
        typeof (resolved as ResolvedSession).store !== 'string'
      ) {
        return null
      }
      return resolved as ResolvedSession
    })()
    this.#session.catch(() => (this.#session = undefined))
    return this.#session
  }

  /**
   * Why sessions cannot be minted, or `null` when they can.
   */
  async unsupportedReason(): Promise<string | null> {
    if (!this.#app.container.hasBinding('encryption')) {
      return 'the encryption service is not bound'
    }
    let config: ResolvedSession | null
    try {
      config = await this.#config()
    } catch (error) {
      return `config/session.ts could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!config) {
      return '@adonisjs/session is not configured (config/session.ts)'
    }
    if (config.enabled === false) {
      return 'sessions are disabled in config/session.ts'
    }
    if (config.store !== 'cookie') {
      return `the active session store is "${config.store}"; only the stateless "cookie" store is supported, because cleanup of server-side session records is not proven`
    }
    return null
  }

  async #encryption(): Promise<Encrypter> {
    return (await this.#app.container.make('encryption')) as unknown as Encrypter
  }

  /**
   * Mints the id and data cookies of a new session holding `values`,
   * valid until `deadline` (epoch ms).
   */
  async mint(values: Record<string, unknown>, deadline: number): Promise<MintedSession> {
    const reason = await this.unsupportedReason()
    if (reason) {
      throw new ToolError('CAPABILITY_UNSUPPORTED', `Cannot mint a session: ${reason}`)
    }
    const config = (await this.#config())!
    const encryption = await this.#encryption()
    const { CookieClient } = (await this.#app.import('@adonisjs/core/http')) as {
      CookieClient: new (encryption: Encrypter) => CookieClientLike
    }
    const sessionId = randomUUID()
    const signedId = new CookieClient(encryption).sign(config.cookieName, sessionId)
    if (signedId === null) {
      throw new Error('The session id cookie could not be signed')
    }
    const data = `e:${encryption.encrypt(values, remaining(deadline), sessionId)}`
    const cookies: Array<[string, string]> = [
      [config.cookieName, encodeURIComponent(signedId)],
      [sessionId, encodeURIComponent(data)],
    ]
    return { cookies, secrets: [signedId, data] }
  }

  /**
   * Cookie transform bounding encrypted cookies to `deadline`: their value
   * is decrypted with the cookie name as purpose and encrypted again with
   * the remaining lifetime. A value that cannot be decrypted is dropped.
   */
  async boundedCookies(deadline: number): Promise<CookieTransform> {
    const encryption = this.#app.container.hasBinding('encryption')
      ? await this.#encryption()
      : undefined
    return (name, value) => {
      let decoded: string
      try {
        decoded = decodeURIComponent(value)
      } catch {
        return value
      }
      if (!decoded.startsWith('e:')) {
        return value
      }
      if (!encryption) {
        return null
      }
      const plain = encryption.decrypt(decoded.slice(2), name)
      if (plain === null || plain === undefined) {
        return null
      }
      return encodeURIComponent(`e:${encryption.encrypt(plain, remaining(deadline), name)}`)
    }
  }

  /**
   * Shield CSRF settings, or `null` when CSRF protection is off.
   */
  csrf(): CsrfConfig | null {
    const csrf: unknown = this.#app.config.get('shield.csrf', undefined)
    if (typeof csrf !== 'object' || csrf === null || (csrf as CsrfConfig).enabled !== true) {
      return null
    }
    const methods = (csrf as { methods?: unknown }).methods
    return {
      enabled: true,
      methods: Array.isArray(methods)
        ? methods.filter((method): method is string => typeof method === 'string')
        : [],
    }
  }

  /**
   * Whether Shield validates a CSRF token for `method`.
   */
  csrfApplies(method: string): boolean {
    const csrf = this.csrf()
    if (!csrf) {
      return false
    }
    return csrf.methods.length === 0
      ? true
      : csrf.methods.some((allowed) => allowed.toUpperCase() === method)
  }

  /**
   * A CSRF secret for the session and the matching token, from the `csrf`
   * package Shield resolves.
   */
  async csrfPair(): Promise<{ secret: string; token: string }> {
    this.#tokens ??= (async () => {
      const appRequire = createRequire(join(fileURLToPath(this.#app.appRoot), 'package.json'))
      const shieldEntry = appRequire.resolve('@adonisjs/shield')
      const csrfPath = createRequire(shieldEntry).resolve('csrf')
      const module = (await import(pathToFileURL(csrfPath).href)) as {
        default: new () => Tokens
      }
      return new module.default()
    })()
    this.#tokens.catch(() => (this.#tokens = undefined))
    const tokens = await this.#tokens
    const secret = await tokens.secret()
    return { secret, token: tokens.create(secret) }
  }
}

/**
 * Lifetime left until `deadline`, at least one second so a credential is
 * never minted already expired.
 */
function remaining(deadline: number): number {
  return Math.max(1_000, deadline - Date.now())
}

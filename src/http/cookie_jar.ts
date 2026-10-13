/*
|--------------------------------------------------------------------------
| Cookie jar
|--------------------------------------------------------------------------
|
| Cookies of one `http_request` call, carried across its redirect hops and
| discarded when the call ends. Cookies are only ever sent back to the
| application origin. Every cookie the application sets passes through
| `transform` first: the session adapter re-encrypts credential cookies with
| the deadline of the call, so a copy outlives the call by at most that
| deadline. A cookie the transform refuses is dropped.
|
*/

export interface JarUpdate {
  set: string[]
  cleared: string[]
  dropped: string[]
}

export type CookieTransform = (name: string, value: string) => string | null

interface ParsedSetCookie {
  name: string
  value: string
  cleared: boolean
}

/**
 * Name, value and whether the header deletes the cookie (`Max-Age<=0`,
 * an `Expires` in the past or an empty value).
 */
export function parseSetCookie(header: string, now = Date.now()): ParsedSetCookie | undefined {
  const [pair, ...attributes] = header.split(';')
  const separator = pair.indexOf('=')
  if (separator <= 0) {
    return undefined
  }
  const name = pair.slice(0, separator).trim()
  const value = pair.slice(separator + 1).trim()
  let cleared = value === ''
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=')
    const key = rawKey.trim().toLowerCase()
    const attributeValue = rest.join('=').trim()
    if (key === 'max-age' && Number(attributeValue) <= 0) {
      cleared = true
    }
    if (key === 'expires') {
      const expires = Date.parse(attributeValue)
      if (!Number.isNaN(expires) && expires <= now) {
        cleared = true
      }
    }
  }
  return { name, value, cleared }
}

export class CookieJar {
  readonly #cookies = new Map<string, string>()
  readonly #seen = new Set<string>()
  readonly #transform: CookieTransform

  constructor(transform: CookieTransform = (_name, value) => value) {
    this.#transform = transform
  }

  /**
   * Stores a cookie minted by the tool, as is.
   */
  set(name: string, value: string) {
    this.#cookies.set(name, value)
    this.#remember(value)
  }

  /**
   * Applies the `Set-Cookie` headers of a response.
   */
  absorb(headers: readonly string[]): JarUpdate {
    const update: JarUpdate = { set: [], cleared: [], dropped: [] }
    for (const header of headers) {
      const parsed = parseSetCookie(header)
      if (!parsed) {
        continue
      }
      this.#remember(parsed.value)
      if (parsed.cleared) {
        this.#cookies.delete(parsed.name)
        update.cleared.push(parsed.name)
        continue
      }
      const value = this.#transform(parsed.name, parsed.value)
      if (value === null) {
        this.#cookies.delete(parsed.name)
        update.dropped.push(parsed.name)
        continue
      }
      this.#cookies.set(parsed.name, value)
      this.#remember(value)
      update.set.push(parsed.name)
    }
    return update
  }

  get size(): number {
    return this.#cookies.size
  }

  header(): string | undefined {
    if (this.#cookies.size === 0) {
      return undefined
    }
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Every cookie value seen by the jar, raw and URL-decoded, for output
   * redaction.
   */
  secrets(): string[] {
    return [...this.#seen]
  }

  clear() {
    this.#cookies.clear()
  }

  #remember(value: string) {
    if (value === '') {
      return
    }
    this.#seen.add(value)
    try {
      this.#seen.add(decodeURIComponent(value))
    } catch {
      // Not URL-encoded; the raw value is enough.
    }
  }
}

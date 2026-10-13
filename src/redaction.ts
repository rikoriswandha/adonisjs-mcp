/*
|--------------------------------------------------------------------------
| Redaction
|--------------------------------------------------------------------------
|
| Baseline scrubbing applied to every error message and error detail the
| endpoint returns. It masks the current values of secret-looking
| environment variables and credential shapes (URL passwords, bearer and
| opaque access tokens).
|
| `project()` builds on it for structured data (config, captured logs and
| exceptions, middleware args): values under sensitive key names are
| masked, strings are scrubbed, and objects that are not plain data are
| summarized instead of serialized. Key-name matching is not a guarantee
| that every secret is masked: a secret stored under a neutral key name
| that is not the value of a secret environment variable stays visible.
|
*/

export const REDACTED = '[REDACTED]'

/**
 * Environment variable name segments that mark the value as secret.
 */
const SECRET_SEGMENTS = new Set([
  'KEY',
  'APIKEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'PRIVATE',
  'CREDENTIAL',
  'CREDENTIALS',
  'SALT',
  'DSN',
  'AUTH',
  'COOKIE',
  'SIGNATURE',
])

/**
 * Shorter values are left alone: masking `true` or `3306` everywhere would
 * destroy unrelated text without protecting anything.
 */
const MIN_SECRET_LENGTH = 8

const TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/g, `$1 ${REDACTED}`],
  [/\boat_[\w.-]{8,}/g, `oat_${REDACTED}`],
]

export function isSecretEnvName(name: string): boolean {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((segment) => SECRET_SEGMENTS.has(segment))
}

export class Redactor {
  readonly #secrets: readonly string[]

  constructor(secrets: Iterable<string>) {
    this.#secrets = [...new Set(secrets)]
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
      .sort((left, right) => right.length - left.length)
  }

  /**
   * Redactor seeded with secret-looking variables of `env`.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv): Redactor {
    return new Redactor(
      Object.entries(env).flatMap(([name, value]) =>
        value !== undefined && isSecretEnvName(name) ? [value] : []
      )
    )
  }

  /**
   * Redactor that also masks `secrets`, e.g. credentials minted for one
   * tool call.
   */
  withSecrets(secrets: Iterable<string>): Redactor {
    return new Redactor([...this.#secrets, ...secrets])
  }

  /**
   * Scrubs only registered secret values, preserving data under neutral or
   * sensitive-looking keys. Used by the shared success-result serializer.
   */
  knownSecrets(input: string): string {
    let output = input
    for (const secret of this.#secrets) {
      if (output.includes(secret)) {
        output = output.split(secret).join(REDACTED)
      }
    }
    return output
  }

  text(input: string): string {
    let output = this.knownSecrets(input)
    for (const [pattern, replacement] of TEXT_PATTERNS) {
      output = output.replace(pattern, replacement)
    }
    return output
  }

  /**
   * Redacts every string of a JSON value. Object keys are kept.
   */
  value(input: unknown): unknown {
    if (typeof input === 'string') {
      return this.text(input)
    }
    if (Array.isArray(input)) {
      return input.map((item) => this.value(item))
    }
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, this.value(item)]))
    }
    return input
  }
}

/**
 * Key words that mark a value as secret wherever they appear in a key,
 * e.g. `password`, `dbPassword`, `client_secret`, `apiToken`.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'tokens',
  'apikey',
  'appkey',
  'secretkey',
  'privatekey',
  'accesskey',
  'credential',
  'credentials',
  'salt',
  'dsn',
  'authorization',
])

/**
 * Words that make a following `key` secret (`appKey`, `private_key`).
 * A plain `key`/`keys` is secret too; `keyPrefix` is not.
 */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'app',
  'api',
  'secret',
  'private',
  'access',
  'signing',
  'encryption',
  'master',
  'client',
  'auth',
  'session',
  'license',
  'service',
  'account',
])

/**
 * Extra words for HTTP-shaped data (logged headers), where cookies carry
 * session credentials. Not used for config, where `cookie` holds options.
 */
export const HTTP_SENSITIVE_WORDS: ReadonlySet<string> = new Set(['cookie', 'cookies'])

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
}

export function isSensitiveKey(key: string, extraWords?: ReadonlySet<string>): boolean {
  const words = keyWords(key).filter((word) => !/^\d+$/.test(word))
  return words.some((word, index) => {
    if (SENSITIVE_WORDS.has(word) || extraWords?.has(word)) {
      return true
    }
    if (word === 'key' || word === 'keys') {
      return words.length === 1 || (index > 0 && KEY_QUALIFIERS.has(words[index - 1]))
    }
    return false
  })
}

export interface ProjectionOptions {
  redactor: Redactor

  /**
   * Additional sensitive key words, e.g. `HTTP_SENSITIVE_WORDS`.
   */
  sensitiveWords?: ReadonlySet<string>

  /**
   * Nesting depth after which values are replaced by `[MaxDepth]`.
   */
  maxDepth?: number
}

function maskValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') {
    return value
  }
  return REDACTED
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Config providers (`configProvider.create(...)`) are resolved lazily by
 * the framework; resolving them runs application code.
 */
function isConfigProvider(value: object): boolean {
  return (
    'type' in value &&
    value.type === 'provider' &&
    'resolver' in value &&
    typeof value.resolver === 'function'
  )
}

function projectValue(
  value: unknown,
  options: Required<Omit<ProjectionOptions, 'sensitiveWords'>> & ProjectionOptions,
  depth: number,
  ancestors: Set<object>
): unknown {
  switch (typeof value) {
    case 'string':
      return options.redactor.text(value)
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'undefined':
      return undefined
    case 'symbol':
      return value.toString()
    case 'function':
      return value.name ? `[Function ${value.name}]` : '[Function]'
  }
  if (value === null) {
    return null
  }

  const object = value as object
  if (ancestors.has(object)) {
    return '[Circular]'
  }
  if (depth >= options.maxDepth) {
    return '[MaxDepth]'
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? null : object.toISOString()
  }
  if (object instanceof RegExp) {
    return object.toString()
  }
  if (object instanceof URL) {
    return options.redactor.text(object.href)
  }
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    return `[Binary ${object.byteLength} bytes]`
  }
  if (object instanceof Error) {
    return { name: object.name, message: options.redactor.text(object.message) }
  }

  ancestors.add(object)
  try {
    if (Array.isArray(object)) {
      return object.map((item) => projectValue(item, options, depth + 1, ancestors) ?? null)
    }
    if (!isPlainObject(object)) {
      return `[${object.constructor?.name || 'Object'}]`
    }
    if (isConfigProvider(object)) {
      return '[ConfigProvider: resolved lazily by the framework, not evaluated]'
    }
    const projected: Record<string, unknown> = {}
    const set = (key: string, item: unknown) =>
      Object.defineProperty(projected, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(object))) {
      if (!descriptor.enumerable) {
        continue
      }
      if (!('value' in descriptor)) {
        set(key, '[Getter]')
        continue
      }
      if (isSensitiveKey(key, options.sensitiveWords)) {
        const masked = maskValue(descriptor.value)
        if (masked !== undefined) {
          set(key, masked)
        }
        continue
      }
      const item = projectValue(descriptor.value, options, depth + 1, ancestors)
      if (item !== undefined) {
        set(key, item)
      }
    }
    return projected
  } finally {
    ancestors.delete(object)
  }
}

/**
 * JSON-safe, redacted copy of `value`. Never invokes getters, `toJSON` or
 * lazy config resolvers; class instances other than built-in value types
 * become `[ClassName]`.
 */
export function project(value: unknown, options: ProjectionOptions): unknown {
  return projectValue(value, { maxDepth: 16, ...options }, 0, new Set()) ?? null
}

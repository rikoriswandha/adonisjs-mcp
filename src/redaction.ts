/*
|--------------------------------------------------------------------------
| Redaction
|--------------------------------------------------------------------------
|
| Baseline scrubbing applied to every error message and error detail the
| endpoint returns. It masks the current values of secret-looking
| environment variables and credential shapes (URL passwords, bearer and
| opaque access tokens). Tool-specific policies (config, logs, HTTP) build
| on it; key-name matching alone is not a guarantee that every secret is
| masked.
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

  text(input: string): string {
    let output = input
    for (const secret of this.#secrets) {
      if (output.includes(secret)) {
        output = output.split(secret).join(REDACTED)
      }
    }
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

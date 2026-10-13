/*
|--------------------------------------------------------------------------
| Resolved config
|--------------------------------------------------------------------------
|
| Reads `app.config` by own data properties only: key segments are
| validated, prototype keys are rejected, getters are never invoked and
| lazy config providers are not resolved. Every value goes through
| `project()`, so sensitive keys, secret environment values and URL
| credentials are masked and non-data objects are summarized.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import { ToolError } from '../errors.js'
import { isSensitiveKey, project, REDACTED, type Redactor } from '../redaction.js'

const SEGMENT = /^[A-Za-z0-9_$-]+$/
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_KEY_LENGTH = 300

export function parseConfigKey(key: string): string[] {
  const segments = key.split('.')
  if (
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    segments.some((segment) => !SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment))
  ) {
    throw new ToolError(
      'INPUT_INVALID',
      `Invalid config key '${key.slice(0, MAX_KEY_LENGTH)}': use dot-separated segments of letters, digits, '_', '$' or '-' (prototype keys are rejected)`
    )
  }
  return segments
}

function isData(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (Array.isArray(value)) {
    return true
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export class ConfigIntrospection {
  constructor(
    readonly app: ApplicationService,
    readonly redactor: Redactor
  ) {}

  /**
   * Redacted value at `key` (the whole config without a key). Throws
   * `NOT_FOUND` when the key does not exist.
   */
  read(key?: string): { key: string | null; value: unknown } {
    let current: unknown = this.app.config.all()
    if (key === undefined) {
      return { key: null, value: project(current, { redactor: this.redactor }) }
    }

    const segments = parseConfigKey(key)
    let sensitive = false
    for (const [index, segment] of segments.entries()) {
      const path = segments.slice(0, index + 1).join('.')
      if (!isData(current)) {
        throw new ToolError(
          'NOT_FOUND',
          `Config key '${path}' does not exist: '${segments.slice(0, index).join('.')}' is not a plain object`
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, segment)
      if (!descriptor || !descriptor.enumerable) {
        throw new ToolError('NOT_FOUND', `Config key '${path}' does not exist`)
      }
      if (!('value' in descriptor)) {
        throw new ToolError('NOT_FOUND', `Config key '${path}' is an accessor; it is not read`)
      }
      sensitive ||= isSensitiveKey(segment)
      current = descriptor.value
    }

    if (sensitive && current !== null && current !== undefined && typeof current !== 'boolean') {
      return { key, value: REDACTED }
    }
    return { key, value: project(current, { redactor: this.redactor }) }
  }
}

/*
|--------------------------------------------------------------------------
| Optional integration availability
|--------------------------------------------------------------------------
|
| Availability of tools backed by an optional package, derived from the
| project profile of the current MCP request: absent package →
| DEPENDENCY_UNAVAILABLE, installed but not wired into this process →
| CAPABILITY_UNSUPPORTED, inspection failure → INTEGRATION_FAILED.
|
*/

import { fileURLToPath } from 'node:url'
import { appTypeScript } from './typescript.js'
import type { AvailabilityContext, Availability, PackageKey } from '../types.js'

export async function packageAvailability(
  context: AvailabilityContext,
  key: PackageKey
): Promise<Availability> {
  const profile = await context.profile()
  const report = profile.packages[key]
  if (report.version === null) {
    return {
      available: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: `${report.name} is not installed in the application`,
    }
  }
  if (report.error) {
    return {
      available: false,
      code: 'INTEGRATION_FAILED',
      reason: `${report.name} is installed but could not be inspected: ${report.error}`,
    }
  }
  if (report.active === false) {
    return {
      available: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason: `${report.name} is installed but not active in this process (${report.signal ?? 'no runtime signal'} is not set)`,
    }
  }
  return { available: true }
}

export const NO_TYPESCRIPT =
  'The application has no typescript package, which is needed to read its source without executing it.'

/**
 * Requires the application's TypeScript compiler, used to read source
 * syntax trees.
 */
export async function typescriptAvailability(context: AvailabilityContext): Promise<Availability> {
  return (await appTypeScript(fileURLToPath(context.app.appRoot)))
    ? { available: true }
    : { available: false, code: 'DEPENDENCY_UNAVAILABLE', reason: NO_TYPESCRIPT }
}

/**
 * First unavailable result, or available.
 */
export async function allAvailable(
  ...checks: ReadonlyArray<() => Availability | Promise<Availability>>
): Promise<Availability> {
  for (const check of checks) {
    const result = await check()
    if (!result.available) {
      return result
    }
  }
  return { available: true }
}

/*
|--------------------------------------------------------------------------
| Loopback target
|--------------------------------------------------------------------------
|
| `http_request` only ever connects to the socket the application's own
| HTTP server listens on. Callers give a path, never a URL: schemes,
| protocol-relative paths, backslashes and fragments are rejected, and the
| MCP endpoint cannot be reached through any encoded or normalized alias of
| its path, directly or through a redirect. The `Host` header only selects
| a route domain of the application; it never changes where the request
| (and its credentials) go.
|
*/

import { ToolError } from '../errors.js'
import { normalizeHost } from '../define_config.js'
import { MCP_CALL_HEADER } from '../guards/network.js'

export interface LoopbackAddress {
  /**
   * Address the request connects to.
   */
  connect: string
  port: number

  /**
   * Default `Host` header: the connected address with the port.
   */
  host: string
}

interface NodeServerLike {
  address(): unknown
}

/**
 * Address the application listens on. Wildcard binds are reached through
 * the loopback address of the same family.
 */
export function loopbackAddress(
  nodeServer: NodeServerLike | undefined | null
): LoopbackAddress | { reason: string } {
  const address = nodeServer?.address()
  if (address === null || address === undefined) {
    return { reason: 'the application HTTP server is not listening' }
  }
  if (typeof address !== 'object' || !('port' in address) || !('address' in address)) {
    return {
      reason: 'the application HTTP server listens on a pipe or unix socket, not on a TCP port',
    }
  }
  const { port } = address as { port: number; address: string }
  let connect = (address as { address: string }).address
  if (connect === '0.0.0.0') {
    connect = '127.0.0.1'
  } else if (connect === '::') {
    connect = '::1'
  }
  const literal = connect.includes(':') ? `[${connect}]` : connect
  return { connect, port, host: `${literal}:${port}` }
}

export interface RequestPath {
  pathname: string
  search: string

  /**
   * Request target sent on the wire: normalized pathname plus query.
   */
  path: string
}

const BASE = new URL('http://loopback.invalid')
const FORBIDDEN_PATH_CHARACTERS = /[\\#\s]/

function hasControlCharacter(value: string, allowTab = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && !(allowTab && code === 0x09)) || code === 0x7f) {
      return true
    }
  }
  return false
}

/**
 * Decoded, dot-segment resolved, lower-cased pathname without empty
 * segments. Used to compare paths with the MCP endpoint path regardless of
 * the encoding a caller (or a redirect) chose.
 */
export function canonicalPath(pathname: string): string {
  let current = pathname
  for (let round = 0; round < 4; round++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      break
    }
    if (decoded === current) {
      break
    }
    current = decoded
  }
  const segments: string[] = []
  for (const segment of current.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return `/${segments.join('/')}`.toLowerCase()
}

/**
 * Whether `pathname` designates the MCP endpoint or a path below it.
 */
export function isMcpPath(pathname: string, mcpPath: string): boolean {
  const candidate = canonicalPath(pathname)
  const endpoint = canonicalPath(mcpPath)
  return candidate === endpoint || candidate.startsWith(`${endpoint}/`)
}

/**
 * Validates a caller supplied request path (with optional query string).
 */
export function parseRequestPath(input: string, mcpPath: string): RequestPath {
  if (!input.startsWith('/')) {
    throw new ToolError(
      'INPUT_INVALID',
      `path "${input}" must start with "/": http_request takes a path of the running application, never a URL`
    )
  }
  if (input.startsWith('//')) {
    throw new ToolError(
      'INPUT_INVALID',
      'path must not start with "//" (a protocol-relative URL designates another host)'
    )
  }
  if (FORBIDDEN_PATH_CHARACTERS.test(input) || hasControlCharacter(input)) {
    throw new ToolError(
      'INPUT_INVALID',
      'path must not contain backslashes, whitespace, control characters or a "#" fragment'
    )
  }
  let url: URL
  try {
    url = new URL(input, BASE)
  } catch {
    throw new ToolError('INPUT_INVALID', `path "${input}" is not a valid request path`)
  }
  if (url.origin !== BASE.origin) {
    throw new ToolError('INPUT_INVALID', `path "${input}" designates another host`)
  }
  if (isMcpPath(url.pathname, mcpPath)) {
    throw new ToolError(
      'INPUT_INVALID',
      `path "${input}" designates the MCP endpoint (${mcpPath}); http_request cannot call it`
    )
  }
  return { pathname: url.pathname, search: url.search, path: `${url.pathname}${url.search}` }
}

/**
 * Lower-cased host name without port for `domain`, or `undefined`.
 */
export function normalizeDomain(input: string): string | undefined {
  if (input.includes(':')) {
    return undefined
  }
  return normalizeHost(input)
}

export type RedirectTarget =
  { followable: true; path: RequestPath } | { followable: false; reason: string }

/**
 * Whether a `Location` can be followed: same scheme, host and port as the
 * request that produced it, and not the MCP endpoint. Anything else is
 * reported, never requested, so credentials never leave the application.
 */
export function redirectTarget(
  location: string,
  current: { host: string; path: string },
  mcpPath: string
): RedirectTarget {
  let url: URL
  try {
    url = new URL(location, `http://${current.host}${current.path}`)
  } catch {
    return { followable: false, reason: 'the Location header is not a valid URL' }
  }
  if (url.protocol !== 'http:' || url.host !== current.host) {
    return {
      followable: false,
      reason: `the redirect leaves the application origin (${url.protocol}//${url.host}); it is not followed and no credential is sent there`,
    }
  }
  if (url.username || url.password) {
    return { followable: false, reason: 'the redirect carries URL credentials' }
  }
  try {
    return {
      followable: true,
      path: parseRequestPath(`${url.pathname}${url.search}`, mcpPath),
    }
  } catch (error) {
    return {
      followable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Header names the tool sets itself, with the input that replaces them.
 */
const RESERVED: ReadonlyArray<[RegExp, string]> = [
  [/^host$/, 'use "domain" to select a route domain'],
  [/^(cookie|authorization|proxy-authorization)$/, 'use "as" to act as a user'],
  [/^x-inertia(-.*)?$/, 'Inertia headers follow the request surface; use "surface"'],
  [/^x-(csrf|xsrf)-token$/, 'CSRF tokens are minted by the tool; use "csrf"'],
  [/^x-request-id$/, 'the tool sets the request id to correlate logs and exceptions'],
  [new RegExp(`^${MCP_CALL_HEADER}$`), 'the tool marks its own requests'],
  [
    /^(content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|expect)$/,
    'the HTTP client manages framing headers',
  ],
  [/^(forwarded|x-forwarded-.*|x-real-ip|proxy-.*)$/, 'proxy headers would spoof the client'],
]

/**
 * Validates caller headers; names are returned lower-cased.
 * `extraReserved` holds names reserved by the active integrations, e.g. the
 * tenant header.
 */
export function validateHeaders(
  headers: Readonly<Record<string, string>>,
  extraReserved: ReadonlyMap<string, string> = new Map()
): Record<string, string> {
  const validated: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (!TOKEN.test(rawName)) {
      throw new ToolError('INPUT_INVALID', `"${rawName}" is not a valid header name`)
    }
    if (hasControlCharacter(value, true)) {
      throw new ToolError('INPUT_INVALID', `header "${rawName}" contains a control character`)
    }
    const reserved =
      RESERVED.find(([pattern]) => pattern.test(name))?.[1] ?? extraReserved.get(name)
    if (reserved) {
      throw new ToolError('INPUT_INVALID', `header "${rawName}" cannot be set: ${reserved}`)
    }
    if (Object.hasOwn(validated, name)) {
      throw new ToolError('INPUT_INVALID', `header "${rawName}" is given twice`)
    }
    validated[name] = value
  }
  return validated
}

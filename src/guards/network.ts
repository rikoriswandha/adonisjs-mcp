/*
|--------------------------------------------------------------------------
| Network guards
|--------------------------------------------------------------------------
|
| Checks run on every request to the MCP endpoint before the MCP SDK sees
| it. They do not depend on application auth or trusted-proxy settings:
|
| - Peer: the socket address, never `X-Forwarded-For`/`Forwarded`, must be
|   loopback unless `allowRemoteAccess` is set.
| - Host: exactly one header, a loopback name on the port the request
|   actually arrived on, or an exact `allowedHosts` entry. Blocks DNS
|   rebinding.
| - Origin: optional (native clients send none), otherwise an exact local
|   origin or an `allowedOrigins` entry; `null` is never accepted.
|
*/

import { isIP } from 'node:net'
import { normalizeHost, normalizeOrigin } from '../define_config.js'

/**
 * Marks requests sent by this package's own tools (e.g. `http_request`).
 * They must never reach the MCP endpoint again.
 */
export const MCP_CALL_HEADER = 'x-adonisjs-mcp-call'

export interface NetworkPolicy {
  allowRemoteAccess: boolean
  allowedHosts: readonly string[]
  allowedOrigins: readonly string[]
}

export interface RequestFacts {
  /**
   * `socket.remoteAddress` of the request.
   */
  remoteAddress: string | undefined

  /**
   * `socket.localPort`: the port the request actually arrived on.
   */
  localPort: number | undefined

  /**
   * Node `IncomingMessage.rawHeaders` (name/value pairs, duplicates kept).
   */
  rawHeaders: readonly string[]
}

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string }

const LOOPBACK_NAMES = new Set(['localhost'])
const HOST_SHAPE = /^(?:[^\s:[\]]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

/**
 * All values of header `name`, in arrival order.
 */
export function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === name) {
      values.push(rawHeaders[index + 1])
    }
  }
  return values
}

/**
 * Whether `address` is an IPv4 (127.0.0.0/8), IPv6 (`::1`) or
 * IPv4-mapped IPv6 loopback address.
 */
export function isLoopbackAddress(address: string): boolean {
  const unbracketed =
    address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const lowered = unbracketed.toLowerCase()
  const ipv4 = lowered.startsWith('::ffff:') ? lowered.slice('::ffff:'.length) : lowered
  if (isIP(ipv4) === 4) {
    return ipv4.split('.')[0] === '127'
  }
  return isIP(lowered) === 6 && /^(?:0{0,4}:){2,7}0{0,3}1$/.test(lowered)
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname) || isLoopbackAddress(hostname)
}

function effectivePort(url: URL): number {
  if (url.port) {
    return Number(url.port)
  }
  return url.protocol === 'https:' ? 443 : 80
}

export function checkPeer(remoteAddress: string | undefined, policy: NetworkPolicy): GuardVerdict {
  if (policy.allowRemoteAccess) {
    return { allowed: true }
  }
  if (remoteAddress && isLoopbackAddress(remoteAddress)) {
    return { allowed: true }
  }
  return {
    allowed: false,
    reason:
      'peer address is not loopback (set allowRemoteAccess only behind a trusted network boundary)',
  }
}

export function checkHost(
  values: readonly string[],
  localPort: number | undefined,
  policy: NetworkPolicy
): GuardVerdict {
  if (values.length !== 1) {
    return {
      allowed: false,
      reason: values.length === 0 ? 'Host header is missing' : 'Host header is repeated',
    }
  }
  const raw = values[0]
  const host = HOST_SHAPE.test(raw) ? normalizeHost(raw) : undefined
  if (host === undefined) {
    return { allowed: false, reason: 'Host header is malformed' }
  }
  if (policy.allowedHosts.includes(host)) {
    return { allowed: true }
  }
  const url = new URL(`http://${host}`)
  if (isLoopbackHostname(url.hostname) && effectivePort(url) === localPort) {
    return { allowed: true }
  }
  return { allowed: false, reason: `Host "${host}" is not allowed (add it to allowedHosts)` }
}

export function checkOrigin(
  values: readonly string[],
  localPort: number | undefined,
  policy: NetworkPolicy
): GuardVerdict {
  if (values.length === 0) {
    return { allowed: true }
  }
  if (values.length > 1) {
    return { allowed: false, reason: 'Origin header is repeated' }
  }
  const origin = normalizeOrigin(values[0])
  if (origin === undefined) {
    return { allowed: false, reason: 'Origin is null, opaque or malformed' }
  }
  if (policy.allowedOrigins.includes(origin)) {
    return { allowed: true }
  }
  const url = new URL(origin)
  if (
    url.protocol === 'http:' &&
    isLoopbackHostname(url.hostname) &&
    effectivePort(url) === localPort
  ) {
    return { allowed: true }
  }
  return { allowed: false, reason: `Origin "${origin}" is not allowed (add it to allowedOrigins)` }
}

/**
 * Runs the peer, Host, Origin and recursion checks in that order.
 */
export function checkRequest(facts: RequestFacts, policy: NetworkPolicy): GuardVerdict {
  const peer = checkPeer(facts.remoteAddress, policy)
  if (!peer.allowed) {
    return peer
  }
  const host = checkHost(headerValues(facts.rawHeaders, 'host'), facts.localPort, policy)
  if (!host.allowed) {
    return host
  }
  const origin = checkOrigin(headerValues(facts.rawHeaders, 'origin'), facts.localPort, policy)
  if (!origin.allowed) {
    return origin
  }
  if (headerValues(facts.rawHeaders, MCP_CALL_HEADER).length > 0) {
    return { allowed: false, reason: 'requests issued by MCP tools cannot call the MCP endpoint' }
  }
  return { allowed: true }
}

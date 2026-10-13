/*
|--------------------------------------------------------------------------
| Endpoint
|--------------------------------------------------------------------------
|
| The MCP endpoint is mounted as the first *server* middleware, not as a
| route. It answers requests whose path is exactly `config.path` before
| the router runs, so:
|
| - the network guards run before anything else touches the request;
| - the application's bodyparser, session, Shield (CSRF) and route
|   middleware never see MCP traffic, and need no exemptions;
| - the MCP SDK reads the body itself, enforcing `limits.maxRequestBytes`
|   and answering malformed JSON with a JSON-RPC parse error;
| - middleware rewriting `Accept` (API starter kit) cannot break the
|   legacy protocol era.
|
| Every other request continues down the application's stack unchanged.
|
*/

import type { ServerResponse } from 'node:http'
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import type { HttpContext } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { NextFn } from '@adonisjs/core/types/http'
import { checkRequest, type NetworkPolicy } from './guards/network.js'
import { createServer, type ServerRuntime } from './server.js'
import type { ResolvedMcpConfig } from './types.js'

/**
 * JSON-RPC "server error" code used by the SDK for transport-level
 * rejections.
 */
const SERVER_ERROR = -32000

export class McpEndpoint {
  readonly path: string
  readonly #policy: NetworkPolicy
  readonly #logger: Logger
  readonly #handler: McpHttpHandler
  readonly #bridge: NodeMcpRequestHandler
  readonly #inFlight = new Set<ServerResponse>()
  #runtime?: ServerRuntime
  #closing?: Promise<void>
  #detached = false
  #middleware?: () => Promise<{
    default: new () => { handle(ctx: HttpContext, next: NextFn): unknown }
  }>

  constructor(config: ResolvedMcpConfig, logger: Logger) {
    this.path = config.path
    this.#policy = config
    this.#logger = logger
    const maxRequestBodySize = config.limits.maxRequestBytes
    this.#handler = createMcpHandler(
      () => {
        if (!this.#runtime) {
          throw new Error('MCP endpoint is not active')
        }
        return createServer(this.#runtime)
      },
      {
        maxRequestBodySize,
        onerror: (error) => this.#logger.debug({ err: error }, 'MCP request rejected by the SDK'),
      }
    )
    this.#bridge = toNodeHandler(this.#handler, {
      maxRequestBodySize,
      onerror: (error) => this.#logger.error({ err: error }, 'MCP request failed'),
    })
  }

  get active(): boolean {
    return this.#runtime !== undefined && this.#closing === undefined
  }

  /**
   * Starts serving the finalized registry.
   */
  activate(runtime: ServerRuntime) {
    this.#runtime = runtime
  }

  /**
   * Stops intercepting the path, so requests reach the application's
   * own routes. Used when the path belongs to an application route.
   */
  detach() {
    this.#detached = true
  }

  /**
   * Stops serving: aborts in-flight modern exchanges through the SDK, then
   * destroys connections still open (legacy exchanges have no SDK abort),
   * so the HTTP server can close. Idempotent.
   */
  close(): Promise<void> {
    this.#closing ??= this.#handler.close().then(() => {
      for (const response of this.#inFlight) {
        response.destroy()
      }
    })
    return this.#closing
  }

  #reject(ctx: HttpContext, status: number, message: string) {
    ctx.response
      .status(status)
      .json({ jsonrpc: '2.0', error: { code: SERVER_ERROR, message }, id: null })
  }

  async handle(ctx: HttpContext) {
    const request = ctx.request.request
    const verdict = checkRequest(
      {
        remoteAddress: request.socket.remoteAddress,
        localPort: request.socket.localPort,
        rawHeaders: request.rawHeaders,
      },
      this.#policy
    )
    if (!verdict.allowed) {
      this.#logger.warn(
        { reason: verdict.reason, remoteAddress: request.socket.remoteAddress },
        'Rejected MCP request'
      )
      return this.#reject(ctx, 403, `Forbidden: ${verdict.reason}`)
    }
    if (request.method !== 'POST') {
      ctx.response.header('Allow', 'POST')
      return this.#reject(ctx, 405, 'Method not allowed.')
    }
    if (!this.active) {
      return this.#reject(ctx, 503, 'MCP endpoint is not ready')
    }
    const response = ctx.response.response
    ctx.response.relayHeaders()
    this.#inFlight.add(response)
    try {
      await this.#bridge(request, response)
    } finally {
      this.#inFlight.delete(response)
    }
  }

  /**
   * Lazy middleware reference for `server.use()`.
   */
  middleware() {
    if (this.#middleware) {
      return this.#middleware
    }
    const path = this.path
    const intercepts = (ctx: HttpContext) => !this.#detached && ctx.request.url() === path
    const handle = (ctx: HttpContext) => this.handle(ctx)
    class AdonisMcpEndpointMiddleware {
      handle(ctx: HttpContext, next: NextFn) {
        if (intercepts(ctx)) {
          return handle(ctx)
        }
        return next()
      }
    }
    this.#middleware = async function adonisMcpEndpoint() {
      return { default: AdonisMcpEndpointMiddleware }
    }
    return this.#middleware
  }

  /**
   * Whether `reference` is the middleware reference of this endpoint.
   */
  isOwnMiddleware(reference: unknown): boolean {
    return this.#middleware !== undefined && reference === this.#middleware
  }
}

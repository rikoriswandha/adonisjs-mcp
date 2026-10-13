import type { ApplicationService } from '@adonisjs/core/types'
import { resolveConfig } from '../src/define_config.js'
import type { ResolvedMcpConfig } from '../src/types.js'

/**
 * Registers the MCP integration for the `web` process in development.
 *
 * Applications load it through the app-local `#providers/mcp_dev_provider`
 * wrapper, which never imports this module outside development. The
 * `app.inDev` checks below are defense in depth for direct registration.
 */
export default class McpProvider {
  #config?: ResolvedMcpConfig

  constructor(protected app: ApplicationService) {}

  /**
   * Resolved config, or `undefined` outside development.
   */
  get config(): ResolvedMcpConfig | undefined {
    return this.#config
  }

  /**
   * Validates `config/mcp.ts` before any other provider boots, so an
   * invalid configuration fails the development server with an actionable
   * message instead of serving partially.
   */
  register() {
    if (!this.app.inDev) {
      return
    }
    this.#config = resolveConfig(this.app.config.get('mcp', undefined))
  }
}

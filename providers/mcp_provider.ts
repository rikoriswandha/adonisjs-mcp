import type { ApplicationService } from '@adonisjs/core/types'
import { resolveConfig } from '../src/define_config.js'
import { loadExtraTools } from '../src/define_tool.js'
import { McpEndpoint } from '../src/handler.js'
import { packageVersion } from '../src/package_info.js'
import { detectProfile } from '../src/profile.js'
import { Redactor } from '../src/redaction.js'
import { DefinitionRegistry } from '../src/registry.js'
import { profileResource } from '../src/resources/profile.js'
import { describeCapabilities, type ServerRuntime } from '../src/server.js'
import {
  getProjectProfileTool,
  type DescribeProject,
} from '../src/tools/app/get_project_profile.js'
import type { ResolvedMcpConfig } from '../src/types.js'

/**
 * Methods checked for an application route on the MCP path. The endpoint
 * would make such a route unreachable.
 */
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/**
 * Registers the MCP endpoint for the `web` process in development.
 *
 * Applications load it through the app-local `#providers/mcp_dev_provider`
 * wrapper, which never imports this module outside development. The
 * environment checks below are defense in depth for direct registration:
 * outside a development `web` process, or with `enabled: false`, nothing
 * is bound, mounted or listened to.
 *
 * - register: validate config, bind `mcp.registry`.
 * - boot: add builtin definitions. Other packages register from their own
 *   `boot()`, in any order.
 * - start: load `extraTools`, mount the endpoint before the HTTP server
 *   boots.
 * - ready: finalize the registry and start serving, or step aside when an
 *   application route owns the path; close in-flight MCP exchanges when
 *   the application terminates.
 */
export default class McpProvider {
  #config?: ResolvedMcpConfig
  #registry?: DefinitionRegistry
  #endpoint?: McpEndpoint
  #runtime?: ServerRuntime

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
    const config = resolveConfig(this.app.config.get('mcp', undefined))
    this.#config = config
    if (!config.enabled || this.app.getEnvironment() !== 'web') {
      return
    }

    const registry = new DefinitionRegistry()
    for (const name of config.tools.disabled) {
      registry.disable(name)
    }
    this.#registry = registry
    this.app.container.bindValue('mcp.registry', registry)
  }

  boot() {
    if (!this.#registry) {
      return
    }
    const describe: DescribeProject = async (context) => ({
      ...(await context.profile()),
      capabilities: await describeCapabilities(this.#runtime!, context),
    })
    this.#registry.tool(getProjectProfileTool(describe))
    this.#registry.resource(profileResource(describe))
  }

  async start() {
    const config = this.#config
    const registry = this.#registry
    if (!config || !registry) {
      return
    }
    for (const definition of await loadExtraTools(config.extraTools)) {
      registry.tool(definition)
    }

    const router = await this.app.container.make('router')
    if (router.commited) {
      throw new Error(
        'Cannot mount the MCP endpoint: the HTTP server booted before @rikology/adonisjs-mcp started'
      )
    }
    const logger = await this.app.container.make('logger')
    const server = await this.app.container.make('server')
    this.#endpoint = new McpEndpoint(config, logger)
    server.use([this.#endpoint.middleware()])
  }

  async ready() {
    const config = this.#config
    const registry = this.#registry
    const endpoint = this.#endpoint
    if (!config || !registry || !endpoint) {
      return
    }

    const snapshot = registry.finalize()
    const logger = await this.app.container.make('logger')
    const router = await this.app.container.make('router')
    const shadowed = ROUTE_METHODS.filter((method) => router.match(config.path, method, false))
    if (shadowed.length > 0) {
      endpoint.detach()
      logger.error(
        'MCP endpoint disabled: "%s" is also an application route (%s). Set a different "path" in config/mcp.ts.',
        config.path,
        shadowed.join(', ')
      )
      return
    }

    const app = this.app
    this.#runtime = {
      app,
      config,
      snapshot,
      redactor: Redactor.fromEnvironment(process.env),
      version: await packageVersion(),
      detectProfile: () => detectProfile(app, config),
    }
    endpoint.activate(this.#runtime)

    /**
     * Terminating hooks run in reverse order. Registered here, after the
     * HTTP server registered its own close hook, this one runs first, so
     * open MCP exchanges cannot hold the server close.
     */
    this.app.terminating(() => endpoint.close())

    const server = await this.app.container.make('server')
    const address = server.getNodeServer()?.address()
    if (address && typeof address === 'object') {
      logger.info('MCP endpoint ready at http://localhost:%d%s', address.port, config.path)
    } else {
      logger.info('MCP endpoint ready at %s', config.path)
    }
  }
}

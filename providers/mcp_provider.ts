import { fileURLToPath } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import { AceRunner } from '../src/ace/runner.js'
import { runAceCommandTool } from '../src/tools/app/run_ace_command.js'
import { ExceptionCapture } from '../src/buffers/exception_capture.js'
import { containerObserver, subscribeExceptions, subscribeLogs } from '../src/buffers/gateway.js'
import { LogCapture } from '../src/buffers/log_capture.js'
import { resolveConfig } from '../src/define_config.js'
import { loadExtraTools } from '../src/define_tool.js'
import { LucidAccess } from '../src/database/lucid.js'
import { ModelCatalog } from '../src/database/models.js'
import { RawSql } from '../src/database/raw_sql.js'
import { MigrationInspector, SchemaDiff } from '../src/database/schema.js'
import { McpEndpoint } from '../src/handler.js'
import { ProjectEvaluator } from '../src/eval/evaluator.js'
import { projectEvalTool } from '../src/tools/runtime/project_eval.js'
import { ConfigIntrospection } from '../src/introspection/config.js'
import { ContainerIntrospection } from '../src/introspection/container.js'
import { EnvIntrospection } from '../src/introspection/env.js'
import { EventIntrospection } from '../src/introspection/events.js'
import { InertiaIntrospection } from '../src/introspection/inertia.js'
import { RouteIntrospection } from '../src/introspection/routes.js'
import { TuyauIntrospection } from '../src/introspection/tuyau.js'
import { ValidatorIntrospection } from '../src/introspection/validators.js'
import { ViewIntrospection } from '../src/introspection/views.js'
import { packageVersion } from '../src/package_info.js'
import { detectProfile } from '../src/profile.js'
import { Redactor } from '../src/redaction.js'
import { DefinitionRegistry } from '../src/registry.js'
import { profileResource } from '../src/resources/profile.js'
import { PackageResource, packageResource } from '../src/resources/package.js'
import { debugRequestPrompt } from '../src/prompts/debug_request.js'
import { addFeaturePrompt } from '../src/prompts/add_feature.js'
import { describeCapabilities, type ServerRuntime } from '../src/server.js'
import { configResource, getConfigTool } from '../src/tools/app/get_config.js'
import { getContainerBindingsTool } from '../src/tools/app/get_container_bindings.js'
import { getEnvTool } from '../src/tools/app/get_env.js'
import { getEventsTool } from '../src/tools/app/get_events.js'
import {
  getInertiaPagesTool,
  getSharedPropsTool,
  getTransformersTool,
} from '../src/tools/app/get_inertia.js'
import { getMiddlewareTool } from '../src/tools/app/get_middleware.js'
import { getPermissionsTool } from '../src/tools/app/get_permissions.js'
import {
  getProjectProfileTool,
  type DescribeProject,
} from '../src/tools/app/get_project_profile.js'
import { getQueueJobsTool } from '../src/tools/app/get_queue_jobs.js'
import { getRoutesTool, routesResource } from '../src/tools/app/get_routes.js'
import { getTuyauSchemaTool } from '../src/tools/app/get_tuyau_schema.js'
import { getValidatorsTool } from '../src/tools/app/get_validators.js'
import { getViewsTool } from '../src/tools/edge/get_views.js'
import { renderViewTool } from '../src/tools/edge/render_view.js'
import { CaptureSource } from '../src/tools/runtime/capture_source.js'
import { diffSchemaTool } from '../src/tools/database/diff_schema.js'
import { executeSqlQueryTool } from '../src/tools/database/execute_sql_query.js'
import { getMigrationsTool } from '../src/tools/database/get_migrations.js'
import { getModelsTool, modelsResource } from '../src/tools/database/get_models.js'
import { ModelQuery, queryModelTool } from '../src/tools/database/query_model.js'
import { getLastExceptionsTool } from '../src/tools/runtime/get_last_exceptions.js'
import { getLogsTool } from '../src/tools/runtime/get_logs.js'
import { HttpRequestService, httpRequestTool } from '../src/tools/http/http_request.js'
import { TenantIntegration } from '../src/tenant.js'
import type { ResolvedMcpConfig } from '../src/types.js'
import { SourceLocation } from '../src/introspection/source_location.js'
import { PackageDocs } from '../src/docs/index.js'
import { getSourceLocationTool } from '../src/tools/runtime/get_source_location.js'
import { searchPackageDocsTool } from '../src/tools/runtime/search_package_docs.js'

/**
 * Methods checked for an application route on the MCP path. The endpoint
 * would make such a route unreachable.
 */
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/**
 * Log and exception buffers fed by the application's opt-in hooks.
 */
interface Capture {
  logs: LogCapture
  exceptions: ExceptionCapture
  unsubscribe: Array<() => void>
}

/**
 * Registers the MCP endpoint for the `web` process in development.
 *
 * Applications load it through the app-local `#providers/mcp_dev_provider`
 * wrapper, which never imports this module outside development. The
 * environment checks below are defense in depth for direct registration:
 * outside a development `web` process, or with `enabled: false`, nothing
 * is bound, mounted, buffered or listened to.
 *
 * - register: validate config, bind `mcp.registry`, subscribe the log and
 *   exception buffers to the capture hooks.
 * - boot: add builtin definitions. Other packages register from their own
 *   `boot()`, in any order.
 * - start: load `extraTools`, mount the endpoint before the HTTP server
 *   boots.
 * - ready: finalize the registry and start serving, or step aside when an
 *   application route owns the path; on termination, close in-flight MCP
 *   exchanges and release the buffers and observers.
 */
export default class McpProvider {
  #config?: ResolvedMcpConfig
  #registry?: DefinitionRegistry
  #endpoint?: McpEndpoint
  #runtime?: ServerRuntime
  #redactor?: Redactor
  #capture?: Capture

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
      this.#release()
      return
    }

    const registry = new DefinitionRegistry()
    for (const name of config.tools.disabled) {
      registry.disable(name)
    }
    this.#registry = registry
    this.#redactor = Redactor.fromEnvironment(process.env)
    this.app.container.bindValue('mcp.registry', registry)

    /**
     * Buffers are subscribed even when the hooks module is not loaded yet:
     * the gateway may load it later (e.g. from the exception handler, which
     * the HTTP server imports after providers registered). Tools report
     * capture as unavailable until the hooks are loaded.
     */
    const logs = new LogCapture({
      capacity: config.tools.logs.bufferSize,
      maxBytes: config.tools.logs.bufferBytes,
      redactor: this.#redactor,
    })
    const exceptions = new ExceptionCapture({
      capacity: config.tools.logs.exceptionBufferSize,
      maxBytes: config.tools.logs.exceptionBufferBytes,
      redactor: this.#redactor,
      appRoot: fileURLToPath(this.app.appRoot),
    })
    this.#capture = {
      logs,
      exceptions,
      unsubscribe: [subscribeLogs(logs.handleLine), subscribeExceptions(exceptions.handle)],
    }
  }

  boot() {
    const registry = this.#registry
    const config = this.#config
    const redactor = this.#redactor
    if (!registry || !config || !redactor) {
      return
    }
    const app = this.app
    const appRoot = fileURLToPath(app.appRoot)
    const describe: DescribeProject = async (context) => ({
      ...(await context.profile()),
      capabilities: await describeCapabilities(this.#runtime!, context),
    })
    const capture = new CaptureSource(config)
    const routes = new RouteIntrospection({
      app,
      config,
      redactor,
      isOwnMiddleware: (reference) => this.#endpoint?.isOwnMiddleware(reference) ?? false,
    })
    const settings = new ConfigIntrospection(app, redactor)

    registry.tool(getProjectProfileTool(describe))
    registry.tool(getLogsTool(capture))
    registry.tool(getLastExceptionsTool(capture))
    registry.tool(getRoutesTool(routes))
    registry.tool(getMiddlewareTool(routes))
    registry.tool(
      getContainerBindingsTool(new ContainerIntrospection(app, appRoot, containerObserver))
    )
    registry.tool(getEventsTool(new EventIntrospection(app)))
    registry.tool(getConfigTool(settings))
    registry.tool(getEnvTool(new EnvIntrospection(app, appRoot)))
    registry.resource(profileResource(describe))
    registry.resource(routesResource(routes))
    registry.resource(configResource(settings))

    const lucid = new LucidAccess(app)
    const models = new ModelCatalog(lucid)
    const migrations = new MigrationInspector(lucid)
    registry.tool(getModelsTool(models))
    registry.tool(queryModelTool(new ModelQuery(lucid, models)))
    registry.tool(executeSqlQueryTool(new RawSql(lucid, models), config))
    registry.tool(getMigrationsTool(migrations))
    registry.tool(diffSchemaTool(new SchemaDiff(lucid, models, migrations)))
    registry.resource(modelsResource(models))

    const inertia = new InertiaIntrospection(app, routes)
    registry.tool(
      httpRequestTool(new HttpRequestService({ app, redactor, catalog: models, inertia }))
    )

    const views = new ViewIntrospection(app, appRoot, redactor)
    registry.tool(getValidatorsTool(new ValidatorIntrospection(app, redactor)))
    registry.tool(getInertiaPagesTool(inertia))
    registry.tool(getSharedPropsTool(inertia))
    registry.tool(getTransformersTool(inertia))
    registry.tool(getTuyauSchemaTool(new TuyauIntrospection(app)))
    registry.tool(getViewsTool(views))
    registry.tool(renderViewTool(views, config))
    registry.tool(getPermissionsTool(redactor))
    registry.tool(getQueueJobsTool(redactor))

    // WP-28: trusted development evaluation.
    if (!config.tools.projectEval) registry.disable('project_eval')
    registry.tool(projectEvalTool(new ProjectEvaluator(app, redactor)))

    // WP-29: isolated Ace commands with a parent-independent watchdog.
    registry.tool(runAceCommandTool(new AceRunner(appRoot, redactor), config))

    // WP-30 / WP-31: application-root source resolution and offline docs.
    registry.tool(getSourceLocationTool(new SourceLocation(appRoot, redactor)))
    registry.tool(
      searchPackageDocsTool(new PackageDocs(appRoot, config.tools.docs.include, redactor))
    )

    // WP-32: package resource and workflow prompts.
    registry.resource(packageResource(new PackageResource(app, appRoot, redactor)))
    registry.prompt(debugRequestPrompt(describe, appRoot))
    registry.prompt(addFeaturePrompt(describe, appRoot))
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
    const redactor = this.#redactor
    if (!config || !registry || !endpoint || !redactor) {
      return
    }

    const snapshot = registry.finalize()
    const logger = await this.app.container.make('logger')
    const router = await this.app.container.make('router')
    const shadowed = ROUTE_METHODS.filter((method) => router.match(config.path, method, false))
    if (shadowed.length > 0) {
      endpoint.detach()
      this.#release()
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
      redactor,
      version: await packageVersion(),
      logs: this.#capture?.logs ?? null,
      exceptions: this.#capture?.exceptions ?? null,
      tenancy: TenantIntegration.detect(app),
      detectProfile: () => detectProfile(app, config),
    }
    endpoint.activate(this.#runtime)

    /**
     * Terminating hooks run in reverse order. Registered here, after the
     * HTTP server registered its own close hook, this one runs first, so
     * open MCP exchanges cannot hold the server close.
     */
    this.app.terminating(async () => {
      await endpoint.close()
      this.#release()
    })

    const server = await this.app.container.make('server')
    const address = server.getNodeServer()?.address()
    if (address && typeof address === 'object') {
      logger.info('MCP endpoint ready at http://localhost:%d%s', address.port, config.path)
    } else {
      logger.info('MCP endpoint ready at %s', config.path)
    }
  }

  /**
   * Detaches the buffers from the capture hooks, drops what they hold and
   * restores the container methods wrapped by the opt-in observer.
   * Idempotent.
   */
  #release() {
    const capture = this.#capture
    if (capture) {
      for (const unsubscribe of capture.unsubscribe) {
        unsubscribe()
      }
      capture.logs.clear()
      capture.exceptions.clear()
      this.#capture = undefined
    }
    containerObserver()?.stop()
  }
}

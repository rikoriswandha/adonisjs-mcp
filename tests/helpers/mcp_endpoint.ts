/*
|--------------------------------------------------------------------------
| MCP endpoint helpers
|--------------------------------------------------------------------------
|
| Installs the packed package into a fixture, rewrites its MCP config and
| extension providers, and sends raw HTTP requests whose headers the fetch
| API would normalize (Host, duplicates).
|
*/

import { request } from 'node:http'
import { connect } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixtureApp, RunningApp } from './fixture_app.js'
import { packedPackage } from './package_tarball.js'

export const DEFAULT_PATH = '/__adonis/mcp'

/**
 * Waits until the provider activated the endpoint. The HTTP server answers
 * before `ready()` ran, and the endpoint answers 503 until then.
 */
export async function waitForMcp(app: RunningApp) {
  await app.logs.waitFor((line) => line.text.includes('MCP endpoint ready'), 30_000)
}

const EXTENSIONS_START = '// fixture-extension-providers:start'
const EXTENSIONS_END = '// fixture-extension-providers:end'

/**
 * Installs the tarball (plus zod for app-owned tools) and runs configure.
 */
export async function installPackage(fixture: FixtureApp) {
  const tarball = await packedPackage()
  await fixture.npm(['install', '--save-dev', tarball, 'zod@^4.2.0'])
  const configured = await fixture.ace(['configure', '@rikology/adonisjs-mcp'], 'development')
  if (configured.exitCode !== 0) {
    throw new Error(`configure failed\n${configured.stdout}\n${configured.stderr}`)
  }
}

/**
 * Writes `config/mcp.ts` with the given object literal body.
 */
export async function writeMcpConfig(fixture: FixtureApp, body: string) {
  await writeFile(
    join(fixture.root, 'config', 'mcp.ts'),
    `import type { McpConfig } from '@rikology/adonisjs-mcp'

const mcpConfig = {
${body}
} satisfies McpConfig

export default mcpConfig
`
  )
}

async function editRcFile(fixture: FixtureApp, edit: (source: string) => string) {
  const file = join(fixture.root, 'adonisrc.ts')
  await writeFile(file, edit(await readFile(file, 'utf8')))
}

/**
 * Registers `#providers/<name>` entries right after the MCP provider, in
 * the given order. Replaces the previous list.
 */
export async function setExtensionProviders(fixture: FixtureApp, names: readonly string[]) {
  await editRcFile(fixture, (source) => {
    const entries = names.map((name) => `    () => import('#providers/${name}'),`).join('\n')
    const block = `${EXTENSIONS_START}\n${entries}\n    ${EXTENSIONS_END}`
    if (source.includes(EXTENSIONS_START)) {
      return source.replace(new RegExp(`${EXTENSIONS_START}[\\s\\S]*?${EXTENSIONS_END}`), block)
    }
    const anchor =
      /(file: \(\) => import\('#providers\/mcp_dev_provider'\),\s*environment: \[[^\]]*\],?\s*\}),?/
    if (!anchor.test(source)) {
      throw new Error('adonisrc.ts has no mcp_dev_provider entry')
    }
    return source.replace(anchor, `$1,\n    ${block}`)
  })
}

/**
 * Sets the environments of the `#providers/mcp_dev_provider` rc entry.
 */
export async function setMcpProviderEnvironments(fixture: FixtureApp, environments: string[]) {
  await editRcFile(fixture, (source) =>
    source.replace(
      /(file: \(\) => import\('#providers\/mcp_dev_provider'\),\s*environment: )\[[^\]]*\]/,
      `$1${JSON.stringify(environments).replaceAll('"', "'").replaceAll(',', ', ')}`
    )
  )
}

/**
 * Adds a preload printing `MCP_PROBE <environment> <hasBinding>` in every
 * process kind, to observe whether the registry was bound.
 */
export async function addRegistryProbe(fixture: FixtureApp) {
  await writeFile(
    join(fixture.root, 'start', 'mcp_probe.ts'),
    `import app from '@adonisjs/core/services/app'

console.log(\`MCP_PROBE \${app.getEnvironment()} \${app.container.hasBinding('mcp.registry')}\`)
`
  )
  await editRcFile(fixture, (source) =>
    source.replace(
      /preloads: \[/,
      `preloads: [\n    { file: () => import('#start/mcp_probe'), environment: ['web', 'console', 'test'] },`
    )
  )
}

/**
 * App-local dev gateway for the opt-in capture hooks, in the shape the
 * configure hook is planned to generate (WP-33): the package is imported
 * only in development.
 */
export const DEV_HOOKS_GATEWAY = `import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'

const hooks = app.inDev ? await import('@rikology/adonisjs-mcp/hooks') : undefined
hooks?.observeContainer()

export const streamWrite = hooks?.streamWrite ?? ((line: string) => line)
export const observeException =
  hooks?.observeException ?? ((_error: unknown, _ctx: HttpContext) => {})
`

/**
 * Wires the capture hooks into the API kit: the gateway, `hooks.streamWrite`
 * in the logger config, and one observer call in the exception handler.
 */
export async function instrumentCapture(fixture: FixtureApp) {
  await writeFile(join(fixture.root, 'start', 'mcp_dev_hooks.ts'), DEV_HOOKS_GATEWAY)

  const loggerFile = join(fixture.root, 'config', 'logger.ts')
  const logger = await readFile(loggerFile, 'utf8')
  const instrumentedLogger = logger
    .replace(/^/, "import { streamWrite } from '#start/mcp_dev_hooks'\n")
    .replace(/(level: env\.get\('LOG_LEVEL'\),)/, '$1\n\n      hooks: { streamWrite },')
  if (!instrumentedLogger.includes('hooks: { streamWrite }')) {
    throw new Error('config/logger.ts has no LOG_LEVEL level entry to anchor the hook')
  }
  await writeFile(loggerFile, instrumentedLogger)

  const handlerFile = join(fixture.root, 'app', 'exceptions', 'handler.ts')
  const handler = await readFile(handlerFile, 'utf8')
  const instrumentedHandler = handler
    .replace(/^/, "import { observeException } from '#start/mcp_dev_hooks'\n")
    .replace(
      /(async handle\(error: unknown, ctx: HttpContext\) \{\n)/,
      '$1    observeException(error, ctx)\n'
    )
  if (!instrumentedHandler.includes('observeException(error, ctx)')) {
    throw new Error('app/exceptions/handler.ts has no handle() method to instrument')
  }
  await writeFile(handlerFile, instrumentedHandler)
}

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * Sends a request with exactly the given headers (no implicit Host).
 */
export function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<RawResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>()
  const outgoing = request(url, {
    method: options.method ?? 'POST',
    headers: options.headers,
    setHost: false,
  })
  outgoing.on('error', reject)
  outgoing.on('response', (incoming) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => (body += chunk))
    incoming.on('end', () =>
      resolve({ status: incoming.statusCode!, headers: incoming.headers, body })
    )
  })
  outgoing.end(options.body)
  return promise
}

/**
 * Writes a raw HTTP/1.1 request on a socket and returns the status code.
 * Used for header shapes Node's HTTP client refuses to produce.
 */
export function rawSocketStatus(port: number, head: string, body: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const socket = connect(port, '127.0.0.1')
  let received = ''
  socket.setEncoding('utf8')
  socket.on('error', reject)
  socket.on('data', (chunk: string) => {
    received += chunk
    const status = /^HTTP\/1\.1 (\d{3})/.exec(received)
    if (status) {
      socket.destroy()
      resolve(Number(status[1]))
    }
  })
  socket.write(
    `${head}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  )
  return promise
}

/**
 * A complete legacy `initialize` request: the SDK answers it with 200, so
 * any other status comes from the endpoint guards.
 */
export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-client', version: '0.0.0' },
  },
})

export const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
}

function firstText(items: unknown): string {
  const first: unknown = Array.isArray(items) ? items[0] : undefined
  if (typeof first === 'object' && first !== null && 'text' in first) {
    if (typeof first.text === 'string') {
      return first.text
    }
  }
  throw new Error('MCP result has no text content')
}

/**
 * Parses the JSON text content of a tool result into the payload shape the
 * test expects; the test's assertions verify that shape.
 */
export function toolPayload<T>(result: { content?: unknown }): T {
  const parsed: unknown = JSON.parse(firstText(result.content))
  return parsed as T
}

/**
 * Parses the JSON text of a resource read, like `toolPayload`.
 */
export function resourcePayload<T>(result: { contents?: unknown }): T {
  const parsed: unknown = JSON.parse(firstText(result.contents))
  return parsed as T
}

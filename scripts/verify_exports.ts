/*
|--------------------------------------------------------------------------
| verify:exports
|--------------------------------------------------------------------------
|
| Packs the built package and installs the tarball into a throwaway
| TypeScript consumer outside the repository. Verifies that the tarball
| only ships build output, that every public export resolves for both the
| type checker (strict, NodeNext) and Node, and that inference and
| container augmentation work for consumers.
|
| Run with `npm run verify:exports` (builds first).
|
*/

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const consumerRoot = await mkdtemp(join(tmpdir(), 'adonisjs-mcp-consumer-'))

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

const REQUIRED_FILES = [
  'package.json',
  'build/index.js',
  'build/index.d.ts',
  'build/configure.js',
  'build/configure.d.ts',
  'build/src/types.js',
  'build/src/types.d.ts',
  'build/providers/mcp_provider.js',
  'build/providers/mcp_provider.d.ts',
  'build/stubs/main.js',
  'build/stubs/config/mcp.stub',
  'build/stubs/providers/mcp_dev_provider.stub',
]

const CONSUMER_SOURCE = `import {
  configure,
  defineConfig,
  defineTool,
  InvalidDefinitionError,
  InvalidMcpConfigError,
  stubsRoot,
  ToolError,
} from '@rikology/adonisjs-mcp'
import type { McpConfig, McpRegistry, ResolvedMcpConfig, ToolContext } from '@rikology/adonisjs-mcp'
import { configure as configureHook } from '@rikology/adonisjs-mcp/configure'
import type { AnyToolDefinition, ExtraToolLoader, ToolOutput } from '@rikology/adonisjs-mcp/types'
import McpProvider from '@rikology/adonisjs-mcp/providers/mcp_provider'
import type { ApplicationService } from '@adonisjs/core/types'
import { z } from 'zod'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<_T extends true>() {}

const tool = defineTool({
  name: 'consumer_tool',
  description: 'Consumer tool via the running AdonisJS app',
  inputSchema: z.object({ id: z.number(), tags: z.array(z.string()).default([]) }),
  annotations: { readOnlyHint: true },
  handler(input, context): ToolOutput {
    assertType<Equal<typeof input, { id: number; tags: string[] }>>()
    assertType<Equal<typeof context, ToolContext>>()
    return { data: input.id, evidence: ['runtime'] }
  },
})

const definitions: AnyToolDefinition[] = [tool]
const loader: ExtraToolLoader = async () => ({ default: definitions })

const config = {
  path: '/__adonis/mcp',
  tools: { projectEval: false, disabled: ['project_eval'], docs: { include: ['@adonisjs/*'] } },
  extraTools: [loader],
} satisfies McpConfig

const resolved: ResolvedMcpConfig = defineConfig(config)
const reusable: McpConfig = resolved

// @ts-expect-error unknown options are type errors
const typo: McpConfig = { tools: { sqll: {} } }

// @ts-expect-error eval can only be disabled with false
const evalOn: McpConfig = { tools: { projectEval: true } }

declare const app: ApplicationService
const registry: McpRegistry = await app.container.make('mcp.registry')
registry.tool(tool)

const provider = new McpProvider(app)
const providerConfig: ResolvedMcpConfig | undefined = provider.config
const hook: typeof configure = configureHook
const error = new ToolError('NOT_FOUND', 'missing', { details: { name: 'x' } })

void [resolved, reusable, typo, evalOn, providerConfig, hook, error, stubsRoot]
void [InvalidDefinitionError, InvalidMcpConfigError]
`

const RUNTIME_CHECK = `import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as root from '@rikology/adonisjs-mcp'
import * as configureModule from '@rikology/adonisjs-mcp/configure'
import * as types from '@rikology/adonisjs-mcp/types'
import McpProvider from '@rikology/adonisjs-mcp/providers/mcp_provider'

assert.deepEqual(Object.keys(root).sort(), [
  'InvalidDefinitionError',
  'InvalidMcpConfigError',
  'ToolError',
  'configure',
  'defineConfig',
  'defineTool',
  'stubsRoot',
])
assert.equal(configureModule.configure, root.configure)
assert.deepEqual(Object.keys(types), [])
assert.ok(existsSync(join(root.stubsRoot, 'config', 'mcp.stub')))
assert.ok(existsSync(join(root.stubsRoot, 'providers', 'mcp_dev_provider.stub')))
assert.equal(root.defineConfig({}).path, '/__adonis/mcp')
assert.throws(() => root.defineConfig({ path: 'x' }), root.InvalidMcpConfigError)

const configFor = (inDev, mcp) => ({ inDev, config: { get: () => mcp } })
const production = new McpProvider(configFor(false, { path: 'invalid' }))
production.register()
assert.equal(production.config, undefined)

const development = new McpProvider(configFor(true, { path: '/_mcp' }))
development.register()
assert.equal(development.config.path, '/_mcp')
assert.throws(() => new McpProvider(configFor(true, { path: 'x' })).register(), /config\\/mcp\\.ts/)
console.log('runtime exports ok')
`

let tarball: string | undefined
try {
  const [packed] = JSON.parse(
    run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', consumerRoot],
      projectRoot
    )
  ) as [{ filename: string; files: { path: string }[] }]
  tarball = join(consumerRoot, packed.filename)

  const shipped = packed.files.map((file) => file.path)
  const missing = REQUIRED_FILES.filter((file) => !shipped.includes(file))
  const unexpected = shipped.filter(
    (file) =>
      !(file.startsWith('build/') || ['package.json', 'README.md', 'LICENSE.md'].includes(file)) ||
      /^build\/(tests|bin|scripts)\//.test(file) ||
      (file.endsWith('.ts') && !file.endsWith('.d.ts'))
  )
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Tarball contents are wrong.\nMissing: ${missing.join(', ') || '-'}\nUnexpected: ${unexpected.join(', ') || '-'}`
    )
  }

  await writeFile(
    join(consumerRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@rikology/adonisjs-mcp': `file:${tarball}`,
          '@adonisjs/core': '^7.6.0',
          'zod': '^4.2.0',
        },
        devDependencies: {
          '@adonisjs/assembler': '^8.5.2',
          '@types/json-schema': '^7.0.15',
          '@types/node': '^24.19.2',
          '@types/picomatch': '^4.0.2',
          '@types/yargs-parser': '^21.0.3',
          '@vinejs/vine': '^4.4.0',
          'typescript': '~6.0.3',
        },
      },
      null,
      2
    )
  )
  await writeFile(
    join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUnusedLocals: false,
        skipLibCheck: false,
        noEmit: true,
        types: ['node'],
      },
      include: ['consumer.ts'],
    })
  )
  await writeFile(join(consumerRoot, 'consumer.ts'), CONSUMER_SOURCE)
  await writeFile(join(consumerRoot, 'runtime.mjs'), RUNTIME_CHECK)

  run('npm', ['install', '--no-audit', '--no-fund'], consumerRoot)
  if (existsSync(join(consumerRoot, 'node_modules', '@rikology', 'adonisjs-mcp', 'src'))) {
    throw new Error('Installed package contains source files')
  }
  run(join(consumerRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], consumerRoot)
  process.stdout.write(run(process.execPath, ['runtime.mjs'], consumerRoot))
  console.log(`verify:exports ok (${packed.files.length} files in ${packed.filename})`)
} finally {
  await rm(consumerRoot, { recursive: true, force: true })
}

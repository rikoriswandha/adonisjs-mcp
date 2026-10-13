/*
|--------------------------------------------------------------------------
| Package entrypoint
|--------------------------------------------------------------------------
|
| Applications reference this entrypoint with `import type` only: it is a
| development dependency and is absent in production.
|
*/

export { configure } from './configure.js'
export { stubsRoot } from './stubs/main.js'
export { defineConfig } from './src/define_config.js'
export { defineTool } from './src/define_tool.js'
export { ToolError, InvalidMcpConfigError, InvalidDefinitionError } from './src/errors.js'
export type * from './src/types.js'

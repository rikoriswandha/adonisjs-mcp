/*
|--------------------------------------------------------------------------
| Application TypeScript compiler
|--------------------------------------------------------------------------
|
| Source-derived metadata (container binding declarations, env schema)
| is parsed with the TypeScript compiler installed in the application,
| resolved from the application root. This package does not ship one.
| Only the syntax tree is used; nothing is type-checked or emitted.
|
*/

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TypeScript from 'typescript'

export type TypeScriptApi = typeof TypeScript

const loaded = new Map<string, Promise<TypeScriptApi | undefined>>()

async function load(appRoot: string): Promise<TypeScriptApi | undefined> {
  let resolved: string
  try {
    resolved = createRequire(join(appRoot, 'package.json')).resolve('typescript')
  } catch {
    return undefined
  }
  const module = (await import(pathToFileURL(resolved).href)) as {
    default?: TypeScriptApi
  } & Partial<TypeScriptApi>
  const api = module.default ?? (module as TypeScriptApi)
  return typeof api.createSourceFile === 'function' ? api : undefined
}

/**
 * The application's `typescript` package, or `undefined` when it is not
 * installed.
 */
export function appTypeScript(appRoot: string): Promise<TypeScriptApi | undefined> {
  let promise = loaded.get(appRoot)
  if (!promise) {
    promise = load(appRoot).catch(() => undefined)
    loaded.set(appRoot, promise)
  }
  return promise
}

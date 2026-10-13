/*
|--------------------------------------------------------------------------
| Application source files
|--------------------------------------------------------------------------
|
| Bounded, read-only access to application source used by framework
| introspection (validators, Inertia, transformers, Tuyau, Edge):
|
| - directory scans never leave their root: entries whose real path
|   escapes the root (symlinks) are skipped, and depth, file count and
|   file size are bounded;
| - application import specifiers (`#controllers/*`) resolve through the
|   `imports` field of the application package.json, like Node does;
| - syntax trees come from the application's own TypeScript compiler and
|   are only read, never type-checked or emitted.
|
*/

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import type * as TypeScript from 'typescript'
import type { TypeScriptApi } from './typescript.js'

/**
 * Largest source file read for introspection.
 */
export const MAX_SOURCE_BYTES = 1024 * 1024

const MAX_DEPTH = 12

export interface ScannedFile {
  /**
   * Real absolute path.
   */
  absolute: string

  /**
   * POSIX path relative to the scanned root.
   */
  relative: string
  size: number
  mtimeMs: number

  /**
   * The file was modified after this process started, so the running
   * process may still use the previous version.
   */
  changedSinceProcessStart: boolean
}

export interface ScanResult {
  root: string
  exists: boolean
  files: ScannedFile[]

  /**
   * More files matched than `maxFiles`; the list is cut.
   */
  truncated: boolean

  /**
   * Entries skipped because their real path leaves the root.
   */
  outsideRoot: number
}

export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether `target` is `root` or inside it.
 */
export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Lists files with one of `extensions` below `directory`, sorted by
 * relative path. Declaration files (`.d.ts`) are skipped unless
 * `declarations` is set.
 */
export async function scanDirectory(
  directory: string,
  options: { extensions: readonly string[]; maxFiles?: number; declarations?: boolean }
): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? 2000
  const extensions = new Set(options.extensions)
  const processStart = performance.timeOrigin
  let root: string
  try {
    root = await realpath(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { root: directory, exists: false, files: [], truncated: false, outsideRoot: 0 }
    }
    throw error
  }

  const files: ScannedFile[] = []
  let truncated = false
  let outsideRoot = 0
  const visited = new Set<string>()

  const walk = async (current: string, depth: number): Promise<void> => {
    if (visited.has(current) || depth > MAX_DEPTH) {
      return
    }
    visited.add(current)
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      if (truncated) {
        return
      }
      if (entry.name.startsWith('.')) {
        continue
      }
      let target = join(current, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          target = await realpath(target)
          const stats = await stat(target)
          isDirectory = stats.isDirectory()
          isFile = stats.isFile()
        } catch {
          continue
        }
        if (!isWithin(root, target)) {
          outsideRoot++
          continue
        }
      }
      if (isDirectory) {
        await walk(target, depth + 1)
        continue
      }
      if (!isFile || !extensions.has(extname(entry.name))) {
        continue
      }
      if (!options.declarations && /\.d\.[cm]?ts$/.test(entry.name)) {
        continue
      }
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const stats = await stat(target)
      files.push({
        absolute: target,
        relative: toPosix(relative(root, join(current, entry.name))),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        changedSinceProcessStart: stats.mtimeMs > processStart,
      })
    }
  }
  await walk(root, 0)
  files.sort((left, right) => (left.relative < right.relative ? -1 : 1))
  return { root, exists: true, files, truncated, outsideRoot }
}

/**
 * Reads a UTF-8 source file. Files above `MAX_SOURCE_BYTES` are refused
 * rather than parsed partially.
 */
export async function readSource(path: string): Promise<string> {
  const stats = await stat(path)
  if (stats.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `${path} is ${stats.size} bytes; files above ${MAX_SOURCE_BYTES} bytes are not read`
    )
  }
  return readFile(path, 'utf8')
}

function scriptKind(ts: TypeScriptApi, path: string): TypeScript.ScriptKind {
  switch (extname(path)) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

/**
 * Syntax tree of `text` with parent pointers set.
 */
export function parseSource(ts: TypeScriptApi, path: string, text: string): TypeScript.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path))
}

/**
 * 1-based line of the start of `node`.
 */
export function lineOf(source: TypeScript.SourceFile, node: TypeScript.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/**
 * Text of a string literal or no-substitution template, otherwise `null`.
 */
export function stringLiteral(ts: TypeScriptApi, node: TypeScript.Node | undefined): string | null {
  if (!node) {
    return null
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return stringLiteral(ts, node.expression)
  }
  return null
}

/**
 * Name of a property: identifier, string or numeric literal. Computed
 * names are `null`.
 */
export function propertyName(ts: TypeScriptApi, name: TypeScript.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

export interface ObjectKeys {
  keys: string[]

  /**
   * `complete`: an object literal whose keys are all static;
   * `partial`: an object literal with spreads or computed keys (the listed
   * keys exist, others may); `unknown`: not an object literal.
   */
  completeness: 'complete' | 'partial' | 'unknown'
}

/**
 * Static keys of an object literal expression.
 */
export function objectKeys(ts: TypeScriptApi, node: TypeScript.Node | undefined): ObjectKeys {
  let current = node
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  if (!current || !ts.isObjectLiteralExpression(current)) {
    return { keys: [], completeness: 'unknown' }
  }
  const keys: string[] = []
  let partial = false
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      partial = true
      continue
    }
    const name = property.name ? propertyName(ts, property.name) : null
    if (name === null) {
      partial = true
      continue
    }
    keys.push(name)
  }
  return { keys, completeness: partial ? 'partial' : 'complete' }
}

type ImportsField = Record<string, unknown>

/**
 * Candidate source files for a compiled `.js` path: the TypeScript
 * sources the development loader maps it to, then the path itself.
 */
function sourceCandidates(path: string): string[] {
  const extension = extname(path)
  const base = path.slice(0, path.length - extension.length)
  if (extension === '.js') {
    return [`${base}.ts`, `${base}.tsx`, path]
  }
  if (extension === '') {
    return [
      `${path}.ts`,
      `${path}.tsx`,
      `${path}.js`,
      join(path, 'index.ts'),
      join(path, 'index.js'),
    ]
  }
  return [path]
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      const stats = await stat(path)
      if (stats.isFile()) {
        return await realpath(path)
      }
    } catch {}
  }
  return null
}

/**
 * Source file an application import specifier (`#controllers/users`) or
 * relative path points to, resolved with the `imports` field of the
 * application package.json. `null` when it does not resolve to a file
 * inside the application root.
 */
export async function resolveAppSpecifier(
  appRoot: string,
  specifier: string,
  from?: string
): Promise<string | null> {
  let target: string | null = null
  if (specifier.startsWith('#')) {
    let imports: ImportsField
    try {
      const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
        imports?: ImportsField
      }
      imports = manifest.imports ?? {}
    } catch {
      return null
    }
    for (const [pattern, mapping] of Object.entries(imports)) {
      const value =
        typeof mapping === 'string'
          ? mapping
          : typeof mapping === 'object' && mapping !== null
            ? (mapping as Record<string, unknown>).default
            : undefined
      if (typeof value !== 'string') {
        continue
      }
      if (pattern === specifier) {
        target = value
        break
      }
      const star = pattern.indexOf('*')
      if (star === -1) {
        continue
      }
      const prefix = pattern.slice(0, star)
      const suffix = pattern.slice(star + 1)
      if (
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix) &&
        specifier.length >= prefix.length + suffix.length
      ) {
        const captured = specifier.slice(prefix.length, specifier.length - suffix.length)
        target = value.split('*').join(captured)
        break
      }
    }
    if (target === null) {
      return null
    }
    target = join(appRoot, target)
  } else if (specifier.startsWith('.') && from) {
    target = join(from, '..', specifier)
  } else {
    return null
  }
  const resolved = await firstExisting(sourceCandidates(target))
  if (!resolved) {
    return null
  }
  const root = await realpath(appRoot)
  return isWithin(root, resolved) ? resolved : null
}

/**
 * POSIX path of `absolute` relative to the application root.
 */
export function appRelative(appRoot: string, absolute: string): string {
  return toPosix(relative(appRoot, absolute))
}

/*
|--------------------------------------------------------------------------
| Source location
|--------------------------------------------------------------------------
|
| `get_source_location` backend. Resolves application imports (`#alias`),
| application paths, installed packages (from the application root, never
| from this package) and legacy `App/...` namespaces to files, without
| executing any of them. Lines come only from a parsed declaration.
|
*/

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type * as TypeScript from 'typescript'
import { ToolError } from '../errors.js'
import { type Redactor } from '../redaction.js'
import { appRelative, errorMessage, isWithin, parseSource, readSource } from './source_files.js'
import { resolveExports, resolveMapping } from './package_maps.js'
import { appTypeScript } from './typescript.js'

/**
 * Sources read from one source map.
 */
const MAX_MAPPED_SOURCES = 200

/**
 * `config/database`, `providers/app_provider`: a path whose first segment
 * is a directory of the application. Takes precedence over an unscoped
 * package of the same name.
 */
async function isAppDirectoryPath(root: string, reference: string): Promise<boolean> {
  const [first, ...rest] = reference.split('/')
  if (rest.length === 0 || first.startsWith('@') || first === '' || first === 'node_modules') {
    return false
  }
  try {
    const stats = await stat(join(root, first))
    return stats.isDirectory()
  } catch {
    return false
  }
}

export interface PackageManifest {
  name?: string
  version?: string
  exports?: unknown
  imports?: Record<string, unknown>
  main?: string
  types?: string
  typings?: string
}

export async function findPackage(appRoot: string, name: string) {
  let directory = appRoot
  for (;;) {
    const linkedRoot = join(directory, 'node_modules', name)
    try {
      const root = await realpath(linkedRoot)
      if (!isWithin(root, await realpath(join(root, 'package.json'))))
        throw new ToolError('INPUT_INVALID', 'Package manifest escapes its package root')
      const manifest = JSON.parse(
        await readFile(join(root, 'package.json'), 'utf8')
      ) as PackageManifest
      return { root, linkedRoot, manifest }
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

interface SourceFileInfo {
  absolute: string
  appRelative: string | null
  exists: boolean
}

async function fileInfo(path: string, boundary: string, appRoot: string): Promise<SourceFileInfo> {
  if (!isWithin(boundary, path))
    throw new ToolError('INPUT_INVALID', 'Resolved path escapes its root')
  try {
    const absolute = await realpath(path)
    if (!isWithin(boundary, absolute))
      throw new ToolError('INPUT_INVALID', 'Source symlink escapes its root')
    const metadata = await stat(absolute)
    return {
      absolute,
      appRelative: isWithin(appRoot, absolute) ? appRelative(appRoot, absolute) : null,
      exists: metadata.isFile(),
    }
  } catch (error) {
    if (error instanceof ToolError) throw error
    return {
      absolute: path,
      appRelative: isWithin(appRoot, path) ? appRelative(appRoot, path) : null,
      exists: false,
    }
  }
}

export class SourceLocation {
  constructor(
    private appRoot: string,
    private redactor: Redactor
  ) {}

  async resolve(reference: string, symbol?: string) {
    const root = await realpath(this.appRoot)
    let kind: 'app-import' | 'app-path' | 'package' | 'legacy-namespace'
    let target: string
    let boundary = root
    let packageInfo:
      { name: string; version: string | null; root: string; linkedRoot: string } | undefined
    let types: SourceFileInfo | undefined
    let source: (SourceFileInfo & { via: string }) | undefined
    let via = 'direct'
    if (reference.startsWith('#')) {
      kind = 'app-import'
      const manifest = JSON.parse(
        await readFile(join(root, 'package.json'), 'utf8')
      ) as PackageManifest
      const mapped = resolveMapping(manifest.imports ?? {}, reference)
      if (!mapped || !mapped.startsWith('./'))
        throw new ToolError('NOT_FOUND', 'Application import has no local mapping')
      target = resolve(root, mapped)
      via = 'imports'
    } else if (reference.startsWith('App/')) {
      kind = 'legacy-namespace'
      target =
        join(
          root,
          'app',
          ...reference
            .slice(4)
            .split('/')
            .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
        ) + '.ts'
      via = 'legacy-namespace'
      const legacyFile = await fileInfo(target, root, root)
      if (!legacyFile.exists)
        throw new ToolError(
          'NOT_FOUND',
          'Legacy namespace file not found; use #models/... or another application import'
        )
    } else if (
      reference.startsWith('.') ||
      isAbsolute(reference) ||
      /\.(?:[cm]?[jt]sx?)$/.test(reference) ||
      (await isAppDirectoryPath(root, reference))
    ) {
      kind = 'app-path'
      target = resolve(root, reference)
    } else {
      kind = 'package'
      const parts = reference.split('/')
      const name = reference.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || parts.includes('..'))
        throw new ToolError('INPUT_INVALID', 'Invalid package reference')
      const pkg = await findPackage(root, name)
      if (!pkg) throw new ToolError('NOT_FOUND', 'Package is not installed in the application')
      boundary = pkg.root
      packageInfo = {
        name,
        version: pkg.manifest.version ?? null,
        root: pkg.root,
        linkedRoot: pkg.linkedRoot,
      }
      const rest = parts.slice(name.startsWith('@') ? 2 : 1).join('/')
      const subpath = rest ? `./${rest}` : '.'
      const mapped =
        pkg.manifest.exports === undefined
          ? rest || pkg.manifest.main || 'index.js'
          : resolveExports(pkg.manifest.exports, subpath)
      if (!mapped)
        throw new ToolError('NOT_FOUND', 'Package subpath is not exported', {
          details: {
            exportedSubpaths: Object.keys((pkg.manifest.exports ?? {}) as object)
              .filter((key) => key.startsWith('.'))
              .slice(0, 50),
          },
        })
      target = resolve(boundary, mapped)
      via = pkg.manifest.exports === undefined ? 'main' : 'exports'
      const typeTarget =
        pkg.manifest.exports === undefined
          ? (pkg.manifest.types ?? pkg.manifest.typings)
          : resolveExports(pkg.manifest.exports, subpath, ['types', 'node', 'import', 'default'])
      if (typeTarget) {
        const declarationTarget = typeTarget.replace(/\.(mjs|cjs|js)$/, (_, extension: string) =>
          extension === 'mjs' ? '.d.mts' : extension === 'cjs' ? '.d.cts' : '.d.ts'
        )
        if (/\.d\.[cm]?ts$/.test(declarationTarget)) {
          const declaration = await fileInfo(resolve(boundary, declarationTarget), boundary, root)
          if (declaration.exists) types = declaration
        }
      }
    }
    const mappingTarget = target
    let file = await fileInfo(target, boundary, root)
    if (!file.exists && kind !== 'package' && target.endsWith('.js')) {
      target = target.slice(0, -3) + '.ts'
      file = await fileInfo(target, boundary, root)
      if (file.exists) via = 'ts-exec'
    }
    if (!file.exists && kind === 'app-path' && extname(target) === '') {
      for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']) {
        const candidate = await fileInfo(target + suffix, boundary, root)
        if (candidate.exists) {
          target += suffix
          file = candidate
          via = 'extension'
          break
        }
      }
    }
    /**
     * Existing package-local sources listed by the source map next to the
     * runtime file. Only a single source proves which file the module came
     * from; a bundle of several is reported as candidates.
     */
    const mappedSources: SourceFileInfo[] = []
    if (kind === 'package' && file.exists) {
      try {
        const mapPath = await realpath(file.absolute + '.map')
        if (!isWithin(boundary, mapPath)) throw new Error('Source map escapes package root')
        const map = JSON.parse(await readSource(mapPath)) as {
          sourceRoot?: string
          sources?: string[]
        }
        for (const entry of (map.sources ?? []).slice(0, MAX_MAPPED_SOURCES)) {
          const candidate = resolve(dirname(file.absolute), map.sourceRoot ?? '', entry)
          if (!isWithin(boundary, candidate)) continue
          const mapped = await fileInfo(candidate, boundary, root)
          if (mapped.exists) {
            mappedSources.push(mapped)
          }
        }
      } catch {}
      if (mappedSources.length === 1) {
        source = { ...mappedSources[0], via: 'source-map' }
      }
    }
    let line: number | null = null
    let column: number | null = null
    let symbolFile: string | null = null
    const limitations: string[] = []
    if (symbol) {
      const ts = await appTypeScript(root)
      if (!ts)
        limitations.push('Application TypeScript compiler is unavailable; symbol line is unknown')
      else if (file.exists) {
        const names = symbol.split('.')
        // Mapped sources first (where the declaration was written), then the
        // runtime file itself.
        for (const candidate of [...mappedSources.map((entry) => entry.absolute), file.absolute]) {
          let text: string
          try {
            text = await readSource(candidate)
          } catch (error) {
            limitations.push(`Skipped ${candidate}: ${errorMessage(error)}`)
            continue
          }
          const sourceFile = parseSource(ts, candidate, text)
          const visit = (node: TypeScript.Node) => {
            if (line !== null) return
            const named = node as TypeScript.Node & { name?: TypeScript.Node }
            const name = named.name?.getText(sourceFile)
            if (
              (name === names.at(-1) &&
                (ts.isClassDeclaration(node) ||
                  ts.isFunctionDeclaration(node) ||
                  ts.isMethodDeclaration(node) ||
                  ts.isInterfaceDeclaration(node) ||
                  ts.isTypeAliasDeclaration(node) ||
                  ts.isVariableDeclaration(node) ||
                  ts.isEnumDeclaration(node) ||
                  ts.isPropertyDeclaration(node))) ||
              (symbol === 'default' &&
                ts.isClassDeclaration(node) &&
                node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
            ) {
              const parent = node.parent as TypeScript.Node & { name?: TypeScript.Node }
              if (names.length === 1 || parent.name?.getText(sourceFile) === names[0]) {
                // The name, not the node start: decorators and modifiers can
                // sit on earlier lines.
                const position = sourceFile.getLineAndCharacterOfPosition(
                  (named.name ?? node).getStart(sourceFile)
                )
                line = position.line + 1
                column = position.character + 1
              }
            }
            ts.forEachChild(node, visit)
          }
          visit(sourceFile)
          if (line !== null) {
            symbolFile = candidate
            break
          }
        }
        if (line === null) limitations.push('Symbol declaration was not found; line is unknown')
      }
    }
    if (mappedSources.length > 1) {
      limitations.push(
        'The source map lists several existing sources (bundle); none is reported as the module source. See sourceCandidates.'
      )
    }
    return {
      data: this.redactor.value({
        reference,
        kind,
        file,
        mappingTarget,
        exists: file.exists,
        line,
        column,
        symbolFile,
        via,
        package: packageInfo,
        types,
        source,
        ...(mappedSources.length > 1
          ? { sourceCandidates: mappedSources.map((entry) => entry.absolute) }
          : {}),
      }),
      evidence: ['source' as const],
      limitations,
    }
  }
}

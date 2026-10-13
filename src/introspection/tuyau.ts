/*
|--------------------------------------------------------------------------
| Generated Tuyau registry inspection
|--------------------------------------------------------------------------
|
| Reads syntax trees only. Runtime `types` placeholders are never imported;
| declaration text is not evaluated or claimed to be a resolved TS shape.
|
*/

import { realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import type * as TypeScript from 'typescript'
import { ToolError } from '../errors.js'
import type { ToolOutput } from '../types.js'
import { appTypeScript, type TypeScriptApi } from './typescript.js'
import {
  appRelative,
  isWithin,
  lineOf,
  objectKeys,
  parseSource,
  propertyName,
  readSource,
  stringLiteral,
  type ObjectKeys,
} from './source_files.js'

const TYPE_TEXT_LIMIT = 4096
const PROCESS_START = Date.now() - process.uptime() * 1000

type Completeness = 'complete' | 'partial' | 'unknown'
interface GeneratedRoute {
  name: string
  methods: string[] | null
  pattern: string | null
  tokens: unknown
  evidence: 'generated'
  completeness: Completeness
  types?: {
    evidence: 'generated'
    typeOnly: true
    shapes: Record<string, string>
    truncated: boolean
  } | null
}

function unwrap(ts: TypeScriptApi, node: TypeScript.Expression): TypeScript.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression
  }
  return node
}

function literal(ts: TypeScriptApi, node: TypeScript.Expression): unknown {
  const value = unwrap(ts, node)
  const text = stringLiteral(ts, value)
  if (text !== null) {
    return text
  }
  if (ts.isNumericLiteral(value)) {
    return Number(value.text)
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return true
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return false
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return null
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((entry) => literal(ts, entry))
  }
  if (ts.isObjectLiteralExpression(value)) {
    const entries: Array<[string, unknown]> = []
    for (const entry of value.properties) {
      if (!ts.isPropertyAssignment(entry)) {
        return null
      }
      const name = propertyName(ts, entry.name)
      if (name === null) {
        return null
      }
      entries.push([name, literal(ts, entry.initializer)])
    }
    return Object.fromEntries(entries)
  }
  return null
}

function registryRoutes(ts: TypeScriptApi, source: TypeScript.SourceFile) {
  const routes: GeneratedRoute[] = []
  let completeness: Completeness = 'unknown'
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== 'routes' ||
        !declaration.initializer
      ) {
        continue
      }
      const object = unwrap(ts, declaration.initializer)
      if (!ts.isObjectLiteralExpression(object)) {
        continue
      }
      completeness = objectKeys(ts, object).completeness
      for (const entry of object.properties) {
        if (!ts.isPropertyAssignment(entry)) {
          completeness = 'partial'
          continue
        }
        const name = propertyName(ts, entry.name)
        const value = unwrap(ts, entry.initializer)
        if (name === null || !ts.isObjectLiteralExpression(value)) {
          completeness = 'partial'
          continue
        }
        const fields = new Map(
          value.properties.flatMap((field) =>
            ts.isPropertyAssignment(field)
              ? [[propertyName(ts, field.name), field.initializer] as const]
              : []
          )
        )
        const methodsNode = fields.get('methods')
        const methods = methodsNode ? literal(ts, methodsNode) : null
        const pattern = stringLiteral(ts, fields.get('pattern'))
        const knownMethods =
          Array.isArray(methods) && methods.every((method) => typeof method === 'string')
            ? (methods as string[])
            : null
        const entryCompleteness = knownMethods && pattern !== null ? 'complete' : 'partial'
        if (entryCompleteness !== 'complete') {
          completeness = 'partial'
        }
        routes.push({
          name,
          methods: knownMethods,
          pattern,
          tokens: fields.has('tokens') ? literal(ts, fields.get('tokens')!) : null,
          evidence: 'generated',
          completeness: entryCompleteness,
        })
      }
    }
  }
  return { routes, completeness }
}

function registryTypes(ts: TypeScriptApi, source: TypeScript.SourceFile) {
  const types = new Map<string, NonNullable<GeneratedRoute['types']>>()
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'Registry') {
      continue
    }
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeLiteralNode(member.type)) {
        continue
      }
      const name = propertyName(ts, member.name)
      if (name === null) {
        continue
      }
      const shapes: Record<string, string> = {}
      let remaining = TYPE_TEXT_LIMIT
      let truncated = false
      for (const field of member.type.members) {
        if (
          !ts.isPropertySignature(field) ||
          propertyName(ts, field.name) !== 'types' ||
          !field.type ||
          !ts.isTypeLiteralNode(field.type)
        ) {
          continue
        }
        for (const shape of field.type.members) {
          if (!ts.isPropertySignature(shape) || !shape.type) {
            continue
          }
          const shapeName = propertyName(ts, shape.name)
          if (shapeName === null) {
            continue
          }
          const text = shape.type.getText(source)
          shapes[shapeName] = text.slice(0, remaining)
          truncated ||= text.length > remaining
          remaining = Math.max(0, remaining - text.length)
        }
      }
      types.set(name, { evidence: 'generated', typeOnly: true, shapes, truncated })
    }
  }
  return types
}

function generatorHook(ts: TypeScriptApi, source: TypeScript.SourceFile) {
  const aliases = new Set<string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      stringLiteral(ts, statement.moduleSpecifier) !== '@tuyau/core/hooks'
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'generateRegistry') {
        aliases.add(element.name.text)
      }
    }
  }
  const calls: Array<{ options: ObjectKeys; location: { file: string; line: number } }> = []
  let hooksSeen = false
  const visit = (node: TypeScript.Node, inHooks: boolean) => {
    const hooks =
      inHooks || (ts.isPropertyAssignment(node) && propertyName(ts, node.name) === 'hooks')
    hooksSeen ||= hooks
    if (
      hooks &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      aliases.has(node.expression.text)
    ) {
      calls.push({
        options: node.arguments.length
          ? objectKeys(ts, node.arguments[0])
          : { keys: [], completeness: 'complete' },
        location: { file: 'adonisrc.ts', line: lineOf(source, node) },
      })
    }
    ts.forEachChild(node, (child) => visit(child, hooks))
  }
  visit(source, false)
  return {
    declared: calls.length > 0,
    evidence: 'source' as const,
    completeness: hooksSeen ? ('complete' as const) : ('unknown' as const),
    calls,
  }
}

export class TuyauIntrospection {
  constructor(readonly app: ApplicationService) {}

  async describe(input: { name?: string; includeTypes?: boolean }): Promise<ToolOutput> {
    const root = await realpath(fileURLToPath(this.app.appRoot))
    const ts = await appTypeScript(root)
    if (!ts) {
      throw new ToolError('DEPENDENCY_UNAVAILABLE', 'Application TypeScript is unavailable')
    }
    const limitations = [
      'Generated declaration shapes are type-only source text, not resolved types; runtime types are placeholders.',
      'Type-shape freshness is not verified: it requires source/dependency generation tracking, not route matching or mtimes.',
    ]
    const rcPath = this.app.makePath('adonisrc.ts')
    const rcInfo = await stat(rcPath)
    const hook = {
      ...generatorHook(ts, parseSource(ts, rcPath, await readSource(rcPath))),
      changedSinceProcessStart: rcInfo.mtimeMs > PROCESS_START,
    }
    if (hook.changedSinceProcessStart) {
      limitations.push(
        'adonisrc.ts changed since process start; the running process may still use its previous version.'
      )
    }
    const artifacts = []
    const sources = new Map<string, TypeScript.SourceFile>()
    for (const name of ['index.ts', 'schema.d.ts', 'tree.d.ts']) {
      const path = this.app.generatedClientPath('registry', name)
      try {
        const resolved = await realpath(path)
        if (!isWithin(root, resolved)) {
          throw new ToolError(
            'CAPABILITY_UNSUPPORTED',
            'Generated registry artifact escapes application root'
          )
        }
        const info = await stat(resolved)
        const changedSinceProcessStart = info.mtimeMs > PROCESS_START
        artifacts.push({
          file: appRelative(root, resolved),
          exists: true,
          size: info.size,
          mtime: info.mtime.toISOString(),
          changedSinceProcessStart,
          evidence: 'generated' as const,
        })
        if (changedSinceProcessStart) {
          limitations.push(
            `${appRelative(root, resolved)} changed since process start; the running process may still use its previous version.`
          )
        }
        if (name !== 'tree.d.ts') {
          sources.set(name, parseSource(ts, path, await readSource(resolved)))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
        artifacts.push({
          file: appRelative(root, path),
          exists: false,
          size: null,
          mtime: null,
          changedSinceProcessStart: false,
          evidence: 'generated' as const,
        })
      }
    }
    const index = sources.get('index.ts')
    const parsed = index
      ? registryRoutes(ts, index)
      : { routes: [], completeness: 'unknown' as const }
    if (input.includeTypes !== false) {
      const schema = sources.get('schema.d.ts')
      const types = schema ? registryTypes(ts, schema) : new Map()
      for (const route of parsed.routes) {
        route.types = types.get(route.name) ?? null
      }
    }
    const router = await this.app.container.make('router')
    const runtimeRoutes = Object.entries(router.toJSON()).flatMap(([domain, entries]) =>
      entries
        .filter((route) => route.name)
        .map((route) => ({
          name: route.name!,
          methods: route.methods,
          pattern: route.pattern,
          domain,
          evidence: 'runtime' as const,
        }))
    )
    const names = new Set(parsed.routes.map((route) => route.name))
    const runtimeNames = new Set(runtimeRoutes.map((route) => route.name))
    const missingFromRegistry = runtimeRoutes.filter((route) => !names.has(route.name))
    const notInRuntime = parsed.routes
      .filter((route) => !runtimeNames.has(route.name))
      .map((route) => route.name)
    const changed = runtimeRoutes.flatMap((route) => {
      const generated = parsed.routes.find((entry) => entry.name === route.name)
      return generated &&
        (generated.pattern !== route.pattern ||
          JSON.stringify(generated.methods?.toSorted()) !==
            JSON.stringify(route.methods.toSorted()))
        ? [{ name: route.name, runtime: route, generated }]
        : []
    })
    const filtered = hook.calls.some(
      (call) => call.options.completeness !== 'complete' || call.options.keys.length > 0
    )
    if (filtered) {
      limitations.push(
        'Generator options may filter routes; unmatched routes cannot be classified as excluded or outdated without executing the generator filters.'
      )
    }
    const missing = !hook.declared || !index
    const status = missing
      ? 'missing'
      : missingFromRegistry.length ||
          notInRuntime.length ||
          changed.length ||
          parsed.completeness !== 'complete' ||
          !router.commited ||
          filtered
        ? 'stale'
        : 'fresh-routes'
    if (!router.commited) {
      limitations.push('Router is not committed; runtime comparison is incomplete.')
    }
    if (input.name && !names.has(input.name)) {
      throw new ToolError(
        'NOT_FOUND',
        `Unknown Tuyau route ${input.name}. Candidates: ${[...names].join(', ')}`
      )
    }
    return {
      data: {
        hook,
        artifacts,
        status,
        completeness: parsed.completeness,
        freshness: {
          comparison: filtered ? 'filtered/unknown' : 'all-named-runtime-routes',
          committed: router.commited,
          typeShapesVerified: false,
          missingFromRegistry,
          notInRuntime,
          changed,
        },
        count: parsed.routes.length,
        routes: input.name
          ? parsed.routes.filter((route) => route.name === input.name)
          : parsed.routes,
      },
      evidence: ['generated', 'source', 'runtime'],
      limitations,
    }
  }
}

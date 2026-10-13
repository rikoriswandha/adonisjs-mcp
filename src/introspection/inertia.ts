/*
| Static Inertia introspection. Reads application syntax and committed route
| references; never invokes controllers, middleware share/flash or transformers.
| Generated declarations are type-only evidence, not observed response data.
*/
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import type * as TS from 'typescript'
import { ToolError } from '../errors.js'
import { appTypeScript, type TypeScriptApi } from './typescript.js'
import { describeReference } from './references.js'
import {
  appRelative,
  lineOf,
  objectKeys,
  parseSource,
  propertyName,
  readSource,
  resolveAppSpecifier,
  scanDirectory,
  stringLiteral,
  type ObjectKeys,
} from './source_files.js'
import type { RouteIntrospection } from './routes.js'

export interface InertiaRoute {
  pattern: string
  methods: string[]
  domain: string
  name?: string | null
  handler: unknown
}
export interface RenderReport {
  component: string | null
  componentEvidence: 'literal' | 'dynamic'
  props: ObjectKeys
  location: { file: string; line: number }
  evidence: 'source'
  changedSinceProcessStart: boolean
}
interface TransformerReport {
  name: string | null
  resource: string | null
  methods: { name: string | null; output: ObjectKeys[]; location: { file: string; line: number } }[]
  location: { file: string; line: number }
  inGenerated: boolean
  changedSinceProcessStart: boolean
  evidence: 'source'
}
function walk(ts: TypeScriptApi, node: TS.Node, visit: (node: TS.Node) => void) {
  visit(node)
  ts.forEachChild(node, (child) => walk(ts, child, visit))
}
function callName(ts: TypeScriptApi, node: TS.Node): string | null {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : null
}
function returns(ts: TypeScriptApi, node: TS.Node): TS.Expression[] {
  const result: TS.Expression[] = []
  const visit = (child: TS.Node) => {
    if (
      child !== node &&
      (ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isMethodDeclaration(child))
    ) {
      return
    }
    if (ts.isReturnStatement(child) && child.expression) {
      result.push(child.expression)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return result
}

export class InertiaIntrospection {
  #modified = new Map<string, boolean>()
  constructor(
    readonly app: ApplicationService,
    readonly routes?: RouteIntrospection
  ) {}
  async setup(): Promise<{ root: string; ts: TypeScriptApi }> {
    const root = await realpath(fileURLToPath(this.app.appRoot))
    const ts = await appTypeScript(root)
    if (!ts) {
      throw new ToolError('DEPENDENCY_UNAVAILABLE', 'Application TypeScript is required')
    }
    return { root, ts }
  }
  async source(path: string, ts: TypeScriptApi) {
    const metadata = await stat(path)
    this.#modified.set(path, metadata.mtimeMs > Date.now() - process.uptime() * 1000)
    return parseSource(ts, path, await readSource(path))
  }
  async generated(root: string, ts: TypeScriptApi, path: string) {
    try {
      return await this.source(join(root, path), ts)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }
  renders(ts: TypeScriptApi, root: string, source: TS.SourceFile, node: TS.Node): RenderReport[] {
    const result: RenderReport[] = []
    walk(ts, node, (child) => {
      if (
        !ts.isCallExpression(child) ||
        callName(ts, child) !== 'render' ||
        !ts.isPropertyAccessExpression(child.expression)
      ) {
        return
      }
      const receiver = child.expression.expression.getText(source)
      if (receiver !== 'inertia' && !/^[\w$]+\.inertia$/.test(receiver)) {
        return
      }
      const component = stringLiteral(ts, child.arguments[0])
      result.push({
        component,
        componentEvidence: component === null ? 'dynamic' : 'literal',
        props: objectKeys(ts, child.arguments[1]),
        location: { file: appRelative(root, source.fileName), line: lineOf(source, child) },
        evidence: 'source',
        changedSinceProcessStart: this.#modified.get(source.fileName) ?? false,
      })
    })
    return result
  }
  async routeRender(route: InertiaRoute) {
    const { root, ts } = await this.setup()
    const unknown = (reason: string) => ({
      status: 'unknown' as const,
      reason,
      renders: [] as RenderReport[],
    })
    const finish = (renders: RenderReport[]) => ({
      status: renders.length ? ('renders' as const) : ('none' as const),
      reason: null,
      renders,
    })
    if (typeof route.handler !== 'function') {
      const handler = route.handler as { reference?: unknown; method?: unknown }
      const ref = Array.isArray(handler.reference)
        ? await describeReference(handler.reference[0], handler.reference[1] ?? 'handle')
        : await describeReference(handler.reference, handler.method)
      if (!ref.module) {
        return unknown('Controller import specifier is unavailable')
      }
      const file = await resolveAppSpecifier(root, ref.module)
      if (!file) {
        return unknown(`Controller source is missing: ${ref.module}`)
      }
      const source = await this.source(file, ts)
      let method: TS.MethodDeclaration | undefined
      for (const declaration of source.statements) {
        if (!ts.isClassDeclaration(declaration)) {
          continue
        }
        for (const member of declaration.members) {
          if (
            ts.isMethodDeclaration(member) &&
            propertyName(ts, member.name) === (ref.method ?? 'handle')
          ) {
            method = member
          }
        }
      }
      return method
        ? finish(this.renders(ts, root, source, method))
        : unknown(`Controller method is missing: ${ref.method}`)
    }
    // Route files are preloads; inspect source rather than invoking macro closures.
    const files: string[] = []
    for (const preload of this.app.rcFile.preloads) {
      if (!(preload.environment as readonly string[]).includes(this.app.getEnvironment())) {
        continue
      }
      const reference = await describeReference(preload.file)
      if (!reference.module) {
        continue
      }
      const file = await resolveAppSpecifier(root, reference.module)
      if (file && !files.includes(file)) {
        files.push(file)
      }
    }
    const candidates: RenderReport[][] = []
    const closureText = (text: string) => {
      const emitted = ts.transpileModule(`const handler = (${text})`, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, removeComments: true },
      }).outputText
      const scanner = ts.createScanner(
        ts.ScriptTarget.ESNext,
        true,
        ts.LanguageVariant.Standard,
        emitted
      )
      const tokens: string[] = []
      for (
        let token = scanner.scan();
        token !== ts.SyntaxKind.EndOfFileToken;
        token = scanner.scan()
      ) {
        if (token === ts.SyntaxKind.SemicolonToken || token === ts.SyntaxKind.CommaToken) {
          continue
        }
        tokens.push(`${token}:${scanner.getTokenValue() || scanner.getTokenText()}`)
      }
      return tokens.join('|')
    }
    const runtimeClosure = closureText(Function.prototype.toString.call(route.handler))
    for (const file of files) {
      if (files.length > 500) {
        return unknown('Preload source import graph exceeds the 500-file bound')
      }
      const source = await this.source(file, ts)
      for (const declaration of source.statements) {
        if (!ts.isImportDeclaration(declaration) || declaration.importClause?.isTypeOnly) {
          continue
        }
        const specifier = stringLiteral(ts, declaration.moduleSpecifier)
        if (!specifier) {
          continue
        }
        const imported = await resolveAppSpecifier(root, specifier, file)
        if (imported && !files.includes(imported)) {
          files.push(imported)
        }
      }
      walk(ts, source, (node) => {
        if (!ts.isCallExpression(node)) {
          return
        }
        const name = callName(ts, node)
        if (
          name !== 'renderInertia' &&
          !['get', 'post', 'put', 'patch', 'delete', 'any'].includes(name ?? '')
        ) {
          return
        }
        let path: string | null = null
        let renders: RenderReport[] = []
        if (
          name === 'renderInertia' &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isCallExpression(node.expression.expression) &&
          callName(ts, node.expression.expression) === 'on'
        ) {
          if (!route.methods.includes('GET')) {
            return
          }
          path = stringLiteral(ts, node.expression.expression.arguments[0])
          const component = stringLiteral(ts, node.arguments[0])
          renders = [
            {
              component,
              componentEvidence: component === null ? 'dynamic' : 'literal',
              props: objectKeys(ts, node.arguments[1]),
              location: { file: appRelative(root, source.fileName), line: lineOf(source, node) },
              evidence: 'source',
              changedSinceProcessStart: this.#modified.get(source.fileName) ?? false,
            },
          ]
        } else if (name !== 'renderInertia') {
          path = stringLiteral(ts, node.arguments[0])
          const closure = node.arguments[1]
          if (!closure || (!ts.isArrowFunction(closure) && !ts.isFunctionExpression(closure))) {
            return
          }
          if (!route.methods.includes((name ?? '').toUpperCase()) && name !== 'any') {
            return
          }
          if (closureText(closure.getText(source)) !== runtimeClosure) {
            return
          }
          renders = this.renders(ts, root, source, closure)
        }
        if (path === null) {
          return
        }
        let domain = 'root'
        let ancestor: TS.Node | undefined = node.parent
        const prefixes: string[] = []
        let dynamicGroup = false
        while (ancestor) {
          if (ts.isCallExpression(ancestor) && callName(ts, ancestor) === 'group') {
            let chain: TS.Node = ancestor
            while (
              chain.parent &&
              ts.isPropertyAccessExpression(chain.parent) &&
              ts.isCallExpression(chain.parent.parent)
            ) {
              chain = chain.parent.parent
              const modifier = callName(ts, chain)
              const value = stringLiteral(ts, (chain as TS.CallExpression).arguments[0])
              if ((modifier === 'prefix' || modifier === 'domain') && value === null) {
                dynamicGroup = true
              }
              if (modifier === 'prefix' && value !== null) {
                prefixes.unshift(value)
              }
              if (modifier === 'domain' && value !== null) {
                domain = value
              }
            }
          }
          ancestor = ancestor.parent
        }
        if (dynamicGroup) {
          return
        }
        const pattern =
          '/' +
          [...prefixes, path]
            .map((part) => part.replace(/^\/+|\/+$/g, ''))
            .filter(Boolean)
            .join('/')
        if (pattern === route.pattern && domain === route.domain) {
          candidates.push(renders)
        }
      })
    }
    return candidates.length === 1
      ? finish(candidates[0])
      : unknown('Closure source could not be uniquely matched by method, pattern and domain')
  }
  async pages(filter?: string) {
    const { root, ts } = await this.setup()
    const scan = await scanDirectory(join(root, 'inertia/pages'), {
      extensions: ['.tsx', '.jsx', '.vue', '.svelte', '.ts'],
    })
    const declaration = await this.generated(root, ts, '.adonisjs/server/pages.d.ts')
    const generated = new Map<string, string | null>()
    if (declaration) {
      walk(ts, declaration, (node) => {
        if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'InertiaPages') {
          return
        }
        for (const member of node.members) {
          if (!member.name) {
            continue
          }
          const name = propertyName(ts, member.name)
          let path: string | null = null
          walk(ts, member, (child) => {
            if (ts.isImportTypeNode(child) && ts.isLiteralTypeNode(child.argument)) {
              path = stringLiteral(ts, child.argument.literal)
            }
          })
          if (name !== null) {
            generated.set(name, path)
          }
        }
      })
    }
    const pages = scan.files.map((file) => ({
      name: file.relative.replace(/\.[^.]+$/, ''),
      file: appRelative(root, file.absolute),
      existsOnDisk: true,
      inGenerated: generated.has(file.relative.replace(/\.[^.]+$/, '')),
      evidence: 'source',
      changedSinceProcessStart: file.changedSinceProcessStart,
    }))
    for (const [name, path] of generated) {
      if (!pages.some((page) => page.name === name)) {
        pages.push({
          name,
          file: path ?? '',
          existsOnDisk: false,
          inGenerated: true,
          evidence: 'generated',
          changedSinceProcessStart: false,
        })
      }
    }
    const router = (await this.app.container.make('router')) as unknown as {
      toJSON(): Record<string, InertiaRoute[]>
    }
    const runtime = Object.entries(router.toJSON()).flatMap(([domain, list]) =>
      list.map((route) => ({ ...route, domain }))
    )
    if (filter && !runtime.some((route) => route.pattern === filter || route.name === filter)) {
      throw new ToolError(
        'NOT_FOUND',
        `Unknown route ${filter}; known: ${runtime.map((route) => route.pattern).join(', ')}`
      )
    }
    const routes = []
    const referenced = new Set<string>()
    for (const route of runtime) {
      const report = await this.routeRender(route)
      for (const render of report.renders) {
        if (render.component !== null) {
          referenced.add(render.component)
        }
      }
      if (filter && route.pattern !== filter && route.name !== filter) {
        continue
      }
      if (report.status !== 'none' || filter) {
        routes.push({
          pattern: route.pattern,
          methods: route.methods,
          domain: route.domain,
          name: route.name ?? null,
          evidence: 'runtime',
          ...report,
        })
      }
    }
    return {
      exists: scan.exists,
      truncated: scan.truncated,
      outsideRoot: scan.outsideRoot,
      pages: pages.map((page) => ({ ...page, referenced: referenced.has(page.name) })),
      generated: {
        exists: declaration !== null,
        entries: [...generated].map(([name, importPath]) => ({
          name,
          importPath,
          evidence: 'generated',
        })),
        absentEntries: pages.filter((page) => !page.inGenerated).map((page) => page.name),
        missingFiles: pages.filter((page) => !page.existsOnDisk).map((page) => page.name),
      },
      routes,
    }
  }
  async shared() {
    const { root, ts } = await this.setup()
    if (!this.routes) {
      throw new ToolError('EXECUTION_FAILED', 'Runtime middleware introspection is unavailable')
    }
    const stack = await this.routes.middleware()
    const candidates = [...stack.server, ...(stack.router ?? [])]
    const middleware: Record<string, unknown>[] = []
    for (const entry of candidates) {
      if (!entry.module) {
        continue
      }
      const file = await resolveAppSpecifier(root, entry.module)
      if (!file) {
        continue
      }
      const source = await this.source(file, ts)
      const baseNames = new Set<string>()
      walk(ts, source, (node) => {
        if (
          ts.isImportDeclaration(node) &&
          stringLiteral(ts, node.moduleSpecifier) === '@adonisjs/inertia/inertia_middleware' &&
          node.importClause?.name
        ) {
          baseNames.add(node.importClause.name.text)
        }
      })
      walk(ts, source, (node) => {
        if (
          !ts.isClassDeclaration(node) ||
          !node.heritageClauses?.some((clause) =>
            clause.types.some((type) => baseNames.has(type.expression.getText(source)))
          )
        ) {
          return
        }
        const methods: Record<string, unknown> = {}
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) {
            continue
          }
          const name = propertyName(ts, member.name)
          if (name !== 'share' && name !== 'flash') {
            continue
          }
          const outputs = returns(ts, member).map((expression) => ({
            ...objectKeys(ts, expression),
            fields: ts.isObjectLiteralExpression(expression)
              ? expression.properties.flatMap((prop) => {
                  const key = prop.name ? propertyName(ts, prop.name) : null
                  if (key === null) {
                    return []
                  }
                  const value = ts.isPropertyAssignment(prop) ? prop.initializer : undefined
                  const wrapper =
                    value &&
                    ts.isCallExpression(value) &&
                    ts.isPropertyAccessExpression(value.expression) &&
                    /(?:^|\.)inertia$/.test(value.expression.expression.getText(source))
                      ? value.expression.name.text
                      : 'plain'
                  return [
                    {
                      name: key,
                      kind: ['always', 'optional', 'defer', 'merge'].includes(wrapper)
                        ? wrapper
                        : 'plain',
                    },
                  ]
                })
              : [],
          }))
          methods[name] = {
            returns: outputs,
            location: { file: appRelative(root, file), line: lineOf(source, member) },
            evidence: 'source',
          }
        }
        middleware.push({
          name: node.name?.text ?? null,
          file: appRelative(root, file),
          evidence: 'runtime+source',
          changedSinceProcessStart: this.#modified.get(file) ?? false,
          ...methods,
        })
      })
    }
    const generated = await this.generated(root, ts, '.adonisjs/client/data.d.ts')
    const aliases: string[] = []
    if (generated) {
      walk(ts, generated, (node) => {
        if (
          ts.isTypeAliasDeclaration(node) &&
          ['SharedProps', 'FlashMessages'].includes(node.name.text)
        ) {
          aliases.push(node.name.text)
        }
      })
    }
    return {
      middleware,
      generated: { exists: generated !== null, aliases, evidence: 'generated' },
      sharedData: { supported: false, reason: 'Inertia v5 config has no sharedData' },
    }
  }
  async transformers(filter?: string) {
    const { root, ts } = await this.setup()
    const scan = await scanDirectory(this.app.transformersPath(), { extensions: ['.ts', '.js'] })
    const declaration = await this.generated(root, ts, '.adonisjs/client/data.d.ts')
    const mappings: { name: string; transformer: string; evidence: string }[] = []
    if (declaration) {
      walk(ts, declaration, (node) => {
        if (
          ts.isTypeAliasDeclaration(node) &&
          ts.isTypeReferenceNode(node.type) &&
          node.type.typeName.getText(declaration) === 'InferData'
        ) {
          mappings.push({
            name: node.name.text,
            transformer: node.type.typeArguments?.[0]?.getText(declaration) ?? '',
            evidence: 'generated',
          })
        }
      })
    }
    const transformers: TransformerReport[] = []
    for (const file of scan.files) {
      const source = await this.source(file.absolute, ts)
      walk(ts, source, (node) => {
        if (!ts.isClassDeclaration(node)) {
          return
        }
        const base = node.heritageClauses
          ?.flatMap((clause) => clause.types)
          .find((type) => type.expression.getText(source) === 'BaseTransformer')
        if (!base) {
          return
        }
        const methods = node.members.flatMap((member) => {
          if (!ts.isMethodDeclaration(member)) {
            return []
          }
          const output = returns(ts, member).map((expression): ObjectKeys => {
            if (
              ts.isCallExpression(expression) &&
              expression.expression.getText(source) === 'this.pick' &&
              expression.arguments[0]?.getText(source) === 'this.resource' &&
              expression.arguments[1] &&
              ts.isArrayLiteralExpression(expression.arguments[1])
            ) {
              const keys = expression.arguments[1].elements.map((element) =>
                stringLiteral(ts, element)
              )
              return {
                keys: keys.filter((key): key is string => key !== null),
                completeness: keys.includes(null) ? 'partial' : 'complete',
              }
            }
            return objectKeys(ts, expression)
          })
          if (output.length === 0) {
            output.push({ keys: [], completeness: 'unknown' })
          }
          return [
            {
              name: propertyName(ts, member.name),
              output,
              location: { file: appRelative(root, file.absolute), line: lineOf(source, member) },
            },
          ]
        })
        const name = node.name?.text ?? null
        transformers.push({
          name,
          resource: base.typeArguments?.[0]?.getText(source) ?? null,
          methods,
          location: { file: appRelative(root, file.absolute), line: lineOf(source, node) },
          inGenerated: mappings.some((mapping) => mapping.transformer === name),
          changedSinceProcessStart: file.changedSinceProcessStart,
          evidence: 'source',
        })
      })
    }
    if (filter && !transformers.some((item) => item.name === filter)) {
      throw new ToolError(
        'NOT_FOUND',
        `Unknown transformer ${filter}; known: ${transformers.map((item) => item.name).join(', ')}`
      )
    }
    return {
      exists: scan.exists,
      truncated: scan.truncated,
      outsideRoot: scan.outsideRoot,
      transformers: transformers.filter((item) => !filter || item.name === filter),
      generated: {
        exists: declaration !== null,
        mappings,
        absentEntries: transformers.filter((item) => !item.inGenerated).map((item) => item.name),
      },
    }
  }
}

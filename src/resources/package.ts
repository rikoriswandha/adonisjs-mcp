import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApplicationService } from '@adonisjs/core/types'
import type * as TypeScript from 'typescript'
import { isPlainObject } from '../define_tool.js'
import { appTypeScript } from '../introspection/typescript.js'
import { parseSource, propertyName, stringLiteral } from '../introspection/source_files.js'
import { isSecretEnvName, isSensitiveKey, project, REDACTED, type Redactor } from '../redaction.js'
import type { ResourceDefinition } from '../types.js'

const MANIFEST_FIELDS = [
  'name',
  'version',
  'private',
  'type',
  'engines',
  'packageManager',
  'imports',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'scripts',
] as const

/** Manifest strings need credential masking without treating package or script names as secrets. */
export function maskManifestString(input: string, script = false): string {
  let output = input.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
  output = output.replace(
    /([?&])([^=\s&#]+)=([^&#\s"'`]+)/g,
    (parameter, separator: string, name: string) => {
      let decoded = name
      try {
        decoded = decodeURIComponent(name)
      } catch {
        // Malformed encodings still receive literal-name checks.
      }
      return isSensitiveKey(decoded) || isSecretEnvName(decoded)
        ? `${separator}${name}=${REDACTED}`
        : parameter
    }
  )
  if (!script) return output
  output = output.replace(
    /(^|[\s;&|])([A-Za-z_/][A-Za-z0-9_/:.-]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g,
    (assignment, prefix: string, variable: string) =>
      isSecretEnvName(variable) || isSensitiveKey(variable)
        ? `${prefix}${variable}=${REDACTED}`
        : assignment
  )
  return output.replace(
    /--([A-Za-z][A-Za-z0-9_-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/g,
    (flag, name: string, separator: string) =>
      isSensitiveKey(name) ? `--${name}${separator}${REDACTED}` : flag
  )
}

/** Fresh, default-deny metadata; loader functions are never inspected or executed. */
export class PackageResource {
  constructor(
    private app: ApplicationService,
    private appRoot: string,
    private redactor: Redactor
  ) {}

  async read() {
    const limitations: string[] = []
    const manifest: Record<string, unknown> = {}
    const raw: unknown = JSON.parse(await readFile(join(this.appRoot, 'package.json'), 'utf8'))
    if (isPlainObject(raw)) {
      for (const field of MANIFEST_FIELDS) {
        if (Object.hasOwn(raw, field)) manifest[field] = raw[field]
      }
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'scripts',
    ] as const) {
      const entries = manifest[field]
      if (!isPlainObject(entries)) continue
      manifest[field] = Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [
          name,
          typeof value === 'string' ? maskManifestString(value, field === 'scripts') : value,
        ])
      )
    }
    const specifiers = await this.specifiers(limitations)
    const runtime = this.app.rcFile
    const mapEntries = (name: 'providers' | 'preloads' | 'commands') => {
      const entries = runtime[name]
      const source = specifiers[name]
      const hasPresets = Array.isArray(runtime.raw.presets) && runtime.raw.presets.length > 0
      const matches = !hasPresets && source !== undefined && source.length === entries.length
      if (hasPresets || !matches) {
        if (!limitations.some((message) => message.startsWith(`${name}:`)))
          limitations.push(
            hasPresets
              ? `${name}: runtime presets prevent reliable source alignment; specifiers are null.`
              : `${name}: source and runtime counts differ or source is unavailable; specifiers are null.`
          )
      }
      return entries.map((entry, index) => ({
        specifier: matches ? source[index] : null,
        ...('environment' in entry ? { environment: entry.environment } : {}),
      }))
    }
    const rc = {
      typescript: runtime.typescript,
      directories: runtime.directories,
      providers: mapEntries('providers'),
      preloads: mapEntries('preloads'),
      commands: mapEntries('commands'),
      commandsAliases: runtime.commandsAliases,
      metaFiles: runtime.metaFiles,
      tests: runtime.tests,
      hooks: Object.fromEntries(
        Object.entries(runtime.hooks ?? {}).map(([name, hooks]) => [
          name,
          Array.isArray(hooks) ? hooks.length : typeof hooks === 'function' ? 1 : 0,
        ])
      ),
      experimental: runtime.experimental,
    }
    return {
      data: {
        manifest: this.redactor.value(manifest),
        rc: project(rc, { redactor: this.redactor }),
      },
      evidence: ['runtime', 'source'] as const,
      limitations,
    }
  }

  private async specifiers(limitations: string[]) {
    const result: Partial<Record<'providers' | 'preloads' | 'commands', (string | null)[]>> = {}
    try {
      const ts = await appTypeScript(this.appRoot)
      if (!ts) throw new Error('Application TypeScript compiler is unavailable')
      const path = join(this.appRoot, 'adonisrc.ts')
      const source = parseSource(ts, path, await readFile(path, 'utf8'))
      // Only the exported defineConfig object is authoritative, not nested lookalike fields.
      const exported = source.statements.find((node) => ts.isExportAssignment(node))
      if (
        !exported ||
        !ts.isExportAssignment(exported) ||
        !ts.isCallExpression(exported.expression)
      )
        throw new Error('Expected an exported defineConfig call')
      const config = exported.expression.arguments[0]
      if (!config || !ts.isObjectLiteralExpression(config))
        throw new Error('Expected a literal rc object')
      for (const field of ['providers', 'preloads', 'commands'] as const) {
        const property = config.properties.find(
          (node) => ts.isPropertyAssignment(node) && propertyName(ts, node.name) === field
        )
        if (
          !property ||
          !ts.isPropertyAssignment(property) ||
          !ts.isArrayLiteralExpression(property.initializer)
        )
          continue
        if (property.initializer.elements.some((entry) => ts.isSpreadElement(entry))) {
          limitations.push(
            `${field}: spread entries prevent source alignment; specifiers are null.`
          )
          continue
        }
        result[field] = property.initializer.elements.map((entry) => {
          let loader: TypeScript.Node = entry
          if (ts.isObjectLiteralExpression(entry)) {
            const file = entry.properties.find(
              (node) => ts.isPropertyAssignment(node) && propertyName(ts, node.name) === 'file'
            )
            if (!file || !ts.isPropertyAssignment(file)) return null
            loader = file.initializer
          }
          if (!ts.isArrowFunction(loader) && !ts.isFunctionExpression(loader)) return null
          const body = ts.isBlock(loader.body)
            ? loader.body.statements.length === 1 && ts.isReturnStatement(loader.body.statements[0])
              ? loader.body.statements[0].expression
              : undefined
            : loader.body
          const literal =
            body &&
            ts.isCallExpression(body) &&
            body.expression.kind === ts.SyntaxKind.ImportKeyword &&
            body.arguments.length === 1
              ? stringLiteral(ts, body.arguments[0])
              : null
          return literal
        })
        if (result[field]?.includes(null))
          limitations.push(`${field}: nonliteral entries have null specifiers.`)
      }
    } catch (error) {
      limitations.push(
        `RC source specifiers unavailable: ${error instanceof Error ? error.message : 'source could not be read'}`
      )
    }
    return result
  }
}

export function packageResource(service: PackageResource): ResourceDefinition {
  return {
    name: 'package',
    uri: 'adonis://package',
    title: 'Application package and rc metadata',
    description:
      'Allowlisted, redacted package manifest and runtime rc configuration with source-derived import specifiers.',
    read: () => service.read(),
  }
}

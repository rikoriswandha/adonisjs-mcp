/*
|--------------------------------------------------------------------------
| Compiled Vine validators
|--------------------------------------------------------------------------
|
| The compiled AST, not the lossy JSON Schema projection, is authoritative.
| Imports trusted validator modules but never invokes validation, predicates,
| rule callbacks, or dynamic messages providers.
|
*/

import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import { isPlainObject } from '../define_tool.js'
import { project, type Redactor } from '../redaction.js'
import {
  appRelative,
  errorMessage,
  lineOf,
  parseSource,
  readSource,
  scanDirectory,
} from './source_files.js'
import { appTypeScript, type TypeScriptApi } from './typescript.js'

interface CompiledValidator {
  toJSON(): { schema: unknown; refs: Record<string, unknown> }
  messagesProvider?: { toJSON?: () => unknown }
}

export interface ValidatorRule {
  name: string
  reference: string | null
  options: unknown
  implicit: boolean | null
  async: boolean | null
  origin: 'vine-definition-match' | 'custom-or-unknown'
  meaning?: 'unknown'
  evidence: string
}

export interface ValidatorNode {
  path: string
  type: string
  subtype: string | null
  optional: boolean | null
  nullable: boolean | null
  allowUnknownProperties: boolean | null
  rules: ValidatorRule[]
  properties: ValidatorNode[]
  each: ValidatorNode | null
  groups: ValidatorNode[]
  branches: Array<{
    schema: ValidatorNode | null
    condition: {
      kind: 'callback'
      executed: false
      reference: string | null
      function: string | null
    }
  }>
  otherwise: {
    kind: 'callback'
    executed: false
    reference: string
    function: string | null
  } | null
  metadata: unknown
}

export interface ValidatorSummary {
  id: string
  name: string
  file: string
  location: { file: string; line: number; evidence: 'source' } | null
  evidence: 'runtime'
  changedSinceProcessStart: boolean
  schema: ValidatorNode | null
  messages: { status: 'serialized'; value: unknown } | { status: 'unknown'; reason: string }
}

export interface ValidatorSnapshot {
  directory: string
  exists: boolean
  truncated: boolean
  outsideRoot: number
  validators: ValidatorSummary[]
  failures: Array<{ file: string; export?: string; message: string }>
}

/** Replace functions without invoking them, then apply the common redactor. */
function functionData(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (typeof value === 'function') {
    return { kind: 'function', name: value.name }
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (ancestors.has(value)) {
    return '[Circular]'
  }
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return value
  }
  if (depth >= 24) {
    return '[MaxDepth]'
  }
  ancestors.add(value)
  const result = Array.isArray(value)
    ? value.map((entry) => functionData(entry, ancestors, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          functionData(entry, ancestors, depth + 1),
        ])
      )
  ancestors.delete(value)
  return result
}

function record(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

const REPRESENTED_NODE_FIELDS: Record<string, true> = {
  properties: true,
  each: true,
  groups: true,
  conditions: true,
  validations: true,
  schema: true,
  fieldName: true,
  propertyName: true,
  type: true,
  subtype: true,
  isOptional: true,
  allowNull: true,
  allowUnknownProperties: true,
  conditionalFnRefId: true,
  elseConditionalFnRefId: true,
}

function callbackName(refs: Record<string, unknown>, reference: unknown): string | null {
  const callback = typeof reference === 'string' ? refs[reference] : null
  return typeof callback === 'function' ? callback.name || null : null
}

async function exportLines(ts: TypeScriptApi, file: string): Promise<Record<string, number>> {
  const source = parseSource(ts, file, await readSource(file))
  const lines: Record<string, number> = {}
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) {
        lines.default = lineOf(source, statement)
      }
      continue
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        lines[element.name.text] = lineOf(source, element)
      }
      continue
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue
    }
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      lines.default = lineOf(source, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          lines[declaration.name.text] = lineOf(source, declaration)
        }
      }
    }
  }
  return lines
}

export class ValidatorIntrospection {
  constructor(
    private app: ApplicationService,
    private redactor: Redactor
  ) {}

  #project(value: unknown): unknown {
    return project(functionData(value), { redactor: this.redactor, maxDepth: 30 })
  }

  #node(
    value: unknown,
    refs: Record<string, unknown>,
    vineSource: string,
    parent = '',
    samePath = false
  ): ValidatorNode | null {
    if (!isPlainObject(value)) {
      return null
    }
    if (value.type === 'root') {
      return this.#node(value.schema, refs, vineSource)
    }
    const field = typeof value.fieldName === 'string' ? value.fieldName : ''
    const path = samePath ? parent : [parent, field].filter(Boolean).join('.')
    const rules = entries(value.validations).map((entry): ValidatorRule => {
      const validation = record(entry)
      const reference = typeof validation.ruleFnId === 'string' ? validation.ruleFnId : null
      const ref = record(reference ? refs[reference] : null)
      const fn = ref.validator
      // Full function definition matching, not a name allowlist: a custom rule
      // named `minLength` does not become built-in. Split/unrecognized package
      // implementations stay unknown. No function is executed for this check.
      const definition = typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''
      const builtin = definition.startsWith('function ') && vineSource.includes(definition)
      return {
        name:
          typeof validation.name === 'string'
            ? validation.name
            : typeof fn === 'function'
              ? fn.name
              : 'unknown',
        reference,
        options: this.#project(ref.options ?? null),
        implicit: boolean(validation.implicit),
        async: boolean(validation.isAsync),
        origin: builtin ? 'vine-definition-match' : 'custom-or-unknown',
        ...(builtin ? {} : { meaning: 'unknown' as const }),
        evidence: builtin
          ? 'runtime reference function definition exactly matches installed Vine entry source'
          : 'runtime compiled reference; definition not verified in installed Vine entry source',
      }
    })
    const otherwise = value.elseConditionalFnRefId
    return {
      path,
      type: typeof value.type === 'string' ? value.type : 'unknown',
      subtype: typeof value.subtype === 'string' ? value.subtype : null,
      optional: boolean(value.isOptional),
      nullable: boolean(value.allowNull),
      allowUnknownProperties: boolean(value.allowUnknownProperties),
      rules,
      properties: entries(value.properties).flatMap((child) => {
        const node = this.#node(child, refs, vineSource, path)
        return node ? [node] : []
      }),
      each: this.#node(value.each, refs, vineSource, path),
      groups: entries(value.groups).flatMap((child) => {
        const node = this.#node(child, refs, vineSource, path)
        return node ? [node] : []
      }),
      branches: entries(value.conditions).map((entry) => {
        const branch = record(entry)
        return {
          schema: this.#node(branch.schema, refs, vineSource, path, true),
          condition: {
            kind: 'callback',
            executed: false,
            reference:
              typeof branch.conditionalFnRefId === 'string' ? branch.conditionalFnRefId : null,
            function: callbackName(refs, branch.conditionalFnRefId),
          },
        }
      }),
      otherwise:
        typeof otherwise === 'string'
          ? {
              kind: 'callback',
              executed: false,
              reference: otherwise,
              function: callbackName(refs, otherwise),
            }
          : null,
      metadata: this.#project(
        Object.fromEntries(Object.entries(value).filter(([name]) => !REPRESENTED_NODE_FIELDS[name]))
      ),
    }
  }

  async snapshot(): Promise<ValidatorSnapshot> {
    const appRoot = await realpath(fileURLToPath(this.app.appRoot))
    const scan = await scanDirectory(this.app.validatorsPath(), { extensions: ['.ts', '.js'] })
    const vinePath = createRequire(join(appRoot, 'package.json')).resolve('@vinejs/vine')
    const vine = (await this.app.import(pathToFileURL(vinePath).href)) as {
      VineValidator: new (...args: never[]) => CompiledValidator
    }
    const vineSource = await readFile(vinePath, 'utf8')
    const validators: ValidatorSummary[] = []
    const ts = await appTypeScript(appRoot)
    const failures: ValidatorSnapshot['failures'] = []
    for (const file of scan.files) {
      const relative = appRelative(appRoot, file.absolute)
      let exports: Record<string, unknown>
      try {
        exports = (await this.app.import(pathToFileURL(file.absolute).href)) as Record<
          string,
          unknown
        >
      } catch (error) {
        failures.push({ file: relative, message: this.redactor.text(errorMessage(error)) })
        continue
      }
      let locations: Record<string, number> = {}
      if (ts) {
        // Source-location failure must not discard successfully imported runtime metadata.
        try {
          locations = await exportLines(ts, file.absolute)
        } catch {
          locations = {}
        }
      }
      for (const [name, candidate] of Object.entries(exports)) {
        if (!(candidate instanceof vine.VineValidator)) {
          continue
        }
        try {
          const compiled = candidate.toJSON()
          const provider = candidate.messagesProvider
          validators.push({
            id: `${file.relative.slice(0, -extname(file.relative).length)}#${name}`,
            name,
            file: relative,
            location: locations[name]
              ? { file: relative, line: locations[name], evidence: 'source' }
              : null,
            evidence: 'runtime',
            changedSinceProcessStart: file.changedSinceProcessStart,
            schema: this.#node(compiled.schema, compiled.refs, vineSource),
            messages:
              typeof provider?.toJSON === 'function'
                ? { status: 'serialized', value: this.#project(provider.toJSON()) }
                : {
                    status: 'unknown',
                    reason: 'Messages provider has no toJSON serializer; not executed',
                  },
          })
        } catch (error) {
          failures.push({
            file: relative,
            export: name,
            message: this.redactor.text(errorMessage(error)),
          })
        }
      }
    }
    return {
      directory: appRelative(appRoot, scan.root),
      exists: scan.exists,
      truncated: scan.truncated,
      outsideRoot: scan.outsideRoot,
      validators,
      failures,
    }
  }
}

/*
|--------------------------------------------------------------------------
| Environment variables
|--------------------------------------------------------------------------
|
| Declared keys come from the `Env.create(appRoot, { ... })` schema in
| `start/env.ts`, parsed (not executed) with the application's TypeScript
| compiler. Presence is read from `process.env`. Values are never read
| into the result.
|
*/

import { access, readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { ApplicationService } from '@adonisjs/core/types'
import type * as TypeScript from 'typescript'
import { ToolError } from '../errors.js'
import { isSecretEnvName } from '../redaction.js'
import type { TypeScriptApi } from './typescript.js'

const ENV_FILES = ['env.ts', 'env.mts', 'env.js']

export interface EnvVariableReport {
  key: string

  /**
   * `Env.schema.<type>` used to validate the variable, when written as a
   * direct schema call.
   */
  type: string | null
  optional: boolean

  /**
   * Declared with `Env.schema.secret()` or named like a secret.
   */
  secret: boolean

  /**
   * Defined in `process.env` (possibly empty).
   */
  present: boolean
  empty: boolean
  line: number
}

export interface EnvReport {
  file: string
  variables: EnvVariableReport[]

  /**
   * Schema entries whose key could not be read statically (spread,
   * computed or shorthand properties).
   */
  unextractable: number
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function findSchema(
  ts: TypeScriptApi,
  source: TypeScript.SourceFile
): TypeScript.ObjectLiteralExpression | undefined {
  let found: TypeScript.ObjectLiteralExpression | undefined
  const visit = (node: TypeScript.Node) => {
    if (found) {
      return
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'create' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Env'
    ) {
      const schema = node.arguments[1]
      if (schema && ts.isObjectLiteralExpression(schema)) {
        found = schema
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

export class EnvIntrospection {
  constructor(
    readonly app: ApplicationService,
    readonly appRoot: string
  ) {}

  async read(ts: TypeScriptApi, prefix?: string): Promise<EnvReport> {
    let path: string | undefined
    for (const name of ENV_FILES) {
      const candidate = this.app.startPath(name)
      if (await exists(candidate)) {
        path = candidate
        break
      }
    }
    if (!path) {
      throw new ToolError(
        'NOT_FOUND',
        `No env schema file (${ENV_FILES.map((name) => `start/${name}`).join(', ')}) was found`
      )
    }

    const file = relative(this.appRoot, path).split(sep).join('/')
    const source = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const schema = findSchema(ts, source)
    if (!schema) {
      throw new ToolError(
        'CAPABILITY_UNSUPPORTED',
        `${file} has no Env.create(appRoot, { ... }) call with an object literal schema`
      )
    }

    const variables: EnvVariableReport[] = []
    let unextractable = 0
    for (const property of schema.properties) {
      const name = property.name
      if (
        !ts.isPropertyAssignment(property) ||
        !name ||
        !(ts.isIdentifier(name) || ts.isStringLiteral(name))
      ) {
        unextractable++
        continue
      }
      const key = name.text
      if (prefix !== undefined && !key.startsWith(prefix)) {
        continue
      }
      const initializer = property.initializer.getText(source)
      const type = /\bEnv\.schema\.(\w+)/.exec(initializer)?.[1] ?? null
      const value = process.env[key]
      variables.push({
        key,
        type,
        optional: /\.optional\b/.test(initializer),
        secret: type === 'secret' || isSecretEnvName(key),
        present: value !== undefined,
        empty: value === '',
        line: source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1,
      })
    }
    return { file, variables, unextractable }
  }
}

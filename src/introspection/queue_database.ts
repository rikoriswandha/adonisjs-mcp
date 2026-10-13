/*
|--------------------------------------------------------------------------
| Version-bound queue database configuration
|--------------------------------------------------------------------------
|
| The queue adapter keeps its table and connection private. Only a static
| official drivers.database declaration is supported for physical reads.
| Dynamic or modified source is not guessed and never evaluated.
|
*/
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type * as TypeScript from 'typescript'
import { appTypeScript } from './typescript.js'
import { parseSource, propertyName, readSource, stringLiteral } from './source_files.js'

export async function queueDatabaseConfig(
  root: string,
  adapterName: string
): Promise<{ connectionName: string | null; tableName: string; evidence: 'source' } | null> {
  const ts = await appTypeScript(root)
  if (!ts) {
    return null
  }
  const file = join(root, 'config/queue.ts')
  const stats = await stat(file)
  if (stats.mtimeMs > performance.timeOrigin) {
    return null
  }
  const source = parseSource(ts, file, await readSource(file))
  let driversName: string | null = null
  let defineName: string | null = null
  let exported: TypeScript.Expression | null = null
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exported = statement.expression
      continue
    }
    // Extra statements could mutate imported factories/configuration.
    if (!ts.isImportDeclaration(statement)) {
      return null
    }
    if (stringLiteral(ts, statement.moduleSpecifier) !== '@adonisjs/queue') {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const element of bindings.elements) {
      const original = element.propertyName?.text ?? element.name.text
      if (original === 'drivers') {
        driversName = element.name.text
      }
      if (original === 'defineConfig') {
        defineName = element.name.text
      }
    }
  }
  if (!driversName || !defineName || !exported || !ts.isCallExpression(exported)) {
    return null
  }
  if (!ts.isIdentifier(exported.expression) || exported.expression.text !== defineName) {
    return null
  }
  const configuration = exported.arguments[0]
  if (!configuration || !ts.isObjectLiteralExpression(configuration)) {
    return null
  }
  const properties = configuration.properties
  if (properties.some((item) => !ts.isPropertyAssignment(item))) {
    return null
  }
  const adapters = properties.filter(
    (item) => ts.isPropertyAssignment(item) && propertyName(ts, item.name) === 'adapters'
  )
  if (adapters.length !== 1 || !ts.isPropertyAssignment(adapters[0])) {
    return null
  }
  const declaration = adapters[0].initializer
  if (!ts.isObjectLiteralExpression(declaration)) {
    return null
  }
  if (declaration.properties.some((item) => !ts.isPropertyAssignment(item))) {
    return null
  }
  const entries = declaration.properties.filter(
    (item) => ts.isPropertyAssignment(item) && propertyName(ts, item.name) === adapterName
  )
  if (entries.length !== 1 || !ts.isPropertyAssignment(entries[0])) {
    return null
  }
  const call = entries[0].initializer
  if (!ts.isCallExpression(call) || call.arguments.length > 1) {
    return null
  }
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.expression.text !== driversName ||
    call.expression.name.text !== 'database'
  ) {
    return null
  }
  let connectionName: string | null = null
  let tableName = 'queue_jobs'
  const options = call.arguments[0]
  if (options) {
    if (!ts.isObjectLiteralExpression(options)) {
      return null
    }
    for (const option of options.properties) {
      if (!ts.isPropertyAssignment(option)) {
        return null
      }
      const name = propertyName(ts, option.name)
      const value = stringLiteral(ts, option.initializer)
      if ((name !== 'connectionName' && name !== 'tableName') || value === null) {
        return null
      }
      if (name === 'connectionName') {
        connectionName = value
      } else {
        tableName = value
      }
    }
  }
  return { connectionName, tableName, evidence: 'source' }
}

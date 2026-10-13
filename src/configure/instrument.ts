import type { ObjectLiteralExpression, PropertyAssignment, SourceFile } from 'ts-morph'

function objectProperty(object: ObjectLiteralExpression, name: string) {
  const property = object.getProperty(name)
  if (property?.getKindName() !== 'PropertyAssignment') return undefined
  const initializer = (property as PropertyAssignment).getInitializer()
  return initializer?.getKindName() === 'ObjectLiteralExpression'
    ? (initializer as ObjectLiteralExpression)
    : undefined
}

function ensureImport(source: SourceFile, name: string) {
  const existing = source.getImportDeclaration('#start/mcp_dev_hooks')
  if (!existing) {
    source.addImportDeclaration({ moduleSpecifier: '#start/mcp_dev_hooks', namedImports: [name] })
  } else if (!existing.getNamedImports().some((item) => item.getName() === name)) {
    existing.addNamedImport(name)
  }
}

/** Returns false without editing when the logger configuration cannot be safely resolved. */
export function instrumentLogger(source: SourceFile): boolean {
  const call = source
    .getDescendants()
    .find(
      (node) =>
        node.getKindName() === 'CallExpression' && node.getText().startsWith('defineConfig(')
    )
  const config = call
    ?.getChildren()
    .find((node) => node.getKindName() === 'SyntaxList')
    ?.getChildren()
    .find((node) => node.getKindName() === 'ObjectLiteralExpression') as
    ObjectLiteralExpression | undefined
  if (!config) return false
  let loggers: ObjectLiteralExpression | undefined
  try {
    loggers = objectProperty(config, 'loggers')
  } catch {
    return false
  }
  if (!loggers) return false
  const defaultProperty = config.getProperty('default') as PropertyAssignment | undefined
  const defaultValue =
    defaultProperty?.getKindName() === 'PropertyAssignment'
      ? defaultProperty.getInitializer()?.getText()
      : undefined
  const defaultName = defaultValue?.match(/^['"]([^'"]+)['"]$/)?.[1]
  if (defaultValue && !defaultName) return false
  const loggerProperty = defaultName ? loggers.getProperty(defaultName) : loggers.getProperties()[0]
  if (loggerProperty?.getKindName() !== 'PropertyAssignment') return false
  const logger = (loggerProperty as PropertyAssignment).getInitializer()
  if (logger?.getKindName() !== 'ObjectLiteralExpression') return false
  const loggerObject = logger as ObjectLiteralExpression
  const gatewayImport = source.getImportDeclaration('#start/mcp_dev_hooks')
  if (
    gatewayImport
      ?.getNamedImports()
      .some((item) => item.getName() === 'streamWrite' && item.getAliasNode())
  )
    return false
  const alreadyImported = gatewayImport
    ?.getNamedImports()
    .some((item) => item.getName() === 'streamWrite' && !item.getAliasNode())
  // Do not introduce a conflicting binding into a customized module.
  if (
    !alreadyImported &&
    (source.getVariableDeclaration('streamWrite') ||
      source.getFunction('streamWrite') ||
      source
        .getImportDeclarations()
        .some((declaration) =>
          declaration
            .getNamedImports()
            .some((item) => (item.getAliasNode()?.getText() ?? item.getName()) === 'streamWrite')
        ))
  )
    return false
  const hooksProperty = loggerObject.getProperty('hooks')
  if (!hooksProperty) {
    loggerObject.addPropertyAssignment({ name: 'hooks', initializer: '{ streamWrite }' })
  } else {
    if (hooksProperty.getKindName() !== 'PropertyAssignment') return false
    const hooks = (hooksProperty as PropertyAssignment).getInitializer()
    if (hooks?.getKindName() !== 'ObjectLiteralExpression') return false
    const hooksObject = hooks as ObjectLiteralExpression
    const existing = hooksObject.getProperty('streamWrite')
    if (existing?.getKindName() === 'ShorthandPropertyAssignment' && !alreadyImported) return false
    if (!existing) hooksObject.addShorthandPropertyAssignment({ name: 'streamWrite' })
    else if (existing.getText() !== 'streamWrite') {
      if (existing.getKindName() !== 'PropertyAssignment') return false
      const initializer = (existing as PropertyAssignment).getInitializer()
      if (!initializer) return false
      if (
        alreadyImported &&
        initializer.getKindName() === 'Identifier' &&
        initializer.getText() === 'streamWrite'
      )
        return true
      if (
        !initializer
          .getText()
          .startsWith('((appStreamWrite) => (line: string) => streamWrite(appStreamWrite(line)))(')
      ) {
        const original = initializer.getText()
        ;(existing as PropertyAssignment).setInitializer(
          `((appStreamWrite) => (line: string) => streamWrite(appStreamWrite(line)))(${original})`
        )
      }
    }
  }
  ensureImport(source, 'streamWrite')
  return true
}

/** Instruments only the default ExceptionHandler subclass and its known two-argument handle method. */
export function instrumentExceptions(source: SourceFile): boolean {
  const handler = source
    .getClasses()
    .find((item) => item.isDefaultExport() && item.getExtends()?.getText() === 'ExceptionHandler')
  if (!handler) return false
  const method = handler.getMethod('handle')
  if (method) {
    const parameters = method.getParameters()
    if (parameters.length !== 2 || !method.getBody()) return false
    const invocation = `observeException(${parameters[0].getName()}, ${parameters[1].getName()})`
    if (
      !method
        .getStatements()
        .some((statement) => statement.getText().replace(/;$/, '') === invocation)
    ) {
      method.insertStatements(0, invocation)
    }
  } else {
    handler.addMethod({
      name: 'handle',
      isAsync: true,
      parameters: [
        { name: 'error', type: 'unknown' },
        { name: 'ctx', type: 'HttpContext' },
      ],
      statements: ['observeException(error, ctx)', 'return super.handle(error, ctx)'],
    })
    const httpImport = source.getImportDeclaration('@adonisjs/core/http')
    if (!httpImport?.getNamedImports().some((item) => item.getName() === 'HttpContext')) {
      source.addImportDeclaration({
        moduleSpecifier: '@adonisjs/core/http',
        namedImports: ['HttpContext'],
        isTypeOnly: true,
      })
    }
  }
  ensureImport(source, 'observeException')
  return true
}

export function vmModulesScript(
  script: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === 'win32') return undefined
  if (script.includes('--experimental-vm-modules')) return script
  if (/\bNODE_OPTIONS\b/.test(script)) return undefined
  return `NODE_OPTIONS=--experimental-vm-modules ${script}`
}

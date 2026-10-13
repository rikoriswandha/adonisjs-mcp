import { test } from '@japa/runner'
import { Project } from 'ts-morph'
import {
  instrumentExceptions,
  instrumentLogger,
  vmModulesScript,
} from '../../src/configure/instrument.js'

test.group('Configure | conservative source edits', () => {
  test('logger default is instrumented and app streamWrite composed exactly once', ({ assert }) => {
    const project = new Project({ useInMemoryFileSystem: true })
    const source = project.createSourceFile(
      'logger.ts',
      `const config = defineConfig({ default: 'app', loggers: { other: {}, app: { hooks: { streamWrite: (line: string) => line.replace('before', 'after'), flush: () => {} } } } })`
    )
    assert.isTrue(instrumentLogger(source))
    const once = source.getFullText()
    assert.include(once, 'streamWrite(appStreamWrite(line))')
    assert.include(once, 'flush: () => {}')
    assert.isTrue(instrumentLogger(source))
    assert.equal(source.getFullText(), once)
  })

  test('unrecognized logger shapes are unchanged', ({ assert }) => {
    const project = new Project({ useInMemoryFileSystem: true })
    for (const input of [
      'defineConfig(getConfig())',
      'defineConfig({ default: env.get("LOGGER"), loggers: { app: {} } })',
      'defineConfig({ loggers: { app: { hooks: customHooks } } })',
    ]) {
      const source = project.createSourceFile(`${project.getSourceFiles().length}.ts`, input)
      assert.isFalse(instrumentLogger(source))
      assert.equal(source.getFullText(), input)
    }
  })

  test('aliased gateway streamWrite is left unchanged for manual instrumentation', ({ assert }) => {
    const source = new Project({ useInMemoryFileSystem: true }).createSourceFile(
      'logger.ts',
      `import { streamWrite as capture } from '#start/mcp_dev_hooks'
const config = defineConfig({ loggers: { app: {} } })`
    )
    const before = source.getFullText()
    assert.isFalse(instrumentLogger(source))
    assert.equal(source.getFullText(), before)
  })

  test('explicit gateway streamWrite property is already instrumented', ({ assert }) => {
    const source = new Project({ useInMemoryFileSystem: true }).createSourceFile(
      'logger.ts',
      `import { streamWrite } from '#start/mcp_dev_hooks'
const config = defineConfig({ loggers: { app: { hooks: { streamWrite: streamWrite } } } })`
    )
    const before = source.getFullText()
    assert.isTrue(instrumentLogger(source))
    assert.equal(source.getFullText(), before)
    assert.isTrue(instrumentLogger(source))
    assert.equal(source.getFullText(), before)
  })

  test('exception handler is instrumented first and missing handle is generated', ({ assert }) => {
    const project = new Project({ useInMemoryFileSystem: true })
    for (const body of [
      '',
      'async handle(error: unknown, ctx: HttpContext) { return super.handle(error, ctx) }',
    ]) {
      const source = project.createSourceFile(
        `${project.getSourceFiles().length}.ts`,
        `export default class Handler extends ExceptionHandler { ${body} }`
      )
      assert.isTrue(instrumentExceptions(source))
      assert.match(source.getFullText(), /handle\([^)]*\)\s*\{\s*observeException\(error, ctx\)/)
      const once = source.getFullText()
      assert.isTrue(instrumentExceptions(source))
      assert.equal(source.getFullText(), once)
    }
  })

  test('VM modules preserves existing flags and avoids replacing NODE_OPTIONS', ({ assert }) => {
    assert.equal(
      vmModulesScript('node ace serve --hmr', 'linux'),
      'NODE_OPTIONS=--experimental-vm-modules node ace serve --hmr'
    )
    assert.equal(
      vmModulesScript('NODE_OPTIONS=--experimental-vm-modules node ace serve', 'linux'),
      'NODE_OPTIONS=--experimental-vm-modules node ace serve'
    )
    assert.isUndefined(vmModulesScript('NODE_OPTIONS=--inspect node ace serve', 'linux'))
    assert.isUndefined(vmModulesScript('node ace serve --hmr', 'win32'))
    assert.isUndefined(
      vmModulesScript('NODE_OPTIONS=--experimental-vm-modules node ace serve', 'win32')
    )
  })
})

import vm from 'node:vm'

// Same selected S-E resolver: main-context loader with an app-root filename.
// This file is installed under clone/node_modules/@sh/tenant-evaluator/.
export async function evaluate(app, appPost, code) {
  const filename = app.makePath('eval-call.mjs')
  const task = vm.compileFunction(`return (async () => { ${code}\n})()`, ['appPost'], {
    filename,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  })(appPost)
  return { filename, hostedModule: import.meta.url, value: await task }
}

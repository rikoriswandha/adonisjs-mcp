import vm from 'node:vm'
import { inspect, format } from 'node:util'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
export const completions = []
export async function evaluate({ candidate = 'compile-app', code, timeout = 1000, callId = 'call' }, app, appUser) {
  const logs = []
  const localConsole = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, text: format(...args) })]))
  const signal = AbortSignal.timeout(timeout)
  const args = [app, appUser, localConsole, signal, completions, callId]
  const names = ['app', 'appUser', 'console', 'signal', 'completions', 'callId']
  const callback = candidate.endsWith('-app') ? (specifier) => app.import(specifier) : candidate.endsWith('-default') ? vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER : undefined
  const filename = candidate.includes('-start-ts-') ? app.makePath('start/__mcp_eval__.ts') : candidate.includes('-root-ts-') ? app.makePath('eval-call.ts') : candidate.includes('-root-') ? app.makePath('eval-call.mjs') : new URL('./eval-call.mjs', import.meta.url).pathname
  let task
  try {
    if (candidate === 'async-function') task = new AsyncFunction(...names, code)(...args)
    else if (candidate.startsWith('compile')) task = vm.compileFunction(`return (async () => { ${code}\n})()`, names, { filename, importModuleDynamically: callback })(...args)
    else if (candidate.startsWith('script')) task = new vm.Script(`(async (${names.join(',')}) => { ${code}\n})`, { filename, importModuleDynamically: callback }).runInThisContext()(...args)
    else if (candidate === 'source-app') {
      const context = vm.createContext(Object.fromEntries(names.map((name, index) => [name, args[index]])))
      const module = new vm.SourceTextModule(`export default await (async () => { ${code}\n})()`, { context, identifier: new URL('./eval-call.mjs', import.meta.url).href, importModuleDynamically: (specifier) => app.import(specifier) })
      await module.link(() => { throw new Error('Static imports not part of probe') })
      task = module.evaluate().then(() => module.namespace.default)
    } else throw new Error(`Unknown candidate ${candidate}`)
    const result = await Promise.race([task, new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cooperative wait expired; execution NOT stopped'), { code: 'TIMEOUT' })), { once: true }))])
    return { ok: true, display: inspect(result, { depth: 4, colors: false }), logs, callId, pid: process.pid }
  } catch (error) {
    return { ok: false, error: { code: error.code, message: error.message }, logs, callId, pid: process.pid }
  }
}

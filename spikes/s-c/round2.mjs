import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
const here = dirname(fileURLToPath(import.meta.url))
function command(cmd, args, cwd, env = {}) {
  const result = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180000 })
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
export async function setup(app) {
  const pkg = resolve(app, 'sc-standin')
  await mkdir(pkg)
  for (const file of ['package.json', 'hooks.d.ts']) await copyFile(resolve(here, 'pkg', file), resolve(pkg, file))
  await writeFile(resolve(pkg, 'hooks.js'), stripTypeScriptTypes(await readFile(resolve(here, 'capture.ts'), 'utf8')))
  const tarball = command('npm', ['pack', '--silent'], pkg).trim().split('\n').at(-1)
  command('npm', ['install', '--save-dev', '--save-exact', resolve(pkg, tarball)], app)
  await copyFile(resolve(here, 'mcp_dev_hooks.ts'), resolve(app, 'start/mcp_dev_hooks.ts'))
  await writeFile(resolve(app, 'providers/mcp_dev_provider.ts'), `import app from '@adonisjs/core/services/app'\n// Package provider is unavailable in production; conditional app-local seam.\nexport default app.inDev ? (await import('./provider.js')).default : class DisabledProvider {}\n`)
  for (const [file, oldText, newText] of [
    ['adonisrc.ts', "import('./providers/provider.js')", "import('./providers/mcp_dev_provider.js')"],
    ['config/logger.ts', "'../providers/capture.js'", "'../start/mcp_dev_hooks.js'"],
    ['app/exceptions/handler.ts', "'../../providers/capture.js'", "'../../start/mcp_dev_hooks.js'"],
    ['providers/provider.ts', "'./capture.js'", "'@rikology/adonisjs-mcp/hooks'"],
  ]) {
    const path = resolve(app, file)
    await writeFile(path, (await readFile(path, 'utf8')).replace(oldText, newText))
  }
  const handlerPath = resolve(app, 'app/exceptions/handler.ts')
  await writeFile(handlerPath, (await readFile(handlerPath, 'utf8')).replace('.status(500)', '.status((error as { status?: number }).status ?? 500)'))
  await writeFile(resolve(app, 'start/routes.ts'), (await readFile(resolve(app, 'start/routes.ts'), 'utf8')) + `\nrouter.get('/production/error', () => { throw new Error('production-probe-error') })\nrouter.get('/production/log', ({ logger }) => { logger.info({ event: 'production-once' }, 'production once'); return { ok: true } })\n`)
}
export async function saveEvidence(app, stdout, stderr, prefix = 'dev') {
  const env = await readFile(resolve(app, '.env'), 'utf8')
  const secrets = env.split('\n').filter((line) => /^(APP_KEY|.*PASSWORD|.*SECRET|.*TOKEN)=/.test(line)).map((line) => line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')).filter(Boolean)
  for (const text of [stdout, stderr]) {
    assert(!secrets.some((secret) => text.includes(secret)), 'secret sentinel not present')
    assert(!/"(?:cookie|authorization|app_key|password|secret|token)"\s*:/i.test(text), 'sensitive structured field not present')
  }
  await mkdir(resolve(here, 'evidence'), { recursive: true })
  await writeFile(resolve(here, `evidence/${prefix}-stdout.log`), stdout)
  await writeFile(resolve(here, `evidence/${prefix}-stderr.log`), stderr)
}
export async function production(app) {
  const evidence = []
  evidence.push(command(process.execPath, ['ace', 'build'], app))
  const build = resolve(app, 'build')
  evidence.push(command('npm', ['ci', '--omit=dev'], build))
  await copyFile(resolve(app, '.env'), resolve(build, '.env'))
  const standalone = app + '-standalone'
  command('cp', ['-cR', build, standalone], app)
  await mkdir(resolve(standalone, 'tmp'), { recursive: true })
  await copyFile(resolve(app, 'tmp/db.sqlite3'), resolve(standalone, 'tmp/db.sqlite3'))
  evidence.push('STANDALONE ' + standalone)
  const absent = spawnSync(process.execPath, ['--input-type=module', '-e', "try { import.meta.resolve('@rikology/adonisjs-mcp/hooks'); process.exit(1) } catch(e) { console.log('PACKAGE_ABSENT', e.code) }"], { cwd: standalone, encoding: 'utf8' })
  assert.equal(absent.status, 0); evidence.push(absent.stdout)
  const child = spawn(process.execPath, ['bin/server.js'], { cwd: standalone, env: { ...process.env, NODE_ENV: 'production', PORT: '41041', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (s) => { stdout += s }); child.stderr.on('data', (s) => { stderr += s })
  try {
    let response
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(stdout + stderr)
      try { response = await fetch('http://127.0.0.1:41041/'); break } catch { await sleep(50) }
    }
    assert.equal(response?.status, 200)
    const root = await response.json()
    const error = await fetch('http://127.0.0.1:41041/production/error'); const errorBody = await error.json()
    assert.equal(error.status, 500); assert.equal(errorBody.error, 'production-probe-error'); assert(errorBody.request_id)
    assert.equal((await fetch('http://127.0.0.1:41041/production/log')).status, 200)
    assert.equal((await fetch('http://127.0.0.1:41041/probe/state')).status, 404)
    evidence.push('HTTP ' + JSON.stringify({ rootStatus: response.status, root, errorStatus: error.status, errorBody, normalLogStatus: 200, captureRouteStatus: 404 }))
  } finally {
    const { promise, resolve: done } = Promise.withResolvers()
    child.once('exit', done); child.kill('SIGTERM')
    await Promise.race([promise, sleep(5000)])
    if (child.exitCode === null) { child.kill('SIGKILL'); await promise }
  }
  const logs = stdout.split('\n').flatMap((s) => { try { return [JSON.parse(s)] } catch { return [] } })
  assert.equal(logs.filter((l) => l.event === 'production-once').length, 1)
  assert.equal(logs.filter((l) => l.event === 'custom-report').length, 2)
  assert.equal(logs.filter((l) => l.msg === 'production-probe-error').length, 1)
  assert(!stdout.includes('SC_SHUTDOWN'))
  const migration = command(process.execPath, ['ace', 'migration:status'], standalone, { NODE_ENV: 'production' })
  evidence.push('MIGRATION_EXIT 0\n' + migration)
  evidence.push('PRODUCTION_OBSERVATIONS ' + JSON.stringify({ root200: true, customError500: true, logOnce: true, packageAbsent: true, captureRouteAbsent: true, providerNotLoaded: true, migrationExit: 0, processStopped: true }))
  await saveEvidence(app, stdout, stderr, 'production')
  await writeFile(resolve(here, 'evidence/production-procedure.log'), evidence.join('\n'))
  console.log(evidence.join('\n'))
}

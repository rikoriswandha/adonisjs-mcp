import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const cloneName = `s-h-api-${Date.now()}`
const clone = process.argv[2] || `/tmp/adonisjs-mcp-m0/${cloneName}`
assert.ok(clone.startsWith('/tmp/adonisjs-mcp-m0/'), 'Disposable clone required')
assert.ok(!['api', 'react', 'hypermedia'].some((kit) => clone.replace(/\/$/, '').endsWith(`/${kit}`)), 'Base fixtures must never be modified')
if (!process.argv[2]) execFileSync('bash', [resolve(root, 'spikes/clone-fixture.sh'), 'api', cloneName], { stdio: 'inherit' })
const run = (binary, args, options = {}) => execFileSync(binary, args, { cwd: clone, stdio: 'inherit', ...options })
run('npm', ['install', '@rikology/adonisjs-tenant@1.0.2', 'pg@8.16.3', 'pgsql-ast-parser@12.0.1'])
run('node', ['ace', 'configure', '@rikology/adonisjs-tenant'], { env: { ...process.env, ADONISJS_TENANT_TENANT_ID_TYPE: 'integer', ADONISJS_TENANT_USER_ID_TYPE: 'integer' } })
for (const [source, destination] of [['tenancy.ts', 'config/tenancy.ts'], ['database.ts', 'config/database.ts'], ['routes.ts', 'start/routes.ts'], ['probe_post.ts', 'app/models/probe_post.ts'], ['round2.ts', 'start/round2.ts']]) {
  copyFileSync(resolve(here, source), resolve(clone, destination))
}
const evaluatorDir = resolve(clone, 'node_modules/@sh/tenant-evaluator')
mkdirSync(evaluatorDir, { recursive: true })
writeFileSync(resolve(evaluatorDir, 'package.json'), JSON.stringify({ name: '@sh/tenant-evaluator', type: 'module', exports: './index.mjs' }))
copyFileSync(resolve(here, 'evaluator_round2.mjs'), resolve(evaluatorDir, 'index.mjs'))
run('node', ['--version'])
run('uname', ['-mrs'])
run('npm', ['ls', '@rikology/adonisjs-tenant', '@adonisjs/core', '@adonisjs/lucid', '@adonisjs/auth', '@adonisjs/assembler', '@poppinss/ts-exec', 'better-sqlite3', 'pg', 'pgsql-ast-parser'])
const pgBin = '/opt/homebrew/opt/postgresql@18/bin'
run(resolve(pgBin, 'postgres'), ['--version'])
const pgDir = mkdtempSync('/tmp/adonisjs-mcp-m0/s-h-pg-')
let pgStarted = false
let child
const captures = []
try {
  run(resolve(pgBin, 'initdb'), ['-D', pgDir, '-U', 'postgres', '--auth=trust'])
  run(resolve(pgBin, 'pg_ctl'), ['-D', pgDir, '-o', `-h 127.0.0.1 -p 55442 -k ${pgDir}`, '-l', resolve(pgDir, 'pg.log'), 'start'])
  pgStarted = true
  run(resolve(pgBin, 'psql'), ['-h', '127.0.0.1', '-p', '55442', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', resolve(here, 'rls.sql')])
  for (const [index, resolver] of ['header', 'subdomain'].entries()) {
    const port = 41140 + index
    let logs = ''
    child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], {
      cwd: clone, env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), SH_RESOLVER: resolver }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { logs += chunk; process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { logs += chunk; process.stderr.write(chunk) })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch {}
      if (ready) break
      await sleep(100)
    }
    assert.ok(ready, `App failed to start: ${logs}`)
    const response = await fetch(`http://127.0.0.1:${port}/scenario`, { signal: AbortSignal.timeout(20000) })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const result = JSON.parse(text)
    const round2Response = await fetch(`http://127.0.0.1:${port}/round2`, { signal: AbortSignal.timeout(20000) })
    const round2Text = await round2Response.text()
    assert.equal(round2Response.status, 200, round2Text)
    const round2 = JSON.parse(round2Text)
    captures.push({ resolver, port, result, round2 })
    writeFileSync(resolve(clone, 's-h-observations.json'), JSON.stringify(captures, null, 2))
    writeFileSync(resolve(here, 'observations.json'), JSON.stringify(captures, null, 2))
    console.log(JSON.stringify({ resolver, result, round2 }, null, 2))
    assert.equal(result.binding, true)
    assert.equal(result.bindingMatchesExport, true)
    assert.equal(result.modelMissing.code, 'E_TENANT_NOT_RESOLVED')
    for (const row of result.concurrent) {
      assert.deepEqual(row.model, [row.tenant])
      assert.deepEqual(row.evalIds, [row.tenant, row.tenant])
      assert.equal(row.after, row.tenant)
      assert.deepEqual(row.raw[0].tenants, [row.tenant])
      for (const attack of row.raw.slice(1)) assert.deepEqual(attack.tenants, ['a', 'b'])
      assert.equal(row.socketNoMiddleware.body.alsTenant, null)
      assert.equal(row.socketMissing.status, 404)
      assert.equal(row.socketWrong.status, 404)
      assert.deepEqual(row.socketMapped.body.rows, [row.tenant])
      const other = row.tenant === 'a' ? 'b' : 'a'
      assert.deepEqual(row.socketMappedOther.body.rows, [other])
      if (resolver === 'subdomain') assert.deepEqual(row.socketDomain.body.rows, [row.tenant])
    }
    for (const row of result.rls) for (const query of row.queries) assert.deepEqual(query.tenants, [row.tenant])
    assert.equal(result.rlsMissing.code, 'E_TENANT_NOT_RESOLVED')
    assert.deepEqual(result.rlsOutside, [])
    assert.deepEqual(result.rlsPoolSetting, [{ setting: null }])
    assert.equal(result.rlsError.ok, false)
    assert.deepEqual(result.rlsAfterError, ['b'])
    assert.deepEqual(result.rlsContextOverride, { alsTenant: 'a', rows: ['b'] })
    for (const field of ['outsideBefore', 'outsideAfter', 'outsideFinal']) assert.equal(result[field], null)
    console.log(`PASS ${resolver}: model/eval isolation, raw SQL bypasses, loopback mapping/fail-closed, forced PostgreSQL RLS and reset`)
    for (const [index, evaluation] of round2.evalResults.entries()) {
      const tenant = index === 0 ? 'a' : 'b'
      assert.deepEqual(evaluation.value, { before: tenant, after: tenant, sameModel: true, tenants: [tenant] })
      assert.ok(evaluation.hostedModule.includes('/node_modules/@sh/tenant-evaluator/'))
      assert.ok(evaluation.filename.endsWith('/eval-call.mjs') && !evaluation.filename.includes('/node_modules/'))
    }
    assert.deepEqual(round2.appBefore, round2.appAfter)
    assert.equal(round2.outsideTenant, null)
    for (const reader of round2.readers) {
      assert.notEqual(reader.readerPid, round2.appBefore.pid)
      assert.deepEqual(reader.role, { rolname: 'sh_reader', rolsuper: false, rolbypassrls: false })
      for (const observation of reader.observations) {
        assert.equal(observation.txState.readonly, 'on')
        assert.equal(observation.txState.tenant, reader.tenant)
        assert.equal(observation.queryMode, 'extended')
        assert.equal(observation.clean.tenant, null)
        assert.equal(observation.clean.readonly, 'off')
        if (['plain', 'filtered', 'or-tautology', 'comment', 'union'].includes(observation.name)) {
          assert.equal(observation.decision, 'ALLOW')
          assert.deepEqual(observation.rows.map(row => row.tenant_id), [reader.tenant])
          assert.equal(observation.error, null)
        } else {
          assert.equal(observation.decision, 'DENY')
          assert.deepEqual(observation.submitted, [])
        }
      }
      assert.match(reader.trustedDeadlineInjection.error, /canceling statement due to user request/)
      assert.deepEqual(reader.trustedDeadlineInjection.activity, { state: 'idle', xact_start: null })
      assert.deepEqual(reader.trustedDeadlineInjection.healthy, [{ healthy: 42 }])
    }
    console.log(`PASS round2 ${resolver}: app-root vm evaluator ALS/import/model identity; dedicated READ ONLY + RLS + AST + extended protocol; deadline/reset; app pool unchanged`)
    const { promise, resolve: exited } = Promise.withResolvers()
    child.once('exit', exited)
    child.kill('SIGTERM')
    const forceStop = setTimeout(() => child?.kill('SIGKILL'), 3000)
    await promise
    clearTimeout(forceStop)
    child = undefined
  }
} finally {
  if (child && child.exitCode === null) {
    const { promise, resolve: exited } = Promise.withResolvers()
    child.once('exit', exited)
    child.kill('SIGTERM')
    const forceStop = setTimeout(() => child?.kill('SIGKILL'), 3000)
    await promise
    clearTimeout(forceStop)
  }
  if (pgStarted) run(resolve(pgBin, 'pg_ctl'), ['-D', pgDir, '-m', 'fast', 'stop'])
  rmSync(pgDir, { recursive: true, force: true })
}

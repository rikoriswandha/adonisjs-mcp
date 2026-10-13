import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))
const cloneName = `s-k-api-${Date.now()}`
const clone = process.argv[2] ?? `/tmp/adonisjs-mcp-m0/${cloneName}`
if (!/^\/(?:private\/)?tmp\/adonisjs-mcp-m0\/s-k-[^/]+$/.test(path.resolve(clone))) throw new Error('Only disposable s-k-* clones are allowed')
const foreignCwd = process.argv[3] === '--foreign-cwd'
const launchCwd = foreignCwd ? path.join(clone, 'tmp/s-k-foreign-cwd') : clone
function run(command, args, cwd = clone) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`)
}
if (!process.argv[2]) run('bash', ['spikes/clone-fixture.sh', 'api', cloneName], root)
run('npm', ['install', '--save-exact', '@rikology/adonisjs-tenant@1.0.2', '@adonisjs/queue@0.6.2', '@adonisjs/bouncer@4.0.1'])
run('npm', ['ls', '@adonisjs/core', '@adonisjs/lucid', '@adonisjs/auth', '@adonisjs/assembler', '@adonisjs/bouncer', '@rikology/adonisjs-tenant', '@adonisjs/queue', '@boringnode/queue', 'better-sqlite3'])
await mkdir(path.join(clone, 'app/jobs'), { recursive: true })
await mkdir(path.join(clone, 'custom_jobs'), { recursive: true })
await mkdir(path.join(clone, 'manual_jobs'), { recursive: true })
await copyFile(path.join(here, 'external_job.ts'), path.join(clone, 'custom_jobs/external_job.ts'))
await copyFile(path.join(here, 'manual_job.ts'), path.join(clone, 'manual_jobs/manual_job.ts'))
for (const [src, dst] of [['probe_provider.ts', 'providers/s_k_probe_provider.ts'], ['sentinel_job.ts', 'app/jobs/sentinel_job.ts'], ['observations.ts', 'start/s_k_observations.ts']]) await copyFile(path.join(here, src), path.join(clone, dst))
await copyFile(path.join(here, 'config_listing.ts'), path.join(clone, 'start/s_k_config_listing.ts'))
await writeFile(path.join(clone, 'config/tenancy.ts'), `import { defineTenancyConfig } from '@rikology/adonisjs-tenant'\nexport default defineTenancyConfig({ default: 'header', tenants: { header: { resolver: 'header' } }, failOnMissing: true })\n`)
await writeFile(path.join(clone, 'config/queue.ts'), `import { defineConfig, drivers } from '@adonisjs/queue'\nexport default defineConfig({ default: 'database', adapters: { database: drivers.database({ connectionName: 'sqlite' }), sync: drivers.sync() }, locations: ['./app/jobs/**/*.ts', './custom_jobs/**/*.ts'] })\n`)
const rcPath = path.join(clone, 'adonisrc.ts')
let rc = await readFile(rcPath, 'utf8')
if (!rc.includes('s_k_probe_provider')) rc = rc.replace('  providers: [', `  providers: [\n    () => import('#providers/s_k_probe_provider'),\n    () => import('@rikology/adonisjs-tenant/providers/tenancy_provider'),\n    () => import('@adonisjs/bouncer/bouncer_provider'),\n    () => import('@adonisjs/queue/queue_provider'),`)
await writeFile(rcPath, rc)
const routesPath = path.join(clone, 'start/routes.ts')
let routes = await readFile(routesPath, 'utf8')
if (!routes.includes('s_k_observations')) routes += `\nawait import('#start/s_k_observations')\n`
await writeFile(routesPath, routes)
await mkdir(launchCwd, { recursive: true })
const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', path.join(clone, 'bin/server.ts')], { cwd: launchCwd, env: { ...process.env, PORT: '41200', HOST: '127.0.0.1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (b) => process.stdout.write(b))
child.stderr.on('data', (b) => process.stderr.write(b))
try {
  let response
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`)
    try { response = await fetch('http://127.0.0.1:41200/s-k/observe'); break } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!response) throw new Error('server readiness deadline')
  const observation = await response.json()
  console.log('OBSERVATION', JSON.stringify(observation, null, 2))
  await writeFile(path.join(clone, 's-k-observation.json'), JSON.stringify(observation, null, 2))
  await writeFile(path.join(here, foreignCwd ? 's-k-observation-foreign-cwd.json' : 's-k-observation.json'), `${JSON.stringify(observation, null, 2)}\n`)
  if (!response.ok || !observation.rowsUnchanged || observation.queue.jobExecutions !== 0 || observation.permission.policyExecutions !== 0 || !observation.queueListing.manualRegisteredLookup || observation.queueListing.rejected.length) throw new Error('probe acceptance failed')
  if (foreignCwd) {
    if (observation.queueListing.jobs.length || observation.queue.sentinelRegistered || JSON.stringify(observation.queueListing.groundTruth) !== JSON.stringify(['manual.explicit'])) throw new Error('foreign cwd loader/listing mismatch')
  } else if (!observation.queueListing.expectedConfiguredCoverage || !observation.queue.sentinelRegistered || JSON.stringify(observation.queueListing.residualGroundTruth) !== JSON.stringify(['manual.explicit'])) throw new Error('configured listing coverage failed')
  console.log('CLONE', clone)
} finally {
  child.kill('SIGTERM')
  const exited = await Promise.race([new Promise((r) => child.once('exit', () => r(true))), new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!exited) { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)) }
}

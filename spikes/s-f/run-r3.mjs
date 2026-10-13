import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const delay = async (ms) => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); await promise }
const clone = process.argv[2] || `/tmp/adonisjs-mcp-m0/s-f3-api-${Date.now()}`
if (!process.argv[2]) {
  const copied = spawnSync('bash', [root + 'spikes/clone-fixture.sh', 'api', clone.split('/').at(-1)], { stdio: 'inherit' })
  if (copied.status) throw new Error('clone failed')
}
const install = spawnSync('npm', ['install', '@rikology/adonisjs-tenant@1.0.2'], { cwd: clone, stdio: 'inherit' })
if (install.status) throw new Error('tenant install failed')
for (const [source, destination] of [['auth-r3.ts', 'config/auth.ts'], ['user-r3.ts', 'app/models/user.ts'], ['tenancy-r3.ts', 'config/tenancy.ts'], ['probe-r3.js', 'start/sf3_probe.js']]) await copyFile(root + `spikes/s-f/${source}`, clone + '/' + destination)
const rcPath = clone + '/adonisrc.ts'; let rc = await readFile(rcPath, 'utf8')
if (!rc.includes('@rikology/adonisjs-tenant/providers/tenancy_provider')) rc = rc.replace("() => import('@adonisjs/auth/auth_provider'),", "() => import('@adonisjs/auth/auth_provider'),\n    () => import('@rikology/adonisjs-tenant/providers/tenancy_provider'),")
await writeFile(rcPath, rc)
const routePath = clone + '/start/routes.ts'; const routes = await readFile(routePath, 'utf8')
if (!routes.includes('./sf3_probe.js')) await writeFile(routePath, routes + "\nimport './sf3_probe.js'\n")
const versions = spawnSync('npm', ['ls', '@rikology/adonisjs-tenant', '@adonisjs/core', '@adonisjs/auth', '@adonisjs/session', '@adonisjs/lucid', '--depth=0'], { cwd: clone, encoding: 'utf8' }).stdout
console.log(versions)
const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], { cwd: clone, env: { ...process.env, PORT: '41104', HOST: '127.0.0.1', LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; child.stdout.on('data', (value) => { logs += value }); child.stderr.on('data', (value) => { logs += value })
try {
  let ready = false
  for (let n = 0; n < 200; n++) { try { await fetch('http://127.0.0.1:41104/sf3/health'); ready = true; break } catch { await delay(100) } }
  if (!ready) throw new Error('server unavailable: ' + logs)
  const response = await fetch('http://127.0.0.1:41104/sf3/run')
  const text = await response.text()
  let secrets = []; try { secrets = JSON.parse(await readFile(clone + '/sf3-sensitive.json', 'utf8')) } catch {}
  const headers = JSON.stringify([...response.headers])
  const exposure = { candidates: secrets.length, secretsInLogs: secrets.filter((value) => logs.includes(value)).length, secretsInResult: secrets.filter((value) => text.includes(value)).length, secretsInHeaders: secrets.filter((value) => headers.includes(value)).length }
  const evidence = { versions, status: response.status, result: JSON.parse(text), exposure }
  await writeFile(clone + '/sf-round3-observations.json', JSON.stringify(evidence, null, 2))
  console.log('OBSERVED ROUND3', JSON.stringify(evidence))
} finally {
  const exited = Promise.withResolvers(); child.once('exit', exited.resolve); child.kill('SIGTERM')
  await Promise.race([exited.promise, delay(3000)])
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited.promise }
  try { await unlink(clone + '/sf3-sensitive.json') } catch {}
}

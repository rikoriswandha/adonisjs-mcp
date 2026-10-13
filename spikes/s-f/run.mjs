import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const sleep = async (ms) => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); await promise }
for (const [kit, port] of [['api', 41100], ['react', 41101]]) {
  const clone = process.argv[2] ? `${process.argv[2]}/s-f-${kit}` : `/tmp/adonisjs-mcp-m0/s-f-${kit}-${Date.now()}`
  if (!process.argv[2]) {
    const copied = spawnSync('bash', [root + 'spikes/clone-fixture.sh', kit, clone.split('/').at(-1)], { stdio: 'inherit' })
    if (copied.status) throw new Error('clone failed')
  }
  await copyFile(root + 'spikes/s-f/probe.js', clone + '/start/sf_probe.js')
  const routes = clone + '/start/routes.ts'
  const original = await readFile(routes, 'utf8')
  if (!original.includes("./sf_probe.js")) await writeFile(routes, original + "\nimport './sf_probe.js'\n")
  const versions = spawnSync('npm', ['ls', '@adonisjs/core', '@adonisjs/auth', '@adonisjs/session', '@adonisjs/shield', '@adonisjs/inertia', '@adonisjs/lucid', '@vinejs/vine', '--depth=0'], { cwd: clone, encoding: 'utf8' })
  console.log(versions.stdout)
  const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], { cwd: clone, env: { ...process.env, SF_KIT: kit, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; child.stdout.on('data', (v) => { logs += v }); child.stderr.on('data', (v) => { logs += v })
  try {
    let ready = false
    for (let n = 0; n < 200; n++) { try { await fetch(`http://127.0.0.1:${port}/sf/csrf`); ready = true; break } catch { await sleep(100) } }
    if (!ready) throw new Error('server unavailable: ' + logs)
    const response = await fetch(`http://127.0.0.1:${port}/sf/run`)
    const text = await response.text()
    console.log('OBSERVED', kit, response.status, text)
    await writeFile(clone + '/sf-observations.json', text)
    console.log('AUTH MIDDLEWARE LOGS', logs.split('\n').filter((v) => v.includes('S-F normal protected middleware')).join('\n'))
  } finally {
    const exited = Promise.withResolvers()
    child.once('exit', exited.resolve)
    child.kill('SIGTERM')
    await Promise.race([exited.promise, sleep(3000)])
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited.promise }
  }
}

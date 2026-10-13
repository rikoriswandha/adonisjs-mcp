import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const delay = async (ms) => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); await promise }
for (const [kit, port, endpoint] of [['react', 41102, '/sf/round2'], ['api', 41103, '/sf/round2-token']]) {
  const clone = process.argv[2] ? `${process.argv[2]}/s-f-${kit}` : `/tmp/adonisjs-mcp-m0/s-f-r2-${kit}-${Date.now()}`
  if (!process.argv[2]) {
    const copied = spawnSync('bash', [root + 'spikes/clone-fixture.sh', kit, clone.split('/').at(-1)], { stdio: 'inherit' })
    if (copied.status) throw new Error('clone failed')
  }
  for (const name of ['probe', 'probe-r2']) await copyFile(root + `spikes/s-f/${name}.js`, clone + `/start/sf_${name.replace('-', '_')}.js`)
  const routes = clone + '/start/routes.ts'
  let source = await readFile(routes, 'utf8')
  for (const file of ['sf_probe.js', 'sf_probe_r2.js']) if (!source.includes(`./${file}`)) source += `\nimport './${file}'\n`
  await writeFile(routes, source)
  console.log(spawnSync('npm', ['ls', '@adonisjs/http-server', '@boringnode/encryption', '@poppinss/utils', '--all'], { cwd: clone, encoding: 'utf8' }).stdout)
  const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], { cwd: clone, env: { ...process.env, SF_KIT: kit, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; child.stdout.on('data', (value) => { logs += value }); child.stderr.on('data', (value) => { logs += value })
  try {
    let ready = false
    for (let n = 0; n < 200; n++) { try { await fetch(`http://127.0.0.1:${port}/sf/csrf`); ready = true; break } catch { await delay(100) } }
    if (!ready) throw new Error('server unavailable: ' + logs)
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`)
    const text = await response.text()
    const secrets = JSON.parse(await readFile(clone + '/sf-sensitive-r2.json', 'utf8'))
    const headerText = JSON.stringify([...response.headers])
    const exposure = { logLevel: 'info', candidates: secrets.length, secretsInAppLogs: secrets.filter((value) => logs.includes(value)).length, secretsInResult: secrets.filter((value) => text.includes(value)).length, secretsInOuterHeaders: secrets.filter((value) => headerText.includes(value)).length, authRequestLogCount: logs.split('\n').filter((line) => line.includes('S-F normal protected middleware')).length }
    await unlink(clone + '/sf-sensitive-r2.json')
    console.log('OBSERVED ROUND2', kit, response.status, text)
    console.log('EXPOSURE', kit, JSON.stringify(exposure))
    await writeFile(clone + '/sf-round2-observations.json', JSON.stringify({ status: response.status, result: JSON.parse(text), exposure }, null, 2))
  } finally {
    const exited = Promise.withResolvers(); child.once('exit', exited.resolve); child.kill('SIGTERM')
    await Promise.race([exited.promise, delay(3000)])
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited.promise }
    try { await unlink(clone + '/sf-sensitive-r2.json') } catch {}
  }
}

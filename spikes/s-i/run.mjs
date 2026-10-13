import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const useExisting = process.argv.includes('--existing')
const suffix = useExisting ? '' : `-${Date.now()}`
const results = { node: process.version, os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), kits: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (s) => createHash('sha256').update(s).digest('hex')
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' } }); const body = await r.text(); return { status: r.status, body: JSON.parse(body) } }
async function until(fn, label) { let error; for (let i = 0; i < 180; i++) { try { const v = await fn(); if (v) return v } catch(e) { error = e } await sleep(500) } throw new Error(`${label}: ${error?.message ?? 'condition not observed'}`) }
async function artifacts(root) {
  const out = {}
  for (const e of await readdir(join(root, '.adonisjs'), { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const path = join(e.parentPath, e.name); const source = await readFile(path, 'utf8')
    out[path.slice(root.length + 1)] = { sha: sha(source), mtime: (await stat(path)).mtimeMs, source }
  }
  return out
}
for (const [index, kit] of ['api', 'react', 'hypermedia'].entries()) {
  const clone = `s-i-${kit}${suffix}`
  const root = `/tmp/adonisjs-mcp-m0/${clone}`
  if (!useExisting) execFileSync('bash', [join(repo, 'spikes/clone-fixture.sh'), kit, clone], { cwd: repo })
  const port = 41160 + index * 3
  const url = `http://127.0.0.1:${port}`
  const record = results.kits[kit] = { root, port }
  record.versions = execFileSync('npm', ['ls', '@adonisjs/core', '@adonisjs/assembler', '@tuyau/core', '@vinejs/vine', '@adonisjs/inertia', 'edge.js', '@adonisjs/vite', '@poppinss/ts-exec', 'hot-hook', '--json'], { cwd: root, encoding: 'utf8' })
  if (kit === 'api') execFileSync(process.execPath, [join(here, 'vine.mjs'), root, join(here, 'vine-observations.json')])
  await mkdir(join(root, 'app/validators'), { recursive: true })
  await mkdir(join(root, 'app/transformers'), { recursive: true })
  for (const file of ['probe_validator', 'probe_transformer']) await writeFile(join(root, `app/${file.includes('validator') ? 'validators' : 'transformers'}/${file}.ts`), await readFile(join(here, file + '.ts')))
  await writeFile(join(root, 'start/s_i.ts'), await readFile(join(here, 'probe_routes.ts')))
  let routes = await readFile(join(root, 'start/routes.ts'), 'utf8')
  routes += '\nimport "./s_i.js"\n'
  if (kit === 'react') {
    await mkdir(join(root, 'inertia/pages'), { recursive: true })
    await writeFile(join(root, 'inertia/pages/s_i.tsx'), "export default function Probe(props: { label: string }) { return <p>before {props.label}</p> }\n")
    routes += "router.get('/__s_i_page', ({ inertia }) => inertia.render('s_i', { label: 'direct' })).as('s_i.page')\n"
    await writeFile(join(root, 'app/controllers/s_i_pages_controller.ts'), await readFile(join(here, 'pages_controller.ts')))
    routes += "router.get('/__s_i_static', [() => import('#controllers/s_i_pages_controller'), 'static']).as('s_i.static')\nrouter.get('/__s_i_dynamic', [() => import('#controllers/s_i_pages_controller'), 'dynamic']).as('s_i.dynamic')\n"
    const vite = await readFile(join(root, 'vite.config.ts'), 'utf8')
    // In a /tmp clone, the kit's **/tmp/** ignore pattern suppresses every page change.
    await writeFile(join(root, 'vite.config.ts'), vite.replace('server: {', `server: {\n    port: ${port + 1}, strictPort: true,`).replace("'**/storage/**', '**/tmp/**'", "'**/storage/**'"))
  }
  if (kit === 'hypermedia') {
    await writeFile(join(root, 'start/s_i_edge.ts'), await readFile(join(here, 'edge_routes.ts')))
    routes += 'import "./s_i_edge.js"\n'
    await writeFile(join(root, 'resources/views/s_i.edge'), '<p>before {{ greeting }}</p>\n')
    await writeFile(join(root, 'resources/views/components/s_i.edge'), '<article>{{ $slots.main() }} {{ $slots.footer?.() }}</article>\n')
  }
  await writeFile(join(root, 'start/routes.ts'), routes)
  const child = spawn(process.execPath, ['ace', 'serve', '--hmr'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; child.stdout.on('data', (b) => logs += b); child.stderr.on('data', (b) => logs += b)
  const viteChild = kit === 'react' ? spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port + 1), '--strictPort'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) : null
  let viteLogs = ''
  viteChild?.stdout.on('data', (b) => viteLogs += b)
  viteChild?.stderr.on('data', (b) => viteLogs += b)
  try {
    record.before = await until(async () => { const r = await get(url + '/__s_i'); return r.status === 200 && r.body.revision === 'before' ? r : false }, 'server startup')
    record.artifactsBefore = await artifacts(root)
    if (kit === 'react') {
      const r = await fetch(url + '/__s_i_page', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1', Accept: 'application/json' } })
      record.inertiaResponse = { status: r.status, inertiaHeader: r.headers.get('x-inertia'), versionHeader: r.headers.get('x-inertia-version'), body: await r.json() }
      record.sharedSource = await readFile(join(root, 'app/middleware/inertia_middleware.ts'), 'utf8')
      record.inertiaConfigSource = await readFile(join(root, 'config/inertia.ts'), 'utf8')
      record.sourceOnly = JSON.parse(execFileSync(process.execPath, [join(here, 'source.mjs'), root], { encoding: 'utf8' }))
      await writeFile(join(here, 'source-observations.json'), JSON.stringify(record.sourceOnly, null, 2) + '\n')
      record.pageBefore = await (await fetch(`http://127.0.0.1:${port+1}/inertia/pages/s_i.tsx`)).text()
    }
    if (kit === 'hypermedia') {
      record.edgeBefore = await get(url + '/__s_i_edge')
      record.edgeTraversal = await get(url + '/__s_i_edge?view=..%2F..%2F.env')
    }
    const validatorPath = join(root, 'app/validators/probe_validator.ts')
    await writeFile(validatorPath, (await readFile(validatorPath, 'utf8')).replace('minLength(3)', 'minLength(7)').replace("'before'", "'after'"))
    record.validatorAfter = await until(async () => { const r = await get(url + '/__s_i'); return r.status === 200 && r.body.revision === 'after' ? r : false }, 'validator freshness')
    const transformerPath = join(root, 'app/transformers/probe_transformer.ts')
    await writeFile(transformerPath, (await readFile(transformerPath, 'utf8')).replace("revision: 'before'", "revision: 'after', added: true"))
    record.transformerAfter = await until(async () => { const r = await get(url + '/__s_i'); return r.status === 200 && r.body.transformed.revision === 'after' ? r : false }, 'transformer freshness')
    if (kit === 'react') {
      await writeFile(join(root, 'inertia/pages/s_i.tsx'), "export default function Probe(props: { label: string, added: boolean }) { return <p>after {props.label}</p> }\n")
      record.pageAfter = await until(async () => { const s = await (await fetch(`http://127.0.0.1:${port+1}/inertia/pages/s_i.tsx`)).text(); return s.includes('after') ? s : false }, 'page freshness')
      await writeFile(join(root, 'inertia/pages/s_i_added.tsx'), 'export default function Added() { return <p>added</p> }\n')
      await until(async () => (await readFile(join(root, '.adonisjs/server/pages.d.ts'), 'utf8')).includes('s_i_added'), 'page inventory regeneration')
      await writeFile(join(root, 'app/transformers/added_transformer.ts'), "import { BaseTransformer } from '@adonisjs/core/transformers'\nexport default class AddedTransformer extends BaseTransformer<{ok:boolean}> { toObject() { return {ok:this.resource.ok} } }\n")
      await until(async () => (await readFile(join(root, '.adonisjs/client/data.d.ts'), 'utf8')).includes('AddedTransformer'), 'transformer inventory regeneration')
    }
    if (kit === 'hypermedia') {
      await writeFile(join(root, 'resources/views/s_i.edge'), '<p>after {{ greeting }}</p>\n')
      record.edgeAfter = await until(async () => { const r = await get(url + '/__s_i_edge'); return r.status === 200 && r.body.html.includes('after') ? r : false }, 'edge freshness')
    }
    await writeFile(join(root, 'start/routes.ts'), routes + "\nrouter.get('/__s_i_added', () => ({ added: true })).as('s_i.added')\n")
    record.routeAfter = await until(async () => { const r = await get(url + '/__s_i_added'); return r.status === 200 ? r : false }, 'route freshness')
    if (Object.hasOwn(record.artifactsBefore, '.adonisjs/client/registry/index.ts')) {
      await until(async () => (await readFile(join(root, '.adonisjs/client/registry/index.ts'), 'utf8')).includes('s_i.added'), 'Tuyau registry regeneration')
      record.registryRuntime = execFileSync(process.execPath, ['--import=@poppinss/ts-exec', '--input-type=module', '-e', "const {registry}=await import('./.adonisjs/client/registry/index.ts');console.log(JSON.stringify(registry))"], { cwd: root, encoding: 'utf8' }).trim()
    } else record.registryCapability = 'absent-no-Tuyau-hook'
    record.artifactsAfter = await artifacts(root)
    record.freshness = Object.fromEntries(Object.entries(record.artifactsAfter).map(([name, a]) => [name, { changed: a.sha !== record.artifactsBefore[name]?.sha, rewritten: a.mtime !== record.artifactsBefore[name]?.mtime }]))
  } catch (error) { record.error = error.stack; console.error(kit, error.message) }
  finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    if (viteChild) { try { process.kill(-viteChild.pid, 'SIGTERM') } catch {} }
    await sleep(1500)
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    if (viteChild) { try { process.kill(-viteChild.pid, 'SIGKILL') } catch {} }
    record.viteLog = viteLogs
    record.serverLog = logs.replace(/\u001b\[[0-9;]*m/g, '')
    if (record.registryRuntime && record.artifactsAfter) {
      const registryFile = join(root, '.adonisjs/client/registry/index.ts')
      const fresh = await readFile(registryFile, 'utf8')
      try {
        await writeFile(registryFile, record.artifactsBefore['.adonisjs/client/registry/index.ts'].source)
        const stale = execFileSync(process.execPath, ['--input-type=module', '-e', "const {registry}=await import('./.adonisjs/client/registry/index.ts');console.log(Object.hasOwn(registry.routes,'s_i.added'))"], { cwd: root, encoding: 'utf8' }).trim()
        record.staleDetection = { runtimeRoutePreviouslyObserved: record.routeAfter.status, generatedHasAdded: stale, result: stale === 'false' ? 'STALE' : 'UNEXPECTED' }
        await rename(registryFile, registryFile + '.s_i_saved')
        try { await stat(registryFile) } catch (error) { record.missingDetection = error.code }
      } finally {
        try { await rename(registryFile + '.s_i_saved', registryFile) } catch {}
        await writeFile(registryFile, fresh)
      }
    }
    await writeFile(join(here, 'observations.json'), JSON.stringify(results, null, 2) + '\n')
  }
  console.log(JSON.stringify({ kit, error: record.error, before: record.before?.body.revision, validatorAfter: record.validatorAfter?.body.revision, transformerAfter: record.transformerAfter?.body.transformed, routeAfter: record.routeAfter?.status, freshness: record.freshness }))
}
if (Object.values(results.kits).some((kit) => kit.error)) process.exitCode = 1

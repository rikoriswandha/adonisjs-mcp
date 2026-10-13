import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = []
const log = (event, value) => { const line = JSON.stringify({ event, ...value }); output.push(line); console.log(line) }
const command = (args, cwd) => { const p = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }); if (p.status) throw Error(p.stdout + p.stderr); return p.stdout }
for (const [index, kit] of ['react', 'api'].entries()) {
  const clone = `/tmp/adonisjs-mcp-m0/s-a-${kit}`
  if (!existsSync(clone)) command(['bash', 'spikes/clone-fixture.sh', kit, `s-a-${kit}`], root)
  command(['npm', 'install', '--save-exact', '@modelcontextprotocol/server@2.3.1', '@modelcontextprotocol/node@2.1.1', '@modelcontextprotocol/client@2.3.1', 'zod@4.6.7'], clone)
  log('versions', { kit, node: process.version, packages: command(['npm', 'ls', '@adonisjs/core', '@adonisjs/http-server', '@adonisjs/bodyparser', '@adonisjs/shield', '@modelcontextprotocol/server', '@modelcontextprotocol/node', '@modelcontextprotocol/client', 'zod'], clone) })
  await copyFile(new URL('probe.ts', import.meta.url), `${clone}/start/sa_probe.ts`)
  const routes = `${clone}/start/routes.ts`
  let text = await readFile(routes, 'utf8')
  if (!text.includes("import './sa_probe.js'")) await writeFile(routes, text + "\nimport './sa_probe.js'\n")
  const shield = `${clone}/config/shield.ts`
  text = await readFile(shield, 'utf8')
  await writeFile(shield, text.replace('exceptRoutes: [],', "exceptRoutes: ['/__adonis/mcp'],").replace(/(csrf:\s*\{[\s\S]*?enabled:) false/, '$1 true'))
  const exceptions = `${clone}/app/exceptions/handler.ts`
  const exceptionSource = await readFile(exceptions, 'utf8')
  if (!exceptionSource.includes('SA_EXCEPTION')) await writeFile(exceptions, exceptionSource.replace('return super.handle(error, ctx)', "console.log('SA_EXCEPTION', JSON.stringify({ code: (error as any)?.code, status: (error as any)?.status, message: (error as any)?.message })); return super.handle(error, ctx)"))
  if (kit === 'api') {
    const middleware = `${clone}/app/middleware/force_json_response_middleware.ts`
    const source = await readFile(middleware, 'utf8')
    if (!source.includes("ctx.request.url() !== '/__adonis/mcp'")) await writeFile(middleware, source.replace("ctx.request.request.headers.accept = 'application/json'", "if (ctx.request.url() !== '/__adonis/mcp') ctx.request.request.headers.accept = 'application/json'"))
  }
  const port = 41000 + index
  const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], { cwd: clone, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (b) => { logs += b; process.stdout.write(b) })
  child.stderr.on('data', (b) => { logs += b; process.stdout.write(b) })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let n = 0; n < 100; n++) { try { await fetch(`${base}/__adonis/mcp`); break } catch { await new Promise(r => setTimeout(r, 100)) } }
    const require = createRequire(`${clone}/package.json`)
    const { Client, StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/client'))
    const capture = async (input, init) => {
      const request = new Request(input, init)
      const body = request.method === 'POST' ? await request.clone().text() : ''
      const response = await fetch(request, { redirect: 'manual' })
      const content = await response.clone().text()
      log('http', { kit, method: request.method, headers: Object.fromEntries([...request.headers].filter(([k]) => !['cookie', 'authorization'].includes(k))), request: body.length > 2000 ? `[${body.length} bytes]` : body, status: response.status, responseHeaders: Object.fromEntries([...response.headers].filter(([k]) => k !== 'set-cookie')), body: content.length > 3000 ? `[${content.length} bytes]` : content })
      return response
    }
    for (const era of ['modern', 'legacy']) {
      const clients = await Promise.all([0, 1].map(async n => {
        const client = new Client({ name: `sa-${era}-${n}`, version: '1' }, { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } })
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/__adonis/mcp`), { fetch: capture })
        await client.connect(transport)
        return client
      }))
      await Promise.all(clients.map(async client => {
        log('list', { kit, era, result: await client.listTools() })
        log('call', { kit, era, result: await client.callTool({ name: 'app_profile', arguments: {} }) })
        await client.notification({ method: 'notifications/cancelled', params: { requestId: 999, reason: 'spike unknown completed request' } })
      }))
      await Promise.all(clients.map(client => client.close()))
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    await capture(`${base}/__adonis/mcp`, { method: 'POST', headers, body: '{bad' })
    await capture(`${base}/__adonis/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2099-01-01' }, body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list' }) })
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'sa-raw', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} }
    await capture(`${base}/__adonis/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call' }, body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list', params: { _meta: meta } }) })
    await capture(`${base}/__adonis/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 93, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }) })
    await capture(`${base}/__adonis/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' }, body: JSON.stringify({ jsonrpc: '2.0', id: 94, method: 'tools/list', params: { _meta: meta } }) })
    for (const method of ['GET', 'DELETE']) await capture(`${base}/__adonis/mcp`, { method, headers: { ...headers, 'mcp-protocol-version': '2026-07-28' } })
    await capture(`${base}/__adonis/mcp`, { method: 'GET', headers })
    await capture(`${base}/__adonis/mcp`, { method: 'DELETE', headers })
    await capture(`${base}/__adonis/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/list', params: { padding: 'x'.repeat(1024 * 1024 + 1) } }) })
    for (const path of ['/sa/csrf-control', '/__adonis/mcp-extra']) await capture(`${base}${path}`, { method: 'POST', headers, body: '{"normal":true}' })
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    log('logs', { kit, headersSentError: logs.includes('ERR_HTTP_HEADERS_SENT'), serializationFailure: logs.includes('Response serialization failed'), logs })
  }
}
await writeFile(new URL('observations.jsonl', import.meta.url), output.join('\n') + '\n')

import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'
let instances = 0
const handler = createMcpHandler((context) => {
  const instance = ++instances
  console.log('SA_FACTORY', JSON.stringify({ instance, era: context.era }))
  const server = new McpServer({ name: 'adonis-sa', version: '0.0.0' })
  server.registerTool('app_profile', { description: 'Inspect the running Adonis application', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ inDev: app.inDev, routes: Object.values(router.toJSON()).flat().length, instance }) }] }))
  return server
}, { maxRequestBodySize: 1024 * 1024, onerror: (error) => console.log('SA_SDK_ERROR', error.message) })
const bridge = toNodeHandler(handler, { maxRequestBodySize: 1024 * 1024, onerror: (error) => console.log('SA_BRIDGE_ERROR', error.message) })
app.terminating(() => handler.close())
router.any('/__adonis/mcp', async (ctx) => {
  const req = ctx.request.request
  const parsed = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method!) ? ctx.request.body() : undefined
  console.log('SA_BEFORE', JSON.stringify({ method: req.method, remoteAddress: req.socket.remoteAddress, readableEnded: req.readableEnded, parsedKeys: parsed ? Object.keys(parsed) : [] }))
  ctx.response.relayHeaders()
  await bridge(req, ctx.response.response, parsed)
  console.log('SA_AFTER', JSON.stringify({ finished: ctx.response.finished, pending: ctx.response.isPending, writableEnded: ctx.response.response.writableEnded }))
})
router.post('/sa/csrf-control', ({ request }) => ({ received: request.body() }))
router.post('/__adonis/mcp-extra', () => ({ shouldNotPass: true }))

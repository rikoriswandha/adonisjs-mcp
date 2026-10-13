import { test } from '@japa/runner'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { ApplicationService } from '@adonisjs/core/types'
import { createServer } from '../../src/server.js'
import { resolveConfig } from '../../src/define_config.js'
import { Redactor } from '../../src/redaction.js'
import { defineTool } from '../../src/define_tool.js'
import { z } from 'zod'
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'

test('Server | app tool and prompt failures are redacted at the protocol boundary', async ({
  assert,
}) => {
  const secret = 'AppPromptSecret-123456789'
  const server = await createServer({
    app: {} as ApplicationService,
    config: resolveConfig({}),
    snapshot: {
      tools: [
        defineTool({
          name: 'app_tool_failure',
          description: 'App failure',
          inputSchema: z.object({}),
          handler() {
            throw new Error(`app-derived ${secret}`)
          },
        }),
      ],
      resources: [],
      disabledTools: [],
      wrappers: [],
      prompts: [
        {
          name: 'app_failure',
          description: 'App prompt',
          get() {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `app-derived ${secret}`, {
              nested: { neutral: secret },
            })
          },
        },
      ],
    },
    redactor: new Redactor([secret]),
    version: '0.0.0',
    logs: null,
    exceptions: null,
    tenancy: null,
    detectProfile: () => Promise.reject(new Error('profile not requested')),
  })
  const client = new Client({ name: 'prompt-regression', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const failure = await client.callTool({ name: 'app_tool_failure', arguments: {} })
    assert.isTrue(failure.isError)
    assert.include(JSON.stringify(failure), '[REDACTED]')
    assert.notInclude(JSON.stringify(failure), secret)
    try {
      await client.getPrompt({ name: 'app_failure' })
      assert.fail('prompt must fail')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !('data' in error)) throw error
      assert.include(error.message, 'app-derived [REDACTED]')
      assert.equal(error.code, -32602)
      assert.deepEqual(error.data, { nested: { neutral: '[REDACTED]' } })
    }
  } finally {
    await client.close()
    await server.close()
  }
})

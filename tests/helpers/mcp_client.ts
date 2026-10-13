import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

/**
 * MCP protocol eras exercised by the suite: `modern` pins revision
 * 2026-07-28 (per-request metadata, no initialize); `legacy` performs the
 * 2025-11-25 initialize handshake.
 */
export type ProtocolEra = 'modern' | 'legacy'

export interface McpClientOptions {
  era: ProtocolEra

  /**
   * Custom fetch, e.g. to record raw HTTP exchanges.
   */
  fetch?: typeof fetch
}

/**
 * Connects the official MCP client to `endpoint`. Callers own the client
 * and must `close()` it.
 */
export async function connectMcpClient(endpoint: URL, options: McpClientOptions): Promise<Client> {
  const client = new Client(
    { name: `adonisjs-mcp-tests-${options.era}`, version: '0.0.0' },
    { versionNegotiation: { mode: options.era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } }
  )
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  await client.connect(transport)
  return client
}

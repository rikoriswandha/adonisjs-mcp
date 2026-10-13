/*
|--------------------------------------------------------------------------
| Loopback HTTP client
|--------------------------------------------------------------------------
|
| One HTTP/1.1 exchange over a fresh connection (no agent, no keep-alive
| pool shared between calls). `node:http` is used instead of `fetch`
| because `Host` must be set explicitly for domain routes. The response
| body is read up to a byte budget; past it the connection is closed and
| the body is marked truncated, so a large response never materializes in
| the application process.
|
*/

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'

export interface OutgoingExchange {
  connect: string
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: Buffer
  signal: AbortSignal
  maxBodyBytes: number
}

export interface ExchangeResult {
  status: number
  statusText: string
  headers: IncomingHttpHeaders
  setCookies: string[]
  body: Buffer

  /**
   * The body was cut at `maxBodyBytes`.
   */
  truncated: boolean
  durationMs: number
}

/**
 * Sends one request. Rejects with the signal reason when aborted, or with
 * the network error; HTTP error statuses resolve normally.
 */
export function exchange(outgoing: OutgoingExchange): Promise<ExchangeResult> {
  const started = performance.now()
  const { promise, resolve, reject } = Promise.withResolvers<ExchangeResult>()
  let settled = false
  const settle = (action: () => void) => {
    if (!settled) {
      settled = true
      action()
    }
  }

  const headers = { ...outgoing.headers }
  if (outgoing.body !== undefined) {
    headers['content-length'] = String(outgoing.body.byteLength)
  }
  const client = httpRequest({
    host: outgoing.connect,
    port: outgoing.port,
    method: outgoing.method,
    path: outgoing.path,
    headers,
    agent: false,
    setHost: false,
    signal: outgoing.signal,
  })

  client.on('error', (error) => {
    settle(() => reject(outgoing.signal.aborted ? outgoing.signal.reason : error))
  })

  client.on('response', (response) => {
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    const finish = () =>
      settle(() =>
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
          setCookies: response.headers['set-cookie'] ?? [],
          body: Buffer.concat(chunks),
          truncated,
          durationMs: performance.now() - started,
        })
      )
    response.on('data', (chunk: Buffer) => {
      if (truncated) {
        return
      }
      const room = outgoing.maxBodyBytes - size
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, Math.max(room, 0)))
        size = outgoing.maxBodyBytes
        truncated = true
        finish()
        response.destroy()
        return
      }
      chunks.push(chunk)
      size += chunk.byteLength
    })
    response.on('end', finish)
    response.on('error', (error) => {
      settle(() => reject(outgoing.signal.aborted ? outgoing.signal.reason : error))
    })
    response.on('close', () => {
      if (!response.complete && !truncated) {
        settle(() =>
          reject(
            outgoing.signal.aborted
              ? outgoing.signal.reason
              : new Error('The application closed the connection before the response ended')
          )
        )
      }
    })
  })

  client.end(outgoing.body)
  return promise
}

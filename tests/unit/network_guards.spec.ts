import { test } from '@japa/runner'
import {
  MCP_CALL_HEADER,
  checkRequest,
  isLoopbackAddress,
  type NetworkPolicy,
  type RequestFacts,
} from '../../src/guards/network.js'

const LOCAL: NetworkPolicy = { allowRemoteAccess: false, allowedHosts: [], allowedOrigins: [] }
const PORT = 3333

function request(
  headers: Array<[string, string]>,
  overrides: Partial<Omit<RequestFacts, 'rawHeaders'>> = {}
): RequestFacts {
  return {
    remoteAddress: '127.0.0.1',
    localPort: PORT,
    rawHeaders: headers.flat(),
    ...overrides,
  }
}

function verdict(facts: RequestFacts, policy: NetworkPolicy = LOCAL): string {
  const result = checkRequest(facts, policy)
  return result.allowed ? 'allowed' : result.reason
}

test.group('Network guards | peer', () => {
  test('recognizes loopback addresses only', ({ assert }) => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ]) {
      assert.isTrue(isLoopbackAddress(address), address)
    }
    for (const address of ['10.0.0.1', '::ffff:10.0.0.1', '::', '0.0.0.0', 'localhost', '']) {
      assert.isFalse(isLoopbackAddress(address), address)
    }
  })

  test('uses the socket address, never forwarding headers', ({ assert }) => {
    const spoofed = request(
      [
        ['Host', `localhost:${PORT}`],
        ['X-Forwarded-For', '127.0.0.1'],
        ['Forwarded', 'for=127.0.0.1'],
        ['X-Real-IP', '127.0.0.1'],
      ],
      { remoteAddress: '192.168.1.20' }
    )
    assert.match(verdict(spoofed), /peer address is not loopback/)
    assert.match(
      verdict(request([['Host', `localhost:${PORT}`]], { remoteAddress: undefined })),
      /peer/
    )
  })

  test('allowRemoteAccess opens the peer check only', ({ assert }) => {
    const remote: NetworkPolicy = { ...LOCAL, allowRemoteAccess: true }
    const lanHost = request([['Host', `192.168.1.5:${PORT}`]], { remoteAddress: '192.168.1.20' })
    assert.match(verdict(lanHost, remote), /Host "192.168.1.5:3333" is not allowed/)
    assert.equal(verdict(lanHost, { ...remote, allowedHosts: [`192.168.1.5:${PORT}`] }), 'allowed')
    const foreignOrigin = request(
      [
        ['Host', `192.168.1.5:${PORT}`],
        ['Origin', 'http://evil.example'],
      ],
      { remoteAddress: '192.168.1.20' }
    )
    assert.match(
      verdict(foreignOrigin, { ...remote, allowedHosts: [`192.168.1.5:${PORT}`] }),
      /Origin/
    )
  })
})

test.group('Network guards | Host', () => {
  test('accepts loopback names on the port the request arrived on', ({ assert }) => {
    for (const host of [
      `localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
      `[::1]:${PORT}`,
      `LOCALHOST:${PORT}`,
    ]) {
      assert.equal(verdict(request([['Host', host]])), 'allowed', host)
    }
    assert.equal(verdict(request([['Host', 'localhost']], { localPort: 80 })), 'allowed')
  })

  test('rejects hostile and malformed Host headers', ({ assert }) => {
    const hostile = [
      `localhost.evil.example:${PORT}`,
      `evil.example:${PORT}`,
      `user@localhost:${PORT}`,
      `localhost:${PORT + 1}`,
      'localhost',
      `localhost:${PORT}x`,
      'localhost:',
      'localhost:99999',
      `localhost:${PORT}/path`,
      `localhost.:${PORT}`,
      '',
    ]
    for (const host of hostile) {
      assert.notEqual(verdict(request([['Host', host]])), 'allowed', host)
    }
  })

  test('rejects missing and repeated Host headers', ({ assert }) => {
    assert.match(verdict(request([])), /Host header is missing/)
    assert.match(
      verdict(
        request([
          ['Host', `localhost:${PORT}`],
          ['host', `evil.example:${PORT}`],
        ])
      ),
      /Host header is repeated/
    )
  })

  test('accepts allowedHosts entries exactly', ({ assert }) => {
    const policy = { ...LOCAL, allowedHosts: ['dev.test:3333'] }
    assert.equal(verdict(request([['Host', 'dev.test:3333']]), policy), 'allowed')
    assert.notEqual(verdict(request([['Host', 'dev.test']]), policy), 'allowed')
    assert.notEqual(verdict(request([['Host', 'sub.dev.test:3333']]), policy), 'allowed')
  })
})

test.group('Network guards | Origin', () => {
  const host: [string, string] = ['Host', `localhost:${PORT}`]

  test('accepts requests without Origin and exact local origins', ({ assert }) => {
    assert.equal(verdict(request([host])), 'allowed')
    for (const origin of [
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
      `http://[::1]:${PORT}`,
    ]) {
      assert.equal(verdict(request([host, ['Origin', origin]])), 'allowed', origin)
    }
  })

  test('rejects null, opaque, foreign and mismatched origins', ({ assert }) => {
    const hostile = [
      'null',
      'file://',
      `http://localhost:${PORT + 1}`,
      'http://localhost',
      `https://localhost:${PORT}`,
      `http://localhost.evil.example:${PORT}`,
      'http://evil.example',
      `http://localhost:${PORT}/path`,
      'not a url',
    ]
    for (const origin of hostile) {
      assert.notEqual(verdict(request([host, ['Origin', origin]])), 'allowed', origin)
    }
    assert.match(
      verdict(
        request([host, ['Origin', `http://localhost:${PORT}`], ['Origin', 'http://evil.example']])
      ),
      /Origin header is repeated/
    )
  })

  test('accepts allowedOrigins entries exactly', ({ assert }) => {
    const policy = { ...LOCAL, allowedOrigins: ['https://dev.test'] }
    assert.equal(verdict(request([host, ['Origin', 'https://dev.test']]), policy), 'allowed')
    assert.notEqual(verdict(request([host, ['Origin', 'http://dev.test']]), policy), 'allowed')
  })
})

test.group('Network guards | recursion', () => {
  test('rejects requests issued by MCP tools', ({ assert }) => {
    assert.match(
      verdict(
        request([
          ['Host', `localhost:${PORT}`],
          [MCP_CALL_HEADER, '1'],
        ])
      ),
      /issued by MCP tools/
    )
  })
})

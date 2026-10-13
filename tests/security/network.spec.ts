import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { test } from '@japa/runner'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import {
  installPackage,
  writeMcpConfig,
  waitForMcp,
  INITIALIZE_BODY,
} from '../helpers/mcp_endpoint.js'

function socketStatus(app: RunningApp, target: string, headers: string[], address = '127.0.0.1') {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const socket = connect({ port: app.port, host: address })
  let received = ''
  socket.setTimeout(10000, () => socket.destroy(new Error('socket response deadline')))
  socket.on('error', reject)
  socket.on('close', () => reject(new Error(`socket closed without an HTTP status for ${target}`)))
  socket.on('data', (chunk) => {
    received += chunk.toString()
    const status = /^HTTP\/1\.1 (\d{3})/.exec(received)
    if (status) {
      resolve(Number(status[1]))
      socket.destroy()
    }
  })
  socket.on('connect', () =>
    socket.write(
      `POST ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(INITIALIZE_BODY)}\r\nConnection: close\r\n\r\n${INITIALIZE_BODY}`
    )
  )
  return promise
}

test.group('Security | socket boundary', (group) => {
  let fixture: FixtureApp
  let app: RunningApp
  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    await installPackage(fixture)
    app = await fixture.start({ nodeEnv: 'development', host: '::' })
    await waitForMcp(app)
    return () => fixture.dispose()
  })

  test('dual-stack loopback peers work while spoofed forwarding cannot open a LAN peer', async ({
    assert,
  }) => {
    const allowed = [`Host: localhost:${app.port}`, `Origin: http://localhost:${app.port}`]
    assert.equal(await socketStatus(app, '/__adonis/mcp', allowed, '::1'), 200)
    assert.equal(await socketStatus(app, '/__adonis/mcp', allowed), 200)
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && !entry.internal && entry.family === 'IPv4')
    assert.exists(lan, 'this live security gate requires a LAN interface')
    assert.equal(
      await socketStatus(
        app,
        '/__adonis/mcp',
        [...allowed, 'X-Forwarded-For: 127.0.0.1', 'Forwarded: for="[::1]";host=localhost'],
        lan!.address
      ),
      403
    )
  })

  test('wire authority ambiguity and endpoint aliases never dispatch an MCP initialize', async ({
    assert,
  }) => {
    for (const host of [
      `localhost.evil.example:${app.port}`,
      `127.0.0.1.nip.io:${app.port}`,
      `user@localhost:${app.port}`,
      `localhost:invalid`,
      `localhost:${app.port + 1}`,
      `localhost.:${app.port}`,
    ]) {
      assert.equal(await socketStatus(app, '/__adonis/mcp', [`Host: ${host}`]), 403, host)
    }
    assert.equal(
      await socketStatus(app, '/__adonis/mcp', [
        `Host: localhost:${app.port}`,
        `Host: localhost:${app.port}`,
      ]),
      403
    )
    for (const origin of [
      'null',
      'data:text/plain,hello',
      'file://',
      `http://localhost:${app.port + 1}`,
      `http://localhost.:${app.port}`,
      `http://localhost.evil.example:${app.port}`,
    ]) {
      assert.equal(
        await socketStatus(app, '/__adonis/mcp', [
          `Host: localhost:${app.port}`,
          `Origin: ${origin}`,
        ]),
        403,
        origin
      )
    }
    // Scheme/host casing is URL-normalized, not a different authority.
    assert.equal(
      await socketStatus(app, '/__adonis/mcp', [
        `Host: LOCALHOST:${app.port}`,
        `Origin: HTTP://LOCALHOST:${app.port}`,
      ]),
      200
    )
    for (const path of [
      '/__adonis/mcp/',
      '/__ADONIS/mcp',
      '/__adonis%2Fmcp',
      '//__adonis/mcp',
      '/x/../__adonis/mcp',
      `http://localhost:${app.port}/__adonis/mcp`,
    ]) {
      assert.notEqual(await socketStatus(app, path, [`Host: localhost:${app.port}`]), 200, path)
    }
  })

  test('remote opt-in changes only peer admission, never authority validation', async ({
    assert,
  }) => {
    await app.stop()
    await writeMcpConfig(fixture, '  allowRemoteAccess: true,')
    app = await fixture.start({ nodeEnv: 'development', host: '0.0.0.0' })
    await waitForMcp(app)
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && !entry.internal && entry.family === 'IPv4')!
    assert.equal(
      await socketStatus(app, '/__adonis/mcp', [`Host: localhost:${app.port}`], lan.address),
      200
    )
    assert.equal(
      await socketStatus(app, '/__adonis/mcp', [`Host: evil.example:${app.port}`], lan.address),
      403
    )
    assert.equal(
      await socketStatus(
        app,
        '/__adonis/mcp',
        [`Host: localhost:${app.port}`, 'Origin: https://evil.example'],
        lan.address
      ),
      403
    )
  })
})

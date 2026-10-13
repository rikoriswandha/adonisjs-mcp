import { test } from '@japa/runner'
import { resolveConfig } from '../../src/define_config.js'
import { CookieJar, parseSetCookie } from '../../src/http/cookie_jar.js'
import { decideSurface, routeAuth, surfaceHeaders } from '../../src/http/surface.js'
import { outlineHtml, summarizeBody, validationErrors } from '../../src/http/summary.js'
import {
  loopbackAddress,
  parseRequestPath,
  redirectTarget,
  validateHeaders,
} from '../../src/http/target.js'
import type { ProjectProfile, SurfaceReport } from '../../src/types.js'
import { ToolError } from '../../src/errors.js'

const MCP = '/__adonis/mcp'

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ToolError ? error.code : 'unexpected'
  }
  return undefined
}

test.group('http_request | request target', () => {
  test('only application paths are accepted; the MCP endpoint is unreachable by any alias', ({
    assert,
  }) => {
    for (const path of [
      MCP,
      '/__adonis/mcp/',
      '/__ADONIS/MCP',
      '/__adonis/%6Dcp',
      '/__adonis/%256dcp',
      '/__adonis//mcp',
      '/x/../__adonis/mcp',
      '/__adonis/./mcp?x=1',
      '/__adonis/mcp/deeper',
      'http://evil.test/',
      '//evil.test/x',
      '/a\\b',
      '/a b',
      '/a#fragment',
      'relative',
    ]) {
      assert.equal(
        codeOf(() => parseRequestPath(path, MCP)),
        'INPUT_INVALID',
        path
      )
    }
    assert.deepEqual(parseRequestPath('/api/./v1/../v2/posts?page=2', MCP), {
      pathname: '/api/v2/posts',
      search: '?page=2',
      path: '/api/v2/posts?page=2',
    })
    assert.equal(parseRequestPath('/__adonis/mcpx', MCP).pathname, '/__adonis/mcpx')
  })

  test('redirects are followable only within the same origin and outside the endpoint', ({
    assert,
  }) => {
    const current = { host: '127.0.0.1:3333', path: '/posts' }
    assert.deepEqual(redirectTarget('/dashboard?tab=1', current, MCP), {
      followable: true,
      path: { pathname: '/dashboard', search: '?tab=1', path: '/dashboard?tab=1' },
    })
    assert.isTrue(redirectTarget('http://127.0.0.1:3333/login', current, MCP).followable)
    for (const location of [
      'http://127.0.0.1:4444/login',
      'http://localhost:3333/login',
      'https://127.0.0.1:3333/login',
      '//evil.test/x',
      'http://user:pass@127.0.0.1:3333/',
      '/__adonis/%6dcp',
      MCP,
    ]) {
      assert.isFalse(redirectTarget(location, current, MCP).followable, location)
    }
  })

  test('headers owned by the tool cannot be supplied', ({ assert }) => {
    for (const name of [
      'Host',
      'Cookie',
      'Authorization',
      'X-Inertia',
      'X-Inertia-Version',
      'X-CSRF-Token',
      'X-Request-Id',
      'X-Forwarded-For',
      'Forwarded',
      'Content-Length',
      'x-adonisjs-mcp-call',
      'X-Tenant-ID',
    ]) {
      assert.equal(
        codeOf(() => validateHeaders({ [name]: 'x' }, new Map([['x-tenant-id', 'tenant']]))),
        'INPUT_INVALID',
        name
      )
    }
    assert.equal(
      codeOf(() => validateHeaders({ 'X-Trace': 'a\r\nInjected: 1' })),
      'INPUT_INVALID'
    )
    assert.equal(
      codeOf(() => validateHeaders({ 'Bad Name': 'x' })),
      'INPUT_INVALID'
    )
    assert.equal(
      codeOf(() => validateHeaders({ Accept: 'a', accept: 'b' })),
      'INPUT_INVALID'
    )
    assert.deepEqual(validateHeaders({ 'Accept-Language': 'id', 'X-Trace': 'a\tb' }), {
      'accept-language': 'id',
      'x-trace': 'a\tb',
    })
  })

  test('wildcard binds are reached through loopback of the same family', ({ assert }) => {
    const server = (address: unknown) => ({ address: () => address })
    assert.deepEqual(loopbackAddress(server({ address: '0.0.0.0', port: 3333 })), {
      connect: '127.0.0.1',
      port: 3333,
      host: '127.0.0.1:3333',
    })
    assert.deepEqual(loopbackAddress(server({ address: '::', port: 3333 })), {
      connect: '::1',
      port: 3333,
      host: '[::1]:3333',
    })
    assert.property(loopbackAddress(server('/tmp/app.sock')), 'reason')
    assert.property(loopbackAddress(server(null)), 'reason')
  })
})

test.group('http_request | cookie jar', () => {
  test('deleted cookies leave the jar and set cookies pass through the transform', ({ assert }) => {
    const jar = new CookieJar((name, value) =>
      name === 'refused' ? null : name === 'session' ? `bounded-${value}` : value
    )
    jar.set('session', 'minted')
    jar.set('theme', 'dark')
    const update = jar.absorb([
      'session=fresh; Path=/; HttpOnly',
      'theme=; Max-Age=0; Path=/',
      'refused=e%3Aabc; Path=/',
      'old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ])
    assert.deepEqual(update, {
      set: ['session'],
      cleared: ['theme', 'old'],
      dropped: ['refused'],
    })
    assert.equal(jar.header(), 'session=bounded-fresh')
    assert.includeMembers(jar.secrets(), ['minted', 'fresh', 'bounded-fresh', 'e:abc'])
    jar.clear()
    assert.isUndefined(jar.header())
  })

  test('Set-Cookie values keep "=" and attributes are not part of the value', ({ assert }) => {
    assert.deepEqual(parseSetCookie('token=a=b=; Path=/; Max-Age=60'), {
      name: 'token',
      value: 'a=b=',
      cleared: false,
    })
    assert.isUndefined(parseSetCookie('no-pair'))
  })
})

function surface(renderer: 'inertia' | 'edge' | null, prefix: string | null): SurfaceReport {
  return { ...(renderer ? { renderer } : {}), prefix, guard: null, evidence: [] }
}

function profile(options: {
  web: SurfaceReport | null
  api: SurfaceReport | null
  default: 'web' | 'api' | null
}): ProjectProfile {
  return {
    surfaces: { web: options.web, api: options.api, default: options.default },
  } as ProjectProfile
}

test.group('http_request | surface', () => {
  const hybrid = profile({
    web: surface('inertia', null),
    api: surface(null, '/api'),
    default: null,
  })
  const drivers: Record<string, string> = { web: 'session', api: 'access_tokens' }
  const base = {
    pathname: '/reports',
    route: { pattern: '/reports', domain: 'root' },
    auth: null,
    defaultGuard: 'web',
    profile: hybrid,
    config: resolveConfig({}),
    driverOf: (name: string) => drivers[name],
  }

  test('precedence: input, guard, route guards, prefix, default-guard route, default', ({
    assert,
  }) => {
    assert.deepInclude(decideSurface({ ...base, explicit: 'api' }), {
      name: 'api',
      source: 'input',
    })
    assert.deepInclude(decideSurface({ ...base, guard: 'web' }), {
      name: 'web',
      source: 'guard',
      renderer: 'inertia',
    })
    assert.deepInclude(decideSurface({ ...base, auth: { guards: ['api'], defaultGuard: false } }), {
      name: 'api',
      source: 'route-guard',
    })
    assert.deepInclude(
      decideSurface({
        ...base,
        pathname: '/api/posts',
        route: { pattern: '/api/posts', domain: 'root' },
      }),
      { name: 'api', source: 'inferred' }
    )
    assert.deepInclude(
      decideSurface({ ...base, route: { pattern: '/status', domain: 'api.example.test' } }),
      { name: 'api', source: 'inferred' }
    )
    assert.deepInclude(decideSurface({ ...base, auth: { guards: [], defaultGuard: true } }), {
      name: 'web',
      source: 'inferred',
    })
    assert.deepInclude(
      decideSurface({
        ...base,
        config: resolveConfig({ profile: { surfaces: { api: { guard: 'web' } } } }),
        guard: 'web',
      }),
      { name: 'api', source: 'guard' },
      'profile.surfaces.*.guard wins over the driver'
    )
  })

  test('contradicting or undecidable requests are rejected', ({ assert }) => {
    assert.equal(
      codeOf(() => decideSurface({ ...base, explicit: 'api', guard: 'web' })),
      'INPUT_INVALID'
    )
    assert.equal(
      codeOf(() => decideSurface(base)),
      'INPUT_INVALID',
      'hybrid without default'
    )
    assert.equal(
      codeOf(() =>
        decideSurface({
          ...base,
          explicit: 'web',
          profile: profile({ web: null, api: surface(null, null), default: 'api' }),
        })
      ),
      'INPUT_INVALID',
      'no web surface'
    )
    assert.deepInclude(
      decideSurface({
        ...base,
        auth: { guards: ['web', 'api'], defaultGuard: false },
        explicit: undefined,
        profile: { ...hybrid, surfaces: { ...hybrid.surfaces, default: 'web' } },
      }),
      { name: 'web', source: 'default' },
      'a route accepting both guards falls through to the default'
    )
  })

  test('JSON requests never carry Inertia headers', ({ assert }) => {
    const api = surfaceHeaders({ name: 'api', renderer: null, source: 'input', detail: '' }, 'v1')
    assert.deepEqual(api, { accept: 'application/json' })
    const inertia = surfaceHeaders(
      { name: 'web', renderer: 'inertia', source: 'input', detail: '' },
      'v1'
    )
    assert.deepInclude(inertia, { 'x-inertia': 'true', 'x-inertia-version': 'v1' })
    const edge = surfaceHeaders(
      { name: 'web', renderer: 'edge', source: 'input', detail: '' },
      null
    )
    assert.notProperty(edge, 'x-inertia')
    assert.include(edge.accept, 'text/html')
  })

  test('route guards come from auth middleware arguments', ({ assert }) => {
    assert.deepEqual(
      routeAuth([
        { name: 'bodyparser' },
        { name: 'auth', args: { guards: ['api', 'web'] } },
        { name: 'auth', args: undefined },
        () => {},
      ]),
      { guards: ['api', 'web'], defaultGuard: true }
    )
  })
})

test.group('http_request | response summary', () => {
  const response = (contentType: string, body: string, extra: Record<string, string> = {}) => ({
    headers: { 'content-type': contentType, ...extra },
    body: Buffer.from(body),
    truncated: false,
  })

  test('Inertia pages are recognized only with the X-Inertia response header', ({ assert }) => {
    const page = JSON.stringify({ component: 'home', props: { errors: { title: 'Required' } } })
    const inertia = summarizeBody(response('application/json', page, { 'x-inertia': 'true' }))
    assert.equal(inertia.kind, 'inertia')
    assert.deepEqual(validationErrors(inertia, 200), {
      source: 'inertia-props.errors',
      errors: { title: 'Required' },
    })
    assert.equal(summarizeBody(response('application/json', page)).kind, 'json')
  })

  test('JSON errors count as validation only on 422', ({ assert }) => {
    const body = summarizeBody(response('application/json', '{"errors":[{"message":"bad"}]}'))
    assert.isNotNull(validationErrors(body, 422))
    assert.isNull(validationErrors(body, 401))
  })

  test('truncated JSON is reported as text, never parsed partially', ({ assert }) => {
    const summary = summarizeBody({
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"rows":[1,2'),
      truncated: true,
    })
    assert.deepInclude(summary, { kind: 'text', truncated: true })
  })

  test('HTML outline skips scripts, comments and decodes entities', ({ assert }) => {
    const outline =
      outlineHtml(`<html><head><title>A &amp; B</title><script>var x = '<h1>no</h1>'</script></head>
<body><!-- <a href="/hidden">x</a> --><h2 class="x">Hi&nbsp;there</h2>
<form action='/save' method=post><input name="_csrf" value="secret-token"><textarea name=body></textarea></form>
<a href="/next">Next <b>page</b></a></body></html>`)
    assert.equal(outline.title, 'A & B')
    assert.deepEqual(outline.headings, [{ level: 2, text: 'Hi there' }])
    assert.deepEqual(outline.forms, [
      { action: '/save', method: 'POST', fields: ['_csrf', 'body'] },
    ])
    assert.deepEqual(outline.links, [{ href: '/next', text: 'Next page' }])
    assert.notInclude(JSON.stringify(outline), 'secret-token')
  })
})

test.group('http_request | config', () => {
  test('tools.http.tenantDomain is a host name without port', ({ assert }) => {
    assert.equal(
      resolveConfig({ tools: { http: { tenantDomain: 'Tenants.Test' } } }).tools.http.tenantDomain,
      'tenants.test'
    )
    for (const tenantDomain of ['tenants.test:3333', '*.tenants.test', 'http://tenants.test']) {
      assert.throws(() => resolveConfig({ tools: { http: { tenantDomain } } }), /tenantDomain/)
    }
  })
})

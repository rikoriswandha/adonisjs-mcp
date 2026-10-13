import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { FixtureApp } from '../helpers/fixture_app.js'
import { connectMcpClient } from '../helpers/mcp_client.js'
import {
  installPackage,
  writeMcpConfig,
  waitForMcp,
  setExtensionProviders,
  toolPayload,
  DEFAULT_PATH,
} from '../helpers/mcp_endpoint.js'
import { OwnedPostgresCluster } from '../helpers/postgres.js'

interface SqlEnvelope {
  data: { rows: unknown[][]; tenant?: { id: string } }
  code?: string
}

test('Security | PostgreSQL extended corpus, AST blind spots and tenant boundaries', async ({
  assert,
}) => {
  const cluster = await OwnedPostgresCluster.start()
  const fixture = await FixtureApp.create('api')
  try {
    const database = await cluster.createDatabase()
    await fixture.useDatabase({ connection: 'pg', ...database })
    await fixture.migrate()
    await cluster.query(
      database.database,
      `
      CREATE TABLE security_rows (id integer, tenant_id text, value text);
      INSERT INTO security_rows VALUES (1, 'a', 'A'), (2, 'b', 'B');
      ALTER TABLE security_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE security_rows FORCE ROW LEVEL SECURITY;
      CREATE POLICY isolation ON security_rows USING (tenant_id = current_setting('app.tenant_id', true));
      CREATE TABLE observer_rows (id integer);
      INSERT INTO observer_rows VALUES (1);
      CREATE SEQUENCE observer_sequence;
      CREATE VIEW unsafe_view AS SELECT * FROM security_rows;
      CREATE MATERIALIZED VIEW observer_materialized AS SELECT * FROM observer_rows;
      CREATE FUNCTION mutate(security_rows) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN DELETE FROM observer_rows; RETURN 1; END $$;
      CREATE FUNCTION sleepy(security_rows) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN 1; END $$;
      CREATE DOMAIN mutating_type AS integer CHECK (nextval('observer_sequence') > 0);
      CREATE ROLE mcp_reader LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO mcp_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
      GRANT USAGE, SELECT ON SEQUENCE observer_sequence TO mcp_reader;
    `
    )
    await installPackage(fixture)
    await fixture.npm(['install', '--save-exact', '@rikology/adonisjs-tenant@1.0.2'])
    await writeFile(
      join(fixture.root, 'config', 'tenancy.ts'),
      `export default { default: 'header', failOnMissing: true, tenants: { header: { resolver: 'header', options: { header: 'X-Tenant-ID', tenants: { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } } } } } }`
    )
    await writeFile(
      join(fixture.root, 'providers', 'tenant_security_provider.ts'),
      "export { default } from '@rikology/adonisjs-tenant/providers/tenancy_provider'\n"
    )
    await setExtensionProviders(fixture, ['tenant_security_provider'])
    await writeFile(
      join(fixture.root, 'app', 'models', 'security_row.ts'),
      `import { BaseModel, column } from '@adonisjs/lucid/orm'
import { TenantScope } from '@rikology/adonisjs-tenant'
export default class SecurityRow extends TenantScope(BaseModel) {
  static table = 'security_rows'
  @column({ isPrimary: true }) declare id: number
  @column() declare value: string
}`
    )
    const routes = join(fixture.root, 'start', 'routes.ts')
    await writeFile(
      routes,
      `${await readFile(routes, 'utf8')}
import SecurityRow from '#models/security_row'
const securityMiddleware = router.named({ tenant: () => import('@rikology/adonisjs-tenant/middleware') })
router.get('/__security/tenant', async () => (await SecurityRow.query()).map((row) => row.value)).use(securityMiddleware.tenant())
`
    )
    await writeMcpConfig(fixture, "  tools: { sql: { readers: { pg: { user: 'mcp_reader' } } } },")
    const app = await fixture.start({
      nodeEnv: 'development',
      nodeOptions: '--experimental-vm-modules',
    })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
    const pg = createRequire(join(fixture.root, 'package.json'))('pg') as {
      Client: new (config: Record<string, unknown>) => {
        connect(): Promise<void>
        query(sql: string): Promise<unknown>
        on(event: 'notification', listener: (message: { payload: string }) => void): void
        end(): Promise<void>
      }
    }
    const notificationObserver = new pg.Client({ ...database })
    const notifications: string[] = []
    const copyPath = join(fixture.root, 'tmp', 'forbidden-copy.txt')
    try {
      await notificationObserver.connect()
      notificationObserver.on('notification', (message) => notifications.push(message.payload))
      await notificationObserver.query('LISTEN security_probe')
      const observe = () =>
        cluster.query(
          database.database,
          `SELECT (SELECT count(*) FROM observer_rows), (SELECT count(*) FROM security_rows), (SELECT last_value || ':' || is_called FROM observer_sequence), (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'), (SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'adonisjs-mcp%')`
        )
      const before = await observe()
      for (const query of [
        '/* outer /* inner */ end */ DELETE FROM observer_rows',
        'SELECT $$; DELETE FROM observer_rows;$$; DELETE FROM observer_rows',
        'SELECT * INTO security_copy FROM observer_rows',
        'SELECT * FROM observer_rows FOR SHARE',
        "SELECT setval('observer_sequence', 200)",
        "SELECT set_config('search_path', 'pg_catalog', false)",
        'SET search_path TO pg_catalog',
        'RESET ALL',
        'SET ROLE postgres',
        'SET SESSION AUTHORIZATION postgres',
        'LISTEN security_probe',
        "NOTIFY security_probe, 'sentinel'",
        "SELECT pg_notify('security_probe', 'sentinel')",
        'SELECT pg_advisory_xact_lock(123)',
        'SELECT pg_try_advisory_lock(123)',
        `COPY observer_rows TO '${copyPath}'`,
        'CALL mutate()',
        'DO $$ BEGIN DELETE FROM observer_rows; END $$',
        'PREPARE probe AS DELETE FROM observer_rows',
        'EXECUTE probe',
        'EXPLAIN ANALYZE DELETE FROM observer_rows',
        'SELECT lo_create(123)',
        "SELECT pg_read_file('/etc/passwd')",
        "SELECT dblink('dbname=postgres', 'DELETE FROM observer_rows')",
        'REFRESH MATERIALIZED VIEW observer_materialized',
      ]) {
        const result = await client.callTool({ name: 'execute_sql_query', arguments: { query } })
        assert.isTrue(result.isError, query)
        assert.equal(await observe(), before, `observer after ${query}`)
        assert.lengthOf(notifications, 0, `notification observer after ${query}`)
        assert.isFalse(existsSync(copyPath), `COPY filesystem observer after ${query}`)
      }
      // PostgreSQL accepts composite attribute notation as a function call.
      // The AST regards it as a reference; the database must still stop the write.
      for (const query of ['SELECT t.mutate FROM security_rows t', 'SELECT 1::mutating_type']) {
        const result = await client.callTool({
          name: 'execute_sql_query',
          arguments: { query, tenant: 'a' },
        })
        assert.isTrue(result.isError, query)
        const failure = toolPayload<{ error: { code: string; details?: { sqlState?: string } } }>(
          result
        )
        assert.equal(failure.error.code, 'READ_ONLY_VIOLATION', query)
        assert.equal(
          failure.error.details?.sqlState,
          '25006',
          'the database, not the AST, stopped the side effect'
        )
        assert.equal(await observe(), before, `AST blind-spot observer after ${query}`)
      }
      const tenantInventory = await cluster.query(
        database.database,
        'SELECT tenant_id FROM security_rows ORDER BY tenant_id'
      )
      assert.equal(tenantInventory, 'a\nb', 'independent superuser observer sees both tenants')
      for (const tenant of ['a', 'b']) {
        for (const query of [
          "SELECT tenant_id FROM security_rows WHERE 'tenant_id=b' <> ''",
          'SELECT tenant_id FROM security_rows WHERE EXISTS (SELECT 1 AS tenant_id)',
          'SELECT tenant_id FROM public.security_rows',
          'SELECT "tenant_id" FROM "public"."security_rows"',
          'SELECT a.tenant_id FROM security_rows a JOIN security_rows b ON true',
        ]) {
          const result = toolPayload<SqlEnvelope>(
            await client.callTool({ name: 'execute_sql_query', arguments: { query, tenant } })
          )
          assert.isAbove(result.data.rows.length, 0, query)
          assert.isTrue(
            result.data.rows.every((row) => row[0] === tenant),
            JSON.stringify(result)
          )
          const independentlyExpected = await cluster.query(
            database.database,
            `SELECT DISTINCT tenant_id FROM security_rows WHERE tenant_id = '${tenant}'`
          )
          assert.deepEqual(
            [...new Set(result.data.rows.map((row) => row[0]))],
            [independentlyExpected],
            `independent tenant inventory after ${query}`
          )
        }
      }
      for (const attempt of [
        { query: 'SELECT * FROM unsafe_view', tenant: 'a' },
        { query: 'SELECT * FROM security_rows', tenant: 'missing' },
        { query: 'SELECT * FROM security_rows' },
        {
          query: "SELECT set_config('search_path', 'public', true), * FROM security_rows",
          tenant: 'a',
        },
      ]) {
        const result = await client.callTool({ name: 'execute_sql_query', arguments: attempt })
        assert.isTrue(result.isError, JSON.stringify(attempt))
        assert.equal(await observe(), before)
      }
      const dollar = await client.callTool({
        name: 'execute_sql_query',
        arguments: { query: 'SELECT $$DELETE FROM observer_rows;$$' },
      })
      assert.isTrue(
        dollar.isError,
        'unsupported dollar quoting fails closed rather than being split as statements'
      )
      assert.equal(
        toolPayload<{ error: { code: string } }>(dollar).error.code,
        'READ_ONLY_VIOLATION'
      )
      assert.equal(await observe(), before)
      const mixed = await Promise.all(
        ['a', 'b'].flatMap((tenant) => [
          client.callTool({ name: 'query_model', arguments: { model: 'SecurityRow', tenant } }),
          client.callTool({
            name: 'http_request',
            arguments: { path: '/__security/tenant', tenant },
          }),
          client.callTool({
            name: 'project_eval',
            arguments: {
              code: "const { default: Row } = await import('#models/security_row'); return (await Row.query()).map((row) => row.value)",
              tenant,
            },
          }),
        ])
      )
      for (const [index, result] of mixed.entries()) {
        assert.notOk(result.isError, JSON.stringify(result))
        const output = JSON.stringify(result)
        assert.include(output, index < 3 ? 'A' : 'B')
        assert.notInclude(output, index < 3 ? '"B"' : '"A"')
      }
      const slow = await client.callTool({
        name: 'execute_sql_query',
        arguments: { query: 'SELECT t.sleepy FROM security_rows t', tenant: 'a', timeout: 300 },
      })
      assert.isTrue(slow.isError)
      assert.include(JSON.stringify(slow), 'TIMEOUT')
      assert.equal(
        await observe(),
        before,
        'pg_sleep hidden behind attribute notation is cancelled and the reader closes'
      )
      const cancellation = new AbortController()
      const cancelled = client
        .callTool(
          {
            name: 'execute_sql_query',
            arguments: { query: 'SELECT t.sleepy FROM security_rows t', tenant: 'a' },
          },
          { signal: cancellation.signal }
        )
        .catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const survivingCall = client.callTool({
        name: 'execute_sql_query',
        arguments: { query: 'SELECT t.sleepy FROM security_rows t', tenant: 'b', timeout: 6000 },
      })
      cancellation.abort()
      await cancelled
      const survivor = toolPayload<SqlEnvelope>(await survivingCall)
      assert.deepEqual(survivor.data.rows, [[1]])
      // Cancellation is asynchronous at the transport boundary: wait for the independently observed reader teardown.
      let afterCancel = ''
      for (let attempt = 0; attempt < 50; attempt++) {
        afterCancel = await observe()
        if (afterCancel === before) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(afterCancel, before)
      const children = toolPayload<{ data: { display: string } }>(
        await client.callTool({
          name: 'project_eval',
          arguments: {
            code: "return process._getActiveHandles().filter(handle => handle.constructor.name === 'ChildProcess').map(handle => handle.pid)",
          },
        })
      )
      assert.equal(
        children.data.display,
        '[]',
        'no owned child process remains after concurrent calls'
      )
    } finally {
      await client.close()
      await notificationObserver.end()
    }
  } finally {
    await fixture.dispose()
    await cluster.stop()
  }
}).timeout(300000)

test('Security | SQLite extended corpus preserves database and filesystem', async ({ assert }) => {
  const fixture = await FixtureApp.create('api')
  try {
    await fixture.migrate()
    await installPackage(fixture)
    const databasePath = join(fixture.root, 'tmp', 'db.sqlite3')
    const app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'legacy' })
    const hash = async () =>
      createHash('sha256')
        .update(await readFile(databasePath))
        .digest('hex')
    const before = await hash()
    const originalStat = await stat(databasePath)
    const modified = originalStat.mtimeMs
    const output = join(fixture.root, 'tmp', 'forbidden.sqlite3')
    try {
      for (const query of [
        'PRAGMA writable_schema=ON',
        'PRAGMA user_version=99',
        'PRAGMA journal_mode=WAL',
        `VACUUM INTO '${output}'`,
        `ATTACH DATABASE '${output}' AS extra`,
        "SELECT load_extension('/tmp/nonexistent')",
        'DELETE FROM users RETURNING id',
        'SELECT * FROM pragma_writable_schema(1)',
        'SELECT * FROM dbstat',
        'SELECT randomblob(2000000000)',
      ]) {
        const result = await client.callTool({
          name: 'execute_sql_query',
          arguments: { query, timeout: 300 },
        })
        assert.isTrue(result.isError, query)
        assert.equal(await hash(), before, query)
        const currentStat = await stat(databasePath)
        assert.equal(currentStat.mtimeMs, modified, query)
        assert.isFalse(existsSync(output), query)
      }
      const require = createRequire(join(fixture.root, 'package.json'))
      const Database = require('better-sqlite3') as new (
        file: string,
        options: { readonly: boolean }
      ) => { prepare(sql: string): { get(): { user_version: number } }; close(): void }
      const observer = new Database(databasePath, { readonly: true })
      try {
        assert.equal(observer.prepare('PRAGMA user_version').get().user_version, 0)
      } finally {
        observer.close()
      }
    } finally {
      await client.close()
    }
  } finally {
    await fixture.dispose()
  }
}).timeout(180000)

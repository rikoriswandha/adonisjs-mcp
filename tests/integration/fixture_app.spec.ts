import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { AppStartError, FixtureApp } from '../helpers/fixture_app.js'
import { OwnedPostgresCluster } from '../helpers/postgres.js'
import { groupAlive } from '../helpers/process.js'

async function environmentOf(app: { fetch(path: string): Promise<Response> }) {
  const response = await app.fetch('/__fixture/environment')
  return response.json()
}

async function refusesConnections(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return false
  } catch {
    return true
  }
}

test.group('Fixture app | lifecycle', (group) => {
  let fixture: FixtureApp

  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    await fixture.migrate()
    return () => fixture.dispose()
  })

  test('starts and stops a real server repeatedly on dynamic ports', async ({ assert }) => {
    for (let run = 0; run < 2; run++) {
      const app = await fixture.start({ nodeEnv: 'development' })
      const response = await app.fetch('/')
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { hello: 'world' })

      await app.logs.waitFor(
        (line) => line.record?.msg === `started HTTP server on 127.0.0.1:${app.port}`,
        5_000
      )

      await app.stop()
      assert.isFalse(groupAlive(app.pid))
      assert.isTrue(await refusesConnections(app.url))
    }
  })

  test('development and test processes are classified explicitly', async ({ assert }) => {
    const development = await fixture.start({ nodeEnv: 'development' })
    assert.deepInclude(await environmentOf(development), {
      nodeEnv: 'development',
      inDev: true,
      inTest: false,
      inProduction: false,
    })
    await development.stop()

    const testing = await fixture.start({ nodeEnv: 'test' })
    assert.deepInclude(await environmentOf(testing), {
      nodeEnv: 'test',
      inDev: false,
      inTest: true,
      inProduction: false,
    })
    await testing.stop()
  })

  test('the hmr runner serves through the assembler and stops its whole tree', async ({
    assert,
  }) => {
    const app = await fixture.start({ nodeEnv: 'development', runner: 'hmr' })
    assert.deepInclude(await environmentOf(app), { nodeEnv: 'development', inDev: true })

    await app.stop()
    assert.isFalse(groupAlive(app.pid))
    assert.isTrue(await refusesConnections(app.url))
  })

  test('a server that fails to boot reports its exit code and output', async ({ assert }) => {
    const envFile = join(fixture.root, '.env')
    const env = await readFile(envFile, 'utf8')
    await writeFile(envFile, env.replace(/^APP_KEY=.*\n/m, ''))
    try {
      await fixture.start({ nodeEnv: 'development' })
      assert.fail('expected the fixture server to fail')
    } catch (error) {
      assert.instanceOf(error, AppStartError)
      assert.notEqual((error as AppStartError).exitCode, 0)
      assert.include((error as AppStartError).logs.text(), 'APP_KEY')
    } finally {
      await writeFile(envFile, env)
    }
  })
})

test.group('Fixture app | databases', () => {
  test('each fixture owns its SQLite file', async ({ assert, cleanup }) => {
    const migrated = await FixtureApp.create('api')
    cleanup(() => migrated.dispose())
    const untouched = await FixtureApp.create('api')
    cleanup(() => untouched.dispose())

    await migrated.migrate()

    const migratedStatus = await migrated.ace(['migration:status'], 'development')
    const untouchedStatus = await untouched.ace(['migration:status'], 'development')
    assert.match(migratedStatus.stdout, /create_users_table.*completed/)
    assert.match(untouchedStatus.stdout, /create_users_table.*pending/)
    assert.isTrue(existsSync(join(migrated.root, 'tmp', 'db.sqlite3')))
  })

  test('PostgreSQL fixtures run against a cluster owned by the test', async ({
    assert,
    cleanup,
  }) => {
    const cluster = await OwnedPostgresCluster.start()
    cleanup(() => cluster.stop())
    const fixture = await FixtureApp.create('api')
    cleanup(() => fixture.dispose())

    const first = await cluster.createDatabase()
    const second = await cluster.createDatabase()
    assert.notEqual(first.database, second.database)
    assert.equal(first.host, '127.0.0.1')

    await fixture.useDatabase({ connection: 'pg', ...first })
    await fixture.migrate()
    const app = await fixture.start({ nodeEnv: 'development' })
    assert.deepInclude(await environmentOf(app), { dbConnection: 'pg' })
    await app.stop()

    const usersTables = "select count(*) from information_schema.tables where table_name = 'users'"
    assert.equal(await cluster.query(first.database, usersTables), '1')
    assert.equal(await cluster.query(second.database, usersTables), '0')

    await cluster.stop()
    assert.isFalse(existsSync(cluster.directory))
    assert.isTrue(await refusesConnections(`http://127.0.0.1:${cluster.port}`))
  })
})

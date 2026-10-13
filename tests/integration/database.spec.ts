/*
|--------------------------------------------------------------------------
| Lucid, SQL, schema and tenant foundation (M4)
|--------------------------------------------------------------------------
|
| SQLite: the API starter kit gets blog models (subdirectory, inherited
| model, soft-delete hooks, serializeAs, computed, relations), a broken and
| a non-model file, an applied and a pending migration. Official MCP
| clients compare what models see with the physical rows, attack the
| read-only boundary and check that nothing changed.
|
| PostgreSQL + tenant: an owned cluster, `@rikology/adonisjs-tenant` with a
| header allowlist, TenantScope models in a custom models directory, a
| FORCE ROW LEVEL SECURITY table and least-privilege reader roles.
|
*/

import { existsSync } from 'node:fs'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Client } from '@modelcontextprotocol/client'
import { FixtureApp, type RunningApp } from '../helpers/fixture_app.js'
import { connectMcpClient, type ProtocolEra } from '../helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  resourcePayload,
  setExtensionProviders,
  toolPayload,
  writeMcpConfig,
  waitForMcp,
} from '../helpers/mcp_endpoint.js'
import { OwnedPostgresCluster } from '../helpers/postgres.js'

interface Envelope<T> {
  data: T
  evidence?: string[]
  limitations?: string[]
  durationMs: number
  truncated: boolean
}

interface Failure {
  code: string
  message: string
}

interface ModelSummary {
  id: string
  name: string
  file: string
  table: string
  primaryKey: string
  connection: string | null
  extends: string | null
  columns: Array<{
    name: string
    columnName: string
    serializeAs: string | null
    isPrimary: boolean
  }>
  computed: Array<{ name: string; serializeAs: string | null }>
  relations: Array<{
    name: string
    type: string
    relatedModel: string | null
    relatedModelId: string | null
    keys: Record<string, string>
  }>
  tenantScoped: boolean
  changedSinceProcessStart: boolean
}

interface ModelsData {
  directory: string
  models: ModelSummary[]
  failures: Array<{ file: string; error: string }>
  skipped: string[]
}

interface QueryModelData {
  rows: Array<Record<string, unknown>>
  returnedRows: number
  hasMore: boolean
  limit: number
  scope: { tenantScoped: boolean; tenant: { id: string } | null; crossTenant: boolean }
  preloadTruncated: string[]
}

interface SqlData {
  connection: string
  dialect: string
  mode: string
  executor: string
  columns: string[]
  rows: unknown[][]
  returnedRows: number
  hasMore: boolean
  tablesRead?: string[]
  tenant: { id: string } | null
  crossTenant: boolean
  affectedRows?: number | null
}

interface MigrationsData {
  table: string
  tableExists: boolean
  migrations: Array<{
    name: string
    file: string | null
    status: string
    batch: number | null
    migratedAt: string | null
  }>
  summary: { migrated: number; pending: number; corrupt: number; lastBatch: number | null }
}

interface DiffData {
  models: Array<{
    model: string
    status: string
    missingColumns: Array<{ property: string; columnName: string }>
    undeclaredColumns: Array<{ column: string }>
    computed: string[]
  }>
  unmappedTables: string[]
  migrations: { pending: number }
}

async function withClient<T>(
  app: RunningApp,
  run: (client: Client) => Promise<T>,
  era: ProtocolEra = 'modern'
) {
  const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
  }
  return toolPayload<Envelope<T>>(result)
}

async function callError(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  if (!result.isError) {
    throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(result.content)}`)
  }
  return toolPayload<{ error: Failure }>(result).error
}

async function statusOf(response: Promise<Response>): Promise<number> {
  const resolved = await response
  return resolved.status
}

async function editFile(path: string, edit: (source: string) => string) {
  await writeFile(path, edit(await readFile(path, 'utf8')))
}

const BLOG_MIGRATION = `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('posts', (table) => {
      table.increments('id')
      table.integer('user_id').notNullable()
      table.string('title').notNullable()
      table.string('secret_note').notNullable()
      table.boolean('featured').notNullable().defaultTo(false)
      table.boolean('legacy_flag').notNullable().defaultTo(false)
      table.timestamp('deleted_at').nullable()
    })
    this.schema.createTable('comments', (table) => {
      table.increments('id')
      table.integer('post_id').notNullable()
      table.string('body').notNullable()
    })
    this.defer(async (db) => {
      const now = new Date().toISOString()
      await db.table('users').multiInsert([
        { id: 1, email: 'ada@example.com', password: 'x', created_at: now },
        { id: 2, email: 'bob@example.com', password: 'x', created_at: now },
      ])
      await db.table('posts').multiInsert([
        { id: 1, user_id: 1, title: 'Hello world', secret_note: 'hidden-1', featured: false },
        { id: 2, user_id: 2, title: 'Deleted post', secret_note: 'hidden-2', featured: false, deleted_at: now },
        { id: 3, user_id: 1, title: 'Featured story', secret_note: 'hidden-3', featured: true },
      ])
      await db.table('comments').multiInsert([
        ...Array.from({ length: 7 }, (_, index) => ({ post_id: 1, body: 'comment ' + (index + 1) })),
        { post_id: 3, body: 'featured comment' },
      ])
    })
  }

  async down() {
    this.schema.dropTable('comments')
    this.schema.dropTable('posts')
  }
}
`

const PENDING_MIGRATION = `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('posts', (table) => {
      table.timestamp('published_at').nullable()
    })
  }
}
`

const POST_MODEL = `import { DateTime } from 'luxon'
import { BaseModel, beforeFetch, beforeFind, belongsTo, column, computed, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import type { ModelQueryBuilderContract } from '@adonisjs/lucid/types/model'
import User from '#models/user'
import Comment from '#models/blog/comment'

export default class Post extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column()
  declare title: string

  @column({ serializeAs: null })
  declare secretNote: string

  @column()
  declare featured: boolean

  @column.dateTime()
  declare deletedAt: DateTime | null

  @column.dateTime()
  declare publishedAt: DateTime | null

  @computed()
  get excerpt() {
    return this.title.slice(0, 5)
  }

  @belongsTo(() => User)
  declare author: BelongsTo<typeof User>

  @hasMany(() => Comment)
  declare comments: HasMany<typeof Comment>

  @beforeFind()
  @beforeFetch()
  static ignoreDeleted(query: ModelQueryBuilderContract<typeof Post>) {
    query.whereNull('deleted_at')
  }
}
`

const COMMENT_MODEL = `import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Post from '#models/blog/post'

export default class Comment extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare postId: number

  @column()
  declare body: string

  @belongsTo(() => Post)
  declare post: BelongsTo<typeof Post>
}
`

const FEATURED_MODEL = `import { beforeFetch, beforeFind } from '@adonisjs/lucid/orm'
import type { ModelQueryBuilderContract } from '@adonisjs/lucid/types/model'
import Post from '#models/blog/post'

export default class FeaturedPost extends Post {
  static table = 'posts'

  @beforeFind()
  @beforeFetch()
  static onlyFeatured(query: ModelQueryBuilderContract<typeof FeaturedPost>) {
    query.where('featured', true)
  }
}
`

test.group('Database | SQLite API starter kit', (group) => {
  let fixture: FixtureApp
  let app: RunningApp

  group.setup(async () => {
    fixture = await FixtureApp.create('api')
    const migrations = join(fixture.root, 'database', 'migrations')
    await writeFile(join(migrations, '1790000000000_create_blog_tables.ts'), BLOG_MIGRATION)
    await fixture.migrate()
    await writeFile(
      join(migrations, '1790000000001_add_published_at_to_posts.ts'),
      PENDING_MIGRATION
    )
    await installPackage(fixture)

    const models = join(fixture.root, 'app', 'models')
    await mkdir(join(models, 'blog'), { recursive: true })
    await writeFile(join(models, 'blog', 'post.ts'), POST_MODEL)
    await writeFile(join(models, 'blog', 'comment.ts'), COMMENT_MODEL)
    await writeFile(join(models, 'blog', 'featured_post.ts'), FEATURED_MODEL)
    await writeFile(
      join(models, 'helpers.ts'),
      'export function slugify(value: string) {\n  return value.toLowerCase()\n}\n'
    )
    await writeFile(join(models, 'broken.ts'), "throw new Error('fixture broken model')\n")
    await editFile(join(fixture.root, 'config', 'database.ts'), (source) =>
      source.replace(
        /(\n {4}pg: \{)/,
        `
    fresh: {
      client: 'better-sqlite3',
      connection: { filename: app.tmpPath('fresh.sqlite3') },
      useNullAsDefault: true,
    },
$1`
      )
    )
    await writeMcpConfig(fixture, '  tools: { sql: { maxRows: 5 } },')
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    return () => fixture.dispose()
  })

  test('get_models discovers models recursively and reports failures per file', async ({
    assert,
  }) => {
    const [tool, resource] = await withClient(app, async (client) => [
      await call<ModelsData>(client, 'get_models'),
      resourcePayload<Envelope<ModelsData>>(await client.readResource({ uri: 'adonis://models' })),
    ])
    const { data } = tool
    assert.equal(data.directory, 'app/models')
    assert.sameMembers(
      data.models.map((model) => model.id),
      ['blog/comment', 'blog/featured_post', 'blog/post', 'user']
    )
    assert.deepEqual(data.skipped, ['app/models/helpers.ts'])
    assert.lengthOf(data.failures, 1)
    assert.equal(data.failures[0].file, 'app/models/broken.ts')
    assert.include(data.failures[0].error, 'fixture broken model')

    const post = data.models.find((model) => model.id === 'blog/post')!
    assert.deepInclude(post, {
      name: 'Post',
      file: 'app/models/blog/post.ts',
      table: 'posts',
      primaryKey: 'id',
      connection: null,
      extends: null,
      tenantScoped: false,
      changedSinceProcessStart: false,
    })
    assert.deepInclude(post.columns, {
      name: 'userId',
      columnName: 'user_id',
      serializeAs: 'userId',
      isPrimary: false,
    })
    assert.deepInclude(post.columns, {
      name: 'secretNote',
      columnName: 'secret_note',
      serializeAs: null,
      isPrimary: false,
    })
    assert.deepEqual(post.computed, [{ name: 'excerpt', serializeAs: 'excerpt' }])
    const author = post.relations.find((relation) => relation.name === 'author')!
    assert.deepInclude(author, { type: 'belongsTo', relatedModel: 'User', relatedModelId: 'user' })
    assert.deepInclude(author.keys, { foreignKey: 'userId', foreignKeyColumnName: 'user_id' })
    const comments = post.relations.find((relation) => relation.name === 'comments')!
    assert.deepInclude(comments, { type: 'hasMany', relatedModelId: 'blog/comment' })
    assert.deepInclude(comments.keys, { foreignKeyColumnName: 'post_id' })

    const featured = data.models.find((model) => model.id === 'blog/featured_post')!
    assert.equal(featured.extends, 'blog/post')
    assert.equal(featured.table, 'posts')
    assert.deepEqual(
      featured.columns.map((column) => column.name),
      post.columns.map((column) => column.name)
    )

    assert.deepEqual(resource.data, data)
  })

  test('query_model shows what the app sees, execute_sql_query the physical rows', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const seen = await call<QueryModelData>(client, 'query_model', {
        model: 'Post',
        orderBy: [{ column: 'id' }],
      })
      assert.deepEqual(
        seen.data.rows.map((row) => row.id),
        [1, 3]
      )
      assert.notProperty(seen.data.rows[0], 'secretNote')
      assert.notProperty(seen.data.rows[0], 'secret_note')
      assert.equal(seen.data.rows[0].excerpt, 'Hello')
      assert.deepInclude(seen.data.scope, { tenantScoped: false, tenant: null, crossTenant: false })

      const featured = await call<QueryModelData>(client, 'query_model', {
        model: 'blog/featured_post',
      })
      assert.deepEqual(
        featured.data.rows.map((row) => row.id),
        [3]
      )

      const raw = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT id, secret_note, deleted_at IS NOT NULL AS deleted FROM posts ORDER BY id',
      })
      assert.deepInclude(raw.data, {
        dialect: 'sqlite',
        mode: 'read-only',
        executor: 'sqlite-reader',
        returnedRows: 3,
        hasMore: false,
      })
      assert.deepEqual(raw.data.columns, ['id', 'secret_note', 'deleted'])
      assert.deepEqual(raw.data.rows, [
        [1, 'hidden-1', 0],
        [2, 'hidden-2', 1],
        [3, 'hidden-3', 0],
      ])
      assert.deepEqual(raw.data.tablesRead, ['posts'])

      const raw2 = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT title FROM posts WHERE user_id = ? AND id > ?',
        bindings: [1, 1],
      })
      assert.deepEqual(raw2.data.rows, [['Featured story']])
    })
  })

  test('query_model validates input and bounds preloads', async ({ assert }) => {
    await withClient(app, async (client) => {
      const preloaded = await call<QueryModelData>(client, 'query_model', {
        model: 'Post',
        where: { user_id: 1 },
        filters: [{ column: 'title', operator: 'like', value: '%o%' }],
        preload: ['comments', 'author'],
        orderBy: [{ column: 'id', direction: 'desc' }],
        serialize: true,
      })
      assert.deepEqual(
        preloaded.data.rows.map((row) => row.id),
        [3, 1]
      )
      assert.deepEqual(preloaded.data.preloadTruncated, ['comments'])
      assert.equal((preloaded.data.rows[0].author as { email: string }).email, 'ada@example.com')
      assert.notProperty(preloaded.data.rows[0].author as object, 'password')

      const limited = await call<QueryModelData>(client, 'query_model', {
        model: 'blog/comment',
        limit: 2,
      })
      assert.deepInclude(limited.data, { returnedRows: 2, hasMore: true, limit: 2 })

      const raw = await call<QueryModelData>(client, 'query_model', {
        model: 'Post',
        where: { id: 1 },
        serialize: false,
      })
      assert.equal(raw.data.rows[0].secretNote, 'hidden-1')

      const errors = await Promise.all([
        callError(client, 'query_model', { model: 'Missing' }),
        callError(client, 'query_model', { model: 'Post', where: { nope: 1 } }),
        callError(client, 'query_model', { model: 'Post', preload: ['comments.nope'] }),
        callError(client, 'query_model', { model: 'Post', limit: 6 }),
        callError(client, 'query_model', { model: 'Post', tenant: 'a' }),
      ])
      assert.deepEqual(
        errors.map((error) => error.code),
        [
          'INPUT_INVALID',
          'INPUT_INVALID',
          'INPUT_INVALID',
          'INPUT_INVALID',
          'CAPABILITY_UNSUPPORTED',
        ]
      )
      assert.include(errors[1].message, 'Unknown column "nope"')
      assert.include(errors[2].message, 'Unknown relation "nope" on model Comment')
    })
  })

  test('execute_sql_query refuses writes and side effects without changing the database', async ({
    assert,
  }) => {
    const attached = join(fixture.root, 'tmp', 'attached.sqlite3')
    const vacuumed = join(fixture.root, 'tmp', 'vacuumed.sqlite3')
    const corpus = [
      'DELETE FROM posts',
      '/* SELECT */ DELETE FROM posts',
      'SELECT 1; DELETE FROM posts',
      'WITH doomed AS (SELECT id FROM posts) DELETE FROM posts',
      'INSERT INTO posts (user_id, title, secret_note) VALUES (1, "x", "y") RETURNING id',
      'UPDATE posts SET title = "x"',
      'PRAGMA user_version = 5',
      'PRAGMA journal_mode = WAL',
      'PRAGMA query_only = OFF',
      `ATTACH DATABASE '${attached}' AS other`,
      `VACUUM INTO '${vacuumed}'`,
      "SELECT load_extension('/tmp/missing')",
      "SELECT * FROM pragma_table_info('posts')",
      'DROP TABLE comments',
    ]
    await withClient(app, async (client) => {
      for (const query of corpus) {
        const error = await callError(client, 'execute_sql_query', { query })
        assert.oneOf(error.code, ['READ_ONLY_VIOLATION', 'EXECUTION_FAILED'], query)
      }
      const denied = await callError(client, 'execute_sql_query', {
        query: "SELECT load_extension('/tmp/missing')",
      })
      assert.equal(denied.code, 'READ_ONLY_VIOLATION')
      assert.include(denied.message, 'load_extension')

      const counts = await call<SqlData>(client, 'execute_sql_query', {
        query:
          'SELECT (SELECT count(*) FROM posts), (SELECT count(*) FROM comments), (SELECT max(title) FROM posts)',
      })
      assert.deepEqual(counts.data.rows, [[3, 8, 'Hello world']])
    })
    assert.isFalse(existsSync(attached))
    assert.isFalse(existsSync(vacuumed))
  })

  test('SQLite results are bounded before materialization and deadlines kill the reader', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const infinite = await call<SqlData>(client, 'execute_sql_query', {
        query: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n',
      })
      assert.deepEqual(infinite.data.rows, [[1], [2], [3], [4], [5]])
      assert.isTrue(infinite.data.hasMore)

      const started = performance.now()
      const [slow, home] = await Promise.all([
        callError(client, 'execute_sql_query', {
          query:
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000000000) SELECT count(*) FROM n',
          timeout: 300,
        }),
        new Promise((resolve) => setTimeout(resolve, 100)).then(() => statusOf(app.fetch('/'))),
      ])
      const elapsed = performance.now() - started
      assert.equal(slow.code, 'TIMEOUT')
      assert.include(slow.message, 'killed')
      assert.isBelow(elapsed, 5_000)
      assert.equal(home, 200)

      const after = await call<SqlData>(client, 'execute_sql_query', { query: 'SELECT 42' })
      assert.deepEqual(after.data.rows, [[42]])

      const plan = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT * FROM posts WHERE id = ?',
        bindings: [1],
        explain: true,
      })
      assert.include(plan.data.columns, 'detail')
      assert.isAbove(plan.data.rows.length, 0)
    })
  })

  test('get_migrations and diff_schema read state without migrating', async ({ assert }) => {
    await withClient(app, async (client) => {
      const status = await call<MigrationsData>(client, 'get_migrations')
      assert.deepInclude(status.data, { table: 'adonis_schema', tableExists: true })
      assert.deepEqual(status.data.summary, { migrated: 3, pending: 1, corrupt: 0, lastBatch: 1 })
      assert.deepInclude(status.data.migrations, {
        name: 'database/migrations/1790000000001_add_published_at_to_posts',
        file: 'database/migrations/1790000000001_add_published_at_to_posts.ts',
        status: 'pending',
        batch: null,
        migratedAt: null,
      })

      const diff = await call<DiffData>(client, 'diff_schema')
      const post = diff.data.models.find((model) => model.model === 'blog/post')!
      assert.equal(post.status, 'drift')
      assert.deepEqual(post.missingColumns, [
        { property: 'publishedAt', columnName: 'published_at' },
      ])
      assert.deepEqual(
        post.undeclaredColumns.map((column) => column.column),
        ['legacy_flag']
      )
      assert.deepEqual(post.computed, ['excerpt'])
      assert.equal(diff.data.models.find((model) => model.model === 'user')?.status, 'in-sync')
      assert.include(diff.data.unmappedTables, 'auth_access_tokens')
      assert.notInclude(diff.data.unmappedTables, 'adonis_schema')
      assert.equal(diff.data.migrations.pending, 1)

      const again = await call<MigrationsData>(client, 'get_migrations')
      assert.equal(again.data.summary.pending, 1)

      const fresh = await call<MigrationsData>(client, 'get_migrations', { connection: 'fresh' })
      assert.isFalse(fresh.data.tableExists)
      assert.equal(fresh.data.summary.pending, 4)
      const freshAgain = await call<MigrationsData>(client, 'get_migrations', {
        connection: 'fresh',
      })
      assert.isFalse(freshAgain.data.tableExists, 'the history table is never created')

      const unknown = await callError(client, 'get_migrations', { connection: 'nope' })
      assert.equal(unknown.code, 'INPUT_INVALID')
    })
  })

  test('a model file changed after start is flagged', async ({ assert }) => {
    const later = new Date(Date.now() + 60_000)
    await utimes(join(fixture.root, 'app', 'models', 'blog', 'comment.ts'), later, later)
    const models = await withClient(
      app,
      (client) => call<ModelsData>(client, 'get_models'),
      'legacy'
    )
    const comment = models.data.models.find((model) => model.id === 'blog/comment')!
    assert.isTrue(comment.changedSinceProcessStart)
    assert.isTrue(
      models.limitations!.some((limitation) => limitation.includes('app/models/blog/comment.ts'))
    )
  })

  test('read-write mode is explicit and mutating', async ({ assert }) => {
    await app.stop()
    await writeMcpConfig(fixture, '  tools: { sql: { maxRows: 5, readOnly: false } },')
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    await withClient(app, async (client) => {
      const { tools } = await client.listTools()
      const tool = tools.find((entry) => entry.name === 'execute_sql_query')!
      assert.deepInclude(tool.annotations, { readOnlyHint: false, destructiveHint: true })
      assert.include(tool.description, 'CAN CHANGE OR DELETE DATA')

      const updated = await call<SqlData>(client, 'execute_sql_query', {
        query: 'UPDATE posts SET title = ? WHERE id = ?',
        bindings: ['Renamed', 1],
      })
      assert.deepInclude(updated.data, {
        mode: 'read-write',
        executor: 'app-connection',
        affectedRows: 1,
      })
      const read = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT title FROM posts WHERE id = 1',
      })
      assert.deepEqual(read.data.rows, [['Renamed']])
    })
  })
})

const TENANT_MIGRATION = `import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('invoices', (table) => {
      table.increments('id')
      table.string('tenant_id').notNullable()
      table.string('number').notNullable()
      table.integer('amount').notNullable()
    })
    this.schema.createTable('notes', (table) => {
      table.increments('id')
      table.string('tenant_id').notNullable()
      table.string('body').notNullable()
    })
    this.schema.createTable('countries', (table) => {
      table.increments('id')
      table.string('code').notNullable()
    })
    this.schema.createSchema('audit')
    this.schema.withSchema('audit').createTable('entries', (table) => {
      table.increments('id')
      table.string('action').notNullable()
    })
    this.schema.raw('ALTER TABLE invoices ENABLE ROW LEVEL SECURITY')
    this.schema.raw('ALTER TABLE invoices FORCE ROW LEVEL SECURITY')
    this.schema.raw(
      "CREATE POLICY tenant_isolation ON invoices USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))"
    )
    this.defer(async (db) => {
      await db.table('invoices').multiInsert([
        { tenant_id: 'a', number: 'A-1', amount: 10 },
        { tenant_id: 'a', number: 'A-2', amount: 20 },
        { tenant_id: 'b', number: 'B-1', amount: 30 },
      ])
      await db.table('notes').multiInsert([
        { tenant_id: 'a', body: 'note a' },
        { tenant_id: 'b', body: 'note b' },
      ])
      await db.table('countries').multiInsert([{ code: 'ID' }, { code: 'NL' }])
      await db.table('audit.entries').insert({ action: 'created' })
    })
  }
}
`

const INVOICE_MODEL = `import { BaseModel, column } from '@adonisjs/lucid/orm'
import { TenantScope } from '@rikology/adonisjs-tenant'

export default class Invoice extends TenantScope(BaseModel) {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare number: string

  @column()
  declare amount: number
}
`

const AUDIT_MODEL = `import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class AuditEntry extends BaseModel {
  static table = 'audit.entries'
  static connection = 'pg_noreader'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare action: string
}
`

const NOTE_MODEL = `import { BaseModel, column } from '@adonisjs/lucid/orm'
import { TenantScope } from '@rikology/adonisjs-tenant'

export default class Note extends TenantScope(BaseModel) {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare body: string
}
`

const COUNTRY_MODEL = `import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Country extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare code: string
}
`

const TENANCY_CONFIG = `const tenancyConfig = {
  default: 'header',
  failOnMissing: true,
  tenants: {
    header: {
      resolver: 'header' as const,
      options: {
        header: 'X-Tenant-ID',
        tenants: {
          a: { id: 'a', name: 'Tenant A' },
          b: { id: 'b', name: 'Tenant B' },
        },
      },
    },
  },
}

export default tenancyConfig
`

const EXTRA_PG_CONNECTIONS = `
    pg_bypass: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        database: env.get('DB_DATABASE'),
      },
    },
    pg_writer: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        database: env.get('DB_DATABASE'),
      },
    },
    pg_noreader: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        database: env.get('DB_DATABASE'),
      },
    },
`

test.group('Database | PostgreSQL with tenants and row level security', (group) => {
  let cluster: OwnedPostgresCluster
  let database: string
  let fixture: FixtureApp
  let app: RunningApp

  group.setup(async () => {
    cluster = await OwnedPostgresCluster.start()
    const created = await cluster.createDatabase()
    database = created.database
    fixture = await FixtureApp.create('api')
    try {
      await fixture.useDatabase({ connection: 'pg', ...created })
      await writeFile(
        join(fixture.root, 'database', 'migrations', '1790000000000_create_tenant_tables.ts'),
        TENANT_MIGRATION
      )
      await fixture.migrate()
      await cluster.query(
        database,
        `CREATE ROLE mcp_reader LOGIN NOSUPERUSER NOBYPASSRLS;
         CREATE ROLE mcp_bypass LOGIN NOSUPERUSER BYPASSRLS;
         CREATE ROLE mcp_writer LOGIN NOSUPERUSER NOBYPASSRLS;
         GRANT USAGE ON SCHEMA public TO mcp_reader, mcp_bypass, mcp_writer;
         GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader, mcp_bypass, mcp_writer;
         GRANT INSERT ON countries TO mcp_writer;`
      )

      await installPackage(fixture)
      await fixture.npm(['install', '--save-exact', '@rikology/adonisjs-tenant@1.0.2'])
      await writeFile(join(fixture.root, 'config', 'tenancy.ts'), TENANCY_CONFIG)
      await writeFile(
        join(fixture.root, 'providers', 'tenancy_fixture_provider.ts'),
        "export { default } from '@rikology/adonisjs-tenant/providers/tenancy_provider'\n"
      )
      await setExtensionProviders(fixture, ['tenancy_fixture_provider'])
      await editFile(join(fixture.root, 'adonisrc.ts'), (source) =>
        source.replace(
          'experimental: {},',
          "experimental: {},\n\n  directories: { models: 'app/tenancy_models' },"
        )
      )
      const models = join(fixture.root, 'app', 'tenancy_models')
      await mkdir(models, { recursive: true })
      await writeFile(join(models, 'invoice.ts'), INVOICE_MODEL)
      await writeFile(join(models, 'note.ts'), NOTE_MODEL)
      await writeFile(join(models, 'country.ts'), COUNTRY_MODEL)
      await writeFile(join(models, 'audit_entry.ts'), AUDIT_MODEL)
      await editFile(join(fixture.root, 'config', 'database.ts'), (source) =>
        source.replace(/(\n {4}pg: \{)/, `${EXTRA_PG_CONNECTIONS}$1`)
      )
      await writeMcpConfig(
        fixture,
        `  tools: {
    sql: {
      maxRows: 5,
      readers: {
        pg: { user: 'mcp_reader' },
        pg_bypass: { user: 'mcp_bypass' },
        pg_writer: { user: 'mcp_writer' },
      },
    },
  },`
      )
      app = await fixture.start({ nodeEnv: 'development' })
      await waitForMcp(app)
    } catch (error) {
      await fixture.dispose()
      await cluster.stop()
      throw error
    }
    return async () => {
      await fixture.dispose()
      await cluster.stop()
    }
  })

  test('models in a custom directory report tenant scoping', async ({ assert }) => {
    const models = await withClient(app, (client) => call<ModelsData>(client, 'get_models'))
    assert.equal(models.data.directory, 'app/tenancy_models')
    const scoped = Object.fromEntries(
      models.data.models.map((model) => [model.id, model.tenantScoped])
    )
    assert.deepEqual(scoped, { audit_entry: false, country: false, invoice: true, note: true })
    const invoice = models.data.models.find((model) => model.id === 'invoice')!
    assert.deepInclude(invoice.columns, {
      name: 'tenant_id',
      columnName: 'tenant_id',
      serializeAs: 'tenantId',
      isPrimary: false,
    })
  })

  test('query_model isolates concurrent tenants and fails closed', async ({ assert }) => {
    const clients = await Promise.all(
      (['modern', 'legacy'] as const).map((era) =>
        connectMcpClient(new URL(DEFAULT_PATH, app.url), { era })
      )
    )
    try {
      const tenants = ['a', 'b', 'a', 'b', 'b', 'a']
      const results = await Promise.all(
        tenants.map((tenant, index) =>
          call<QueryModelData>(clients[index % 2], 'query_model', {
            model: 'Invoice',
            tenant,
            orderBy: [{ column: 'number' }],
          })
        )
      )
      results.forEach((result, index) => {
        const tenant = tenants[index]
        assert.isTrue(
          result.data.rows.every((row) => row.tenantId === tenant),
          `tenant ${tenant} saw ${JSON.stringify(result.data.rows)}`
        )
        assert.lengthOf(result.data.rows, tenant === 'a' ? 2 : 1)
        assert.equal(result.data.scope.tenant?.id, tenant)
      })

      const [missing, unknown, country] = await Promise.all([
        callError(clients[0], 'query_model', { model: 'Invoice' }),
        callError(clients[0], 'query_model', { model: 'Invoice', tenant: 'zzz' }),
        call<QueryModelData>(clients[1], 'query_model', { model: 'Country' }),
      ])
      assert.equal(missing.code, 'TENANT_SCOPE_REQUIRED')
      assert.equal(unknown.code, 'NOT_FOUND')
      assert.include(unknown.message, 'Unknown tenant "zzz"')
      assert.equal(country.data.returnedRows, 2)
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  })

  test('tenant raw SQL is limited by FORCE row level security, never by text', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      for (const tenant of ['a', 'b']) {
        for (const query of [
          'SELECT tenant_id, number FROM invoices',
          'SELECT tenant_id, number FROM invoices WHERE tenant_id = $1 OR 1=1',
          "SELECT tenant_id, number FROM invoices /* WHERE tenant_id = 'a' */",
          'SELECT tenant_id, number FROM invoices WHERE tenant_id = $1 UNION SELECT tenant_id, number FROM invoices',
        ]) {
          const bindings = query.includes('$1') ? [tenant] : []
          const result = await call<SqlData>(client, 'execute_sql_query', {
            query,
            bindings,
            tenant,
          })
          assert.isAbove(result.data.rows.length, 0, query)
          assert.isTrue(
            result.data.rows.every((row) => row[0] === tenant),
            `${tenant}: ${query} -> ${JSON.stringify(result.data.rows)}`
          )
          assert.equal(result.data.tenant?.id, tenant)
        }
      }

      const override = await callError(client, 'execute_sql_query', {
        query: "SELECT set_config('app.tenant_id', 'b', true), * FROM invoices",
        tenant: 'a',
      })
      assert.equal(override.code, 'READ_ONLY_VIOLATION')

      const unprotected = await Promise.all([
        callError(client, 'execute_sql_query', { query: 'SELECT * FROM notes', tenant: 'a' }),
        callError(client, 'execute_sql_query', {
          query: 'SELECT i.number, c.code FROM invoices i CROSS JOIN countries c',
          tenant: 'a',
        }),
        callError(client, 'execute_sql_query', { query: 'SELECT * FROM invoices' }),
        callError(client, 'execute_sql_query', { query: 'SELECT * FROM notes' }),
      ])
      assert.deepEqual(
        unprotected.map((error) => error.code),
        [
          'TENANT_SCOPE_REQUIRED',
          'TENANT_SCOPE_REQUIRED',
          'TENANT_SCOPE_REQUIRED',
          'TENANT_SCOPE_REQUIRED',
        ]
      )
      assert.include(unprotected[1].message, 'countries')

      const global = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT code FROM countries ORDER BY code',
      })
      assert.deepEqual(global.data.rows, [['ID'], ['NL']])
      assert.isFalse(global.data.crossTenant)
    })
  })

  test('the reader refuses writes, side effects and over-privileged roles', async ({ assert }) => {
    await withClient(app, async (client) => {
      for (const query of [
        'COMMIT; DELETE FROM countries',
        'DELETE FROM countries',
        'WITH d AS (DELETE FROM countries RETURNING *) SELECT * FROM d',
        'SELECT pg_advisory_lock(1)',
        "SELECT nextval('countries_id_seq')",
        'SELECT pg_sleep(5)',
        'SELECT * FROM countries FOR UPDATE',
        "COPY (SELECT 1) TO PROGRAM 'true'",
      ]) {
        const error = await callError(client, 'execute_sql_query', { query })
        assert.equal(error.code, 'READ_ONLY_VIOLATION', query)
      }

      const roles = await Promise.all([
        callError(client, 'execute_sql_query', {
          query: 'SELECT * FROM invoices',
          tenant: 'a',
          connection: 'pg_bypass',
        }),
        callError(client, 'execute_sql_query', {
          query: 'SELECT * FROM countries',
          connection: 'pg_writer',
        }),
        callError(client, 'execute_sql_query', {
          query: 'SELECT 1',
          connection: 'pg_noreader',
        }),
      ])
      assert.deepEqual(
        roles.map((error) => error.code),
        ['CAPABILITY_UNSUPPORTED', 'CAPABILITY_UNSUPPORTED', 'CAPABILITY_UNSUPPORTED']
      )
      assert.include(roles[0].message, 'BYPASSRLS')
      assert.include(roles[1].message, 'can write')
      assert.include(roles[2].message, 'tools.sql.readers.pg_noreader')
    })
    assert.equal(await cluster.query(database, 'SELECT count(*) FROM countries'), '2')
    assert.equal(
      await cluster.query(database, "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'"),
      '0'
    )
  })

  test('cursor bounds rows and the deadline cancels the query in PostgreSQL', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const started = performance.now()
      const bounded = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT generate_series(1, 200000000) AS g',
      })
      assert.deepEqual(bounded.data.rows, [[1], [2], [3], [4], [5]])
      assert.isTrue(bounded.data.hasMore)
      // The unbounded series would run for hours; 15 s leaves room for slow hosted runners.
      assert.isBelow(performance.now() - started, 15_000)

      const slowStarted = performance.now()
      const [slow, home] = await Promise.all([
        callError(client, 'execute_sql_query', {
          query: 'SELECT count(*) FROM (SELECT generate_series(1, 20000000000) AS g) AS numbers',
          timeout: 300,
        }),
        new Promise((resolve) => setTimeout(resolve, 100)).then(() => statusOf(app.fetch('/'))),
      ])
      assert.equal(slow.code, 'TIMEOUT')
      assert.include(slow.message, 'pg_cancel_backend')
      assert.isBelow(performance.now() - slowStarted, 15_000)
      assert.equal(home, 200)

      const appPool = await call<QueryModelData>(client, 'query_model', { model: 'Country' })
      assert.equal(appPool.data.returnedRows, 2, 'the application pool is unaffected')

      const plan = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT * FROM countries WHERE id = $1',
        bindings: [1],
        explain: true,
      })
      assert.deepEqual(plan.data.columns, ['QUERY PLAN'])
    })
    const deadline = Date.now() + 5_000
    let readers = ''
    while (Date.now() < deadline) {
      readers = await cluster.query(
        database,
        "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'adonisjs-mcp%'"
      )
      if (readers === '0') {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(readers, '0', 'no reader or cancel connection outlives the call')
  })

  test('migrations and schema diff on PostgreSQL, per connection and schema', async ({
    assert,
  }) => {
    await withClient(app, async (client) => {
      const status = await call<MigrationsData>(client, 'get_migrations')
      assert.deepInclude(status.data.summary, { pending: 0, corrupt: 0 })
      const diff = await call<DiffData>(client, 'diff_schema')
      assert.deepEqual(
        Object.fromEntries(diff.data.models.map((model) => [model.model, model.status])),
        { country: 'in-sync', invoice: 'in-sync', note: 'in-sync' }
      )
      assert.include(diff.data.unmappedTables, 'users')

      const audit = await call<DiffData>(client, 'diff_schema', { connection: 'pg_noreader' })
      assert.deepEqual(
        audit.data.models.map((model) => [model.model, model.status]),
        [['audit_entry', 'in-sync']]
      )
      const entries = await call<QueryModelData>(client, 'query_model', { model: 'AuditEntry' })
      assert.deepEqual(
        entries.data.rows.map((row) => row.action),
        ['created']
      )
    })
  })

  test('cross-tenant reads are an explicit, labelled operator decision', async ({ assert }) => {
    await app.stop()
    await writeMcpConfig(
      fixture,
      `  tools: {
    sql: {
      maxRows: 5,
      allowCrossTenant: true,
      readers: { pg: { user: 'mcp_reader' } },
    },
  },`
    )
    app = await fixture.start({ nodeEnv: 'development' })
    await waitForMcp(app)
    await withClient(app, async (client) => {
      const invoices = await call<QueryModelData>(client, 'query_model', { model: 'Invoice' })
      assert.equal(invoices.data.returnedRows, 3)
      assert.deepInclude(invoices.data.scope, { tenant: null, crossTenant: true })
      assert.isTrue(invoices.limitations!.some((limitation) => limitation.includes('Cross-tenant')))

      const notes = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT tenant_id FROM notes ORDER BY tenant_id',
      })
      assert.deepEqual(notes.data.rows, [['a'], ['b']])
      assert.isTrue(notes.data.crossTenant)

      const rls = await call<SqlData>(client, 'execute_sql_query', {
        query: 'SELECT * FROM invoices',
      })
      assert.isTrue(rls.data.crossTenant)
      assert.equal(rls.data.returnedRows, 0, 'row security still applies without a tenant setting')

      const scoped = await call<QueryModelData>(client, 'query_model', {
        model: 'Invoice',
        tenant: 'b',
      })
      assert.deepInclude(scoped.data.scope, { crossTenant: false })
      assert.equal(scoped.data.returnedRows, 1)
    })
  })
})

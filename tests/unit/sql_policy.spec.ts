import { test } from '@japa/runner'
import { loadPostgresParser } from '../../src/database/postgres_parser.js'
import { checkPostgresQuery } from '../../src/database/postgres_policy.js'
import { checkSqliteProgram, leadingKeyword } from '../../src/database/sqlite_policy.js'

const parser = await loadPostgresParser()

test.group('PostgreSQL read-only policy', () => {
  test('allows read queries: {$self}')
    .with([
      'SELECT * FROM users WHERE email = $1',
      'SELECT u.id, count(*) FROM users u JOIN posts p ON p.user_id = u.id GROUP BY u.id HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 5',
      'WITH recent AS (SELECT * FROM posts WHERE created_at > now()) SELECT id FROM recent',
      'SELECT id FROM posts UNION ALL SELECT id FROM comments',
      'VALUES (1, 2)',
      "SELECT data->>'name', lower(title) FROM posts WHERE id = ANY($1)",
      'SELECT row_number() OVER (PARTITION BY user_id ORDER BY id) FROM posts',
      'SELECT * FROM generate_series(1, 3) AS g',
      'SELECT EXISTS (SELECT 1 FROM posts) /* comment */ -- trailing',
      'SELECT pg_catalog.lower(title) FROM posts',
    ])
    .run(({ assert }, sql) => {
      const verdict = checkPostgresQuery(parser, sql)
      assert.isTrue(verdict.allowed, verdict.allowed ? '' : verdict.reason)
    })

  test('denies writes, side effects and unknown grammar: {$self}')
    .with([
      'SELECT 1; DELETE FROM users',
      'COMMIT; DELETE FROM users',
      'COMMIT',
      'ROLLBACK',
      'DELETE FROM users',
      '/* SELECT */ DELETE FROM users',
      'INSERT INTO users (id) VALUES (1) RETURNING id',
      'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d',
      'EXPLAIN ANALYZE DELETE FROM users',
      "SELECT nextval('users_id_seq')",
      "SELECT setval('users_id_seq', 1)",
      'SELECT pg_advisory_lock(1)',
      "SELECT set_config('app.tenant_id', 'b', true)",
      'SELECT pg_sleep(30)',
      "SELECT dblink_exec('dbname=postgres', 'DROP TABLE users')",
      'SELECT pg_terminate_backend(1)',
      "SELECT lo_import('/etc/passwd')",
      "SELECT query_to_xml('DELETE FROM users', true, true, '')",
      'SELECT * FROM pg_ls_dir($1)',
      'DO $$ BEGIN DELETE FROM users; END $$',
      'CALL purge()',
      "COPY (SELECT 1) TO PROGRAM 'true'",
      'LISTEN channel',
      "NOTIFY channel, 'x'",
      'SET ROLE postgres',
      'SET TRANSACTION READ WRITE',
      'SELECT * FROM users FOR UPDATE',
      'SELECT * INTO copy FROM users',
      'SELECT public.lower(title) FROM posts',
      'SELECT "Lower"(title) FROM posts',
      'SELECT a OPERATOR(pg_catalog.+) b FROM t',
      '',
    ])
    .run(({ assert }, sql) => {
      assert.isFalse(checkPostgresQuery(parser, sql).allowed)
    })

  test('reports relations with schema and CTE names', ({ assert }) => {
    const verdict = checkPostgresQuery(
      parser,
      'WITH posts AS (SELECT * FROM public.posts) SELECT * FROM posts JOIN "Users" u ON true WHERE EXISTS (SELECT 1 FROM audit.logs)'
    )
    assert.isTrue(verdict.allowed)
    if (verdict.allowed) {
      assert.sameDeepMembers(verdict.relations, [
        { schema: 'public', name: 'posts' },
        { schema: null, name: 'posts' },
        { schema: null, name: 'Users' },
        { schema: 'audit', name: 'logs' },
      ])
      assert.deepEqual(verdict.cteNames, ['posts'])
    }
  })
})

test.group('SQLite read-only program policy', () => {
  test('returns the root pages a plain read opens', ({ assert }) => {
    const verdict = checkSqliteProgram([
      { opcode: 'Init', p2: 0, p3: 0, p4: null },
      { opcode: 'OpenRead', p2: 2, p3: 0, p4: '3' },
      { opcode: 'OpenRead', p2: 3, p3: 0, p4: 'k(2,,)' },
      { opcode: 'Function', p2: 6, p3: 0, p4: 'like(2)' },
      { opcode: 'AggStep', p2: 0, p3: 0, p4: 'count(0)' },
      { opcode: 'Halt', p2: 0, p3: 0, p4: null },
    ])
    assert.deepEqual(verdict, { allowed: true, rootPages: [2, 3] })
  })

  test('denies {$self.label}')
    .with([
      { label: 'load_extension', opcode: 'Function', p4: 'load_extension(1)', p3: 0 },
      { label: 'ATTACH', opcode: 'Function', p4: 'sqlite_attach(3)', p3: 0 },
      { label: 'VACUUM INTO', opcode: 'Vacuum', p4: null, p3: 0 },
      { label: 'pragma table-valued functions', opcode: 'VOpen', p4: 'vtab:1', p3: 0 },
      { label: 'schema changes', opcode: 'Expire', p4: null, p3: 0 },
      { label: 'writes', opcode: 'OpenWrite', p4: null, p3: 0 },
      { label: 'attached databases', opcode: 'OpenRead', p4: null, p3: 2 },
    ])
    .run(({ assert }, row) => {
      const verdict = checkSqliteProgram([{ opcode: row.opcode, p2: 2, p3: row.p3, p4: row.p4 }])
      assert.isFalse(verdict.allowed)
    })

  test('classifies the leading keyword after comments', ({ assert }) => {
    assert.equal(leadingKeyword('  -- note\n/* block */ select 1'), 'SELECT')
    assert.equal(leadingKeyword('/* select */ DELETE FROM t'), 'DELETE')
    assert.equal(leadingKeyword('PRAGMA query_only=OFF'), 'PRAGMA')
    assert.equal(leadingKeyword('-- only a comment'), '')
  })
})

/**
 * `pgsql-ast-parser`, loaded on the first PostgreSQL raw SQL call only.
 */
export async function loadPostgresParser(): Promise<{ parse(sql: string): unknown[] }> {
  const { parse } = await import('pgsql-ast-parser')
  return { parse: (sql) => parse(sql) }
}

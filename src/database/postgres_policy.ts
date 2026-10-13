/*
|--------------------------------------------------------------------------
| Read-only PostgreSQL policy
|--------------------------------------------------------------------------
|
| Layer on top of the database-enforced boundaries (least-privilege
| reader, READ ONLY transaction, extended protocol). It rejects what those
| boundaries do not neutralize: transaction control, functions with side
| effects (advisory locks, set_config, pg_sleep, dblink, lo_*), COPY,
| LISTEN/NOTIFY, locking clauses and data-modifying CTEs.
|
| Statements are parsed with `pgsql-ast-parser` (`parse`, never
| `parseFirst`): exactly one SELECT/VALUES/WITH statement, every node type
| from an allowlist, every function call from a reviewed list of built-in
| functions without side effects. Grammar the parser does not know fails
| closed.
|
| Views, operators and functions defined in the application database are
| trusted code; the policy cannot see what a view does.
|
*/

import { isPlainObject } from '../define_tool.js'

/**
 * Built-in PostgreSQL functions without side effects that read-only
 * queries may call, unqualified or qualified with `pg_catalog`. Names are
 * compared exactly: a quoted mixed-case name is a different function.
 */
export const POSTGRES_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregates
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'bool_and',
  'bool_or',
  'every',
  'string_agg',
  'array_agg',
  'json_agg',
  'jsonb_agg',
  'json_object_agg',
  'jsonb_object_agg',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'variance',
  'var_pop',
  'var_samp',
  'percentile_cont',
  'percentile_disc',
  'mode',
  // Window functions
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
  // Conditional and row constructors
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'row',
  'exists',
  'any',
  'all',
  'some',
  'num_nulls',
  'num_nonnulls',
  // Strings
  'lower',
  'upper',
  'initcap',
  'length',
  'char_length',
  'character_length',
  'octet_length',
  'bit_length',
  'substr',
  'substring',
  'trim',
  'btrim',
  'ltrim',
  'rtrim',
  'lpad',
  'rpad',
  'replace',
  'concat',
  'concat_ws',
  'left',
  'right',
  'position',
  'strpos',
  'split_part',
  'starts_with',
  'reverse',
  'repeat',
  'translate',
  'format',
  'md5',
  'regexp_replace',
  'regexp_match',
  'regexp_matches',
  'regexp_split_to_array',
  'string_to_array',
  'array_to_string',
  'to_hex',
  'ascii',
  'chr',
  'encode',
  'decode',
  // Numbers
  'abs',
  'round',
  'ceil',
  'ceiling',
  'floor',
  'trunc',
  'mod',
  'div',
  'power',
  'sqrt',
  'cbrt',
  'sign',
  'exp',
  'ln',
  'log',
  'log10',
  'pi',
  // Date and time
  'now',
  'date_trunc',
  'date_part',
  'date_bin',
  'age',
  'to_char',
  'to_date',
  'to_timestamp',
  'to_number',
  'make_date',
  'make_time',
  'make_timestamp',
  'make_timestamptz',
  'make_interval',
  'justify_days',
  'justify_hours',
  'justify_interval',
  'isfinite',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
  'timezone',
  // JSON
  'to_json',
  'to_jsonb',
  'row_to_json',
  'json_build_object',
  'jsonb_build_object',
  'json_build_array',
  'jsonb_build_array',
  'json_array_length',
  'jsonb_array_length',
  'json_typeof',
  'jsonb_typeof',
  'json_extract_path',
  'jsonb_extract_path',
  'json_extract_path_text',
  'jsonb_extract_path_text',
  'json_object_keys',
  'jsonb_object_keys',
  'json_array_elements',
  'jsonb_array_elements',
  'json_array_elements_text',
  'jsonb_array_elements_text',
  'json_each',
  'jsonb_each',
  'json_each_text',
  'jsonb_each_text',
  'jsonb_pretty',
  'jsonb_strip_nulls',
  'jsonb_set',
  'jsonb_insert',
  'jsonb_path_query',
  'jsonb_path_query_array',
  'jsonb_path_query_first',
  'jsonb_path_exists',
  // Arrays and set-returning
  'array_length',
  'array_upper',
  'array_lower',
  'array_position',
  'array_positions',
  'array_remove',
  'array_append',
  'array_prepend',
  'array_cat',
  'cardinality',
  'unnest',
  'generate_series',
  'generate_subscripts',
  // Text search
  'to_tsvector',
  'to_tsquery',
  'plainto_tsquery',
  'phraseto_tsquery',
  'websearch_to_tsquery',
  'ts_rank',
  'ts_rank_cd',
  'ts_headline',
])

/**
 * AST node types a read-only PostgreSQL query may contain. Any other
 * `type` (insert/update/delete, locking clauses, unknown grammar) fails.
 */
const POSTGRES_NODE_TYPES: ReadonlySet<string> = new Set([
  'select',
  'union',
  'union all',
  'values',
  'with',
  'with recursive',
  'table',
  'statement',
  'call',
  'ref',
  'parameter',
  'list',
  'array',
  'array select',
  'null',
  'extract',
  'integer',
  'numeric',
  'string',
  'boolean',
  'constant',
  'member',
  'keyword',
  'arrayIndex',
  'case',
  'binary',
  'unary',
  'cast',
  'ternary',
  'overlay',
  'substring',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
])

const ROOT_TYPES: ReadonlySet<string> = new Set([
  'select',
  'union',
  'union all',
  'values',
  'with',
  'with recursive',
])

export interface RelationName {
  schema: string | null
  name: string
}

export type PolicyVerdict =
  | {
      allowed: true

      /**
       * Relations named in FROM clauses. Unqualified names that are also
       * CTE names are listed in `cteNames` and may refer to either.
       */
      relations: RelationName[]
      cteNames: string[]
    }
  | { allowed: false; reason: string }

interface PgsqlAstParser {
  parse(sql: string): unknown[]
}

function deny(reason: string): PolicyVerdict {
  return { allowed: false, reason }
}

/**
 * Checks one PostgreSQL query against the read-only subset.
 */
export function checkPostgresQuery(parser: PgsqlAstParser, sql: string): PolicyVerdict {
  let statements: unknown[]
  try {
    statements = parser.parse(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return deny(`outside the supported read-only SQL subset (parser: ${message})`)
  }
  if (statements.length !== 1) {
    return deny(`exactly one statement is required, got ${statements.length}`)
  }
  const root = statements[0]
  if (!isPlainObject(root) || typeof root.type !== 'string' || !ROOT_TYPES.has(root.type)) {
    const type = isPlainObject(root) ? String(root.type) : 'unknown'
    return deny(`only SELECT, VALUES and WITH queries are allowed, got "${type}"`)
  }

  const relations = new Map<string, RelationName>()
  const cteNames = new Set<string>()
  const problems: string[] = []

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!isPlainObject(node)) {
      return
    }
    if ('type' in node) {
      const type = node.type
      if (typeof type !== 'string' || !POSTGRES_NODE_TYPES.has(type)) {
        problems.push(`"${String(type)}" is not allowed in read-only queries`)
        return
      }
      if (type === 'call') {
        const fn = isPlainObject(node.function) ? node.function : {}
        const name = typeof fn.name === 'string' ? fn.name : ''
        const schema = typeof fn.schema === 'string' ? fn.schema : undefined
        if ((schema !== undefined && schema !== 'pg_catalog') || !POSTGRES_FUNCTIONS.has(name)) {
          problems.push(
            `function ${schema ? `${schema}.` : ''}${name}() is not in the read-only function allowlist`
          )
        }
      }
      if ((type === 'binary' || type === 'unary') && node.opSchema !== undefined) {
        problems.push('schema-qualified OPERATOR() calls are not allowed')
      }
      if (type === 'table' && isPlainObject(node.name) && typeof node.name.name === 'string') {
        const schema = typeof node.name.schema === 'string' ? node.name.schema : null
        relations.set(`${schema ?? ''}\0${node.name.name}`, { schema, name: node.name.name })
      }
      if (type === 'select' && (node.for !== undefined || node.skip !== undefined)) {
        problems.push('locking clauses (FOR UPDATE/SHARE) are not allowed')
      }
      if (type === 'with' && Array.isArray(node.bind)) {
        for (const binding of node.bind) {
          if (isPlainObject(binding) && isPlainObject(binding.alias)) {
            cteNames.add(String(binding.alias.name))
          }
        }
      }
      if (type === 'with recursive' && isPlainObject(node.alias)) {
        cteNames.add(String(node.alias.name))
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'type') {
        visit(value)
      }
    }
  }
  visit(root)

  if (problems.length > 0) {
    return deny([...new Set(problems)].join('; '))
  }
  return { allowed: true, relations: [...relations.values()], cteNames: [...cteNames] }
}

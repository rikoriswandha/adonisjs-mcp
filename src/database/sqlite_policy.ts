/*
|--------------------------------------------------------------------------
| Read-only SQLite policy
|--------------------------------------------------------------------------
|
| Checked natively inside the SQLite reader process, on top of the
| readonly file connection: the statement must be a single statement that
| SQLite reports as a read-only reader, start with SELECT/WITH/VALUES, and
| compile to a program without writes, schema or session changes, virtual
| tables or functions outside a reviewed list of built-ins. The compiled
| program (`EXPLAIN`) is the authority, not a JavaScript grammar.
|
| This module has no imports: the reader process loads it.
|
*/

/**
 * Built-in SQLite functions without side effects, as named in the
 * compiled program (`Function`/`Agg*` opcodes).
 */
export const SQLITE_FUNCTIONS: ReadonlySet<string> = new Set([
  'count',
  'sum',
  'total',
  'avg',
  'min',
  'max',
  'group_concat',
  'string_agg',
  'abs',
  'round',
  'ceil',
  'ceiling',
  'floor',
  'trunc',
  'sign',
  'mod',
  'pow',
  'power',
  'sqrt',
  'exp',
  'ln',
  'log',
  'log2',
  'log10',
  'pi',
  'lower',
  'upper',
  'length',
  'octet_length',
  'substr',
  'substring',
  'trim',
  'ltrim',
  'rtrim',
  'replace',
  'instr',
  'char',
  'unicode',
  'hex',
  'unhex',
  'quote',
  'printf',
  'format',
  'concat',
  'concat_ws',
  'coalesce',
  'ifnull',
  'nullif',
  'iif',
  'typeof',
  'likely',
  'unlikely',
  'likelihood',
  'like',
  'glob',
  'date',
  'time',
  'datetime',
  'julianday',
  'strftime',
  'unixepoch',
  'timediff',
  'json',
  'jsonb',
  'json_extract',
  'jsonb_extract',
  'json_array',
  'json_object',
  'json_array_length',
  'json_type',
  'json_valid',
  'json_quote',
  'json_group_array',
  'json_group_object',
  '->',
  '->>',
  'random',
  'zeroblob',
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
])

/**
 * Opcodes that write, change the schema or session, or run virtual
 * table code. A read-only SELECT never needs them.
 */
const DENIED_OPCODES: ReadonlySet<string> = new Set([
  'OpenWrite',
  'Vacuum',
  'IncrVacuum',
  'Checkpoint',
  'JournalMode',
  'ParseSchema',
  'Expire',
  'Destroy',
  'Clear',
  'CreateBtree',
  'SqlExec',
  'DropTable',
  'DropIndex',
  'DropTrigger',
  'LoadAnalysis',
  'Program',
  'VBegin',
  'VCreate',
  'VDestroy',
  'VOpen',
  'VFilter',
  'VColumn',
  'VNext',
  'VUpdate',
  'VRename',
  'VCheck',
  'VInitIn',
])

const FUNCTION_OPCODES: ReadonlySet<string> = new Set([
  'Function',
  'PureFunc',
  'AggStep',
  'AggStep1',
  'AggFinal',
  'AggValue',
  'AggInverse',
])

export const SQLITE_READ_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES'])

export interface SqliteInstruction {
  opcode: string
  p2: number
  p3: number
  p4: string | null
}

export type SqliteProgramVerdict =
  { allowed: true; rootPages: number[] } | { allowed: false; reason: string }

/**
 * Checks the program SQLite compiled for a statement (`EXPLAIN` rows).
 * Returns the B-tree root pages the program opens for reading.
 */
export function checkSqliteProgram(program: readonly SqliteInstruction[]): SqliteProgramVerdict {
  const problems = new Set<string>()
  const rootPages = new Set<number>()
  for (const instruction of program) {
    if (DENIED_OPCODES.has(instruction.opcode)) {
      problems.add(
        instruction.opcode.startsWith('V')
          ? 'virtual tables (including pragma table-valued functions) are not allowed'
          : `the statement compiles to ${instruction.opcode}, which read-only queries never need`
      )
    }
    if (FUNCTION_OPCODES.has(instruction.opcode)) {
      const name = (instruction.p4 ?? '').replace(/\(-?\d+\)$/, '')
      if (!SQLITE_FUNCTIONS.has(name)) {
        problems.add(`function ${name}() is not in the read-only function allowlist`)
      }
    }
    if (instruction.opcode === 'OpenRead') {
      if (instruction.p3 !== 0) {
        problems.add('only the main database can be read')
      }
      rootPages.add(instruction.p2)
    }
  }
  if (problems.size > 0) {
    return { allowed: false, reason: [...problems].join('; ') }
  }
  return { allowed: true, rootPages: [...rootPages] }
}

/**
 * First keyword of a statement, after whitespace and comments, uppercased.
 * Classification only: the compiled program and the readonly connection
 * are the enforcement.
 */
export function leadingKeyword(sql: string): string {
  let index = 0
  while (index < sql.length) {
    if (/\s/.test(sql[index])) {
      index++
    } else if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
    } else if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
    } else {
      break
    }
  }
  return /^[A-Za-z]+/.exec(sql.slice(index))?.[0].toUpperCase() ?? ''
}

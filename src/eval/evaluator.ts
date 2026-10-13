/*
|--------------------------------------------------------------------------
| Trusted development evaluator
|--------------------------------------------------------------------------
| Runs in the application process, not a sandbox. Deadlines stop waiting,
| never execution. The application importer owns module identity and HMR.
*/
import vm from 'node:vm'
import { formatWithOptions, inspect } from 'node:util'
import { performance } from 'node:perf_hooks'
import type { ApplicationService } from '@adonisjs/core/types'
import { ToolError } from '../errors.js'
import { callScope } from '../call_scope.js'
import type { Redactor } from '../redaction.js'
import type { TenantIdentity, ToolContext, ToolOutput } from '../types.js'

export const EVAL_LIMITATIONS = [
  'Trusted development REPL: code can read secrets, write databases/files and access the network; this is not a sandbox.',
  'Timeout/cancellation is cooperative: execution is not stopped and side effects may continue. Synchronous loops freeze the HTTP server.',
  'Only the injected lexical console is captured; imported modules using global console are not captured.',
  'Redaction is best effort. Relative imports resolve through the application importer, not the synthetic eval filename.',
]

function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text
  return (
    Buffer.from(text)
      .subarray(0, Math.max(0, bytes - 3))
      .toString('utf8') + '…'
  )
}

const MAX_CONSOLE_ENTRIES = 200

const INSPECT_OPTIONS = {
  depth: 4,
  colors: false,
  maxArrayLength: 100,
  breakLength: Infinity,
} as const

/**
 * Lexical `console` handed to one evaluation. Nothing is patched globally;
 * modules imported by the code keep the real console.
 */
class ConsoleCapture {
  readonly entries: Array<{ level: string; text: string }> = []
  dropped = 0
  #bytes = 0
  readonly #counters = new Map<string, number>()
  readonly #timers = new Map<string, number>()
  readonly console: Record<string, (...args: unknown[]) => void>

  constructor(redactor: Redactor, maxBytes: number, maxStringLength: number) {
    const options = { ...INSPECT_OPTIONS, maxStringLength }
    const push = (level: string, args: unknown[]) => {
      // Checked before formatting: a full capture costs nothing per call.
      if (this.entries.length >= MAX_CONSOLE_ENTRIES || this.#bytes >= maxBytes) {
        this.dropped++
        return
      }
      const text = bounded(
        redactor.inspectedText(formatWithOptions(options, ...args)),
        Math.min(16_384, maxBytes)
      )
      const bytes = Buffer.byteLength(text)
      if (this.#bytes + bytes > maxBytes) {
        this.dropped++
        return
      }
      this.#bytes += bytes
      this.entries.push({ level, text })
    }
    const label = (value: unknown) => (value === undefined ? 'default' : String(value))
    const elapsed = (name: string) => {
      const started = this.#timers.get(name)
      return started === undefined ? null : `${name}: ${(performance.now() - started).toFixed(3)}ms`
    }
    this.console = {
      ...Object.fromEntries(
        ['log', 'info', 'warn', 'error', 'debug', 'trace'].map((level) => [
          level,
          (...args: unknown[]) => push(level, args),
        ])
      ),
      dir: (value: unknown) => push('dir', [inspect(value, options)]),
      table: (value: unknown) => push('table', [inspect(value, options)]),
      assert: (condition: unknown, ...args: unknown[]) => {
        if (!condition) push('error', ['Assertion failed', ...args])
      },
      count: (name?: unknown) => {
        const key = label(name)
        const count = (this.#counters.get(key) ?? 0) + 1
        this.#counters.set(key, count)
        push('log', [`${key}: ${count}`])
      },
      countReset: (name?: unknown) => {
        this.#counters.delete(label(name))
      },
      time: (name?: unknown) => {
        this.#timers.set(label(name), performance.now())
      },
      timeLog: (name?: unknown, ...args: unknown[]) => {
        const line = elapsed(label(name))
        if (line) push('log', [line, ...args])
      },
      timeEnd: (name?: unknown) => {
        const line = elapsed(label(name))
        this.#timers.delete(label(name))
        if (line) push('log', [line])
      },
      group: (...args: unknown[]) => {
        if (args.length > 0) push('log', args)
      },
      groupCollapsed: (...args: unknown[]) => {
        if (args.length > 0) push('log', args)
      },
      groupEnd: () => {},
    }
  }

  snapshot() {
    return { entries: [...this.entries], dropped: this.dropped }
  }
}

export class ProjectEvaluator {
  constructor(
    private app: ApplicationService,
    private redactor: Redactor
  ) {}

  async run(
    code: string,
    timeout: number,
    tenant: TenantIdentity | null,
    context: ToolContext
  ): Promise<ToolOutput> {
    const started = performance.now()
    const options = {
      ...INSPECT_OPTIONS,
      // Never below the 4 KiB failure-message cut, so a secret cannot be shown partially there.
      maxStringLength:
        Math.max(context.config.limits.maxResultBytes / 2, 4096) +
        this.redactor.longestEscapedSecretLength,
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)])
    const capture = new ConsoleCapture(
      this.redactor,
      Math.min(65_536, context.config.limits.maxResultBytes / 4),
      options.maxStringLength
    )
    const logger = await this.app.container.make('logger')
    const excerpt = this.redactor.text(code.replace(/\s+/g, ' ')).slice(0, 200)
    // Abort events may originate in the transport's ALS, not the tool's.
    const audit = (status: string) =>
      callScope.run({ callId: context.callId }, () =>
        logger.info(
          {
            tool: 'project_eval',
            status,
            durationMs: performance.now() - started,
            callId: context.callId,
            codeExcerpt: excerpt,
          },
          'MCP project_eval audit'
        )
      )
    let detached = false
    const interrupted = Promise.withResolvers<never>()
    const onAbort = () => {
      detached = true
      const cancelled = context.signal.aborted
      audit(cancelled ? 'cancelled' : 'timeout')
      interrupted.reject(
        new ToolError(
          cancelled ? 'CANCELLED' : 'TIMEOUT',
          'Stopped waiting for evaluation; execution was not stopped and side effects may continue.',
          { details: { console: capture.snapshot(), limitations: EVAL_LIMITATIONS } }
        )
      )
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const execution = Promise.resolve().then(async () => {
      if (signal.aborted) return undefined
      const db = this.app.container.hasBinding('lucid.db')
        ? await this.app.container.make('lucid.db')
        : undefined
      const evaluate = vm.compileFunction(
        `return (async () => {\n${code}\n})()`,
        ['app', 'container', 'console', 'signal', 'db', 'tenant'],
        {
          filename: this.app.makePath('__mcp_eval__.js'),
          lineOffset: -1,
          importModuleDynamically: (specifier) => this.app.import(specifier),
        }
      )
      return evaluate(this.app, this.app.container, capture.console, signal, db, tenant) as unknown
    })
    // Both branches consume late rejection, retain the call ALS, and audit it.
    const observed = execution.then(
      (value) => {
        audit(detached ? 'late-completed' : 'completed')
        return value
      },
      (error: unknown) => {
        audit(detached ? 'late-failed' : 'threw')
        throw error
      }
    )
    try {
      const value = await Promise.race([interrupted.promise, observed])
      const inspected = this.redactor.inspectedText(inspect(value, options))
      const display = bounded(inspected, context.config.limits.maxResultBytes / 2)
      return {
        data: {
          display,
          displayTruncated: display !== inspected,
          type: bounded(
            this.redactor.text(
              value === null
                ? 'null'
                : typeof value === 'object'
                  ? (value.constructor?.name ?? 'object')
                  : typeof value
            ),
            1024
          ),
          console: capture.snapshot(),
          durationMs: performance.now() - started,
          callId: context.callId,
          ...(tenant ? { tenant: this.redactor.value(tenant) } : {}),
        },
        limitations: EVAL_LIMITATIONS,
      }
    } catch (error) {
      if (detached && error instanceof ToolError) throw error
      const failure =
        error instanceof Error
          ? error
          : new Error(this.redactor.inspectedText(formatWithOptions(options, error)))
      throw new ToolError('EXECUTION_FAILED', bounded(this.redactor.text(failure.message), 4096), {
        details: {
          name: this.redactor.text(failure.name),
          message: bounded(this.redactor.text(failure.message), 4096),
          stack: bounded(this.redactor.text(failure.stack ?? ''), 16_384),
          console: capture.snapshot(),
          limitations: EVAL_LIMITATIONS,
        },
      })
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

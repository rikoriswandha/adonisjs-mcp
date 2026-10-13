/*
|--------------------------------------------------------------------------
| Read-only queue registration and state
|--------------------------------------------------------------------------
|
| Mirrors the 0.6.0 loader without registering jobs. Public pending counts
| are separate from explicitly version-bound internal physical SQL reads.
|
*/
import { glob, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import { packageAvailability } from '../../introspection/integrations.js'
import { queueDatabaseConfig } from '../../introspection/queue_database.js'
import { errorMessage } from '../../introspection/source_files.js'
import { project } from '../../redaction.js'
import type { Redactor } from '../../redaction.js'
import type { AnyToolDefinition } from '../../types.js'

interface Select extends PromiseLike<Record<string, unknown>[]> {
  from(table: string): Select
  select(...columns: string[]): Select
  where(column: string, value: string): Select
  orderBy(column: string): Select
  limit(count: number): Select
  count(column: string): Select
  groupBy(...columns: string[]): Select
}
interface Database {
  connection(name?: string): { query(): Select }
}
interface Adapter {
  sizeOf?(queue: string): Promise<number>
}
interface JobFunction extends Function {
  options?: { name?: string; queue?: string }
}

export function getQueueJobsTool(redactor: Redactor): AnyToolDefinition {
  return defineTool({
    name: 'get_queue_jobs',
    title: 'Queue jobs and state',
    description:
      'Reads configured job registrations and pending queue counts from the running AdonisJS application. Imports trusted job modules (top-level code runs). Status listing uses a version-gated database physical-schema adapter. Never loads/registers, dispatches or executes jobs.',
    inputSchema: z.object({
      status: z.enum(['pending', 'active', 'delayed', 'completed', 'failed']).optional(),
      queue: z.string().min(1).max(255).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: (context) => packageAvailability(context, 'queue'),
    async handler(input, context) {
      const app = context.app
      const root = fileURLToPath(app.appRoot)
      const module = (await app.import('@boringnode/queue')) as {
        Locator: { get(name: string): unknown }
      }
      const manager = (await app.container.make('queue.manager' as never)) as { use(): Adapter }
      const adapter = manager.use()
      const locations = app.config.get<string[]>('queue.locations', [])
      const jobs: Array<{
        name: string
        file: string
        registered: boolean
        evidence: string
        changedSinceProcessStart: boolean
      }> = []
      const rejected: Array<{ file: string; reason: string }> = []
      const queues = new Set<string>([
        'default',
        ...Object.keys(app.config.get<Record<string, unknown>>('queue.queues', {})),
      ])
      const seen = new Set<string>()
      for (const pattern of locations) {
        for await (const file of glob(pattern)) {
          if (seen.has(file)) {
            continue
          }
          seen.add(file)
          try {
            const imported = (await app.import(`file://${resolve(file)}`)) as { default: unknown }
            if (typeof imported.default !== 'function') {
              rejected.push({ file, reason: 'default export is not a function' })
              continue
            }
            const candidate = imported.default as JobFunction
            const name = candidate.options?.name || candidate.name
            if (candidate.options?.queue) {
              queues.add(candidate.options.queue)
            }
            const registered = module.Locator.get(name) === candidate
            const stats = await stat(resolve(file))
            jobs.push({
              name,
              file,
              registered,
              evidence: 'config-declared+runtime-verified',
              changedSinceProcessStart: stats.mtimeMs > performance.timeOrigin,
            })
            if (!registered) {
              rejected.push({
                file,
                reason: module.Locator.get(name)
                  ? 'name collision: Locator identity mismatch'
                  : 'class is not registered in Locator',
              })
            }
          } catch (error) {
            rejected.push({ file, reason: redactor.text(errorMessage(error)) })
          }
        }
      }
      const pending: Array<{ queue: string; count: number | null; reason?: string }> = []
      const limitations = [
        'Configured locations use process.cwd(), resolve(file), and the loader raw file URL semantics, not appRoot. Imports run trusted top-level code.',
        'Manual registrations outside configured locations are not enumerable. Public sizeOf(queue) counts pending jobs only.',
        'Physical status reads support static official drivers.database config only; dynamic or changed configuration is unsupported.',
      ]
      let state: unknown = {
        available: false,
        code: 'CAPABILITY_UNSUPPORTED',
        reason: 'Status listing requires @boringnode/queue 0.6.0 and the database adapter',
        evidence: 'internal-physical-schema',
      }
      try {
        const require = createRequire(join(root, 'package.json'))
        const manifest = JSON.parse(
          await readFile(
            join(dirname(require.resolve('@boringnode/queue')), '..', 'package.json'),
            'utf8'
          )
        ) as { version: string }
        const profile = await context.profile()
        if (manifest.version === '0.6.0' && profile.packages.queue.version === '0.6.2') {
          const driver = (await app.import('@boringnode/queue/drivers/knex_adapter')) as {
            KnexAdapter: new (...args: never[]) => unknown
          }
          if (adapter instanceof driver.KnexAdapter) {
            const config = await queueDatabaseConfig(root, app.config.get<string>('queue.default'))
            if (config) {
              const db = (await app.container.make('lucid.db' as never)) as Database
              const connection = db.connection(config.connectionName ?? undefined)
              const countsQuery = connection
                .query()
                .from(config.tableName)
                .select('queue', 'status')
                .count('* as count')
                .groupBy('queue', 'status')
              if (input.queue) {
                countsQuery.where('queue', input.queue)
              }
              const counts = await countsQuery
              for (const count of counts) {
                if (typeof count.queue === 'string') {
                  queues.add(count.queue)
                }
              }
              const listing = connection
                .query()
                .from(config.tableName)
                .select('id', 'queue', 'status', 'data', 'error', 'finished_at')
                .orderBy('id')
                .limit(input.limit)
              if (input.status) {
                listing.where('status', input.status)
              }
              if (input.queue) {
                listing.where('queue', input.queue)
              }
              const rows = await listing
              state = {
                available: true,
                evidence: 'internal-physical-schema',
                configurationEvidence: config.evidence,
                table: config.tableName,
                counts,
                limit: input.limit,
                rows: rows.map((row) => {
                  let data: unknown = row.data
                  if (typeof data === 'string') {
                    try {
                      data = JSON.parse(data)
                    } catch {
                      /* Keep invalid persisted text as redacted text. */
                    }
                  }
                  return project({ ...row, data }, { redactor })
                }),
              }
            } else {
              state = {
                available: false,
                code: 'CAPABILITY_UNSUPPORTED',
                reason:
                  'Database connection/table cannot be proven from static unchanged config/queue.ts',
                evidence: 'internal-physical-schema',
              }
            }
          }
        }
      } catch (error) {
        state = {
          available: false,
          code: 'CAPABILITY_UNSUPPORTED',
          reason: redactor.text(errorMessage(error)),
          evidence: 'internal-physical-schema',
        }
      }
      if (input.queue && !queues.has(input.queue)) {
        throw new ToolError(
          'NOT_FOUND',
          `Unknown queue "${input.queue}". Known queues: ${[...queues].join(', ')}`
        )
      }
      for (const queue of [...queues].sort()) {
        if (input.queue && input.queue !== queue) {
          continue
        }
        if (typeof adapter.sizeOf !== 'function') {
          pending.push({ queue, count: null, reason: 'Driver does not expose sizeOf' })
        } else {
          try {
            pending.push({ queue, count: await adapter.sizeOf(queue) })
          } catch (error) {
            pending.push({ queue, count: null, reason: redactor.text(errorMessage(error)) })
          }
        }
      }
      if (jobs.some((job) => job.changedSinceProcessStart)) {
        limitations.push(
          'Job files changed after process start; the running process may still use the previous version.'
        )
      }
      return {
        data: {
          jobs,
          rejected,
          locations,
          cwd: process.cwd(),
          appRoot: root,
          coverage: 'configured locations only; runtime identity verified per class',
          manualRegistrations: 'not-enumerable',
          pending: { meaning: 'pending-only', queues: pending },
          state,
        },
        evidence: ['runtime', 'source'],
        limitations,
      }
    },
  })
}

import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { FixtureApp, RunningApp } from './fixture_app.js'
import { DEFAULT_PATH, INITIALIZE_BODY, MCP_HEADERS } from './mcp_endpoint.js'

export interface RuntimeSample {
  pid: number
  marker: number
  resources: Record<string, number>
  memory: { rss: number; heapUsed: number }
  delay: { mean: number; p95: number; max: number }
  subscribers: { logs: number; exceptions: number }
  emitterListeners: number
}

export const probeController = (
  marker: number
) => `import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { IntervalHistogram } from 'node:perf_hooks'
import app from '@adonisjs/core/services/app'
import emitter from '@adonisjs/core/services/emitter'
import { instrumentationStatus } from '@rikology/adonisjs-mcp/hooks'
const state = app as typeof app & { lifecycleHistogram?: IntervalHistogram }
state.lifecycleHistogram ??= monitorEventLoopDelay({ resolution: 20 })
state.lifecycleHistogram.enable()
export default class LifecycleProbeController {
  handle() {
    const resources: Record<string, number> = {}
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1
    const histogram = state.lifecycleHistogram!
    return { pid: process.pid, marker: ${marker}, resources, memory: process.memoryUsage(), subscribers: instrumentationStatus().subscribers, emitterListeners: emitter.listenerCount(), delay: { mean: histogram.mean / 1e6, p95: histogram.percentile(95) / 1e6, max: histogram.max / 1e6 } }
  }
}
`

export async function installLifecycleProbe(fixture: FixtureApp) {
  await writeFile(
    join(fixture.root, 'app/controllers/lifecycle_probe_controller.ts'),
    probeController(0)
  )
  await appendFile(
    join(fixture.root, 'start/routes.ts'),
    `
import lifecycleApp from '@adonisjs/core/services/app'
import lifecycleDb from '@adonisjs/lucid/services/db'
import lifecycleLogger from '@adonisjs/core/services/logger'
import { writeFileSync as lifecycleWrite } from 'node:fs'
import { instrumentationStatus as lifecycleStatus } from '@rikology/adonisjs-mcp/hooks'
router.get('/__fixture/lifecycle', [() => import('#controllers/lifecycle_probe_controller'), 'handle'])
if (lifecycleApp.getEnvironment() === 'web') lifecycleApp.terminating(async () => {
  await lifecycleDb.rawQuery('select 1')
  lifecycleLogger.info('lifecycle application termination still owns logger and database')
  lifecycleWrite(lifecycleApp.makePath('shutdown-evidence.json'), JSON.stringify({ database: true, logger: true, subscribers: lifecycleStatus().subscribers }))
})
`
  )
}

export async function sampleRuntime(app: RunningApp): Promise<RuntimeSample> {
  const response = await app.fetch('/__fixture/lifecycle')
  if (!response.ok) throw new Error(`Runtime probe failed: ${response.status}`)
  return response.json() as Promise<RuntimeSample>
}

export async function awaitRuntime(app: RunningApp, predicate: (sample: RuntimeSample) => boolean) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const sample = await sampleRuntime(app)
      if (predicate(sample)) {
        const ready = await app.fetch(DEFAULT_PATH, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: INITIALIZE_BODY,
          signal: AbortSignal.timeout(1000),
        })
        await ready.text()
        if (ready.status === 200) return sample
      }
    } catch {
      /* The assembler is replacing the HTTP child. */
    }
    await sleep(100)
  }
  throw new Error(`Lifecycle change did not become visible\n${app.logs.text()}`)
}

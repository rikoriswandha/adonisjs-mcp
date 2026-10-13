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
  gcAvailable: boolean
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
  handle({ request }: { request: { input(name: string): unknown } }) {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
    if (request.input('gc') === 'true') { if (!gc) throw new Error('Runtime probe requires --expose-gc'); gc() }
    const resources: Record<string, number> = {}
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1
    const histogram = state.lifecycleHistogram!
    return { pid: process.pid, marker: ${marker}, resources, memory: process.memoryUsage(), gcAvailable: Boolean(gc), subscribers: instrumentationStatus().subscribers, emitterListeners: emitter.listenerCount(), delay: { mean: histogram.mean / 1e6, p95: histogram.percentile(95) / 1e6, max: histogram.max / 1e6 } }
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

export async function sampleRuntime(app: RunningApp, gc = false): Promise<RuntimeSample> {
  const response = await app.fetch(`/__fixture/lifecycle${gc ? '?gc=true' : ''}`)
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

// The 720-call reference smoke retained ~4.1 KiB/call in its final post-GC window.
// 16 KiB allows roughly 4x that steady-state baseline without hiding large per-call leaks.
export const RETAINED_HEAP_BYTES_PER_CALL = 16 * 1024

export function capacityViolations(before: RuntimeSample, after: RuntimeSample, calls: number) {
  const violations: string[] = []
  if (after.pid !== before.pid) violations.push('process PID changed')
  if (!before.gcAvailable || !after.gcAvailable) violations.push('GC is unavailable')
  if (JSON.stringify(after.subscribers) !== JSON.stringify(before.subscribers))
    violations.push('capture subscriber counts changed')
  if (after.emitterListeners !== before.emitterListeners)
    violations.push('emitter listener count changed')
  for (const [name, count] of Object.entries(after.resources)) {
    const allowance = name === 'TCPSocketWrap' ? 4 : name === 'Timeout' ? 2 : 0
    if (count > (before.resources[name] ?? 0) + allowance)
      violations.push(`${name} grew by ${count - (before.resources[name] ?? 0)}`)
  }
  if ((after.memory.heapUsed - before.memory.heapUsed) / calls > RETAINED_HEAP_BYTES_PER_CALL)
    violations.push('retained heap growth exceeds 16 KiB per call after GC')
  return violations
}

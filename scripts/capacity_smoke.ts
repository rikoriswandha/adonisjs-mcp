// Fast/slow concurrent capacity is measured here; two-tenant correctness is covered by matrix.spec.ts.
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { arch, cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { FixtureApp } from '../tests/helpers/fixture_app.js'
import { connectMcpClient } from '../tests/helpers/mcp_client.js'
import {
  DEFAULT_PATH,
  installPackage,
  instrumentCapture,
  waitForMcp,
} from '../tests/helpers/mcp_endpoint.js'
import {
  installLifecycleProbe,
  sampleRuntime,
  awaitRuntime,
  probeController,
  capacityViolations,
  RETAINED_HEAP_BYTES_PER_CALL,
} from '../tests/helpers/lifecycle.js'
import type { RuntimeSample } from '../tests/helpers/lifecycle.js'

const { values: options } = parseArgs({ options: { out: { type: 'string' } } })
const fixture = await FixtureApp.create('api')
try {
  await installPackage(fixture)
  await instrumentCapture(fixture)
  await installLifecycleProbe(fixture)
  const app = await fixture.start({
    nodeEnv: 'development',
    runner: 'hmr',
    nodeOptions: '--experimental-vm-modules --expose-gc',
  })
  await waitForMcp(app)
  const client = await connectMcpClient(new URL(DEFAULT_PATH, app.url), { era: 'modern' })
  try {
    const names = [
      'get_routes',
      'get_models',
      'get_events',
      'get_logs',
      'get_config',
      'project_eval',
    ]
    const timings: Record<string, { coldMs: number; warm: number[] }> = {}
    for (const name of names) {
      const started = performance.now()
      const result = await client.callTool({
        name,
        arguments: name === 'project_eval' ? { code: 'return 42' } : {},
      })
      if (result.isError) throw new Error(JSON.stringify(result))
      timings[name] = { coldMs: performance.now() - started, warm: [] }
    }
    const initial = await sampleRuntime(app, true)
    const windows: RuntimeSample[] = []
    const concurrentMs: number[] = []
    for (let window = 0; window < 3; window++) {
      for (let iteration = 0; iteration < 36; iteration++) {
        for (const name of names) {
          const started = performance.now()
          const result = await client.callTool({
            name,
            arguments: name === 'project_eval' ? { code: 'return 42' } : {},
          })
          if (result.isError) throw new Error(JSON.stringify(result))
          const elapsed = performance.now() - started
          timings[name].warm.push(elapsed)
        }
      }
      const concurrentStarted = performance.now()
      const concurrentResults = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          client.callTool({
            name: index % 2 === 0 ? 'get_routes' : 'project_eval',
            arguments:
              index % 2 === 0
                ? {}
                : {
                    code: "const { setTimeout: sleep } = await import('node:timers/promises'); await sleep(75); return 42",
                  },
          })
        )
      )
      if (concurrentResults.length < 4)
        throw new Error('Capacity concurrent phase requires at least four simultaneous calls')
      for (const result of concurrentResults)
        if (result.isError) throw new Error(JSON.stringify(result))
      concurrentMs.push(performance.now() - concurrentStarted)
      // Idle keep-alive connections are bounded but not retained workload resources.
      await awaitRuntime(
        app,
        (sample) =>
          (sample.resources.TCPSocketWrap ?? 0) <= (initial.resources.TCPSocketWrap ?? 0) + 4
      )
      windows.push(await sampleRuntime(app, true))
    }
    const before = windows[1]
    const after = windows[2]
    await writeFile(
      join(fixture.root, 'app/controllers/lifecycle_probe_controller.ts'),
      probeController(1)
    )
    await awaitRuntime(app, (sample) => sample.marker === 1)
    const afterSwap = await sampleRuntime(app, true)
    const packageVersions: Record<string, string> = {}
    for (const name of [
      '@rikology/adonisjs-mcp',
      '@adonisjs/core',
      '@adonisjs/lucid',
      '@adonisjs/assembler',
    ]) {
      const metadata = JSON.parse(
        await readFile(join(fixture.root, 'node_modules', name, 'package.json'), 'utf8')
      ) as { version: string }
      packageVersions[name] = metadata.version
    }
    const calls = 240
    const violations = [
      ...capacityViolations(before, after, calls).map((reason) => `after: ${reason}`),
      ...capacityViolations(before, afterSwap, calls).map((reason) => `afterSwap: ${reason}`),
    ]
    const previousGrowth = windows[1].memory.heapUsed - windows[0].memory.heapUsed
    const steadyGrowth = after.memory.heapUsed - before.memory.heapUsed
    if ((steadyGrowth - previousGrowth) / calls > 8 * 1024)
      violations.push(
        'steady-state per-call growth increased by more than 8 KiB over the previous window'
      )
    const latency = Object.fromEntries(
      Object.entries(timings).map(([name, values]) => {
        const sorted = values.warm.toSorted((a, b) => a - b)
        return [
          name,
          {
            coldMs: values.coldMs,
            p50Ms: sorted[Math.floor(sorted.length * 0.5)],
            p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          },
        ]
      })
    )
    const report = {
      environment: {
        os: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0].model,
        node: process.version,
        packageVersions,
      },
      workload: {
        calls: calls * 3,
        coldCalls: names.length,
        warmupWindows: 1,
        measuredWindows: 2,
        callsPerWindow: calls,
        tools: names,
        rounds: 36,
        concurrency: 24,
        phases: {
          sequential: { calls: 216, concurrency: 1, windows: 3 },
          concurrent: {
            calls: 24,
            windows: 3,
            concurrency: 24,
            tools: ['get_routes', 'project_eval'],
            slowAwaitMs: 75,
            elapsedMs: concurrentMs,
          },
        },
        hotSwaps: 1,
        runner: 'hmr',
        thresholds: {
          resourceGrowthDefault: 0,
          socketGrowth: 4,
          timerGrowth: 2,
          retainedHeapBytesPerCall: RETAINED_HEAP_BYTES_PER_CALL,
          steadyGrowthNoiseBytesPerCall: 8 * 1024,
        },
      },
      latency,
      retainedHeapBytesPerCall: {
        previousWindow: previousGrowth / calls,
        after: (after.memory.heapUsed - before.memory.heapUsed) / calls,
        afterSwap: (afterSwap.memory.heapUsed - before.memory.heapUsed) / calls,
      },
      swapRetainedHeapBytes: afterSwap.memory.heapUsed - after.memory.heapUsed,
      windows,
      before,
      after,
      afterSwap,
      violations,
    }
    const json = JSON.stringify(report)
    if (options.out) await writeFile(options.out, `${json}\n`)
    console.log(json)
    if (violations.length) process.exitCode = 1
  } finally {
    await client.close()
  }
} finally {
  await fixture.dispose()
}

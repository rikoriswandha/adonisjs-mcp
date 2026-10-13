import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { arch, cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
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
} from '../tests/helpers/lifecycle.js'

const fixture = await FixtureApp.create('api')
try {
  await installPackage(fixture)
  await instrumentCapture(fixture)
  await installLifecycleProbe(fixture)
  const app = await fixture.start({
    nodeEnv: 'development',
    runner: 'hmr',
    nodeOptions: '--experimental-vm-modules',
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
    await sampleRuntime(app)
    await sleep(100)
    const before = await sampleRuntime(app)
    for (let iteration = 0; iteration < 36; iteration++) {
      for (const name of names) {
        const started = performance.now()
        const result = await client.callTool({
          name,
          arguments: name === 'project_eval' ? { code: 'return 42' } : {},
        })
        if (result.isError) throw new Error(JSON.stringify(result))
        const elapsed = performance.now() - started
        if (!timings[name]) timings[name] = { coldMs: elapsed, warm: [] }
        else timings[name].warm.push(elapsed)
      }
    }
    const after = await sampleRuntime(app)
    await writeFile(
      join(fixture.root, 'app/controllers/lifecycle_probe_controller.ts'),
      probeController(1)
    )
    const afterSwap = await awaitRuntime(app, (sample) => sample.marker === 1)
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
    const violations: string[] = []
    if (
      afterSwap.subscribers.logs !== before.subscribers.logs ||
      afterSwap.subscribers.exceptions !== before.subscribers.exceptions
    )
      violations.push('capture subscriber counts changed')
    if (afterSwap.emitterListeners !== before.emitterListeners)
      violations.push('emitter listener count changed')
    for (const [name, count] of Object.entries(afterSwap.resources)) {
      const allowance = name === 'TCPSocketWrap' ? 4 : name === 'Timeout' ? 2 : 0
      if (count > (before.resources[name] ?? 0) + allowance)
        violations.push(`${name} grew by ${count - (before.resources[name] ?? 0)}`)
    }
    if (afterSwap.memory.heapUsed - before.memory.heapUsed > 128 * 1024 * 1024)
      violations.push('heap grew by more than 128 MiB')
    if (afterSwap.memory.rss - before.memory.rss > 256 * 1024 * 1024)
      violations.push('RSS grew by more than 256 MiB')
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
    console.log(
      JSON.stringify({
        environment: {
          os: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0].model,
          node: process.version,
          packageVersions,
        },
        workload: {
          calls: 216,
          tools: names,
          rounds: 36,
          concurrency: 1,
          hotSwaps: 1,
          runner: 'hmr',
          thresholds: {
            resourceGrowthDefault: 0,
            socketGrowth: 4,
            timerGrowth: 2,
            heapGrowthBytes: 128 * 1024 * 1024,
            rssGrowthBytes: 256 * 1024 * 1024,
          },
        },
        latency,
        before,
        after,
        afterSwap,
        violations,
      })
    )
    if (violations.length) process.exitCode = 1
  } finally {
    await client.close()
  }
} finally {
  await fixture.dispose()
}

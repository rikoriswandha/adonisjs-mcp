import { glob } from 'node:fs/promises'
import { resolve } from 'node:path'
import app from '@adonisjs/core/services/app'
import { Locator } from '@adonisjs/queue'

export async function listConfiguredJobs() {
  const locations = app.config.get<string[]>('queue.locations', [])
  const jobs: { name: string; file: string; registered: boolean; evidence: string }[] = []
  const rejected: { file: string; reason: string }[] = []
  for (const pattern of locations) {
    for await (const file of glob(pattern)) {
      try {
        // Mirror queue 0.6.0 exactly, including its raw file URL limitation.
        const module = await import(`file://${resolve(file)}`)
        const candidate: unknown = module.default
        if (typeof candidate !== 'function') { rejected.push({ file, reason: 'default export is not a function' }); continue }
        let name = candidate.name
        if ('options' in candidate && candidate.options && typeof candidate.options === 'object' && 'name' in candidate.options && typeof candidate.options.name === 'string' && candidate.options.name) name = candidate.options.name
        jobs.push({ name, file, registered: Locator.get(name) === candidate, evidence: 'config-declared+runtime-verified' })
      } catch (error) {
        rejected.push({ file, reason: error instanceof Error ? error.message : 'module import failed' })
      }
    }
  }
  return { locations, cwd: process.cwd(), appRoot: app.makePath(), jobs, rejected, coverage: 'configured locations relative to process.cwd(); manual registrations outside locations are not enumerable', publicLookup: 'Locator.get(name)' }
}

import { Job } from '@adonisjs/queue'
import { counters } from '#providers/s_k_probe_provider'
export default class SentinelJob extends Job {
  async execute() { counters.jobExecutions++; throw new Error('Introspection must never execute this job') }
}

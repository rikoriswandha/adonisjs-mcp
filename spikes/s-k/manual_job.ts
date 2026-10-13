import { Job } from '@adonisjs/queue'
import { counters } from '#providers/s_k_probe_provider'
export default class ManualJob extends Job {
  async execute() { counters.jobExecutions++; throw new Error('Must not execute manual job') }
}

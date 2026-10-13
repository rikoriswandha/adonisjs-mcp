import { Job } from '@adonisjs/queue'
import { counters } from '#providers/s_k_probe_provider'
export default class ExternalLocationJob extends Job {
  static options = { name: 'external.configured' }
  async execute() { counters.jobExecutions++; throw new Error('Must not execute external job') }
}

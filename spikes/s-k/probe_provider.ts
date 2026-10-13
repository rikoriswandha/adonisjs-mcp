import { Locator } from '@adonisjs/queue'
export const observedJobs = new Set<string>()
export const counters = { policyExecutions: 0, jobExecutions: 0 }
export default class ProbeProvider {
  original = Locator.register
  register() {
    const original = this.original
    Locator.register = function (name, jobClass) {
      observedJobs.add(name)
      return original.call(this, name, jobClass)
    }
  }
  shutdown() { Locator.register = this.original }
}

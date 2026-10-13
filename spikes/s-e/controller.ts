import app from '@adonisjs/core/services/app'
export const sourceUrl = import.meta.url
export default class SpikeEvalController {
  static marker = 'controller-before'
  handle() {
    Object.assign(app, { spikeExecutedController: SpikeEvalController })
    return { marker: SpikeEvalController.marker, url: sourceUrl, pid: process.pid }
  }
}

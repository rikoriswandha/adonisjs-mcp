import type { ApplicationService } from '@adonisjs/core/types'
export default class McpProvider {
  constructor(app: ApplicationService)
  register(): void
  boot(): Promise<void>
}

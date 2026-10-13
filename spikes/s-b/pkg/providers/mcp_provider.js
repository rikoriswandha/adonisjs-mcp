console.log('SB_PACKAGE_MODULE_LOADED')
export default class McpProvider {
  constructor(app) { this.app = app }
  register() { if (this.app.inDev) this.app.container.singleton('sb.mcp.buffer', () => []) }
  async boot() {
    console.log('SB_PACKAGE_BOOT', JSON.stringify({environment:this.app.getEnvironment(),inDev:this.app.inDev,inProduction:this.app.inProduction}))
    if (!this.app.inDev || !this.app.config.get('mcp.enabled')) return
    const router = await this.app.container.make('router')
    router.get('/__adonis/mcp', () => ({spike:'S-B', buffer:this.app.container.hasBinding('sb.mcp.buffer')}))
  }
}

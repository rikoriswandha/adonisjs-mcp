import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'

// app singleton is initialised before config loading; package import is dev-only.
const hooks = app.inDev ? await import('@rikology/adonisjs-mcp/hooks') : undefined
export const streamWrite = hooks?.streamWrite ?? ((line: string) => line)
export const observeException = hooks?.observeException ?? ((_error: unknown, _ctx: HttpContext) => {})
export const custom = hooks?.custom ?? { reports: 0, handles: 0 }

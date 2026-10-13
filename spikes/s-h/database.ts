import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({
  connection: 'sqlite',
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: { filename: app.tmpPath('db.sqlite3') },
      useNullAsDefault: true,
      migrations: { naturalSort: true, paths: ['database/migrations'] },
    },
    tenant_pg: {
      client: 'pg',
      connection: { host: '127.0.0.1', port: 55442, user: 'sh_reader', database: 'postgres' },
      pool: { min: 0, max: 4 },
    },
  },
})

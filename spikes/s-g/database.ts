import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: {
  sqlite: { client: 'better-sqlite3', connection: { filename: app.tmpPath('db.sqlite3') }, useNullAsDefault: true, pool: { min: 0, max: 1 } },
  sqlite_ro: { client: 'better-sqlite3', connection: { filename: app.tmpPath('db.sqlite3'), options: { readonly: true } }, useNullAsDefault: true, pool: { min: 0, max: 1 } },
  pg: { client: 'pg', connection: { host: '127.0.0.1', port: 55441, user: 'postgres', database: 'postgres' }, pool: { min: 0, max: 1 } },
  pg_ro: { client: 'pg', connection: { host: '127.0.0.1', port: 55441, user: 'spike_reader', database: 'postgres' }, pool: { min: 0, max: 1 } },
} })

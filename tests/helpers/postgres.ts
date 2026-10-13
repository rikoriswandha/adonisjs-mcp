/*
|--------------------------------------------------------------------------
| Owned PostgreSQL cluster
|--------------------------------------------------------------------------
|
| Tests never connect to an existing PostgreSQL server. Every run creates
| its own cluster with initdb in a temporary directory, listening on
| 127.0.0.1 and a free port, and deletes it afterwards. When the server
| binaries are missing the helper fails instead of falling back to a
| server it does not own.
|
*/

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fixtureRoot, freePort } from './fixture_root.js'
import { isolatedEnvironment, runChecked, runCommand } from './process.js'

const SEARCH_ROOTS = [
  '/opt/homebrew/opt',
  '/usr/local/opt',
  '/usr/lib/postgresql',
  '/usr/local/pgsql',
  '/Applications/Postgres.app/Contents/Versions',
]

function hasServerBinaries(directory: string): boolean {
  return existsSync(join(directory, 'initdb')) && existsSync(join(directory, 'pg_ctl'))
}

async function findBinDirectory(): Promise<string> {
  const explicit = process.env.ADONISJS_MCP_PG_BIN
  if (explicit) {
    if (!hasServerBinaries(explicit)) {
      throw new Error(`ADONISJS_MCP_PG_BIN=${explicit} does not contain initdb and pg_ctl`)
    }
    return explicit
  }

  const fromPgConfig = await runCommand('pg_config', ['--bindir'], {
    cwd: process.cwd(),
    env: isolatedEnvironment(),
  }).catch(() => undefined)
  const pgConfigDirectory = fromPgConfig?.stdout.trim()
  if (fromPgConfig?.exitCode === 0 && pgConfigDirectory && hasServerBinaries(pgConfigDirectory)) {
    return pgConfigDirectory
  }

  for (const root of SEARCH_ROOTS) {
    const entries = await readdir(root).catch(() => [])
    const candidates = entries
      .filter((entry) => /^(postgresql(@\d+)?|\d+(\.\d+)?)$/.test(entry))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    for (const entry of candidates) {
      const directory = join(root, entry, 'bin')
      if (hasServerBinaries(directory)) {
        return directory
      }
    }
  }

  throw new Error(
    'PostgreSQL server binaries (initdb, pg_ctl) were not found. Install PostgreSQL or set ADONISJS_MCP_PG_BIN to its bin directory. Tests never connect to an existing server.'
  )
}

export interface PostgresDatabase {
  host: string
  port: number
  user: string
  database: string
}

export class OwnedPostgresCluster {
  readonly host = '127.0.0.1'
  readonly user = 'adonisjs_mcp_fixture'
  readonly directory: string
  readonly port: number
  readonly #binDirectory: string
  #running = true

  private constructor(directory: string, port: number, binDirectory: string) {
    this.directory = directory
    this.port = port
    this.#binDirectory = binDirectory
  }

  static async start(): Promise<OwnedPostgresCluster> {
    const binDirectory = await findBinDirectory()
    const directory = await mkdtemp(join(fixtureRoot(), 'pg-'))
    const dataDirectory = join(directory, 'data')
    const options = { cwd: directory, env: isolatedEnvironment({ TZ: 'UTC' }) }

    try {
      await runChecked(
        join(binDirectory, 'initdb'),
        [
          '-D',
          dataDirectory,
          '-U',
          'adonisjs_mcp_fixture',
          '--auth=trust',
          '--encoding=UTF8',
          '--locale=C',
          '--no-instructions',
        ],
        options
      )
      const port = await freePort()
      await runChecked(
        join(binDirectory, 'pg_ctl'),
        [
          '-D',
          dataDirectory,
          '-o',
          `-p ${port} -h 127.0.0.1 -k ${directory}`,
          '-l',
          join(directory, 'server.log'),
          '-w',
          'start',
        ],
        options
      )
      return new OwnedPostgresCluster(directory, port, binDirectory)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  #options() {
    return { cwd: this.directory, env: isolatedEnvironment() }
  }

  #connectionArgs() {
    return ['-h', this.host, '-p', String(this.port), '-U', this.user]
  }

  /**
   * Creates a uniquely named database inside this cluster.
   */
  async createDatabase(): Promise<PostgresDatabase> {
    const database = `fixture_${randomBytes(6).toString('hex')}`
    await runChecked(
      join(this.#binDirectory, 'createdb'),
      [...this.#connectionArgs(), database],
      this.#options()
    )
    return { host: this.host, port: this.port, user: this.user, database }
  }

  async dropDatabase(database: string) {
    await runChecked(
      join(this.#binDirectory, 'dropdb'),
      [...this.#connectionArgs(), '--force', database],
      this.#options()
    )
  }

  /**
   * Runs a SQL statement through psql and returns its unaligned output.
   */
  async query(database: string, sql: string): Promise<string> {
    const result = await runChecked(
      join(this.#binDirectory, 'psql'),
      [...this.#connectionArgs(), '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
      this.#options()
    )
    return result.stdout.trim()
  }

  /**
   * Stops the server and deletes the cluster directory.
   */
  async stop() {
    if (this.#running) {
      this.#running = false
      await runCommand(
        join(this.#binDirectory, 'pg_ctl'),
        ['-D', join(this.directory, 'data'), '-m', 'fast', '-w', 'stop'],
        this.#options()
      )
    }
    await rm(this.directory, { recursive: true, force: true })
  }
}

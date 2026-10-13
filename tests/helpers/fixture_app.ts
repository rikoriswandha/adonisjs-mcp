/*
|--------------------------------------------------------------------------
| Fixture application factory
|--------------------------------------------------------------------------
|
| Creates disposable AdonisJS applications from the templates in
| `tests/fixtures/apps/<kit>`. Dependencies are installed once per
| lockfile into a cache and cloned into every fixture. Each fixture owns
| its directory, SQLite file or PostgreSQL database, ports and processes,
| and removes them on `dispose()`.
|
| Every process is started with an explicit NODE_ENV and an allowlisted
| environment (see `isolatedEnvironment`), so fixtures never pick up the
| developer's database settings.
|
*/

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ChildProcess } from 'node:child_process'
import { copyTree, fixtureRoot, freePort, repositoryRoot } from './fixture_root.js'
import {
  LogCapture,
  groupAlive,
  isolatedEnvironment,
  runChecked,
  runCommand,
  signalGroup,
  spawnGroup,
  type CommandResult,
} from './process.js'
import type { PostgresDatabase } from './postgres.js'

export type FixtureKit = 'api' | 'api-bare' | 'hybrid' | 'edge' | 'vue'
export type NodeEnvironment = 'development' | 'test' | 'production'

/**
 * `direct` boots `bin/server.ts` once; `hmr` runs `node ace serve --hmr`
 * (assembler + hot-hook), as `npm run dev` does.
 */
export type DevRunner = 'direct' | 'hmr'

export type FixtureDatabase = { connection: 'sqlite' } | ({ connection: 'pg' } & PostgresDatabase)

const READY_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 15_000

function templateDirectory(kit: FixtureKit) {
  return join(repositoryRoot, 'tests', 'fixtures', 'apps', kit)
}

/**
 * Installs the template dependencies once per lockfile content and returns
 * the cached `node_modules` directory.
 */
async function installedDependencies(kit: FixtureKit): Promise<string> {
  const template = templateDirectory(kit)
  const manifest = await readFile(join(template, 'package.json'))
  const lockfile = await readFile(join(template, 'package-lock.json'))
  const hash = createHash('sha256').update(manifest).update(lockfile).digest('hex').slice(0, 16)
  const cacheDirectory = join(fixtureRoot(), 'cache', `${kit}-${hash}`)
  const nodeModules = join(cacheDirectory, 'node_modules')
  if (existsSync(nodeModules)) {
    return nodeModules
  }

  const staging = `${cacheDirectory}.${process.pid}.${randomBytes(4).toString('hex')}`
  await mkdir(staging, { recursive: true })
  try {
    await writeFile(join(staging, 'package.json'), manifest)
    await writeFile(join(staging, 'package-lock.json'), lockfile)
    await runChecked('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: staging,
      env: isolatedEnvironment(),
      timeoutMs: 900_000,
    })
    await rename(staging, cacheDirectory).catch(async (error) => {
      if (!existsSync(nodeModules)) {
        throw error
      }
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return nodeModules
}

export class AppStartError extends Error {
  constructor(
    message: string,
    readonly logs: LogCapture,
    readonly exitCode: number | null
  ) {
    super(`${message}\n--- process output ---\n${logs.text()}`)
    this.name = 'AppStartError'
  }
}

/**
 * A running fixture HTTP server.
 */
export class RunningApp {
  readonly url: string
  readonly port: number
  readonly logs: LogCapture
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  readonly #child: ChildProcess
  #hasExited = false

  private constructor(child: ChildProcess, port: number, logs: LogCapture) {
    this.#child = child
    this.port = port
    this.url = `http://127.0.0.1:${port}`
    this.logs = logs
    const exited = Promise.withResolvers<{
      exitCode: number | null
      signal: NodeJS.Signals | null
    }>()
    child.once('close', (exitCode, signal) => {
      this.#hasExited = true
      exited.resolve({ exitCode, signal })
    })
    this.exited = exited.promise
  }

  get pid(): number {
    return this.#child.pid!
  }

  /**
   * Spawns the server and resolves once it answers HTTP. Fails with the
   * captured output when the process exits or the deadline passes first.
   */
  static async launch(
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; port: number }
  ): Promise<RunningApp> {
    const child = spawnGroup(command, args, options)
    const logs = new LogCapture()
    logs.attach(child.stdout, 'stdout')
    logs.attach(child.stderr, 'stderr')
    const app = new RunningApp(child, options.port, logs)

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (app.#hasExited) {
        const { exitCode } = await app.exited
        throw new AppStartError(
          `Fixture server exited with ${exitCode} before it was ready`,
          logs,
          exitCode
        )
      }
      try {
        await fetch(app.url, { signal: AbortSignal.timeout(1_000), redirect: 'manual' })
        return app
      } catch {
        await sleep(100)
      }
    }
    await app.stop()
    throw new AppStartError(`Fixture server not ready after ${READY_TIMEOUT_MS}ms`, logs, null)
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(new URL(path, this.url), { redirect: 'manual', ...init })
  }

  /**
   * Stops the whole process group (assembler and its HTTP child included):
   * SIGTERM first, SIGKILL after the deadline.
   */
  async stop() {
    const pid = this.#child.pid
    if (pid === undefined) {
      return
    }
    if (!this.#hasExited) {
      signalGroup(this.#child, 'SIGTERM')
      const timedOut = await Promise.race([
        this.exited.then(() => false),
        sleep(STOP_TIMEOUT_MS, true),
      ])
      if (timedOut) {
        signalGroup(this.#child, 'SIGKILL')
        await this.exited
      }
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (groupAlive(pid)) {
      if (Date.now() > deadline) {
        signalGroup(this.#child, 'SIGKILL')
      }
      await sleep(50)
    }
  }
}

/**
 * Standalone production deployment of a fixture: the output of
 * `node ace build` copied next to (not inside) the fixture, with
 * production dependencies only.
 */
export class ProductionDeployment {
  constructor(
    readonly root: string,
    readonly fixture: FixtureApp
  ) {}

  async start(): Promise<RunningApp> {
    const port = await freePort()
    const app = await RunningApp.launch(process.execPath, ['bin/server.js'], {
      cwd: this.root,
      env: this.fixture.environment('production', port),
      port,
    })
    this.fixture.track(app)
    return app
  }

  ace(args: readonly string[]): Promise<CommandResult> {
    return runCommand(process.execPath, ['ace.js', ...args], {
      cwd: this.root,
      env: this.fixture.environment('production'),
      timeoutMs: 120_000,
    })
  }
}

export class FixtureApp {
  readonly kit: FixtureKit
  readonly container: string
  readonly root: string
  #database: FixtureDatabase = { connection: 'sqlite' }
  #running = new Set<RunningApp>()

  private constructor(kit: FixtureKit, container: string) {
    this.kit = kit
    this.container = container
    this.root = join(container, 'app')
  }

  /**
   * Creates a fresh application from the template, with dependencies
   * cloned from the install cache and a newly generated APP_KEY.
   */
  static async create(kit: FixtureKit = 'api'): Promise<FixtureApp> {
    const nodeModules = await installedDependencies(kit)
    const container = await mkdtemp(join(fixtureRoot(), `${kit}-`))
    const fixture = new FixtureApp(kit, container)
    try {
      await cp(templateDirectory(kit), fixture.root, {
        recursive: true,
        filter: (source) => !/[/\\](node_modules|build)$|db\.sqlite3$/.test(source),
      })
      await copyTree(nodeModules, join(fixture.root, 'node_modules'))
      await fixture.#writeEnvFile(randomBytes(32).toString('base64url'))
    } catch (error) {
      await fixture.dispose()
      throw error
    }
    return fixture
  }

  get database(): FixtureDatabase {
    return this.#database
  }

  /**
   * Points the fixture at another database. `pg` databases must come from
   * an `OwnedPostgresCluster`.
   */
  async useDatabase(database: FixtureDatabase) {
    this.#database = database
    const env = await readFile(join(this.root, '.env'), 'utf8')
    const appKey = /^APP_KEY=(.*)$/m.exec(env)?.[1]
    await this.#writeEnvFile(appKey!)
  }

  async #writeEnvFile(appKey: string) {
    const database = this.#database
    const lines = [
      'TZ=UTC',
      'PORT=3333',
      'HOST=127.0.0.1',
      'NODE_ENV=development',
      'LOG_LEVEL=info',
      `APP_KEY=${appKey}`,
      'APP_URL=http://127.0.0.1:3333',
      'SESSION_DRIVER=cookie',
      `DB_CONNECTION=${database.connection}`,
    ]
    if (database.connection === 'pg') {
      lines.push(
        `DB_HOST=${database.host}`,
        `DB_PORT=${database.port}`,
        `DB_USER=${database.user}`,
        `DB_DATABASE=${database.database}`
      )
    }
    await writeFile(join(this.root, '.env'), `${lines.join('\n')}\n`)
  }

  /**
   * Process environment for this fixture. NODE_ENV is always explicit;
   * values from `.env` (APP_KEY, database) are read by the application.
   * `host` is the bind address.
   */
  environment(nodeEnv: NodeEnvironment, port?: number, host = '127.0.0.1'): NodeJS.ProcessEnv {
    return isolatedEnvironment({
      NODE_ENV: nodeEnv,
      TZ: 'UTC',
      HOST: host,
      LOG_LEVEL: 'info',
      ...(port === undefined ? {} : { PORT: String(port), APP_URL: `http://127.0.0.1:${port}` }),
    })
  }

  track(app: RunningApp) {
    this.#running.add(app)
  }

  ace(args: readonly string[], nodeEnv: NodeEnvironment): Promise<CommandResult> {
    return runCommand(process.execPath, ['ace.js', ...args], {
      cwd: this.root,
      env: this.environment(nodeEnv),
      timeoutMs: 300_000,
    })
  }

  npm(args: readonly string[]): Promise<CommandResult> {
    return runChecked('npm', ['--no-audit', '--no-fund', ...args], {
      cwd: this.root,
      env: this.environment('development'),
      timeoutMs: 600_000,
    })
  }

  /**
   * Runs pending migrations against the configured database.
   */
  async migrate(nodeEnv: NodeEnvironment = 'development') {
    const result = await this.ace(['migration:run', '--force'], nodeEnv)
    if (result.exitCode !== 0) {
      throw new Error(`migration:run failed\n${result.stdout}\n${result.stderr}`)
    }
  }

  /**
   * Starts the HTTP server from source. Production runs from a build; use
   * `buildProduction()` for that. `host` is the bind address (default
   * loopback).
   */
  async start(options: {
    nodeEnv: Exclude<NodeEnvironment, 'production'>
    runner?: DevRunner
    host?: string
    nodeOptions?: string
  }): Promise<RunningApp> {
    const port = await freePort()
    const args =
      options.runner === 'hmr'
        ? ['ace.js', 'serve', '--hmr']
        : ['--import=@poppinss/ts-exec', 'bin/server.ts']
    const app = await RunningApp.launch(process.execPath, args, {
      cwd: this.root,
      env: {
        ...this.environment(options.nodeEnv, port, options.host),
        ...(options.nodeOptions === undefined ? {} : { NODE_OPTIONS: options.nodeOptions }),
      },
      port,
    })
    this.track(app)
    return app
  }

  /**
   * Builds the application and installs it as a standalone deployment with
   * `npm ci --omit=dev`, outside any ancestor `node_modules`.
   */
  async buildProduction(): Promise<ProductionDeployment> {
    const build = await this.ace(['build'], 'development')
    if (build.exitCode !== 0) {
      throw new Error(`node ace build failed\n${build.stdout}\n${build.stderr}`)
    }

    const deployment = join(this.container, 'production')
    await rm(deployment, { recursive: true, force: true })
    await copyTree(join(this.root, 'build'), deployment)
    await cp(join(this.root, '.env'), join(deployment, '.env'))
    const sqliteFile = join(this.root, 'tmp', 'db.sqlite3')
    if (existsSync(sqliteFile)) {
      await mkdir(join(deployment, 'tmp'), { recursive: true })
      await cp(sqliteFile, join(deployment, 'tmp', 'db.sqlite3'))
    }
    await runChecked('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: deployment,
      env: this.environment('production'),
      timeoutMs: 600_000,
    })
    return new ProductionDeployment(deployment, this)
  }

  /**
   * Stops every process started for this fixture and deletes its files.
   */
  async dispose() {
    for (const app of this.#running) {
      await app.stop()
    }
    this.#running.clear()
    await rm(this.container, { recursive: true, force: true })
  }
}

/*
|--------------------------------------------------------------------------
| Project profile
|--------------------------------------------------------------------------
|
| Describes the running application from evidence that does not execute
| application code: installed package manifests, container bindings and
| flags set by providers, resolved config, committed routes and generated
| artifacts. Installed and active are separate facts; a package with no
| verified runtime signal reports `active: null` instead of a guess.
|
*/

import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import type {
  PackageKey,
  PackageReport,
  ProfileEvidence,
  ProjectProfile,
  ResolvedMcpConfig,
  SurfaceName,
  SurfaceReport,
} from './types.js'

interface Container {
  hasBinding(binding: unknown): boolean
  make(binding: string): Promise<unknown>
}

interface Probe {
  app: ApplicationService
  container: Container
}

interface Signal {
  /**
   * Description of the runtime signal, e.g. `container binding 'lucid.db'`.
   */
  label: string
  check(probe: Probe): Promise<boolean> | boolean
}

function binding(key: string): Signal {
  return {
    label: `container binding '${key}'`,
    check: ({ container }) => container.hasBinding(key),
  }
}

/**
 * Class-keyed binding exported by the package itself. The module is
 * imported through the application importer, so it is the copy the
 * application uses.
 */
function classBinding(specifier: string, exportName: string): Signal {
  return {
    label: `container binding ${exportName} from '${specifier}'`,
    async check({ app, container }) {
      const module: unknown = await app.import(specifier)
      const key =
        typeof module === 'object' && module !== null
          ? (module as Record<string, unknown>)[exportName]
          : undefined
      if (typeof key !== 'function') {
        throw new Error(`'${specifier}' does not export ${exportName}`)
      }
      return container.hasBinding(key)
    },
  }
}

const PACKAGES: Record<PackageKey, { name: string; signal?: Signal }> = {
  lucid: { name: '@adonisjs/lucid', signal: binding('lucid.db') },
  auth: { name: '@adonisjs/auth', signal: binding('auth.manager') },
  session: {
    name: '@adonisjs/session',
    signal: classBinding('@adonisjs/session', 'SessionCollection'),
  },
  shield: {
    name: '@adonisjs/shield',
    signal: classBinding('@adonisjs/shield/shield_middleware', 'default'),
  },
  vine: {
    name: '@vinejs/vine',
    signal: { label: 'app.usingVineJS', check: ({ app }) => app.usingVineJS },
  },
  edge: {
    name: 'edge.js',
    signal: { label: 'app.usingEdgeJS', check: ({ app }) => app.usingEdgeJS },
  },
  inertia: {
    name: '@adonisjs/inertia',
    signal: classBinding('@adonisjs/inertia', 'InertiaManager'),
  },
  vite: { name: '@adonisjs/vite', signal: binding('vite') },
  tuyau: { name: '@tuyau/core' },
  transmit: { name: '@adonisjs/transmit' },
  tenant: { name: '@rikology/adonisjs-tenant', signal: binding('tenant.service') },
  permissions: { name: '@adonisplus/permissions' },
  bouncer: { name: '@adonisjs/bouncer' },
  queue: { name: '@adonisjs/queue', signal: binding('queue.manager') },
}

const INERTIA_ADAPTERS: ReadonlyArray<[string, 'react' | 'vue' | 'svelte']> = [
  ['@inertiajs/react', 'react'],
  ['@inertiajs/vue3', 'vue'],
  ['@inertiajs/svelte', 'svelte'],
]

type Manifest = Record<string, unknown>

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : undefined
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Version of `name` as Node resolves it from `root`: the nearest
 * `node_modules/<name>/package.json` walking up the directory tree.
 */
async function installedVersion(root: string, name: string): Promise<string | null> {
  let directory = root
  while (true) {
    const manifest = await readManifest(join(directory, 'node_modules', name, 'package.json'))
    if (manifest && typeof manifest.version === 'string') {
      return manifest.version
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return null
    }
    directory = parent
  }
}

function dependencyNames(manifest: Manifest | undefined, field: string): Set<string> {
  const value = manifest?.[field]
  return new Set(typeof value === 'object' && value !== null ? Object.keys(value) : [])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function inspectPackage(
  probe: Probe,
  root: string,
  key: PackageKey,
  declared: { dependencies: Set<string>; devDependencies: Set<string> }
): Promise<PackageReport> {
  const { name, signal } = PACKAGES[key]
  const version = await installedVersion(root, name)
  const report: PackageReport = {
    name,
    declared: declared.dependencies.has(name)
      ? 'dependencies'
      : declared.devDependencies.has(name)
        ? 'devDependencies'
        : null,
    version,
    active: version === null ? false : null,
    signal: signal?.label ?? null,
  }
  if (version === null || !signal) {
    return report
  }
  try {
    report.active = await signal.check(probe)
  } catch (error) {
    report.error = errorMessage(error)
  }
  return report
}

function routePatterns(routes: unknown): { pattern: string; domain: string }[] {
  if (typeof routes !== 'object' || routes === null) {
    return []
  }
  return Object.entries(routes).flatMap(([domain, list]) =>
    Array.isArray(list)
      ? list.flatMap((route: unknown) =>
          typeof route === 'object' &&
          route !== null &&
          'pattern' in route &&
          typeof route.pattern === 'string'
            ? [{ pattern: route.pattern, domain }]
            : []
        )
      : []
  )
}

async function authSummary(
  probe: Probe,
  report: PackageReport
): Promise<{ summary: ProjectProfile['auth']; error?: string }> {
  if (report.active !== true) {
    return { summary: null }
  }
  try {
    const manager = (await probe.container.make('auth.manager')) as {
      config?: { default?: unknown; guards?: unknown }
    }
    const guards = manager.config?.guards
    const fallback = manager.config?.default
    return {
      summary: {
        guards: typeof guards === 'object' && guards !== null ? Object.keys(guards) : [],
        default: typeof fallback === 'string' ? fallback : null,
      },
    }
  } catch (error) {
    return { summary: null, error: errorMessage(error) }
  }
}

/**
 * Detects the profile of the running application. Safe to call on every
 * MCP request: it reads manifests and container state, never executes
 * controllers, factories or queries.
 */
export async function detectProfile(
  app: ApplicationService,
  config: ResolvedMcpConfig
): Promise<ProjectProfile> {
  const root = fileURLToPath(app.appRoot)
  const probe: Probe = { app, container: app.container as unknown as Container }
  const manifest = await readManifest(join(root, 'package.json'))
  const declared = {
    dependencies: dependencyNames(manifest, 'dependencies'),
    devDependencies: dependencyNames(manifest, 'devDependencies'),
  }

  const keys = Object.keys(PACKAGES) as PackageKey[]
  const reports = await Promise.all(keys.map((key) => inspectPackage(probe, root, key, declared)))
  const packages = Object.fromEntries(keys.map((key, index) => [key, reports[index]])) as Record<
    PackageKey,
    PackageReport
  >

  const auth = await authSummary(probe, packages.auth)
  if (auth.error) {
    packages.auth.error = auth.error
  }

  const limitations: string[] = []
  const unverified = reports
    .filter((report) => report.version !== null && report.active === null && !report.error)
    .map((report) => report.name)
  if (unverified.length > 0) {
    limitations.push(
      `No verified runtime signal for ${unverified.join(', ')}; their activity is reported as null.`
    )
  }

  const inertiaActive = packages.inertia.active === true
  const edgeActive = packages.edge.active === true
  const renderer = inertiaActive ? 'inertia' : edgeActive ? 'edge' : null
  if (inertiaActive && edgeActive) {
    limitations.push(
      'Edge is active alongside Inertia (it renders the root view); pages rendered directly with Edge are not detected.'
    )
  }

  const surfacesConfig = config.profile.surfaces
  let web: SurfaceReport | null = null
  if (renderer) {
    const evidence: ProfileEvidence[] = [
      {
        kind: 'runtime',
        detail: `${renderer === 'inertia' ? packages.inertia.signal : packages.edge.signal} is set`,
      },
    ]
    if (surfacesConfig.web) {
      evidence.push({ kind: 'config', detail: 'profile.surfaces.web in config/mcp.ts' })
    }
    web = {
      renderer,
      prefix: surfacesConfig.web?.prefix ?? null,
      guard: surfacesConfig.web?.guard ?? null,
      evidence,
    }
  } else if (surfacesConfig.web) {
    limitations.push(
      'profile.surfaces.web is configured but neither Inertia nor Edge is active; no web surface is reported.'
    )
  }

  const router = (await app.container.make('router')) as { toJSON(): unknown }
  const routes = routePatterns(router.toJSON())
  const apiRoutes = routes.filter(
    (route) =>
      route.pattern === '/api' ||
      route.pattern.startsWith('/api/') ||
      route.domain.startsWith('api.')
  )
  const apiEvidence: ProfileEvidence[] = []
  if (surfacesConfig.api) {
    apiEvidence.push({ kind: 'config', detail: 'profile.surfaces.api in config/mcp.ts' })
  }
  if (apiRoutes.length > 0) {
    apiEvidence.push({
      kind: 'runtime',
      detail: `${apiRoutes.length} committed route(s) under /api or an api.* domain`,
    })
  }
  if (!renderer) {
    apiEvidence.push({ kind: 'runtime', detail: 'neither Inertia nor Edge is active' })
  }
  const observedApiPrefix = routes.some(
    (route) => route.pattern === '/api' || route.pattern.startsWith('/api/')
  )
  const api: SurfaceReport | null =
    apiEvidence.length > 0
      ? {
          prefix: surfacesConfig.api?.prefix ?? (observedApiPrefix ? '/api' : null),
          guard: surfacesConfig.api?.guard ?? null,
          evidence: apiEvidence,
        }
      : null

  const present = (['web', 'api'] as const).filter((name) => (name === 'web' ? web : api))
  let defaultSurface: SurfaceName | null = surfacesConfig.default ?? null
  if (defaultSurface === null && present.length === 1) {
    defaultSurface = present[0]
  }
  if (web && api && defaultSurface === null) {
    limitations.push(
      'The project is hybrid and profile.surfaces.default is not set; requests matching neither surface have no default.'
    )
  }

  const declaredAll = new Set([...declared.dependencies, ...declared.devDependencies])
  const adapter = INERTIA_ADAPTERS.find(([name]) => declaredAll.has(name))?.[1] ?? null
  const ssr: unknown = app.config.get('inertia.ssr.enabled', null)

  return {
    kind: web && api ? 'hybrid' : (renderer ?? 'api'),
    app: {
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      root,
      environment: app.getEnvironment(),
      nodeVersion: process.version,
      coreVersion: await installedVersion(root, '@adonisjs/core'),
    },
    surfaces: { web, api, default: defaultSurface },
    inertia: inertiaActive ? { adapter, ssr: typeof ssr === 'boolean' ? ssr : null } : null,
    auth: auth.summary,
    packages,
    generated: {
      controllers: await exists(app.generatedServerPath('controllers.ts')),
      data: await exists(app.generatedClientPath('data.d.ts')),
      tuyauRegistry: await exists(app.generatedClientPath('registry', 'index.ts')),
    },
    endpoint: { path: config.path, allowRemoteAccess: config.allowRemoteAccess },
    limitations,
  }
}

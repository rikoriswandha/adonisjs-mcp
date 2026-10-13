/*
|--------------------------------------------------------------------------
| Container bindings
|--------------------------------------------------------------------------
|
| Fold 11 has no inventory API (spike S-D), so the list is built from two
| lanes and verified against the live container with `hasBinding()`,
| which never constructs anything:
|
| - source-declared: members of `ContainerBindings` declared by
|   `@adonisjs/core/types` or augmented by `declare module
|   '@adonisjs/core/types'` in installed packages that depend on
|   @adonisjs/core and in application sources;
| - runtime-observed (opt-in): registrations recorded by the container
|   observer the application's dev gateway starts, with kind, alias
|   target and the registering provider when its synchronous register()
|   was running.
|
| The result is partial by construction and labelled so: undeclared keys
| registered before observation (or without it) cannot be discovered.
|
*/

import { readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { ApplicationService } from '@adonisjs/core/types'
import type * as TypeScript from 'typescript'
import type {
  ContainerObserver,
  ObservedRegistration,
  RegistrationKind,
} from './container_observer.js'
import { appTypeScript, type TypeScriptApi } from './typescript.js'

const CORE_TYPES_MODULE = '@adonisjs/core/types'
const MAX_FILES_PER_ROOT = 5000
const MAX_TYPE_CHARS = 200
const SKIPPED_APP_DIRECTORIES = new Set(['node_modules', 'build', 'tmp', 'public', 'coverage'])

export interface BindingDeclaration {
  /**
   * Declaring file, relative to the application root.
   */
  file: string
  line: number
  type: string | null
}

export interface BindingReport {
  key: string
  keyType: 'string' | 'symbol' | 'class'
  kind: Exclude<RegistrationKind, 'swap'> | null
  aliasOf: string | null
  swapped: boolean
  registrations: number

  /**
   * Provider whose synchronous register() made the latest registration.
   */
  origin: string | null
  originEvidence: 'provider-register-trace' | null
  declaredIn: BindingDeclaration[]
  evidence: Array<'source-declared' | 'runtime-observed' | 'runtime-verified'>
}

interface Container {
  hasBinding(binding: unknown): boolean
}

type Manifest = Record<string, unknown>

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : undefined
  } catch {
    return undefined
  }
}

function names(manifest: Manifest | undefined, field: string): string[] {
  const value = manifest?.[field]
  return typeof value === 'object' && value !== null ? Object.keys(value) : []
}

/**
 * Directory of package `name` as Node resolves it from `root`.
 */
async function packageDirectory(root: string, name: string): Promise<string | undefined> {
  let directory = root
  while (true) {
    const candidate = join(directory, 'node_modules', name)
    if (await readManifest(join(candidate, 'package.json'))) {
      return realpath(candidate)
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return undefined
    }
    directory = parent
  }
}

async function collectFiles(
  root: string,
  accept: (name: string) => boolean,
  skipDirectory: (name: string) => boolean
): Promise<{ files: string[]; capped: boolean }> {
  const files: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skipDirectory(entry.name)) {
          pending.push(join(directory, entry.name))
        }
      } else if (entry.isFile() && accept(entry.name)) {
        if (files.length >= MAX_FILES_PER_ROOT) {
          return { files, capped: true }
        }
        files.push(join(directory, entry.name))
      }
    }
  }
  return { files, capped: false }
}

function memberKey(ts: TypeScriptApi, member: TypeScript.TypeElement): string | undefined {
  const name = member.name
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) {
    return name.text
  }
  return undefined
}

function interfaceMembers(
  ts: TypeScriptApi,
  source: TypeScript.SourceFile,
  declaration: TypeScript.InterfaceDeclaration,
  file: string,
  output: Map<string, BindingDeclaration[]>
): number {
  let skipped = 0
  for (const member of declaration.members) {
    const key = memberKey(ts, member)
    if (key === undefined) {
      skipped++
      continue
    }
    const typeNode = ts.isPropertySignature(member) ? member.type : undefined
    const typeText = typeNode?.getText(source) ?? null
    const entry: BindingDeclaration = {
      file,
      line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
      type:
        typeText === null
          ? null
          : typeText.length > MAX_TYPE_CHARS
            ? `${typeText.slice(0, MAX_TYPE_CHARS)}…`
            : typeText,
    }
    const list = output.get(key) ?? []
    list.push(entry)
    output.set(key, list)
  }
  return skipped
}

/**
 * Collects `ContainerBindings` members of one file. `isCoreTypes` accepts
 * the top-level interface of `@adonisjs/core/types` itself; elsewhere only
 * interfaces inside `declare module '@adonisjs/core/types'` count.
 */
function scanSource(
  ts: TypeScriptApi,
  text: string,
  path: string,
  file: string,
  isCoreTypes: boolean,
  output: Map<string, BindingDeclaration[]>
): number {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  let skipped = 0
  for (const statement of source.statements) {
    if (
      isCoreTypes &&
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'ContainerBindings'
    ) {
      skipped += interfaceMembers(ts, source, statement, file, output)
    }
    if (
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteral(statement.name) &&
      statement.name.text === CORE_TYPES_MODULE &&
      statement.body &&
      ts.isModuleBlock(statement.body)
    ) {
      for (const inner of statement.body.statements) {
        if (ts.isInterfaceDeclaration(inner) && inner.name.text === 'ContainerBindings') {
          skipped += interfaceMembers(ts, source, inner, file, output)
        }
      }
    }
  }
  return skipped
}

export interface DeclaredBindings {
  declarations: Map<string, BindingDeclaration[]>
  packages: string[]
  appFiles: number
  skippedMembers: number
  capped: string[]
}

async function declaredBindings(ts: TypeScriptApi, appRoot: string): Promise<DeclaredBindings> {
  const declarations = new Map<string, BindingDeclaration[]>()
  const manifest = await readManifest(join(appRoot, 'package.json'))
  const candidates = new Set([
    '@adonisjs/core',
    ...names(manifest, 'dependencies'),
    ...names(manifest, 'devDependencies'),
  ])
  const scannedPackages: string[] = []
  const capped: string[] = []
  let skippedMembers = 0
  const isDeclaration = (name: string) => /\.d\.[mc]?ts$/.test(name)

  const coreDirectory = await packageDirectory(appRoot, '@adonisjs/core')
  const coreManifest = coreDirectory
    ? await readManifest(join(coreDirectory, 'package.json'))
    : undefined
  const coreExports = coreManifest?.exports as Record<string, unknown> | undefined
  const coreTypesTarget =
    typeof coreExports?.['./types'] === 'string' ? coreExports['./types'] : undefined
  const coreTypesFile =
    coreDirectory && coreTypesTarget
      ? join(coreDirectory, coreTypesTarget.replace(/\.js$/, '.d.ts'))
      : undefined

  for (const name of [...candidates].sort()) {
    const directory = await packageDirectory(appRoot, name)
    if (!directory) {
      continue
    }
    const packageManifest = await readManifest(join(directory, 'package.json'))
    const dependsOnCore =
      name === '@adonisjs/core' ||
      names(packageManifest, 'dependencies').includes('@adonisjs/core') ||
      names(packageManifest, 'peerDependencies').includes('@adonisjs/core')
    if (!dependsOnCore) {
      continue
    }
    scannedPackages.push(name)
    const { files, capped: wasCapped } = await collectFiles(
      directory,
      isDeclaration,
      (entry) => entry === 'node_modules'
    )
    if (wasCapped) {
      capped.push(name)
    }
    for (const path of files) {
      const text = await readFile(path, 'utf8').catch(() => '')
      if (!text.includes('ContainerBindings')) {
        continue
      }
      skippedMembers += scanSource(
        ts,
        text,
        path,
        relative(appRoot, path).split(sep).join('/'),
        path === coreTypesFile,
        declarations
      )
    }
  }

  const { files: appFiles, capped: appCapped } = await collectFiles(
    appRoot,
    (entry) => /\.[mc]?ts$/.test(entry),
    (entry) => SKIPPED_APP_DIRECTORIES.has(entry)
  )
  if (appCapped) {
    capped.push('application sources')
  }
  for (const path of appFiles) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text.includes('ContainerBindings')) {
      skippedMembers += scanSource(
        ts,
        text,
        path,
        relative(appRoot, path).split(sep).join('/'),
        false,
        declarations
      )
    }
  }

  return {
    declarations,
    packages: scannedPackages,
    appFiles: appFiles.length,
    skippedMembers,
    capped,
  }
}

function displayKey(key: unknown): { key: string; keyType: BindingReport['keyType'] } {
  if (typeof key === 'string') {
    return { key, keyType: 'string' }
  }
  if (typeof key === 'symbol') {
    return { key: key.toString(), keyType: 'symbol' }
  }
  if (typeof key === 'function') {
    return { key: `class:${key.name || '(anonymous)'}`, keyType: 'class' }
  }
  return { key: String(key), keyType: 'string' }
}

export interface BindingInventory {
  bindings: BindingReport[]
  declaredUnavailable: Array<{ key: string; declaredIn: BindingDeclaration[] }>
  lanes: {
    sourceDeclared: { enabled: boolean; packages: string[]; appFiles: number }
    runtimeObserved: { enabled: boolean; records: number; dropped: number }
  }
  limitations: string[]
}

export class ContainerIntrospection {
  constructor(
    readonly app: ApplicationService,
    readonly appRoot: string,
    readonly observer: () => ContainerObserver | undefined
  ) {}

  async bindings(pattern?: string): Promise<BindingInventory> {
    const container = this.app.container as unknown as Container
    const limitations: string[] = [
      'Partial inventory: AdonisJS exposes no list of container bindings. Keys are discovered from ContainerBindings declarations and, when enabled, observed registrations, then verified with hasBinding() without constructing anything.',
      'Classes the container can construct without a binding are not bindings and are not listed.',
    ]

    const ts = await appTypeScript(this.appRoot)
    let declared: DeclaredBindings | undefined
    if (ts) {
      declared = await declaredBindings(ts, this.appRoot)
      if (declared.skippedMembers > 0) {
        limitations.push(
          `${declared.skippedMembers} ContainerBindings member(s) with computed names were skipped.`
        )
      }
      if (declared.capped.length > 0) {
        limitations.push(`Declaration scan stopped early in: ${declared.capped.join(', ')}.`)
      }
    } else {
      limitations.push(
        'The application has no typescript package, so ContainerBindings declarations were not read.'
      )
    }

    const observer = this.observer()
    if (!observer) {
      limitations.push(
        'Registration observation is off (start/mcp_dev_hooks.ts does not call observeContainer()): kind, alias target and provider origin are unknown, and undeclared keys are missing.'
      )
    } else {
      limitations.push(
        'Registrations made before observeContainer() ran, through saved references to the original container methods, or outside a provider register() have no recorded origin.'
      )
      if (observer.dropped > 0) {
        limitations.push(
          `${observer.dropped} registration(s) beyond the observer limit were not recorded.`
        )
      }
    }

    interface Candidate {
      key: unknown
      records: ObservedRegistration[]
      declaredIn: BindingDeclaration[]
    }
    const candidates = new Map<unknown, Candidate>()
    const candidate = (key: unknown) => {
      let entry = candidates.get(key)
      if (!entry) {
        entry = { key, records: [], declaredIn: [] }
        candidates.set(key, entry)
      }
      return entry
    }
    for (const [key, list] of declared?.declarations ?? []) {
      candidate(key).declaredIn.push(...list)
    }
    for (const record of observer?.records ?? []) {
      candidate(record.key).records.push(record)
    }

    const needle = pattern?.toLowerCase()
    const bindings: BindingReport[] = []
    const declaredUnavailable: BindingInventory['declaredUnavailable'] = []
    for (const entry of candidates.values()) {
      const display = displayKey(entry.key)
      if (needle !== undefined && !display.key.toLowerCase().includes(needle)) {
        continue
      }
      let available = false
      try {
        available = container.hasBinding(entry.key)
      } catch {
        available = false
      }
      if (!available) {
        if (entry.declaredIn.length > 0) {
          declaredUnavailable.push({ key: display.key, declaredIn: entry.declaredIn })
        }
        continue
      }
      const registrations = entry.records.filter((record) => record.kind !== 'swap')
      const latest = registrations.at(-1)
      const evidence: BindingReport['evidence'] = []
      if (entry.declaredIn.length > 0) {
        evidence.push('source-declared')
      }
      if (entry.records.length > 0) {
        evidence.push('runtime-observed')
      }
      evidence.push('runtime-verified')
      bindings.push({
        ...display,
        kind: latest ? (latest.kind as BindingReport['kind']) : null,
        aliasOf:
          latest?.kind === 'alias' && latest.aliasOf !== undefined
            ? displayKey(latest.aliasOf).key
            : null,
        swapped: entry.records.some((record) => record.kind === 'swap'),
        registrations: registrations.length,
        origin: latest?.origin ?? null,
        originEvidence: latest?.origin ? 'provider-register-trace' : null,
        declaredIn: entry.declaredIn,
        evidence,
      })
    }
    bindings.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))

    return {
      bindings,
      declaredUnavailable,
      lanes: {
        sourceDeclared: {
          enabled: declared !== undefined,
          packages: declared?.packages ?? [],
          appFiles: declared?.appFiles ?? 0,
        },
        runtimeObserved: {
          enabled: observer !== undefined,
          records: observer?.records.length ?? 0,
          dropped: observer?.dropped ?? 0,
        },
      },
      limitations,
    }
  }
}

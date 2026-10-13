/*
|--------------------------------------------------------------------------
| Package documentation index
|--------------------------------------------------------------------------
|
| `search_package_docs` backend. Offline lexical search over installed
| packages matching `tools.docs.include`, resolved from the application
| root like Node does (nearest `node_modules` first). Only README/docs
| Markdown and type declarations inside each package's real root are read,
| with per-file and per-package caps. The index is built on first use and
| cached per package generation (real root, version, package.json mtime).
|
*/

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import { ToolError } from '../errors.js'
import { type Redactor } from '../redaction.js'
import { isWithin } from '../introspection/source_files.js'
import type { PackageManifest } from '../introspection/source_location.js'

export interface DocChunk {
  text: string
  startLine: number
  endLine: number
  heading: string
}
export function chunkDocs(text: string, declarations = false): DocChunk[] {
  const lines = text.split(/\r?\n/)
  const chunks: DocChunk[] = []
  let start = 0
  let heading = ''
  const flush = (end: number) => {
    if (end > start && lines.slice(start, end).some((line) => line.trim()))
      chunks.push({
        text: lines.slice(start, end).join('\n'),
        startLine: start + 1,
        endLine: end,
        heading,
      })
    start = end
  }
  for (let index = 0; index < lines.length; index++) {
    const boundary = declarations
      ? /^\s*\/\*\*/.test(lines[index]) ||
        (/^\s*(?:export |declare )/.test(lines[index]) &&
          !lines.slice(start, index).some((line) => /\/\*\*/.test(line)))
      : /^#{1,6}\s/.test(lines[index])
    if (boundary || index - start >= 80) {
      flush(index)
      heading = lines[index]
    }
  }
  flush(lines.length)
  return chunks
}

export function tokens(text: string) {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length > 1 &&
        ![
          'the',
          'and',
          'for',
          'with',
          'from',
          'this',
          'that',
          'are',
          'you',
          'to',
          'of',
          'in',
          'is',
          'an',
          'as',
        ].includes(token)
    )
}

interface IndexedChunk extends DocChunk {
  file: string

  /**
   * Term frequencies, token count and heading terms computed once at
   * indexing time so a search only touches chunks containing a query term.
   */
  frequencies: Map<string, number>
  length: number
  headingTerms: ReadonlySet<string>
}
interface IndexedPackage {
  generation: string
  version: string | null
  chunks: IndexedChunk[]
  skipped: string[]
}

export class PackageDocs {
  #cache = new Map<string, IndexedPackage>()
  constructor(
    private appRoot: string,
    private include: readonly string[],
    private redactor: Redactor
  ) {}
  /**
   * `node_modules` directories the application resolves packages from,
   * nearest first (hoisted workspaces install into an ancestor).
   */
  #moduleDirectories(): string[] {
    const directories: string[] = []
    let directory = this.appRoot
    for (;;) {
      const modules = join(directory, 'node_modules')
      if (existsSync(modules)) {
        directories.push(modules)
      }
      const parent = dirname(directory)
      if (parent === directory) return directories
      directory = parent
    }
  }

  available() {
    return this.#moduleDirectories().length > 0
  }

  async search(query: string, requested?: string[]) {
    /**
     * Package name → directory, the nearest `node_modules` winning as in
     * Node resolution.
     */
    const locations = new Map<string, string>()
    for (const modules of this.#moduleDirectories()) {
      let entries
      try {
        entries = await readdir(modules, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('@')) {
          try {
            for (const child of await readdir(join(modules, entry.name))) {
              const name = `${entry.name}/${child}`
              if (!locations.has(name)) locations.set(name, join(modules, name))
            }
          } catch {}
        } else if (!entry.name.startsWith('.') && !locations.has(entry.name)) {
          locations.set(entry.name, join(modules, entry.name))
        }
      }
    }
    const names = [...locations.keys()]
    const allowed = names.filter((name) =>
      this.include.some(
        (pattern) =>
          pattern === name || (pattern.endsWith('/*') && name.startsWith(pattern.slice(0, -1)))
      )
    )
    if (requested?.some((name) => !allowed.includes(name)))
      throw new ToolError(
        'INPUT_INVALID',
        'Requested packages must be installed and match docs include patterns',
        { details: { include: this.include } }
      )
    const selected = [...new Set(requested ?? allowed)].sort()
    const indexed: {
      package: string
      version: string | null
      cacheHit: boolean
      skipped: string[]
    }[] = []
    const searched: Array<{ name: string; version: string | null; chunks: IndexedChunk[] }> = []
    const activeRoots = new Set<string>()
    for (const name of allowed) {
      try {
        activeRoots.add(await realpath(locations.get(name)!))
      } catch {}
    }
    for (const key of this.#cache.keys()) if (!activeRoots.has(key)) this.#cache.delete(key)
    for (const name of selected) {
      let root: string
      let manifest: PackageManifest
      let generation: string
      try {
        root = await realpath(locations.get(name)!)
        const manifestPath = join(root, 'package.json')
        if (!isWithin(root, await realpath(manifestPath))) continue
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
        const metadata = await stat(manifestPath)
        generation = `${manifest.version}:${metadata.mtimeMs}`
      } catch {
        continue
      }
      let cached = this.#cache.get(root)
      const cacheHit = cached?.generation === generation
      if (!cacheHit) {
        const chunks: IndexedChunk[] = []
        const skipped: string[] = []
        let bytes = 0
        let files = 0
        let entriesScanned = 0
        const visited = new Set<string>()
        const walk = async (directory: string, depth: number) => {
          if (depth > 12) {
            skipped.push(relative(root, directory) + ': depth cap')
            return
          }
          let canonical: string
          try {
            canonical = await realpath(directory)
          } catch {
            return
          }
          if (!isWithin(root, canonical) || visited.has(canonical)) return
          visited.add(canonical)
          const entries = await readdir(directory, { withFileTypes: true })
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++entriesScanned > 20000) {
              if (!skipped.includes('Package traversal entry cap'))
                skipped.push('Package traversal entry cap')
              return
            }
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
            const path = join(directory, entry.name)
            const file = relative(root, path).replaceAll('\\', '/')
            let resolved: string
            try {
              resolved = await realpath(path)
            } catch {
              continue
            }
            if (!isWithin(root, resolved)) {
              skipped.push(file + ': outside package root')
              continue
            }
            const metadata = await stat(resolved)
            if (metadata.isDirectory()) {
              await walk(path, depth + 1)
              continue
            }
            const declaration = /\.d\.[cm]?ts$/i.test(file)
            const markdown =
              /^README[^/]*\.(md|markdown)$/i.test(file) || /^docs\/.*\.md$/i.test(file)
            if (!declaration && !markdown) continue
            if (
              files >= 500 ||
              metadata.size > 512 * 1024 ||
              bytes + metadata.size > 8 * 1024 * 1024
            ) {
              skipped.push(file + ': indexing cap')
              continue
            }
            files++
            bytes += metadata.size
            const text = await readFile(resolved, 'utf8')
            for (const chunk of chunkDocs(text, declaration)) {
              const terms = tokens(chunk.text)
              const frequencies = new Map<string, number>()
              for (const term of terms) {
                frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
              }
              chunks.push({
                ...chunk,
                file,
                frequencies,
                length: terms.length,
                headingTerms: new Set(tokens(chunk.heading)),
              })
            }
          }
        }
        await walk(root, 0)
        cached = { generation, version: manifest.version ?? null, chunks, skipped }
        this.#cache.set(root, cached)
      }
      if (!cached) continue
      indexed.push({ package: name, version: cached.version, cacheHit, skipped: cached.skipped })
      searched.push({ name, version: cached.version, chunks: cached.chunks })
    }
    const terms = [...new Set(tokens(query))]
    let total = 0
    let totalLength = 0
    const documentFrequency = new Map(terms.map((term) => [term, 0]))
    for (const pkg of searched) {
      for (const chunk of pkg.chunks) {
        total++
        totalLength += chunk.length
        for (const term of terms) {
          if (chunk.frequencies.has(term)) {
            documentFrequency.set(term, documentFrequency.get(term)! + 1)
          }
        }
      }
    }
    const average = Math.max(totalLength / Math.max(total, 1), 1)
    const phrase = query.toLowerCase()
    const ranked: Array<{
      chunk: IndexedChunk
      package: string
      version: string | null
      score: number
    }> = []
    for (const pkg of searched) {
      for (const chunk of pkg.chunks) {
        let score = 0
        for (const term of terms) {
          const frequency = chunk.frequencies.get(term)
          if (!frequency) continue
          const containing = documentFrequency.get(term)!
          const idf = Math.log(1 + (total - containing + 0.5) / (containing + 0.5))
          score +=
            (idf * frequency * 2.2) /
            (frequency + 1.2 * (0.25 + (0.75 * chunk.length) / average))
          if (chunk.headingTerms.has(term)) score += idf * 2
        }
        if (score === 0) continue
        if (chunk.text.toLowerCase().includes(phrase)) score *= 1.5
        ranked.push({ chunk, package: pkg.name, version: pkg.version, score })
      }
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        a.package.localeCompare(b.package) ||
        a.chunk.file.localeCompare(b.chunk.file) ||
        a.chunk.startLine - b.chunk.startLine
    )
    const snippets = ranked
      .slice(0, 5)
      .map(({ chunk, package: name, version, score }) => {
        const lines: string[] = []
        let bytes = 0
        for (const line of chunk.text.split('\n').slice(0, 40)) {
          const size = Buffer.byteLength(line) + (lines.length ? 1 : 0)
          if (bytes + size > 4096) break
          lines.push(line)
          bytes += size
        }
        return {
          package: name,
          version,
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.startLine + lines.length - 1,
          score,
          text: this.redactor.text(lines.join('\n')),
        }
      })
      .filter((snippet) => snippet.endLine >= snippet.startLine)
    return {
      data: this.redactor.value({ query, snippets, indexed }),
      evidence: ['source' as const],
      limitations: [
        'Offline lexical search; index generations follow package.json version and mtime, not individual file edits. Index caps and escaped symlinks are reported per package.',
      ],
    }
  }
}

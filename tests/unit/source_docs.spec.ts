import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redactor } from '../../src/redaction.js'
import { test } from '@japa/runner'
import { resolveExports, resolveMapping } from '../../src/introspection/package_maps.js'
import { chunkDocs, PackageDocs, tokens } from '../../src/docs/index.js'
import { SourceLocation } from '../../src/introspection/source_location.js'

test.group('Source mappings and documentation chunks', () => {
  test('conditions and longest patterns resolve without exposing private subpaths', ({
    assert,
  }) => {
    const exports = {
      './*': './generic/*.js',
      './orm/*': {
        types: './types/*.d.ts',
        node: { import: './runtime/*.js' },
        default: './fallback/*.js',
      },
      '.': { import: './main.js', default: './fallback.js' },
      './private': null,
    }
    assert.equal(resolveExports(exports, './orm/user'), './runtime/user.js')
    assert.equal(
      resolveExports(exports, './orm/user', ['types', 'node', 'import', 'default']),
      './types/user.d.ts'
    )
    assert.equal(resolveExports(exports, '.'), './main.js')
    assert.isNull(resolveExports(exports, './private'))
    assert.isNull(resolveExports({ '.': './index.js' }, './unknown'))
    assert.equal(
      resolveMapping(
        { '#*': './app/*.js', '#models/*': { node: './app/models/*.js' } },
        '#models/user'
      ),
      './app/models/user.js'
    )
    assert.equal(resolveExports('./index.js', '.'), './index.js')
    assert.isNull(resolveExports('./index.js', './unknown'))
  })
  test('chunks preserve original heading and declaration line ranges', ({ assert }) => {
    const markdown = 'Preamble\n\n# Router\nUse router.get\n\n## Groups\nGroup routes\n'
    const lines = markdown.split('\n')
    const chunks = chunkDocs(markdown)
    assert.equal(chunks[1].startLine, 3)
    assert.equal(chunks[2].startLine, 6)
    for (const chunk of chunks)
      assert.equal(chunk.text, lines.slice(chunk.startLine - 1, chunk.endLine).join('\n'))
    const declarations =
      '/** Router documentation */\nexport declare class Router {\n  get(): void\n}\n\n/** Preload relations */\nexport declare function preload(): void\n'
    for (const chunk of chunkDocs(declarations, true))
      assert.equal(
        chunk.text,
        declarations
          .split('\n')
          .slice(chunk.startLine - 1, chunk.endLine)
          .join('\n')
      )
    assert.deepEqual(tokens('preloadRelations snake_case kebab-case the'), [
      'preload',
      'relations',
      'snake',
      'case',
      'kebab',
      'case',
    ])
  })
  test('ranking favors heading matches, limits results and preserves truncated line ranges', async ({
    assert,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-doc-rank-'))
    try {
      const pkg = join(root, 'node_modules/@rikology/ranking')
      await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), '{"name":"@rikology/ranking","version":"1"}')
      const content =
        '# Quokka\n' +
        Array.from({ length: 50 }, (_, index) => `Quokka detail ${index}`).join('\n') +
        Array.from({ length: 7 }, (_, index) => `\n# Other ${index}\nQuokka reference`).join('')
      await writeFile(join(pkg, 'README.md'), content)
      const docs = new PackageDocs(root, ['@rikology/*'], new Redactor([]))
      const result = await docs.search('Quokka')
      const data = result.data as {
        snippets: { startLine: number; endLine: number; text: string }[]
      }
      assert.lengthOf(data.snippets, 5)
      assert.equal(data.snippets[0].startLine, 1)
      assert.isAtMost(data.snippets[0].endLine, 40)
      for (const snippet of data.snippets)
        assert.equal(
          snippet.text,
          content
            .split('\n')
            .slice(snippet.startLine - 1, snippet.endLine)
            .join('\n')
        )
      const empty = await docs.search('unfindablezz')
      const emptyData = empty.data as { snippets: unknown[] }
      assert.lengthOf(emptyData.snippets, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test('docs resolve hoisted packages with the nearest node_modules winning', async ({
    assert,
  }) => {
    const workspace = await mkdtemp(join(tmpdir(), 'mcp-doc-hoist-'))
    try {
      const app = join(workspace, 'apps/web')
      await mkdir(app, { recursive: true })
      for (const [modules, word] of [
        [join(workspace, 'node_modules'), 'Hoistedwombat'],
        [join(app, 'node_modules'), 'Nearestwombat'],
      ]) {
        for (const name of ['@rikology/hoisted', '@rikology/shadowed']) {
          const pkg = join(modules, name)
          await mkdir(pkg, { recursive: true })
          await writeFile(join(pkg, 'package.json'), `{"name":"${name}","version":"1"}`)
          await writeFile(join(pkg, 'README.md'), `# ${word}\n`)
        }
      }
      await rm(join(app, 'node_modules/@rikology/hoisted'), { recursive: true })
      const docs = new PackageDocs(app, ['@rikology/*'], new Redactor([]))
      const hoistedResult = await docs.search('Hoistedwombat')
      const hoisted = hoistedResult.data as { snippets: { package: string }[] }
      assert.deepEqual(
        hoisted.snippets.map((snippet) => snippet.package),
        ['@rikology/hoisted']
      )
      const nearestResult = await docs.search('Nearestwombat')
      const nearest = nearestResult.data as { snippets: { package: string }[] }
      assert.deepEqual(
        nearest.snippets.map((snippet) => snippet.package),
        ['@rikology/shadowed']
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
  test('a source map proves the module source only when it lists one existing file', async ({
    assert,
  }) => {
    const app = await mkdtemp(join(tmpdir(), 'mcp-source-map-'))
    try {
      await writeFile(join(app, 'package.json'), '{"name":"app"}')
      for (const [name, sources] of [
        ['single', ['../src/index.ts']],
        ['bundle', ['../src/errors.ts', '../src/parse.ts']],
      ] as const) {
        const pkg = join(app, 'node_modules', name)
        await mkdir(join(pkg, 'dist'), { recursive: true })
        await mkdir(join(pkg, 'src'), { recursive: true })
        await writeFile(
          join(pkg, 'package.json'),
          JSON.stringify({ name, version: '1.0.0', exports: './dist/index.js' })
        )
        await writeFile(join(pkg, 'dist/index.js'), 'export {}\n')
        await writeFile(join(pkg, 'dist/index.js.map'), JSON.stringify({ version: 3, sources }))
        for (const source of sources) {
          await writeFile(join(pkg, 'dist', source), 'export {}\n')
        }
      }
      const resolver = new SourceLocation(app, new Redactor([]))
      const singleResult = await resolver.resolve('single')
      const single = singleResult.data as { source?: { absolute: string; via: string } }
      assert.equal(single.source?.via, 'source-map')
      assert.isTrue(single.source?.absolute.endsWith('/single/src/index.ts'))
      const bundle = await resolver.resolve('bundle')
      const data = bundle.data as { source?: unknown; sourceCandidates?: string[] }
      assert.isUndefined(data.source)
      assert.lengthOf(data.sourceCandidates!, 2)
    } finally {
      await rm(app, { recursive: true, force: true })
    }
  })
})

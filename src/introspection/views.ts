/*
|--------------------------------------------------------------------------
| Application Edge views
|--------------------------------------------------------------------------
| Mounted roots and raw templates come from the application's Edge singleton.
| Discovery reads source only; rendering executes trusted application code.
| Core 7.6's Edge provider imports the same edge.js default export and installs
| HttpContext.view as edge.createRenderer().share({ request }). The real fixture
| test verifies that HTTP view.render and render_view increment the same global
| helper closure. No synthetic request renderer or separate Edge instance is used.
*/
import { realpath } from 'node:fs/promises'
import type { ApplicationService } from '@adonisjs/core/types'
import { ToolError } from '../errors.js'
import type { Redactor } from '../redaction.js'
import { appRelative, errorMessage, isWithin, readSource, scanDirectory } from './source_files.js'

interface EdgeInstance {
  loader: {
    mounted: Record<string, string>
    templates: Record<string, { template: string }>
    listComponents(): {
      diskName: string
      components: { componentName: string; tagName: string }[]
    }[]
  }
  render(name: string, state: Record<string, unknown>): Promise<string>
}

export interface ViewSlots {
  names: string[]
  completeness: 'complete' | 'partial' | 'unknown'
}
export function viewSlots(source: string): ViewSlots {
  const names = [
    ...new Set([...source.matchAll(/\$slots\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1])),
  ].sort()
  const dynamic = /\$slots\s*\[/.test(source)
  return { names, completeness: dynamic ? (names.length ? 'partial' : 'unknown') : 'complete' }
}

export interface ViewEntry {
  name: string
  disk: string
  file: string | null
  evidence: 'source' | 'runtime'
  component: { tag: string; usage: string; evidence: 'runtime' } | null
  slots: ViewSlots
  changedSinceProcessStart: boolean
}

export class ViewIntrospection {
  constructor(
    readonly app: ApplicationService,
    readonly appRoot: string,
    readonly redactor: Redactor
  ) {}

  async instance() {
    const imported = (await this.app.import('edge.js')) as { default: EdgeInstance }
    return imported.default
  }

  async inventory(name?: string) {
    const edge = await this.instance()
    const root = await realpath(this.appRoot)
    const views: ViewEntry[] = []
    const disks = []
    const limitations = [
      'Component identities and tags come from Edge loader.listComponents(). Slots are literal source references, not an exhaustive runtime contract; comments and strings may contain references.',
      'The application Edge singleton is the default edge.js export used by the Core Edge provider to create HttpContext.view renderers. Request-specific shared state is not populated here.',
    ]
    const components = new Map<string, string>()
    for (const disk of edge.loader.listComponents()) {
      for (const entry of disk.components) {
        components.set(entry.componentName, entry.tagName)
      }
    }
    const component = (viewName: string) => {
      const tag = components.get(viewName)
      return tag === undefined
        ? null
        : {
            tag: `@${tag}`,
            usage: `@component('${viewName}')`,
            evidence: 'runtime' as const,
          }
    }
    for (const [disk, directory] of Object.entries(edge.loader.mounted)) {
      const scanned = await scanDirectory(directory, {
        extensions: ['.edge'],
        maxFiles: Math.max(0, 2000 - views.length),
      })
      disks.push({
        disk,
        root: scanned.root,
        exists: scanned.exists,
        truncated: scanned.truncated,
        outsideRoot: scanned.outsideRoot,
        evidence: 'runtime' as const,
      })
      for (const file of scanned.files) {
        const localName = file.relative.slice(0, -5)
        const viewName = disk === 'default' ? localName : `${disk}::${localName}`
        let slots: ViewSlots = { names: [], completeness: 'unknown' }
        try {
          slots = viewSlots(await readSource(file.absolute))
        } catch (error) {
          limitations.push(this.redactor.text(errorMessage(error)))
        }
        views.push({
          name: viewName,
          disk,
          file: isWithin(root, file.absolute) ? appRelative(root, file.absolute) : file.absolute,
          evidence: 'source',
          component: component(viewName),
          slots,
          changedSinceProcessStart: file.changedSinceProcessStart,
        })
      }
    }
    let registeredTruncated = false
    for (const [viewName, template] of Object.entries(edge.loader.templates)) {
      if (views.length >= 2000) {
        registeredTruncated = true
        break
      }
      const existing = views.findIndex((entry) => entry.name === viewName)
      const entry: ViewEntry = {
        name: viewName,
        disk: 'default',
        file: null,
        evidence: 'runtime',
        component: component(viewName),
        slots: viewSlots(template.template),
        changedSinceProcessStart: false,
      }
      if (existing === -1) {
        views.push(entry)
      } else {
        views[existing] = entry
      }
    }
    if (views.some((entry) => entry.changedSinceProcessStart)) {
      limitations.push(
        'Some view files changed since process start; the running process may still use a previous cached version.'
      )
    }
    const truncated = registeredTruncated || disks.some((disk) => disk.truncated)
    if (truncated) {
      limitations.push(
        'View discovery was truncated at 2000 entries; only inventoried names can be rendered.'
      )
    }
    if (disks.some((disk) => disk.outsideRoot)) {
      limitations.push('Symlinks outside mounted view roots were skipped.')
    }
    if (name && !views.some((entry) => entry.name === name)) {
      throw new ToolError(
        'NOT_FOUND',
        `Unknown view ${name}. Known views: ${views.map((entry) => entry.name).join(', ')}`
      )
    }
    return {
      data: {
        views: name ? views.filter((entry) => entry.name === name) : views,
        disks,
        truncated,
      },
      evidence: ['runtime', 'source'] as const,
      limitations,
    }
  }

  async render(name: string, state: Record<string, unknown>, maxBytes: number) {
    await this.inventory(name)
    const edge = await this.instance()
    let html: string
    try {
      html = this.redactor.text(await edge.render(name, state))
    } catch (error) {
      const location = error as { filename?: string; line?: number; col?: number }
      throw new ToolError('EXECUTION_FAILED', this.redactor.text(errorMessage(error)), {
        details: {
          location:
            typeof location.filename === 'string'
              ? {
                  file: this.redactor.text(location.filename),
                  line: location.line ?? null,
                  column: location.col ?? null,
                }
              : null,
        },
      })
    }
    const bytes = Buffer.byteLength(html)
    if (bytes > maxBytes) {
      const buffer = Buffer.from(html)
      let end = maxBytes
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
        end--
      }
      html = buffer.subarray(0, end).toString('utf8')
    }
    return {
      data: { name, html, bytes, truncated: bytes > maxBytes },
      evidence: ['runtime'] as const,
      limitations: [
        'Rendering executes application templates, globals and helpers, which can have side effects. Request, auth, csrf and development @vite dependencies are absent or may fail. Output is text only, never opened as browser content.',
      ],
    }
  }
}

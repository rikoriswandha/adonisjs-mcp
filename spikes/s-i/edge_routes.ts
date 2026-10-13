import router from '@adonisjs/core/services/router'
import edge from 'edge.js'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

router.get('/__s_i_edge', async ({ request, response }) => {
  const views: Record<string, { path: string, kind: string, slots: string[], dynamic: boolean }> = {}
  for (const [disk, mounted] of Object.entries(edge.loader.mounted)) {
    const root = await realpath(mounted)
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.edge')) continue
      const path = await realpath(join(entry.parentPath, entry.name))
      const rel = relative(root, path)
      if (rel.startsWith('..') || rel.startsWith(sep)) continue
      const name = `${disk === 'default' ? '' : disk + '::'}${rel.slice(0, -5).split(sep).join('.')}`
      const source = await readFile(path, 'utf8')
      views[name] = { path: rel, kind: rel.startsWith('components/') ? 'component-convention' : 'view',
        slots: [...source.matchAll(/\$slots\.([\w]+)/g)].map((match) => match[1]),
        dynamic: source.includes('$slots[') || source.includes('@component(') }
    }
  }
  const name = request.input('view', 's_i')
  if (!Object.hasOwn(views, name)) return response.badRequest({ error: 'VIEW_NOT_IN_INVENTORY' })
  return { pid: process.pid, mounted: edge.loader.mounted, rawTemplates: Object.keys(edge.loader.templates), views,
    html: await edge.render(name, { greeting: '<JSON state>' }) }
}).as('s_i.edge')

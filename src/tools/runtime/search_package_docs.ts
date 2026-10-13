import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { type PackageDocs } from '../../docs/index.js'

export function searchPackageDocsTool(docs: PackageDocs) {
  return defineTool({
    name: 'search_package_docs',
    title: 'Search installed package documentation',
    description:
      'Offline lexical search of allowlisted installed package README, docs Markdown and declarations. Lazy bounded package-generation cache; returns at most five bounded, redacted snippets with exact original line ranges and skipped-file reports. No network access.',
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      packages: z.array(z.string().min(1).max(214)).max(100).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: () =>
      docs.available()
        ? { available: true }
        : {
            available: false,
            code: 'CAPABILITY_UNSUPPORTED',
            reason: 'No node_modules directory at or above the application root',
          },
    handler: (input) => docs.search(input.query, input.packages),
  })
}

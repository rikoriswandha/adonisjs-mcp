import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import { lucidAvailability } from '../../database/lucid.js'
import type { ModelCatalog, ModelCatalogSnapshot } from '../../database/models.js'
import type { AnyToolDefinition, ResourceDefinition, ToolOutput } from '../../types.js'

const LIMITATIONS = [
  'Only models exported from files under the models directory (app.modelsPath(), recursive) are discovered; Lucid has no global model registry.',
  'Model files are imported and booted (decorators and static boot() run), as Lucid does on first use.',
]

async function describe(catalog: ModelCatalog, name?: string): Promise<ToolOutput> {
  const snapshot = await catalog.snapshot()
  let models = snapshot.models
  if (name !== undefined) {
    models = models.filter((model) => model.id === name || model.name === name)
    if (models.length === 0) {
      throw new ToolError(
        'NOT_FOUND',
        `No model "${name}" in ${snapshot.directory}. Known models: ${
          snapshot.models.map((model) => model.id).join(', ') || 'none'
        }`
      )
    }
  }
  const limitations = [...LIMITATIONS]
  const changed = models.filter((model) => model.changedSinceProcessStart)
  if (changed.length > 0) {
    limitations.push(
      `${changed.map((model) => model.file).join(', ')} changed after the process started; the running process may still use the previous version until the dev server restarts.`
    )
  }
  if (snapshot.failures.length > 0) {
    limitations.push(
      `${snapshot.failures.length} model file(s) failed to import or boot; see "failures".`
    )
  }
  const data: ModelCatalogSnapshot = { ...snapshot, models }
  return { data, evidence: ['runtime'], limitations }
}

export function getModelsTool(catalog: ModelCatalog): AnyToolDefinition {
  return defineTool({
    name: 'get_models',
    title: 'Lucid models',
    description:
      'Lists the Lucid models of the running AdonisJS application: table, primary key, connection, columns (property and physical column names, serializeAs), computed properties, relations with resolved keys, tenant scoping and file path. Files that fail to import are reported per file. Imports model files; does not query the database.',
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe("Model class name (e.g. 'User') or catalog id (e.g. 'admin/role')"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    available: lucidAvailability,
    handler: (input) => describe(catalog, input.name),
  })
}

export function modelsResource(catalog: ModelCatalog): ResourceDefinition {
  return {
    name: 'models',
    uri: 'adonis://models',
    title: 'Lucid models',
    description: 'Same data as the get_models tool without a filter.',
    available: lucidAvailability,
    read: () => describe(catalog),
  }
}

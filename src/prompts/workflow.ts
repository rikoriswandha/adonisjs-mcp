import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AvailabilityContext,
  CapabilityReport,
  ProjectProfile,
  PromptOutput,
} from '../types.js'
import type { DescribeProject } from '../tools/app/get_project_profile.js'

export interface WorkflowCapabilities {
  tools: readonly CapabilityReport[]
  resources: readonly CapabilityReport[]
  prompts: readonly CapabilityReport[]
}

export async function workflowContext(
  describe: DescribeProject,
  context: AvailabilityContext,
  appRoot: string
) {
  // The provider closure supplies this exact profile-plus-capabilities result.
  const described = (await describe(context)) as ProjectProfile & {
    capabilities: WorkflowCapabilities
  }
  const flowExists = await stat(join(appRoot, '.flow')).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  return { profile: described, capabilities: described.capabilities, flowExists }
}

export function workflowText(capabilities: WorkflowCapabilities) {
  const missing = new Map<string, string>()
  return {
    tool(name: string): string {
      const entry = capabilities.tools.find((item) => item.name === name)
      if (entry?.status === 'served') return `\`${name}\``
      missing.set(name, entry?.reason ?? entry?.code ?? entry?.status ?? 'not registered')
      return '(tool not available, see below)'
    },
    resource(name: string): string {
      const entry = capabilities.resources.find((item) => item.name === name)
      if (entry?.status === 'served') return `adonis://${name}`
      missing.set(name, entry?.reason ?? entry?.code ?? entry?.status ?? 'not registered')
      return '(resource not available, see below)'
    },
    finish(lines: string[]): PromptOutput {
      return {
        messages: [
          {
            role: 'user',
            text: [
              ...lines,
              ...[...missing].map(([name, reason]) => `Not available: ${name} — ${reason}`),
            ].join('\n'),
          },
        ],
      }
    },
  }
}

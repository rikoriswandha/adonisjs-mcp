import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import type { AnyToolDefinition, AvailabilityContext } from '../../types.js'

/**
 * Profile plus the served/disabled/unavailable status of every registered
 * definition. Shared with the `adonis://profile` resource.
 */
export type DescribeProject = (context: AvailabilityContext) => Promise<unknown>

export function getProjectProfileTool(describe: DescribeProject): AnyToolDefinition {
  return defineTool({
    name: 'get_project_profile',
    title: 'Project profile',
    description:
      'Describes the running AdonisJS application: project kind (api, inertia, edge, hybrid), request surfaces, auth guards, installed versus active integrations, generated artifacts, and why each MCP tool, resource and prompt is or is not served. Read-only; call it first in a session.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(_input, context) {
      return { data: await describe(context), evidence: ['runtime', 'generated'] }
    },
  })
}

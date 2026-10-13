import { z } from 'zod'
import type { DescribeProject } from '../tools/app/get_project_profile.js'
import type { ProjectProfile, PromptDefinition } from '../types.js'
import { workflowContext, workflowText, type WorkflowCapabilities } from './workflow.js'

const schema = z.object({
  path: z.string(),
  method: z
    .string()
    .regex(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i)
    .optional(),
  userId: z.string().optional(),
  guard: z.string().optional(),
  tenant: z.string().optional(),
  surface: z.enum(['web', 'api']).optional(),
})
export type DebugRequestArgs = z.output<typeof schema>

export function buildDebugRequest(
  args: DebugRequestArgs,
  profile: ProjectProfile,
  capabilities: WorkflowCapabilities,
  flowExists: boolean
) {
  const text = workflowText(capabilities)
  const request = {
    path: args.path,
    method: args.method?.toUpperCase() ?? 'GET',
    ...(args.userId !== undefined
      ? { as: { userId: args.userId, ...(args.guard !== undefined ? { guard: args.guard } : {}) } }
      : {}),
    ...(args.tenant !== undefined ? { tenant: args.tenant } : {}),
    ...(args.surface !== undefined ? { surface: args.surface } : {}),
  }
  return text.finish([
    `Debug ${JSON.stringify(args.path)} in this ${profile.kind} application.`,
    `1. Read ${text.resource('profile')} or ${text.tool('get_project_profile')} before choosing conventions and request surfaces.`,
    `2. Resolve the route and middleware using ${text.tool('get_routes')} and ${text.tool('get_middleware')}.`,
    `3. Reproduce with ${text.tool('http_request')}: ${JSON.stringify(request)}. This performs a real HTTP request and may have side effects; obtain appropriate consent before mutating application state.`,
    `4. The HTTP result already contains correlated logs and exceptions when instrumentation exists. For additional context, correlate the request id with ${text.tool('get_last_exceptions')} and ${text.tool('get_logs')}.`,
    `5. Inspect the implicated source with ${text.tool('get_source_location')} and consult ${text.tool('search_package_docs')} for installed-package conventions.`,
    '6. Fix the root cause with the smallest change and add a regression test.',
    `7. Re-run the same request with ${text.tool('http_request')} and inspect the resulting evidence.`,
    ...(args.guard !== undefined && args.userId === undefined
      ? ['The supplied guard is ignored without userId; provide userId to select an auth guard.']
      : []),
    ...(flowExists ? ['Follow the existing .flow/ project workflow.'] : []),
  ])
}

export function debugRequestPrompt(
  describe: DescribeProject,
  appRoot: string
): PromptDefinition<typeof schema> {
  return {
    name: 'debug_request',
    description: 'Plan evidence-driven request debugging without executing requests.',
    argsSchema: schema,
    async get(args, context) {
      const workflow = await workflowContext(describe, context, appRoot)
      return buildDebugRequest(args, workflow.profile, workflow.capabilities, workflow.flowExists)
    },
  }
}

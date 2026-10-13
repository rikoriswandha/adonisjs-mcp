import { z } from 'zod'
import type { DescribeProject } from '../tools/app/get_project_profile.js'
import type { ProjectProfile, PromptDefinition } from '../types.js'
import { workflowContext, workflowText, type WorkflowCapabilities } from './workflow.js'

const schema = z.object({ feature: z.string(), surface: z.enum(['web', 'api', 'both']).optional() })
export type AddFeatureArgs = z.output<typeof schema>

export function buildAddFeature(
  args: AddFeatureArgs,
  profile: ProjectProfile,
  capabilities: WorkflowCapabilities,
  flowExists: boolean
) {
  const text = workflowText(capabilities)
  const lines = [
    `Implement the requested feature: ${JSON.stringify(args.feature)}.`,
    `Read ${text.resource('profile')} or ${text.tool('get_project_profile')} to follow this ${profile.kind} project's conventions.`,
  ]
  if (profile.kind === 'hybrid' && args.surface === undefined) {
    lines.push(
      'First ask the user whether this feature is for web, api or both. Do not plan or implement before the answer.'
    )
    return text.finish(lines)
  }
  const api = profile.kind === 'api' || (profile.kind === 'hybrid' && args.surface === 'api')
  const both = profile.kind === 'hybrid' && args.surface === 'both'
  const inertia =
    profile.kind === 'inertia' || (profile.kind === 'hybrid' && !api && profile.inertia !== null)
  lines.push(
    `1. Before writing code, inspect existing models with ${text.tool('get_models')}, validators with ${text.tool('get_validators')}, and routes with ${text.tool('get_routes')}.`,
    `If the feature touches data, inspect ${text.tool('get_migrations')} and ${text.tool('diff_schema')} before deciding whether schema changes are needed.`
  )
  // Tuyau has no runtime activity signal (profile `active: null`); the served tool is the evidence.
  const tuyau = capabilities.tools.some(
    (entry) => entry.name === 'get_tuyau_schema' && entry.status === 'served'
  )
  if ((api || both) && tuyau)
    lines.push(`Inspect the API contract with ${text.tool('get_tuyau_schema')}.`)
  if (inertia)
    lines.push(
      `Inspect ${text.tool('get_inertia_pages')} and ${text.tool('get_shared_props')} before designing the page.`
    )
  else if (!api) lines.push(`Inspect ${text.tool('get_views')} before designing the Edge template.`)
  lines.push(
    `2. Scaffold with ${text.tool('run_ace_command')}: make:validator and make:controller${inertia ? ', plus make:page (node ace make:page)' : !api ? ', plus make:view' : ''}. When schema changes are needed, scaffold make:migration. Then edit the generated files following existing conventions.`
  )
  if (both) {
    lines.push(
      `3. Create one validator, one service and a shared transformer${profile.generated.data ? ' from @generated/data' : ' using the existing application convention'}; use two thin controllers, one for web and one for api.`
    )
  } else
    lines.push(
      '3. Create a thin controller using the validated input and existing service conventions.'
    )
  if (profile.generated.controllers)
    lines.push('Use #generated/controllers for generated controller imports.')
  lines.push('4. Register the route following the inspected route conventions.')
  if (inertia) {
    lines.push(
      `5. Implement the page following the ${profile.inertia?.adapter ?? 'detected'} adapter convention.`
    )
    lines.push(
      `6. Inspect ${text.tool('get_transformers')} and expose serializable page data through a transformer${profile.generated.data ? ' from @generated/data' : ''}.`
    )
    lines.push(
      `7. Add an HTTP test with Inertia headers (X-Inertia: true); exercise the web response with ${text.tool('http_request')}.`
    )
  } else if (!api) {
    lines.push('5. Create the Edge template using the inspected view conventions.')
    lines.push(
      `6. Check the rendered view using ${text.tool('render_view')} and add an HTTP test using ${text.tool('http_request')}.`
    )
  }
  if (api || both)
    lines.push(
      `Add an HTTP test asserting JSON for the api route; exercise it with ${text.tool('http_request')}.`
    )
  lines.push(
    'HTTP checks perform real requests and may have side effects. Review mutation inputs before executing them.'
  )
  if (flowExists) lines.push('Follow the existing .flow/ project workflow.')
  return text.finish(lines)
}

export function addFeaturePrompt(
  describe: DescribeProject,
  appRoot: string
): PromptDefinition<typeof schema> {
  return {
    name: 'add_feature',
    description: 'Plan a feature using the detected project kind and selected surface.',
    argsSchema: schema,
    async get(args, context) {
      const workflow = await workflowContext(describe, context, appRoot)
      return buildAddFeature(args, workflow.profile, workflow.capabilities, workflow.flowExists)
    },
  }
}

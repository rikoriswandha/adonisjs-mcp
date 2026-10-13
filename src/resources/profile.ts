import type { DescribeProject } from '../tools/app/get_project_profile.js'
import type { ResourceDefinition } from '../types.js'

export function profileResource(describe: DescribeProject): ResourceDefinition {
  return {
    name: 'profile',
    uri: 'adonis://profile',
    title: 'Project profile',
    description:
      'Same data as the get_project_profile tool: project kind, surfaces, auth, active integrations and why each tool, resource and prompt is or is not served.',
    async read(_request, context) {
      return { data: await describe(context), evidence: ['runtime', 'generated'] }
    },
  }
}

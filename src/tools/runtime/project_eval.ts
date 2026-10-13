import vm from 'node:vm'
import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import type { ProjectEvaluator } from '../../eval/evaluator.js'

export function projectEvalTool(evaluator: ProjectEvaluator) {
  return defineTool({
    name: 'project_eval',
    title: 'Evaluate trusted application code',
    description:
      "Trusted development REPL in the running application: can modify data/files and access secrets/network. Supports return, top-level await and natural await import('#alias') through the application loader. Injects app, container, console, signal, db (if Lucid exists) and tenant. Timeout stops waiting, not execution; synchronous loops freeze the server. Requires --experimental-vm-modules (ExperimentalWarning).",
    inputSchema: z.object({
      code: z.string().min(1).max(100_000),
      timeout: z.int().positive().optional(),
      tenant: z.string().min(1).max(200).optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    available: () =>
      typeof vm.SourceTextModule === 'function'
        ? { available: true }
        : {
            available: false,
            code: 'CAPABILITY_UNSUPPORTED',
            reason:
              'Start the development process with NODE_OPTIONS=--experimental-vm-modules (for example in the dev script). Node emits an ExperimentalWarning; no default-loader fallback is used.',
          },
    async handler(input, context) {
      const config = context.config.tools.projectEval
      if (!config) throw new ToolError('CAPABILITY_UNSUPPORTED', 'project_eval is disabled')
      const timeout = input.timeout ?? config.timeout
      if (timeout > config.timeout)
        throw new ToolError(
          'INPUT_INVALID',
          `timeout exceeds tools.projectEval.timeout (${config.timeout}ms)`
        )
      if (input.tenant && !context.tenancy)
        throw new ToolError(
          'CAPABILITY_UNSUPPORTED',
          'tenant requires the application tenancy integration'
        )
      const tenant = input.tenant ? await context.tenancy!.resolve(input.tenant) : null
      const evaluate = () => evaluator.run(input.code, timeout, tenant, context)
      return tenant ? context.tenancy!.run(tenant, evaluate) : evaluate()
    },
  })
}

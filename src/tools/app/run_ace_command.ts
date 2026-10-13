import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { ToolError } from '../../errors.js'
import type { AceRunner } from '../../ace/runner.js'
import type { ResolvedMcpConfig } from '../../types.js'

export function runAceCommandTool(runner: AceRunner, config: ResolvedMcpConfig) {
  return defineTool({
    name: 'run_ace_command',
    title: 'Run Ace command',
    description:
      'Runs an Ace command in a new console process with closed stdin and bounded output. Generators, migrations and provider boot can mutate files and databases. POSIX process-group deadline/cancellation kills owned processes, not side effects. Restart can lose the result; inspect state instead of retrying blindly. Nonzero exits are returned as real exit codes.',
    inputSchema: z.object({
      command: z.string().min(1).max(200),
      args: z.array(z.string().max(4096)).max(100).optional(),
      flags: z
        .record(
          z.string(),
          z.union([
            z.string().max(4096),
            z.number().finite(),
            z.boolean(),
            z.array(z.string().max(4096)).max(100),
          ])
        )
        .optional(),
      timeout: z.number().int().positive().optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    available: () => runner.available(),
    handler: async (input, context) => {
      if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(input.command))
        throw new ToolError('INPUT_INVALID', 'Invalid Ace command name')
      const argv = [input.command]
      for (const value of input.args ?? []) {
        if (value.startsWith('-'))
          throw new ToolError(
            'INPUT_INVALID',
            'Positional args cannot start with -; use flags instead'
          )
        if (value.includes('\0'))
          throw new ToolError('INPUT_INVALID', 'Arguments cannot contain NUL')
        argv.push(value)
      }
      for (const [name, value] of Object.entries(input.flags ?? {})) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name))
          throw new ToolError('INPUT_INVALID', 'Invalid Ace flag name')
        if (typeof value === 'boolean') argv.push(value ? `--${name}` : `--no-${name}`)
        else
          for (const item of Array.isArray(value) ? value : [value]) {
            if (String(item).includes('\0'))
              throw new ToolError('INPUT_INVALID', 'Flags cannot contain NUL')
            argv.push(`--${name}=${item}`)
          }
      }
      if (Buffer.byteLength(JSON.stringify(argv)) > config.limits.maxResultBytes / 4)
        throw new ToolError('INPUT_INVALID', 'Ace argv exceeds the result budget')
      const timeout = input.timeout ?? config.tools.ace.timeout
      if (timeout > config.tools.ace.timeout)
        throw new ToolError('INPUT_INVALID', 'timeout exceeds the configured Ace maximum')
      return runner.run(argv, timeout, config.limits.maxResultBytes, context.signal)
    },
  })
}

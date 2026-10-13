import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { DEFAULT_LOG_TAIL, LOG_LEVELS } from '../../buffers/log_capture.js'
import type { CaptureSource } from './capture_source.js'
import type { AnyToolDefinition, LogLevelName } from '../../types.js'

const LEVEL_NAMES = Object.keys(LOG_LEVELS) as [LogLevelName, ...LogLevelName[]]

export function getLogsTool(source: CaptureSource): AnyToolDefinition {
  return defineTool({
    name: 'get_logs',
    title: 'Application logs',
    description:
      'Returns recent log records written by the running AdonisJS application (root and child loggers, including ctx.logger), redacted, oldest first. Filter by minimum level, a case-insensitive literal text, request id (ctx.logger request_id) or MCP call id; pass lastSeq back as afterSeq to read the following records oldest first (hasMore says another page is waiting). Read-only.',
    inputSchema: z.object({
      tail: z
        .int()
        .min(0)
        .max(source.config.tools.logs.bufferSize)
        .default(DEFAULT_LOG_TAIL)
        .describe('Number of most recent matching records'),
      level: z.enum(LEVEL_NAMES).optional().describe('Minimum level'),
      grep: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('Case-insensitive literal text searched in the message and fields'),
      requestId: z.string().min(1).max(200).optional(),
      callId: z.string().min(1).max(200).optional(),
      afterSeq: z.int().min(0).optional().describe('Only records with a greater seq'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    available: () => source.availability('log'),
    handler(input, context) {
      if (!context.logs) {
        throw source.unavailableError('log')
      }
      const page = context.logs.query(input)
      const limitations = [
        'Only loggers configured with hooks.streamWrite are captured; records below the configured level are never written.',
      ]
      if (page.stats.observed === 0) {
        limitations.push(
          'No log record has reached hooks.streamWrite yet; check that config/logger.ts passes hooks: { streamWrite } from start/mcp_dev_hooks.ts.'
        )
      }
      if (page.stats.evicted > 0) {
        limitations.push(
          `${page.stats.evicted} older record(s) were evicted by tools.logs.bufferSize/bufferBytes.`
        )
      }
      if (page.missed > 0) {
        limitations.push(`${page.missed} record(s) after afterSeq were evicted before this read.`)
      }
      return {
        data: {
          entries: page.entries,
          matched: page.matched,
          lastSeq: page.lastSeq,
          hasMore: page.hasMore,
          missed: page.missed,
          capture: page.stats,
        },
        evidence: ['runtime'],
        limitations,
      }
    },
  })
}

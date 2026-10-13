import { z } from 'zod'
import { defineTool } from '../../define_tool.js'
import { DEFAULT_EXCEPTION_LIMIT } from '../../buffers/exception_capture.js'
import type { CaptureSource } from './capture_source.js'
import type { AnyToolDefinition } from '../../types.js'

export function getLastExceptionsTool(source: CaptureSource): AnyToolDefinition {
  return defineTool({
    name: 'get_last_exceptions',
    title: 'Handled exceptions',
    description:
      "Returns the most recent exceptions handled by the running AdonisJS application's HTTP exception handler, newest first: name, code, redacted message, response status, sanitized stack, request method/path/route and request id, plus a fingerprint and how often it occurred. Use the request id with get_logs to read the request's logs. Read-only.",
    inputSchema: z.object({
      limit: z
        .int()
        .min(1)
        .max(source.config.tools.logs.exceptionBufferSize)
        .default(Math.min(DEFAULT_EXCEPTION_LIMIT, source.config.tools.logs.exceptionBufferSize)),
      requestId: z.string().min(1).max(200).optional(),
      distinct: z
        .boolean()
        .default(false)
        .describe('Only the most recent exception of each fingerprint'),
      afterSeq: z.int().min(0).optional().describe('Only exceptions with a greater seq'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    available: () => source.availability('exception'),
    handler(input, context) {
      if (!context.exceptions) {
        throw source.unavailableError('exception')
      }
      const page = context.exceptions.query(input)
      const limitations = [
        'Only exceptions passed to HttpExceptionHandler.handle() are captured: errors outside HTTP requests and errors whose report() throws before handle() are not.',
      ]
      if (page.stats.observed === 0) {
        limitations.push(
          'No exception has reached observeException() yet; if a request already failed, check that HttpExceptionHandler.handle() calls it.'
        )
      }
      if (page.stats.evicted > 0) {
        limitations.push(
          `${page.stats.evicted} older exception(s) were evicted by tools.logs.exceptionBufferSize/exceptionBufferBytes.`
        )
      }
      if (page.missed > 0) {
        limitations.push(
          `${page.missed} exception(s) after afterSeq were evicted before this read.`
        )
      }
      return {
        data: {
          exceptions: page.exceptions,
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

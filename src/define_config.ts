import { z } from 'zod'
import { InvalidMcpConfigError } from './errors.js'
import { toolNameIssue } from './define_tool.js'
import type { ExtraToolLoader, McpConfig, ResolvedMcpConfig } from './types.js'

export const DEFAULT_ENDPOINT_PATH = '/__adonis/mcp'

const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/
const PACKAGE_SEGMENT = /^[a-z0-9~-][a-z0-9._~-]*$/

/**
 * Exact endpoint path: Shield exemption and the request guard compare it
 * literally, so parameters, wildcards, encoded characters, dot segments and
 * trailing slashes are rejected.
 */
function isExactPath(value: string, allowRoot: boolean): boolean {
  if (value === '/') {
    return allowRoot
  }
  if (!value.startsWith('/') || value.endsWith('/')) {
    return false
  }
  return value
    .slice(1)
    .split('/')
    .every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/**
 * Normalized `Host` value (`hostname[:port]`), or `undefined` when the value
 * is not an exact host.
 */
export function normalizeHost(value: string): string | undefined {
  if (value.length === 0 || /[\s*/\\@?#]/.test(value)) {
    return undefined
  }
  try {
    return new URL(`http://${value}`).host
  } catch {
    return undefined
  }
}

/**
 * Normalized origin (`scheme://host[:port]`), or `undefined` when the value
 * is not an exact http(s) origin.
 */
export function normalizeOrigin(value: string): string | undefined {
  if (value.includes('*')) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const exact =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !/[?#]/.test(value) &&
    !/^[a-z]+:\/\/[^/]+\/./i.test(value)
  return exact ? url.origin : undefined
}

function isDocsPackagePattern(value: string): boolean {
  const [first, second, ...rest] = value.split('/')
  if (rest.length > 0) {
    return false
  }
  if (second === undefined) {
    return PACKAGE_SEGMENT.test(first)
  }
  return (
    first.startsWith('@') &&
    PACKAGE_SEGMENT.test(first.slice(1)) &&
    (second === '*' || PACKAGE_SEGMENT.test(second))
  )
}

const positiveInteger = z.int().positive()
const deadline = z.strictObject({ timeout: positiveInteger.optional() })

const surface = z.strictObject({
  prefix: z
    .string()
    .refine((value) => isExactPath(value, true), {
      message: "must be an absolute path prefix such as '/' or '/api'",
    })
    .optional(),
  guard: z.string().min(1, { message: 'must be a non-empty guard name' }).optional(),
})

const configSchema = z.strictObject({
  enabled: z.boolean().optional(),
  path: z
    .string()
    .refine((value) => isExactPath(value, false), {
      message:
        "must be an exact absolute path such as '/__adonis/mcp' (no trailing slash, route parameters, wildcards, query or encoded characters)",
    })
    .optional(),
  allowRemoteAccess: z.boolean().optional(),
  allowedHosts: z
    .array(
      z.string().refine((value) => normalizeHost(value) !== undefined, {
        message: "must be an exact host such as 'dev.test' or 'dev.test:3333' (no wildcards)",
      })
    )
    .optional(),
  allowedOrigins: z
    .array(
      z.string().refine((value) => normalizeOrigin(value) !== undefined, {
        message:
          "must be an exact http(s) origin such as 'http://dev.test:3333' (no path, wildcard or 'null')",
      })
    )
    .optional(),
  limits: z
    .strictObject({
      maxRequestBytes: positiveInteger.optional(),
      maxResultBytes: positiveInteger.optional(),
    })
    .optional(),
  profile: z
    .strictObject({
      surfaces: z
        .strictObject({
          web: surface.optional(),
          api: surface.optional(),
          default: z.enum(['web', 'api']).optional(),
        })
        .optional(),
    })
    .optional(),
  tools: z
    .strictObject({
      disabled: z
        .array(
          z.string().superRefine((value, context) => {
            const issue = toolNameIssue(value)
            if (issue) {
              context.addIssue({ code: 'custom', message: issue })
            }
          })
        )
        .optional(),
      projectEval: z
        .union([z.literal(false), z.strictObject({ timeout: positiveInteger.optional() })], {
          error: 'must be false or an object such as { timeout: 30000 }',
        })
        .optional(),
      sql: z
        .strictObject({
          readOnly: z.boolean().optional(),
          maxRows: positiveInteger.optional(),
          allowCrossTenant: z.boolean().optional(),
        })
        .optional(),
      logs: z
        .strictObject({
          bufferSize: positiveInteger.optional(),
          exceptionBufferSize: positiveInteger.optional(),
        })
        .optional(),
      docs: z
        .strictObject({
          include: z
            .array(
              z.string().refine(isDocsPackagePattern, {
                message: "must be a package name or a scope pattern such as '@adonisjs/*'",
              })
            )
            .optional(),
        })
        .optional(),
      http: deadline.optional(),
      ace: deadline.optional(),
    })
    .optional(),
  extraTools: z
    .array(
      z.custom<ExtraToolLoader>((value) => typeof value === 'function', {
        message: "must be a lazy loader such as () => import('#start/mcp_tools')",
      })
    )
    .optional(),
})

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((formatted, key) => {
    if (typeof key === 'number') {
      return `${formatted}[${key}]`
    }
    return formatted ? `${formatted}.${String(key)}` : String(key)
  }, '')
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const path = formatPath(issue.path)
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map(
        (key) => `${path ? `${path}.` : ''}${key}: unknown option (check for a typo)`
      )
    }
    return [`${path || '(root)'}: ${issue.message}`]
  })
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
    Object.freeze(value)
  }
  return value
}

/**
 * Applies defaults to `config/mcp.ts` and validates it. Arrays replace the
 * default instead of extending it, so `tools.docs.include` can narrow the
 * indexed scopes. Resolving an already resolved config returns an equal
 * config.
 */
export function resolveConfig(input: unknown): ResolvedMcpConfig {
  const parsed = configSchema.safeParse(input === undefined ? {} : input)
  if (!parsed.success) {
    throw new InvalidMcpConfigError(formatIssues(parsed.error))
  }

  const config = parsed.data
  const tools = config.tools ?? {}
  const surfaces = config.profile?.surfaces ?? {}

  return deepFreeze({
    enabled: config.enabled ?? true,
    path: config.path ?? DEFAULT_ENDPOINT_PATH,
    allowRemoteAccess: config.allowRemoteAccess ?? false,
    allowedHosts: unique((config.allowedHosts ?? []).map((host) => normalizeHost(host)!)),
    allowedOrigins: unique((config.allowedOrigins ?? []).map((origin) => normalizeOrigin(origin)!)),
    limits: {
      maxRequestBytes: config.limits?.maxRequestBytes ?? 1024 * 1024,
      maxResultBytes: config.limits?.maxResultBytes ?? 256 * 1024,
    },
    profile: {
      surfaces: {
        ...(surfaces.web ? { web: { ...surfaces.web } } : {}),
        ...(surfaces.api ? { api: { ...surfaces.api } } : {}),
        ...(surfaces.default ? { default: surfaces.default } : {}),
      },
    },
    tools: {
      disabled: unique(tools.disabled ?? []),
      projectEval:
        tools.projectEval === false ? false : { timeout: tools.projectEval?.timeout ?? 30_000 },
      sql: {
        readOnly: tools.sql?.readOnly ?? true,
        maxRows: tools.sql?.maxRows ?? 100,
        allowCrossTenant: tools.sql?.allowCrossTenant ?? false,
      },
      logs: {
        bufferSize: tools.logs?.bufferSize ?? 1000,
        exceptionBufferSize: tools.logs?.exceptionBufferSize ?? 100,
      },
      docs: {
        include: unique(tools.docs?.include ?? ['@adonisjs/*', '@rikology/*']),
      },
      http: { timeout: tools.http?.timeout ?? 30_000 },
      ace: { timeout: tools.ace?.timeout ?? 30_000 },
    },
    extraTools: [...(config.extraTools ?? [])],
  })
}

/**
 * Typed config helper for contexts where this package is installed at
 * runtime. `config/mcp.ts` must not use it: the application loads its
 * config in production, where this development dependency is absent. Use
 * `import type { McpConfig }` with `satisfies McpConfig` there instead.
 */
export function defineConfig(config: McpConfig): ResolvedMcpConfig {
  return resolveConfig(config)
}

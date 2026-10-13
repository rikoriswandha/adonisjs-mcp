/*
|--------------------------------------------------------------------------
| Response summary
|--------------------------------------------------------------------------
|
| Turns a (possibly truncated) response body into data an agent can read:
| JSON as parsed, an Inertia page object (component, props, version), an
| HTML outline (title, headings, forms, links, text excerpt) or a text
| excerpt. Validation errors are lifted out of the shapes AdonisJS
| produces: `{ errors: [...] }` from VineJS on JSON requests, and the
| `errors` prop Inertia shares from the session flash after a redirect.
|
| The HTML outline is a lightweight extraction, not a DOM parse.
|
*/

import type { IncomingHttpHeaders } from 'node:http'

const MAX_TEXT_CHARS = 32 * 1024
const MAX_HTML_TEXT_CHARS = 4000
const MAX_HTML_ITEMS = 30

export interface InertiaPage {
  component: string
  url: string | null
  version: string | null
  props: Record<string, unknown>
  [key: string]: unknown
}

export interface HtmlOutline {
  title: string | null
  headings: Array<{ level: number; text: string }>
  forms: Array<{ action: string | null; method: string; fields: string[] }>
  links: Array<{ href: string; text: string }>
  text: string
}

export type BodySummary =
  | { kind: 'empty'; bytes: 0 }
  | { kind: 'json'; bytes: number; truncated: boolean; json: unknown }
  | { kind: 'inertia'; bytes: number; truncated: boolean; inertia: InertiaPage }
  | { kind: 'html'; bytes: number; truncated: boolean; html: HtmlOutline }
  | { kind: 'text'; bytes: number; truncated: boolean; contentType: string | null; text: string }
  | { kind: 'binary'; bytes: number; truncated: boolean; contentType: string | null }

export interface ValidationReport {
  source: 'response-body.errors' | 'inertia-props.errors'
  errors: unknown
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function decodeEntities(text: string): string {
  return text
    .replaceAll(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([\da-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
}

function plainText(html: string): string {
  return decodeEntities(html.replaceAll(/<[^>]*>/g, ' '))
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!match) {
    return null
  }
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '')
}

export function outlineHtml(html: string): HtmlOutline {
  const withoutCode = html
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(withoutCode)
  const headings = [...withoutCode.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
    .slice(0, MAX_HTML_ITEMS)
    .map((match) => ({ level: Number(match[1]), text: plainText(match[2]) }))
  const forms = [...withoutCode.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)]
    .slice(0, MAX_HTML_ITEMS)
    .map((match) => ({
      action: attribute(match[1], 'action'),
      method: (attribute(match[1], 'method') ?? 'get').toUpperCase(),
      fields: [...match[2].matchAll(/<(?:input|select|textarea|button)\b([^>]*)>/gi)]
        .map((field) => attribute(field[1], 'name'))
        .filter((name): name is string => name !== null && name !== ''),
    }))
  const links = [...withoutCode.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
    .map((match) => ({ href: attribute(match[1], 'href'), text: plainText(match[2]) }))
    .filter((link): link is { href: string; text: string } => link.href !== null)
    .slice(0, MAX_HTML_ITEMS)
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(withoutCode)?.[1] ?? withoutCode
  return {
    title: title ? plainText(title[1]) : null,
    headings,
    forms,
    links,
    text: plainText(body).slice(0, MAX_HTML_TEXT_CHARS),
  }
}

function isInertiaPage(value: unknown): value is InertiaPage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { component?: unknown }).component === 'string' &&
    typeof (value as { props?: unknown }).props === 'object'
  )
}

export function summarizeBody(response: {
  headers: IncomingHttpHeaders
  body: Buffer
  truncated: boolean
}): BodySummary {
  const bytes = response.body.byteLength
  const { truncated } = response
  if (bytes === 0) {
    return { kind: 'empty', bytes: 0 }
  }
  const contentType = header(response.headers, 'content-type')?.toLowerCase() ?? null
  const mime = contentType?.split(';')[0].trim() ?? ''
  const text = () => response.body.toString('utf8')

  if (mime === 'application/json' || mime.endsWith('+json')) {
    if (!truncated) {
      try {
        const json: unknown = JSON.parse(text())
        if (header(response.headers, 'x-inertia') === 'true' && isInertiaPage(json)) {
          return { kind: 'inertia', bytes, truncated, inertia: json }
        }
        return { kind: 'json', bytes, truncated, json }
      } catch {
        // Not valid JSON despite the content type; reported as text.
      }
    }
    return { kind: 'text', bytes, truncated, contentType, text: text().slice(0, MAX_TEXT_CHARS) }
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return { kind: 'html', bytes, truncated, html: outlineHtml(text()) }
  }
  if (
    mime.startsWith('text/') ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === ''
  ) {
    const decoded = text()
    if (mime !== '' || !decoded.includes('\uFFFD')) {
      return { kind: 'text', bytes, truncated, contentType, text: decoded.slice(0, MAX_TEXT_CHARS) }
    }
  }
  return { kind: 'binary', bytes, truncated, contentType }
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0
}

/**
 * Validation errors reported by the response, if any. JSON bodies only
 * count on 422, the status VineJS failures produce; a 401 body also has an
 * `errors` array.
 */
export function validationErrors(body: BodySummary, status: number): ValidationReport | null {
  if (body.kind === 'inertia') {
    const errors = body.inertia.props.errors
    return isNonEmpty(errors) ? { source: 'inertia-props.errors', errors } : null
  }
  if (status === 422 && body.kind === 'json' && typeof body.json === 'object' && body.json) {
    const errors = (body.json as { errors?: unknown }).errors
    return isNonEmpty(errors) ? { source: 'response-body.errors', errors } : null
  }
  return null
}

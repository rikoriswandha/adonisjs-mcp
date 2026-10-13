import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('./', import.meta.url))
const base = process.argv[2] || '/tmp/adonisjs-mcp-m0'
const files = [
  ['s-f-api/sf-observations.json', 'sf-round1-api.json'],
  ['s-f-react/sf-observations.json', 'sf-round1-react.json'],
  ['s-f-api/sf-round2-observations.json', 'sf-round2-api.json'],
  ['s-f-react/sf-round2-observations.json', 'sf-round2-react.json'],
  ['s-f3-api/sf-round3-observations.json', 'sf-round3-api.json'],
]
const sensitiveKeys = /^(authorization|cookie|set-cookie|app_key|password|secret|tokenValue|bearer)$/i
const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'frames' ? '[REDACTED: development frames may include source/context]' : sensitiveKeys.test(key) ? '[REDACTED]' : redact(item)]))
  if (typeof value === 'string') return value.replace(/\boat_[A-Za-z0-9_\-]+/g, '[REDACTED ACCESS TOKEN]').replace(/Bearer\s+[A-Za-z0-9._\-]{32,}/gi, 'Bearer [REDACTED]')
  return value
}
const manifest = []
for (const [source, destination] of files) {
  const raw = JSON.parse(await readFile(`${base}/${source}`, 'utf8'))
  const safe = JSON.stringify(redact(raw), null, 2) + '\n'
  const matches = [...safe.matchAll(/\boat_[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9._\-]{32,}|["']APP_KEY["']\s*:\s*["'](?!\[REDACTED)/gi)]
  if (matches.length) throw new Error('secret scan rejected ' + destination)
  await writeFile(root + destination, safe)
  manifest.push({ source, destination, secretPatternMatchesAfterRedaction: matches.length })
}
await writeFile(root + 'sf-evidence-manifest.json', JSON.stringify({ redaction: 'Credential-named fields/access token patterns; development error frames removed explicitly. Runtime rounds 2/3 additionally compared actual issued credentials against logs/results/headers with zero matches.', files: manifest }, null, 2) + '\n')
console.log(JSON.stringify(manifest))

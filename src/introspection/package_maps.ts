/* Static package mappings are resolved without importing application code. */
export function conditionalTarget(value: unknown, conditions: readonly string[]): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = conditionalTarget(entry, conditions)
      if (target !== null) return target
    }
  } else if (value && typeof value === 'object') {
    const mapping = value as Record<string, unknown>
    for (const condition of conditions) {
      if (Object.hasOwn(mapping, condition)) {
        if (mapping[condition] === null) return null
        const target = conditionalTarget(mapping[condition], conditions)
        if (target !== null) return target
      }
    }
  }
  return null
}

export function resolveMapping(
  map: Record<string, unknown>,
  key: string,
  conditions = ['node', 'import', 'default']
): string | null {
  if (Object.hasOwn(map, key)) return conditionalTarget(map[key], conditions)
  const patterns = Object.keys(map)
    .filter((pattern) => pattern.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)
  for (const pattern of patterns) {
    const star = pattern.indexOf('*')
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < pattern.length - 1)
      continue
    const target = conditionalTarget(map[pattern], conditions)
    return target === null
      ? null
      : target.replaceAll('*', key.slice(prefix.length, key.length - suffix.length))
  }
  return null
}

export function resolveExports(
  exports: unknown,
  subpath: string,
  conditions = ['node', 'import', 'default']
): string | null {
  if (
    exports &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith('.'))
  ) {
    return resolveMapping(exports as Record<string, unknown>, subpath, conditions)
  }
  return subpath === '.' ? conditionalTarget(exports, conditions) : null
}

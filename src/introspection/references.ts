/*
|--------------------------------------------------------------------------
| Handler references
|--------------------------------------------------------------------------
|
| Describes controller, middleware and listener references the way the
| framework stores them, without importing or constructing anything:
|
| - lazy imports (`() => import('#controllers/users_controller')`) report
|   the import specifier found in the function source (source evidence;
|   the specifier is not resolved to a file);
| - classes report their name;
| - strings (`'#controllers/users_controller.index'`) are split like the
|   framework splits them.
|
| Anonymous functions report `name: null` instead of an invented name.
|
*/

import { parseBindingReference } from '@adonisjs/core/container'

export interface ReferenceReport {
  reference: 'lazy' | 'class' | 'string' | 'function' | 'unknown'

  /**
   * Import specifier of a lazy import or string reference.
   */
  module: string | null

  /**
   * Class name of a class reference, or function name.
   */
  name: string | null
  method: string | null
}

export function isClass(value: unknown): value is abstract new (...args: never[]) => unknown {
  if (typeof value !== 'function') {
    return false
  }
  try {
    return /^class[\s{]/.test(Function.prototype.toString.call(value))
  } catch {
    return false
  }
}

const IMPORT_CALL = /\bimport\s*\(/

type BindingTuple = Exclude<Parameters<typeof parseBindingReference>[0], string>

/**
 * Describes `reference` (and `method`, when the framework stores it next
 * to the reference) without evaluating it.
 */
export async function describeReference(
  reference: unknown,
  method?: unknown
): Promise<ReferenceReport> {
  const methodName = typeof method === 'string' && method.length > 0 ? method : null
  if (typeof reference === 'string') {
    const parsed = await parseBindingReference(reference)
    return {
      reference: 'string',
      module: parsed.moduleNameOrPath,
      name: null,
      method: parsed.method,
    }
  }
  if (isClass(reference)) {
    return {
      reference: 'class',
      module: null,
      name: reference.name || null,
      method: methodName,
    }
  }
  if (typeof reference === 'function') {
    let source = ''
    try {
      source = Function.prototype.toString.call(reference)
    } catch {
      source = ''
    }
    if (IMPORT_CALL.test(source)) {
      try {
        const parsed = await parseBindingReference([
          reference,
          methodName ?? undefined,
        ] as unknown as BindingTuple)
        if (parsed.moduleNameOrPath !== reference.name) {
          return {
            reference: 'lazy',
            module: parsed.moduleNameOrPath,
            name: null,
            method: methodName,
          }
        }
      } catch {
        // Unparsable source: reported as an unnamed function below.
      }
    }
    return { reference: 'function', module: null, name: reference.name || null, method: methodName }
  }
  return { reference: 'unknown', module: null, name: null, method: methodName }
}

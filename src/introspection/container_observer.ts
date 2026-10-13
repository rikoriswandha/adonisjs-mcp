/*
|--------------------------------------------------------------------------
| Container registration observer (opt-in)
|--------------------------------------------------------------------------
|
| Fold 11 keeps bindings in ECMAScript private fields and has no inventory
| API (spike S-D). When the application's dev gateway calls
| `observeContainer()` (at config load, before any provider registers),
| the public registration methods of the container instance are wrapped
| to record each successful registration: key, kind, alias target, and
| the provider whose synchronous `register()` made it, taken from the
| public `providerRegister` tracing channel. Factories are never called.
|
| Limitations, reported by the tool: registrations made before
| observation started, through references to the original methods, or
| outside a provider's synchronous `register()` (constructor, boot, start)
| have an unknown or missing origin.
|
*/

import { tracingChannels } from '@adonisjs/core/app'

export type RegistrationKind = 'bind' | 'singleton' | 'bindValue' | 'alias' | 'swap'

const METHODS: readonly RegistrationKind[] = ['bind', 'singleton', 'bindValue', 'alias', 'swap']

export interface ObservedRegistration {
  seq: number
  key: unknown
  kind: RegistrationKind
  aliasOf?: unknown

  /**
   * Class name of the provider whose `register()` was running, or `null`.
   */
  origin: string | null
}

type ContainerMethods = Record<RegistrationKind, (...args: unknown[]) => unknown>

interface ProviderRegisterMessage {
  provider?: unknown
}

function providerName(message: unknown): string | null {
  const provider = (message as ProviderRegisterMessage | undefined)?.provider
  if (typeof provider === 'object' && provider !== null) {
    const name = provider.constructor?.name
    return typeof name === 'string' && name.length > 0 ? name : null
  }
  return null
}

export class ContainerObserver {
  readonly maxRecords: number
  readonly #records: ObservedRegistration[] = []
  readonly #providers: Array<string | null> = []
  #restore: Array<() => void> = []
  #dropped = 0
  #seq = 0
  #active = false
  readonly #trace = {
    start: (message: unknown) => {
      this.#providers.push(providerName(message))
    },
    end: () => {
      this.#providers.pop()
    },
    asyncStart: () => {},
    asyncEnd: () => {},
    error: () => {},
  }

  constructor(maxRecords = 10_000) {
    this.maxRecords = maxRecords
  }

  get active(): boolean {
    return this.#active
  }

  /**
   * Registrations not recorded because `maxRecords` was reached.
   */
  get dropped(): number {
    return this.#dropped
  }

  get records(): readonly ObservedRegistration[] {
    return this.#records
  }

  #record(kind: RegistrationKind, args: unknown[]) {
    if (this.#records.length >= this.maxRecords) {
      this.#dropped++
      return
    }
    const origin = this.#providers.at(-1) ?? null
    this.#records.push({
      seq: ++this.#seq,
      key: args[0],
      kind,
      ...(kind === 'alias' ? { aliasOf: args[1] } : {}),
      origin,
    })
  }

  /**
   * Wraps the registration methods of `container`. Idempotent.
   */
  start(container: object) {
    if (this.#active) {
      return
    }
    const target = container as ContainerMethods
    const observer = this
    for (const kind of METHODS) {
      const original = target[kind]
      if (typeof original !== 'function') {
        continue
      }
      const own = Object.hasOwn(target, kind)
      target[kind] = function (this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args)
        observer.#record(kind, args)
        return result
      }
      this.#restore.push(() => {
        if (own) {
          target[kind] = original
        } else {
          delete (target as Partial<ContainerMethods>)[kind]
        }
      })
    }
    tracingChannels.providerRegister.subscribe(this.#trace)
    this.#active = true
  }

  /**
   * Restores the original methods and detaches from the tracing channel.
   * Recorded registrations are kept. Idempotent.
   */
  stop() {
    if (!this.#active) {
      return
    }
    for (const restore of this.#restore) {
      restore()
    }
    this.#restore = []
    tracingChannels.providerRegister.unsubscribe(this.#trace)
    this.#providers.length = 0
    this.#active = false
  }
}

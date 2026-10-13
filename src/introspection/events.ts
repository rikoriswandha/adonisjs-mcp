/*
|--------------------------------------------------------------------------
| Events
|--------------------------------------------------------------------------
|
| Reads the emitter's persistent listener map (`emitter.eventsListeners`,
| public in @adonisjs/events 10). Nothing is emitted and no listener is
| imported or constructed. Listeners registered with `once()` or `onAny()`
| are not in that map (spike S-D); the transport listener counts expose
| the difference without identifying them.
|
*/

import type { ApplicationService } from '@adonisjs/core/types'
import { describeReference, type ReferenceReport } from './references.js'

export interface ListenerReport extends ReferenceReport {
  type: 'function' | 'class' | 'lazy' | 'string' | 'unknown'
}

export interface EventReport {
  event: string
  eventType: 'string' | 'class' | 'symbol'
  listeners: ListenerReport[]

  /**
   * Listeners the transport holds for this event, including `once()` and
   * `onAny()` listeners that are not in the persistent map.
   */
  transportListenerCount: number | null
}

interface EmitterLike {
  eventsListeners: Map<unknown, Map<unknown, unknown>>
  listenerCount(event?: unknown): number
}

function displayEvent(event: unknown): Pick<EventReport, 'event' | 'eventType'> {
  if (typeof event === 'function') {
    return { event: `class:${event.name || '(anonymous)'}`, eventType: 'class' }
  }
  if (typeof event === 'symbol') {
    return { event: event.toString(), eventType: 'symbol' }
  }
  return { event: String(event), eventType: 'string' }
}

async function describeListener(listener: unknown): Promise<ListenerReport> {
  if (Array.isArray(listener)) {
    const described = await describeReference(listener[0], listener[1] ?? 'handle')
    return {
      ...described,
      type:
        described.reference === 'class'
          ? 'class'
          : described.reference === 'lazy'
            ? 'lazy'
            : 'unknown',
    }
  }
  if (typeof listener === 'string') {
    return { ...(await describeReference(listener)), type: 'string' }
  }
  if (typeof listener === 'function') {
    return {
      reference: 'function',
      module: null,
      name: listener.name || null,
      method: null,
      type: 'function',
    }
  }
  return { reference: 'unknown', module: null, name: null, method: null, type: 'unknown' }
}

export class EventIntrospection {
  constructor(readonly app: ApplicationService) {}

  async events(pattern?: string) {
    const emitter = (await this.app.container.make('emitter')) as unknown as EmitterLike
    const needle = pattern?.toLowerCase()
    const events: EventReport[] = []
    let mappedListeners = 0
    for (const [event, listeners] of emitter.eventsListeners) {
      if (listeners.size === 0) {
        continue
      }
      const display = displayEvent(event)
      if (needle !== undefined && !display.event.toLowerCase().includes(needle)) {
        continue
      }
      const reports: ListenerReport[] = []
      for (const listener of listeners.keys()) {
        reports.push(await describeListener(listener))
      }
      mappedListeners += reports.length
      let transportListenerCount: number | null = null
      try {
        transportListenerCount = emitter.listenerCount(event)
      } catch {
        transportListenerCount = null
      }
      events.push({ ...display, listeners: reports, transportListenerCount })
    }

    let totalTransportListeners: number | null = null
    try {
      totalTransportListeners = emitter.listenerCount()
    } catch {
      totalTransportListeners = null
    }
    return { events, mappedListeners, totalTransportListeners }
  }
}

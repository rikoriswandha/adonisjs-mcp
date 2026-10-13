/*
|--------------------------------------------------------------------------
| Call scope
|--------------------------------------------------------------------------
|
| Async context of one MCP tool call. Logs and exceptions captured while a
| call's handler runs (including application code it awaits) carry its
| `callId`; anything outside that async context, such as concurrent HTTP
| traffic, carries none.
|
*/

import { AsyncLocalStorage } from 'node:async_hooks'

export interface CallScope {
  readonly callId: string
}

export const callScope = new AsyncLocalStorage<CallScope>()

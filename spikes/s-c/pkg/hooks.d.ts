import type { HttpContext } from '@adonisjs/core/http'
export declare const custom: { reports: number; handles: number }
export declare function streamWrite(line: string): string
export declare function observeException(error: unknown, ctx: HttpContext): void
export declare function attach(): void
export declare function detach(): void
export declare function snapshot(): { logs: object[]; exceptions: object[]; bytes: number; dropped: number; logSubscribers: number; exceptionSubscribers: number; custom: typeof custom }

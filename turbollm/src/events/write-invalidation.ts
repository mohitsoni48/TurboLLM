// Invalidations for writes to state that lives in the config store (settings, engines, model
// settings) or in a route's own job (bench, build). One middleware is the chokepoint for those,
// so no route module has to remember to announce its own writes. Stores that change on their own
// (the chat DB, the download manager, engine Managers, the scanner) announce at the store instead
// (observe-store.ts, downloads.ts, manager.ts, scanner.ts), which also covers background changes.
import type { MiddlewareHandler } from 'hono'
import { eventBus, type EventBus } from './bus'

const WRITE_FAMILIES: ReadonlyArray<{ prefix: string; keys: readonly string[] }> = [
  { prefix: '/api/v1/settings', keys: ['settings', 'status'] },
  { prefix: '/api/v1/engines', keys: ['engines', 'status'] },
  { prefix: '/api/v1/engine', keys: ['engines', 'status'] },
  { prefix: '/api/v1/build', keys: ['engines', 'status'] },
  { prefix: '/api/v1/models', keys: ['models', 'status'] },
  { prefix: '/api/v1/modeldirs', keys: ['models', 'status'] },
  { prefix: '/api/v1/bench', keys: ['status'] },
]

/** The invalidation keys a successful write to `path` stands for. */
export function keysForWrite(path: string): string[] {
  const family = WRITE_FAMILIES.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`))
  return family ? [...family.keys] : []
}

export function invalidateOnWrite(bus: EventBus = eventBus): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (isRead(c.req.method) || c.res.status >= 400) return
    for (const key of keysForWrite(c.req.path)) bus.emit(key)
  }
}

function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

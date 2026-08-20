// turbollm/src/ext/mount.ts
//
// Mounts /api/ext/v1 only when explicitly enabled (spec 27 §4, §10). A disabled feature answers
// 404 rather than 403 — there is no reason to confirm the surface exists to someone who cannot
// use it. Registering the routes conditionally (rather than mounting them always and gating
// inside) is what makes this true: an unmounted route falls through to Hono's own 404, not a
// gate that could itself be probed.
import type { Hono } from 'hono'
import type { Deps } from '../deps.js'
import type { PublicRunManager } from './run-manager.js'
import { registerExtChatRoutes } from './routes.chats.js'
import { registerExtRunRoutes, type RunDeps } from './routes.runs.js'

export function mountExtApi(app: Hono, d: Deps, runs: PublicRunManager, rd: RunDeps): void {
  if (!d.store.snapshot().api?.ext?.enabled) return
  registerExtChatRoutes(app, d)
  registerExtRunRoutes(app, d, runs, rd)
}

// turbollm/src/ext/mount.ts
//
// Mounts /api/ext/v1 only when explicitly enabled (spec 27 §4, §10). A disabled feature answers
// 404 rather than 403 — there is no reason to confirm the surface exists to someone who cannot
// use it. Registering the routes conditionally (rather than mounting them always and gating
// inside) is what makes this true: an unmounted route falls through to Hono's own 404, not a
// gate that could itself be probed.
//
// This is also the ONE place that constructs the shared IdempotencyStore/TenantLimiter for a
// mounted app — a single instance handed to BOTH route registrars, so a chat-creation replay
// and a run-creation replay for the same tenant see the same state, and the per-tenant request
// budget is genuinely shared across the whole surface rather than split per route file. Returns
// them (or null when disabled) so the caller (server.ts) can drive the idempotency store's own
// prune tick alongside the run-registry reaper it already runs.
import type { Hono } from 'hono'
import type { Deps } from '../deps.js'
import type { PublicRunManager } from './run-manager.js'
import { registerExtChatRoutes } from './routes.chats.js'
import { registerExtRunRoutes, type RunDeps } from './routes.runs.js'
import { IdempotencyStore } from './idempotency.js'
import { TenantLimiter, DEFAULT_MAX_IN_FLIGHT_PER_TENANT, DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT } from './limits.js'

export interface ExtDeps {
  idempotency: IdempotencyStore
  limiter: TenantLimiter
}

export function mountExtApi(app: Hono, d: Deps, runs: PublicRunManager, rd: RunDeps): ExtDeps | null {
  const cfg = d.store.snapshot().api?.ext
  if (!cfg?.enabled) return null
  const ext: ExtDeps = {
    idempotency: new IdempotencyStore(),
    limiter: new TenantLimiter({
      maxInFlight: cfg.maxInFlightPerTenant ?? DEFAULT_MAX_IN_FLIGHT_PER_TENANT,
      ratePerMinute: cfg.requestsPerMinutePerTenant ?? DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT,
    }),
  }
  registerExtChatRoutes(app, d, ext)
  registerExtRunRoutes(app, d, runs, rd, ext)
  return ext
}

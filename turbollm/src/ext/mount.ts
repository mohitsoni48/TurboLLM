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
import { AuditLog } from './audit.js'
import { buildOpenApiDocument } from './openapi.js'

const BASE = '/api/ext/v1'

export interface ExtDeps {
  idempotency: IdempotencyStore
  limiter: TenantLimiter
  audit: AuditLog
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
    // Shared with BOTH route registrars (same reasoning as idempotency/limiter above): one
    // AuditLog per mounted app, over the SAME ConversationStore connection, so a chat mutation
    // and a run mutation for the same tenant land in the same table via the same instance.
    audit: new AuditLog(d.db),
  }
  // `runs` is threaded into the chat routes too (not just the run routes) so a chat/message
  // mutation can refuse with 409 run_active while a generation is in flight for that chat
  // (spec §7.2) — see routes.chats.ts's `hasActiveRun` for why this needs the SAME manager
  // instance the generate route starts runs on, not a second one.
  registerExtChatRoutes(app, d, ext, runs)
  registerExtRunRoutes(app, d, runs, rd, ext)
  // The document a client reads to discover the schema in the first place (Phase 4 Task 4).
  // Registered after the chat/run routes purely for source-order clarity — Hono matches this
  // against the SAME `${BASE}/*` request-id/auth/rate-limit middleware already registered above
  // regardless of where this specific handler sits, so it is a live member of the mounted
  // surface exactly like every other route here (still subject to that shared middleware
  // stack), just with no `requireScope` call — see EXT_ROUTES' own entry for why.
  app.get(`${BASE}/openapi.json`, (c) => c.json(buildOpenApiDocument(d.version)))
  return ext
}

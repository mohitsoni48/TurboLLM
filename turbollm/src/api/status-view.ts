import type { Deps } from '../deps'

/** The model-stat subset of `GET /api/v1/status` — engine state, the loaded model, and the
 *  live t/s / TTFT / prefill-% / context-use numbers the engine card renders.
 *
 *  Extracted so the Turbo Link façade (`GET /api/link/v1/status`, ADR-376 spec §5.4) can
 *  RE-EXPORT the host's existing status shape instead of growing a second one. There is
 *  deliberately no remote-stats model and no translation layer: the peer renders a linked
 *  host's numbers with the exact components it already uses for its own, and the only way
 *  to keep that true over time is for both routes to be fed by this one builder.
 *
 *  What is NOT here is as deliberate as what is: `engine.launchCommand` is absent. It is
 *  the engine's full argv — an absolute host binary path plus an absolute model path — and
 *  it is the single most likely thing to leak across a link. The local route adds it on top
 *  of this object (see routes.ts), so the façade cannot include it even by accident: it
 *  would have to go out of its way to construct the field rather than merely forget to
 *  strip it. Anything added here in future is visible to every linked peer by default —
 *  add host paths, credentials, or key material to the local route, never to this. */
export interface ModelStatusView {
  engine: {
    id: string
    name: string
    kind: string
    state: string
    port: number | null
    pid: number | null
    error?: unknown
    /** How many generations the engine can serve at once. Omitted — not defaulted to 1 —
     *  when the engine advertises no slot count, exactly as the local route does. */
    parallelSlots?: number
  }
  model: {
    key: string
    name: string
    quant: string | null
    ctx: number | null
    vision: boolean
    loadElapsedMs?: number
  } | null
  /** Live running-session stats. Null unless the engine is actually running — the numbers
   *  are meaningless otherwise, and a stale reading is worse than an absent one. */
  engineStats: unknown
  /** Per-request progress (prefill % / live token count) for the engine card. */
  liveGeneration: unknown
}

/** Build the shared model-stat payload. Reads only `d.manager` + `d.registry`, so both the
 *  local route and the link façade can call it with the same Deps and get the same object. */
export function buildModelStatus(d: Deps): ModelStatusView {
  const ms = d.manager.status()
  const active = d.registry.active()
  const engine: ModelStatusView['engine'] = {
    id: active?.id ?? '',
    name: active?.name ?? '',
    kind: active?.kind ?? '',
    state: ms.state,
    port: ms.port,
    pid: ms.pid,
  }
  if (ms.err) engine.error = ms.err
  const parallelSlots = d.manager.parallelSlots()
  if (parallelSlots !== null) engine.parallelSlots = parallelSlots
  return {
    engine,
    model: ms.model
      ? {
          key: ms.model.key,
          name: ms.model.name,
          quant: ms.model.quant,
          ctx: ms.model.ctx,
          vision: ms.model.vision,
          loadElapsedMs: ms.loadElapsedMs,
        }
      : null,
    engineStats: ms.state === 'running' ? d.manager.sessionStats() : null,
    liveGeneration: ms.state === 'running' ? d.manager.liveGeneration() : null,
  }
}

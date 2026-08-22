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
 *  ## The rule for what may live here
 *
 *  **No host filesystem detail crosses the façade, and no field carrying FREE-FORM engine
 *  output may live in this builder.** Not "strip `launchCommand`" — that is one instance of
 *  the rule, and stating it narrowly is exactly how the second instance gets missed. Every
 *  field below is a bounded scalar, an enum, or a piece of model metadata the peer already
 *  learns from `GET /api/link/v1/models`. Anything whose value is produced by, or echoed
 *  from, the engine process is out.
 *
 *  Two fields of the local `/api/v1/status` engine block are therefore absent, and the local
 *  route adds them back on top of this object (see routes.ts) — so the façade cannot include
 *  them even by accident: it would have to go out of its way to CONSTRUCT the field rather
 *  than merely forget to strip it.
 *
 *   - `launchCommand` — the engine's full argv: an absolute host binary path plus an
 *     absolute model path.
 *   - `error` (`ErrInfo`) — carries `logTail: string[]`, the engine's raw stderr. llama.cpp
 *     echoes the model path, the mmproj path and its own binary path in its error output, so
 *     this leaks absolute host paths as a matter of routine, not as an edge case. The peer
 *     does not need it: `engine.state === 'error'` already tells it the host's engine is
 *     down, which is the whole of what a remote renderer can act on. A sanitised or
 *     classified form could be re-added later if a peer UI ever needs the reason — but the
 *     simplest thing that cannot leak is the right default.
 *
 *  Anything added here in future is visible to every linked peer by default. Add host paths,
 *  raw process output, credentials, or key material to the local route, never to this. */
export interface ModelStatusView {
  engine: {
    id: string
    name: string
    kind: string
    state: string
    port: number | null
    pid: number | null
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
  // NO `engine.error` here — see the interface doc. `ErrInfo.logTail` is the engine's raw
  // stderr and routinely contains absolute host paths. `state` already carries 'error'.
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

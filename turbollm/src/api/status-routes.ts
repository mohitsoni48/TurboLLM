// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { GATE_VERSION } from '../comfyui/gate-template'
import { createGateVersionReader } from '../comfyui/gate-version'
import type { Deps } from '../deps'
import type { EngineRuntime, Status, TunnelStatus } from '../contract/status'
import { enabledFeatures } from '../features'
import { isTerminalBackendAvailable } from '../terminal/terminal-routes'
import { classifyLoadFailure } from '../telemetry/classify'
import { buildModelStatus } from './status-view'
import { failedLoadView } from './failed-load-view'
import { jevStatus } from './jev-status'
import { layaStatus } from './laya-status'
import { servingStatus } from './serving-status'
import { textClassificationStatus } from './text-classification-status'
import type { EngineJobs } from './engine-work'

/** GET /api/v1/status: the local status payload every surface polls. */
export function registerStatusRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
  // The gate node's installed version, cached per file (status is polled every couple of seconds).
  const gateVersion = createGateVersionReader()
  // ---- meta ----
  app.get('/api/v1/status', (c) => {
    // The engine/model/engineStats/liveGeneration block comes from the SHARED builder
    // (status-view.ts) — the same one `GET /api/link/v1/status` re-exports, so a linked
    // peer renders a host's numbers with the components it already uses for its own
    // (ADR-376 §5.4). `parallelSlots` and the omit-vs-default rules live there now; only the
    // strictly LOCAL-ONLY additions are made here.
    //
    // Both additions below exist here rather than in the shared builder for one reason: no
    // host filesystem detail may cross the Turbo Link façade, so anything that can carry a
    // path — an argv, or free-form engine output — is added on the local side. The façade
    // would then have to CONSTRUCT the field to leak it, not merely forget to strip it.
    //
    //   - `launchCommand`: the engine's full argv — absolute binary path + absolute model path.
    //   - `error` (ErrInfo): carries `logTail`, the engine's raw stderr. llama.cpp echoes the
    //     model path, the mmproj path and its own binary path there as a matter of routine.
    //
    // `ms` is read here rather than threaded out of the builder because `Manager.status()` is
    // a synchronous snapshot getter and this whole handler body is synchronous — the two reads
    // cannot interleave, so they cannot disagree.
    const core = buildModelStatus(d)
    const ms = d.manager.status()
    // How many generations this engine can serve at once (llama.cpp's `--parallel N`). Consumed
    // by `turbollm launch` to cap an agent CLI's own background-agent fan-out at what the engine
    // can actually run — see cli-launch.ts. Omitted, not defaulted to 1, when the engine
    // advertises no slot count: "unknown" and "exactly one" are different answers, and a client
    // must not read the former as the latter.
    const launchCommand = d.manager.launchCommand()
    const engine: EngineRuntime = { ...core.engine }
    // `failReason` (ADR-338 Decision 4): the SAME `classifyLoadFailure` the telemetry
    // path already runs on this exact object, now also handed to the UI so a failed load
    // can offer a one-click recovery instead of dead-ending on "Copy log". Classified
    // here rather than in the web bundle on purpose — one classifier, server-side, so the
    // remedy a user is offered can never disagree with the reason we recorded.
    //
    // Unlike `logTail` this is a closed enum and carries no path or free text, so it is
    // safe by construction; it rides with `error` only because that is the thing it
    // describes.
    //
    // `engineName`, `modelName` and `expectedToLoad` (failed-load-view.ts): which engine could
    // not load which model, and whether it was expected to. The banner named neither, and its
    // remedies suited a model the engine runs even for one it cannot.
    if (ms.err) engine.error = { ...ms.err, failReason: classifyLoadFailure(ms.err), ...failedLoadView(d) }
    if (launchCommand) engine.launchCommand = launchCommand
    const payload = {
      version: d.version,
      engine,
      model: core.model,
      // Last model the user loaded (config-tracked) — lets `turbollm launch` auto-load the
      // true last-used model instead of guessing the first library entry (F-034).
      lastLoaded: d.store.read().lastLoaded,
      // Turbo Link (ADR-382): the linked-machine model this install is pointed at, or '' for
      // local. On /status because every surface reads it here — the web app hydrates its picker
      // from it, and `turbollm launch <cli>` (which has no access to browser state) uses it
      // instead of auto-loading a local model the user did not ask for.
      selectedRemoteModel: d.store.read().selectedRemoteModel ?? '',
      // The alive Jev model, if any (ADR-434 (i)(1)): Workspace becomes the Jev Playground while
      // one is loaded in any slot. Local-only, like `launchCommand` — not in the shared builder.
      jev: jevStatus(d),
      // The alive Laya model, if any (ADR-443): the System One playground runs against it. It never changes the
      // Workspace — a Laya model runs beside the chat model.
      laya: layaStatus(d),
      // How many models are loaded beside the primary: alive pool slots (running, starting or stopping), an embedding
      // model's and a Laya load's included, and a model still loading into a pool slot (ModelRouter.poolModelCount).
      // Local-only, like `jev` and `laya`. The Android app keeps its service while any model is loaded; it read only
      // the primary engine, jev and laya, so with notifications off it stopped (and its process could be killed) under
      // an embedding model loaded, or still loading, beside an ejected chat model.
      poolModels: d.modelRouter.poolModelCount(),
      // Which server features are on (serving-status.ts): `lan` (the listener is bound beyond loopback), `remote`
      // (remote access is up or coming up) and `linkPeers` (the Turbo Link peers this daemon hosts). Local-only, like
      // `poolModels`. The Android app quits the daemon when it is closed with nothing running, and counts these as
      // running: models and work alone left out a daemon serving LAN clients, a remote-access URL or linked machines.
      serving: servingStatus(d),
      // The alive text classification model, Jev or Laya (ADR-444): the one field the UI reads for the feature.
      // A Jev one wins when both are alive, as `jev ?? laya` did.
      textClassification: textClassificationStatus(d),
      engineStats: core.engineStats,
      liveGeneration: core.liveGeneration,
      // Auto-tune runner state (spec 09 §1): real progress while a sweep runs, then
      // a lingering done/error snapshot the detail dialog reads to show the result.
      bench: d.bench.status(),
      downloads: { active: d.downloads.activeCount() },
      // `cancellable`: whether POST /engines/backends/cancel can stop this run — only the
      // downloads that register `provisionAbort` (declared with the backend routes below). The
      // first-run seed, auto-updates and the uv/pip runtime installs (MLX*, vLLM, SGLang, Laya)
      // take no signal, so the banner hides its Cancel for them instead of offering a no-op.
      engineProvision: { ...d.provision.get(), cancellable: jobs.provisionAbort !== null },
      // Background agent tasks (reviewer + skill distill): running + recently-finished,
      // so the UI can show them inline in the conversation + a side panel on click.
      agentTasks: d.agentTasks?.list() ?? [],
      // In-app compile-from-source status (ADR-100): live phase + log tail while a build runs.
      engineBuild: d.build.get(),
      // Whether this install can spawn a PTY at all (node-pty is an optional native dependency,
      // so a healthy install may legitimately not have it). The Code agent picker reads this to
      // decide whether a terminal-only agent is even offerable on this machine.
      terminalAvailable: isTerminalBackendAvailable(),
      // ComfyUI GPU coordination: lets the UI explain a paused/unloaded engine.
      // Also expose the installed gate node version so the UI can prompt an upgrade.
      comfyui: (() => {
        const snap = d.comfy?.snapshot() ?? null
        if (!snap) return null
        const installedVersion = gateVersion(d.store.read().comfyui.gatePath)
        return { ...snap, installedVersion, currentVersion: GATE_VERSION }
      })(),
      telemetryLevel: d.store.read().telemetry.level,
      uptimeSec: Math.floor((Date.now() - d.startedAt) / 1000),
      // Cloud Launch tunnel (ADR-045/152): null until --tunnel is active.
      tunnel: tunnelStatusSnapshot(d),
      // Local feature flags (TURBOLLM_FEATURES env var) — deliberately undocumented
      // in any user-facing README; see features.ts.
      features: enabledFeatures(),
    } satisfies Status
    return c.json(payload)
  })
}

/** Back-compat mapping for /api/v1/status's `tunnel` field (spec 30 §5): the field's wire
 *  shape — { active, url, error } — is unchanged even though TunnelManager was replaced by
 *  RemoteAccessManager underneath it. External consumers and the deploy/ recipes read this
 *  field by its existing shape; do not rename or restructure it here. */
function tunnelStatusSnapshot(d: Deps): TunnelStatus | null {
  if (!d.remote) return null
  const s = d.remote.state()
  const active = s.kind === 'connected' || s.kind === 'starting' || s.kind === 'reconnecting'
  const error = s.kind === 'failed' ? s.reason : s.kind === 'reconnecting' ? s.lastError : null
  return { active, url: d.remote.url(), error }
}

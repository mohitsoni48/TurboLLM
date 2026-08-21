import type { ConfigStore } from './config/config'
import type { Manager } from './engines/manager'
import type { ComfyGuard } from './engines/comfy-guard'
import type { Registry } from './engines/registry'
import type { ProvisionState } from './engines/provision-state'
import type { BuildState } from './engines/build-state'
import type { UpdateChecker } from './engines/update'
import type { AppUpdateChecker } from './app-update'
import type { Scanner } from './models/scanner'
import type { HashStore } from './models/hashes'
import type { ConversationStore } from './chat/db'
import type { HfClient } from './hf/hf'
import type { DownloadManager } from './downloads/downloads'
import type { BenchRunner } from './bench/bench'
import type { ModelRouter } from './gateway/model-router'
import type { ToolRegistry } from './tools/tool-registry'
import type { GenerationGate } from './agents/gate'
import type { TunnelManager } from './tunnel/manager'
import type { AgentTaskState } from './agents/task-state'
import type { Emitter } from './telemetry/emit'
import type { CodeRunManager } from './code/code-run-manager'
import type { LinkManager } from './link/link-manager'
import type { RemoteCatalog } from './link/remote-catalog'

export interface Deps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  scanner: Scanner
  hashes: HashStore
  db: ConversationStore
  provision: ProvisionState
  /** Live status of an in-app compile-from-source run (ADR-100). One build at a time;
   *  guarded alongside `provision` so a build and a download never run concurrently. */
  build: BuildState
  /** Honest engine update checker (ADR-085): per-engine installed/latest/hasUpdate with
   *  an in-memory cache. Optional — absent in tests that don't exercise the update routes. */
  updates?: UpdateChecker
  /** App self-update checker (F-006, ADR-031): is a newer TurboLLM published on npm than
   *  the running version? Informational only (npm does the upgrade). Optional — absent in
   *  tests that don't exercise the app-update route. */
  appUpdates?: AppUpdateChecker
  hf: HfClient
  downloads: DownloadManager
  bench: BenchRunner
  /** Gateway model router (v0.6.0): auto model-swap and keep-N pool. */
  modelRouter: ModelRouter
  /** Tool registry (v0.7.0): built-in tools + MCP host. Optional — absent in tests. */
  tools?: ToolRegistry
  /** ComfyUI GPU coordinator (spec: unload/block while ComfyUI renders, reload after).
   *  Optional: only wired in the real `serve()` entrypoint (cli.ts); absent under tests. */
  comfy?: ComfyGuard
  /** Priority-queue mutex serialising engine calls (multiple concurrent generation
   *  requests). Optional — absent under tests; only wired in cli.ts. */
  gate?: GenerationGate
  /** Cloud Launch tunnel (ADR-045/152): owns the cloudflared child when `--tunnel` is
   *  active. Optional: only wired in the real `serve()` entrypoint (cli.ts); absent
   *  under tests. Its presence/active() state is what forces auth enforcement on
   *  tunneled traffic regardless of lanBind (see auth.ts lanAuth). */
  tunnel?: TunnelManager
  /** Background agent-task registry (reviewer + skill distill). Surfaced via /status
   *  so the UI can show running bg tasks inline. Optional — absent under tests. */
  agentTasks?: AgentTaskState
  /** Journey-event emitter (ADR-299). Optional — absent under tests, where the
   *  middleware simply skips rather than every test needing to stub telemetry. */
  telemetry?: Emitter
  version: string
  startedAt: number
  /** Re-exec the daemon so config changes (port, LAN bind) take effect (spec 08 §2).
   *  Gracefully stops the engine, releases the listen socket, then spawns a detached
   *  replacement and exits. Optional: only wired in the real `serve()` entrypoint
   *  (cli.ts); absent under tests, where the restart route returns 501. */
  requestRestart?: () => void
  /** Re-point the HTTP listener at the host/port the config now wants, WITHOUT a full
   *  restart — keeps the engine + model loaded. Used for LAN/port changes. Wired only
   *  in the real `serve()` entrypoint (cli.ts); absent under tests. */
  rebind?: () => void
  /** The daemon-owned Code-session run registry (code-run-manager.ts), shared between the live
   *  Code UI routes and Routine execution (this phase, Task 7) so a routine's in-app-pi run is
   *  the SAME kind of observable session a live one is. Optional: only wired in the real
   *  serve() entrypoint (cli.ts); absent under tests that don't exercise Code/Routines. */
  codeRuns?: CodeRunManager
  /** The live RoutineScheduler instance (Phase 1, turbollm/src/routines/scheduler.ts), exposed
   *  so routine-routes.ts's POST .../run-now can trigger an immediate fire through the exact
   *  same overlap guard a normal scheduled tick uses. Optional: only wired in the real serve()
   *  entrypoint. */
  routineScheduler?: import('./routines/scheduler').RoutineScheduler
  /** Turbo Link peer-side poll loop (ADR-376). Optional — absent under tests; only
   *  wired in the real serve() entrypoint, same convention as tunnel/gate/comfy. */
  links?: LinkManager
  /** The peer's cache of what each ONLINE linked host currently has (ADR-376). The SAME
   *  instance `ModelRouter` routes on, so `GET /v1/models` can only ever advertise ids the
   *  router can actually resolve — a second, independently-refreshed catalog would let the
   *  two disagree, which is precisely how a model gets listed and then 503s.
   *  Optional — absent under tests and in any embedding without Turbo Link, in which case
   *  `/v1/models` is exactly the pre-Turbo-Link local list. */
  remoteCatalog?: RemoteCatalog
}

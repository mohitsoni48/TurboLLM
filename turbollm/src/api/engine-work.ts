// The engine-work slot: what engine jobs are under way, shared by every engine route module (ADR-100).
import type { Engine } from '../config/config'
import type { Deps } from '../deps'
import { ReleaseInstallJob } from '../engines/release-install'

/** The engine jobs under way that no Deps service tracks. Module-level (one per daemon), because
 *  engineWorkBusy (every engine-mutating route's guard) reads it from every route module. */
export const engineWork = {
  /** Whether a /engines/zip upload request is currently extracting/probing — module-level
   *  because engineWorkBusy (every engine-mutating route's guard) reads it from any closure.
   *  Request-scoped: set synchronously before the body is parsed, cleared in finally, so it
   *  is always false between requests. */
  zipUploadInFlight: false,
  /** Whether a manual engine update has been accepted but may not have called provision.start
   *  yet (the update looks up GitHub first). Reserves the engine-work slot across that gap.
   *  POST /engines/backends/:id/update takes it for its own lookup too (see there). */
  engineUpdateInFlight: false,
  /** Whether DELETE /engines/backends/:id is under way. It stops the backend's engine and pool slots before it
   *  unregisters them and deletes their folders, and a model stop waits seconds for the process to exit: an update of
   *  the backend, the auto-update scheduler or a download started in that wait registered the deleted backend again once
   *  it finished. Holds the engine-work slot across the wait, as zipUploadInFlight does for an upload. */
  backendDeleteInFlight: false,
  /** Whether POST /engines/backends/:id/enable (or the Download of a Disabled backend, its Enable too) is registering a
   *  backend's build. Registering probes (runs) the binary, for seconds: a Delete of the backend in that probe found
   *  nothing registered to remove and deleted the build, and the Enable then registered and activated an engine whose
   *  binary was gone. Holds the engine-work slot across the probe, as backendDeleteInFlight does across a Delete's engine
   *  stop. */
  backendEnableInFlight: false,
  /** Whether POST /engines (the Enable of a Disabled source-built, release or custom card, or the Add of an engine) is
   *  registering a binary. Its probe takes seconds too, and the route held nothing across it: a Delete of that Disabled
   *  build (DELETE /engines/build, or a release card's forget and discard) in the probe deleted the folder, and the
   *  Enable then registered an engine whose binary was gone; a rebuild of the folder started in it had the unfinished
   *  marker it had just written removed by the Enable's markBuildComplete. Holds the engine-work slot across the probe,
   *  as backendEnableInFlight does. */
  engineEnableInFlight: false,
}

/** The abort handles and the release-install slot behind the engine routes, created once per registerApi and passed
 *  to each engine route module (status reads provisionAbort for its `cancellable`). */
export type EngineJobs = {
  // Tracks the in-flight backend download so it can be cancelled.
  provisionAbort: AbortController | null
  // The single slot behind the GitHub-release install flow (ADR-453), and its own abort handle
  // (provisionAbort is shared with every other engine download).
  releaseJob: ReleaseInstallJob
  releaseAbort: AbortController | null
  // Tracks the in-flight 1-click build so it can be cancelled (ADR-100).
  buildAbort: AbortController | null
}

export function createEngineJobs(): EngineJobs {
  return { provisionAbort: null, releaseJob: new ReleaseInstallJob(), releaseAbort: null, buildAbort: null }
}

// engineWorkBusy's answers for the three flags above, also the backend Enable's own refusals.
export const BACKEND_DELETE_BUSY = 'An engine is being deleted — wait for it to finish.'
export const BACKEND_ENABLE_BUSY = 'An engine is being enabled — wait for it to finish.'
export const ENGINE_ENABLE_BUSY = 'An engine is being added or enabled — wait for it to finish.'

/** Why a backend's build on disk may not be registered and activated now (its Enable, or its Download when it is
 *  Disabled), or null. Not while a backend Delete runs: one stopping this backend's engine removed the engine activated
 *  here, or deleted the build registered here, right after. Nor while this backend downloads or updates: an update
 *  (it runs on a Disabled backend too) that reached its swap during the probe of the old build found no engine of it
 *  to hand over, so it deleted that build, and the engine registered here ran a binary that was gone. Anything else
 *  still lets it through, so an Enable during a source build goes on (the Engines screen offers it then). */
export function backendEnableBusy(d: Deps, backendId: string): string | null {
  if (engineWork.backendDeleteInFlight) return BACKEND_DELETE_BUSY
  if (engineWork.backendEnableInFlight) return BACKEND_ENABLE_BUSY
  const provision = d.provision.get()
  if (provision.active && provision.backend === backendId) return 'This backend is being downloaded or updated — wait for it to finish.'
  return null
}

/** A download (engine provision), a 1-click build, or a .zip upload writes under
 * `<dataDir>/engines` and ends by mutating the registry + flipping the active engine. They
 * must not run at once (ADR-100). Returns a user-facing message when either is in flight,
 * else null.
 *
 * `engineChange`: for the routes that only add, disable or delete an engine (POST /engines, DELETE /engines/:id,
 * /engines/backends/:id and /engines/build). A CUDA Toolkit download or a build guide prerequisite install does not
 * count there: it writes into no engine folder and registers nothing, yet it refused every Enable, Disable, Add and
 * Delete for as long as it ran, with "A build is in progress". A source build still counts, as it may be writing
 * into the very folder being deleted. */
export function engineWorkBusy(d: Deps, opts: { engineChange?: boolean } = {}): string | null {
  if (engineWork.zipUploadInFlight) return 'An engine zip upload is in progress — wait for it to finish.'
  if (engineWork.engineUpdateInFlight) return 'An engine update is in progress — wait for it to finish.'
  if (engineWork.backendDeleteInFlight) return BACKEND_DELETE_BUSY
  if (engineWork.backendEnableInFlight) return BACKEND_ENABLE_BUSY
  if (engineWork.engineEnableInFlight) return ENGINE_ENABLE_BUSY
  if (d.provision.get().active) return 'An engine download is in progress — wait for it to finish.'
  if (d.build.isActive() && (!opts.engineChange || d.build.isEngineBuildActive())) return 'A build is in progress — wait for it to finish.'
  return null
}

/** Why replacing the files of the engine `isTarget` picks out must wait for auto-tune, or null. A run stops its model
 *  between two probes, which the update routes' engineBusy and the scheduler's engineIsIdle read as idle, so an update
 *  of the engine being tuned got through mid-run: it stopped the probe it caught, and swapped the build under the rest
 *  of the run (later probes ran the new build with the old one's tune, or a binary it had deleted; a llama.cpp
 *  backend's new id stopped the run as "another engine was selected"). Refused while the run lasts, as the activate
 *  route refuses a switch, by every route that replaces an engine's files in place: its update, a newer release tag
 *  installed into its folder, a same-named zip re-upload and a rebuild. Only that engine: a run launches nothing else,
 *  so another engine's update, and every other download, build and upload (engineWorkBusy's callers), still goes ahead
 *  during a tune. */
export function autoTuneUpdateBlock(d: Pick<Deps, 'bench'>, isTarget: (tuned: Engine) => boolean, doing = 'updating this engine'): string | null {
  const tuned = d.bench?.tuningEngine()
  return tuned && isTarget(tuned) ? `Stop auto-tune before ${doing}.` : null
}

export function engineBusy(d: Deps): boolean {
  const s = d.manager.status().state
  return s === 'running' || s === 'starting' || s === 'stopping'
}

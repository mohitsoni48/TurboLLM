// What GET /api/v1/status says about a failed load beside its error: the engine it ran on and the model it tried, by
// name, and whether that engine was expected to load that model. The load-failure banner said only "Model load failed:
// <the engine's message>", and its remedies suit a model the engine runs (re-download it, try another engine) even
// for one it cannot run at all: a model "Show models for every engine" lists loads only on the selected engine and
// fails there with the engine's own error. Local-only, like the error it rides with: never in the shared
// `buildModelStatus`, so the Turbo Link façade's status is unchanged.
import type { Deps } from '../deps'
import { modelIncompatibility } from '../engines/compat'

export interface FailedLoadView {
  /** Name of the engine the failed load ran on ('' when no load is recorded). */
  engineName: string
  /** Name of the model it tried to load ('' when no load is recorded). */
  modelName: string
  /** Key of that model ('' when no load is recorded): what the banner's Retry loads. The config's lastLoaded is no
   *  stand-in, as it is recorded only once a load succeeds and still names the previous model after a failed one. */
  modelKey: string
  /** False when that engine is not expected to load that model (modelIncompatibility: the Models screen's
   *  compatibleWithActiveEngine for it); true when it is, or when the model has left the library. */
  expectedToLoad: boolean
}

/** Read off Manager.restartOpts(), the last load attempted, also one that failed (status() names no model then). */
export function failedLoadView(d: Pick<Deps, 'manager' | 'scanner'>): FailedLoadView {
  const opts = d.manager.restartOpts()
  if (!opts) return { engineName: '', modelName: '', modelKey: '', expectedToLoad: true }
  const entry = d.scanner.get(opts.model.key)
  return {
    engineName: opts.engine.name,
    modelName: opts.model.name,
    modelKey: opts.model.key,
    expectedToLoad: !entry || modelIncompatibility(opts.engine, entry) === null,
  }
}

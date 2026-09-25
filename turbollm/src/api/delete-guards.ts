// Whether a model or an engine is too alive to delete. The primary manager is not the whole pool: a Laya model
// always runs in its own slot (ADR-443), and an embedding or auto-swapped model may too, so both guards also ask
// the router.
import type { Engine } from '../config/config'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { layaStatus } from './laya-status'

/** True while any slot is running or starting `entry` (matched by key or by path). */
export function modelDeleteBlocked(d: Pick<Deps, 'manager' | 'modelRouter'>, entry: Pick<ModelEntry, 'key' | 'path'>): boolean {
  const ms = d.manager.status()
  const primaryKey = ms.state === 'running' || ms.state === 'starting' ? ms.model?.key : undefined
  if (primaryKey === entry.key || primaryKey === entry.path) return true
  const pool = d.modelRouter.loadedModelKeys()
  return pool.has(entry.key) || pool.has(entry.path)
}

/** True while `engine` is serving: the active engine while the primary is alive, and the Laya engine — which is
 *  never active — while a Laya model is alive. */
export function engineDeleteBlocked(d: Pick<Deps, 'manager' | 'modelRouter' | 'registry' | 'scanner'>, engine: Engine): boolean {
  if (engine.kind === 'laya') return layaStatus(d) !== null
  if (engine.id !== d.registry.list().activeEngineId) return false
  const s = d.manager.status().state
  return s === 'running' || s === 'starting' || s === 'stopping'
}

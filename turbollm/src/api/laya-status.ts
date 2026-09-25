// Which Laya model is alive (ADR-443). A local-only `/api/v1/status` field, like `jev`: the System One playground
// runs against it. Unlike `jev` it never changes the Workspace — a Laya model runs beside the chat model.
import type { Deps } from '../deps'
import type { AliveSlot } from '../gateway/model-router'
import type { ModelEntry } from '../models/scanner'

export interface LayaStatus {
  key: string
  name: string
  checkpoints: string[]
  state: 'starting' | 'running' | 'stopping'
}

interface AliveLayaModel {
  slot: AliveSlot
  entry: ModelEntry
  checkpoints: string[]
}

/** The most recently used alive Laya model, or null. A Laya model is never in the primary (ADR-443 (4)). */
export function layaStatus(d: Pick<Deps, 'modelRouter' | 'scanner'>): LayaStatus | null {
  const newest = aliveLayaModels(d).reduce<AliveLayaModel | undefined>(
    (latest, m) => (!latest || m.slot.lastUsedMs > latest.slot.lastUsedMs ? m : latest),
    undefined,
  )
  return newest
    ? { key: newest.entry.key, name: newest.entry.name, checkpoints: newest.checkpoints, state: newest.slot.state }
    : null
}

function aliveLayaModels(d: Pick<Deps, 'modelRouter' | 'scanner'>): AliveLayaModel[] {
  return d.modelRouter.aliveSlots().flatMap((slot) => {
    const entry = d.scanner.get(slot.modelKey)
    return entry?.laya ? [{ slot, entry, checkpoints: entry.laya.checkpoints }] : []
  })
}

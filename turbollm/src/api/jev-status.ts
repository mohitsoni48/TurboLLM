// Which Jev model is alive, in which slot and in what state (ADR-434 (i)(1): the Workspace mode
// follows the loaded model). A local-only `/api/v1/status` field — never part of the shared
// `buildModelStatus`, so the Turbo Link façade's status is unchanged (ADR-376 §5.4).
import type { Deps } from '../deps'
import type { AliveSlot } from '../gateway/model-router'
import type { JevInfo, JevLabel } from '../models/jev'
import type { ModelEntry } from '../models/scanner'

export interface JevStatus {
  key: string
  name: string
  labels: JevLabel[]
  state: 'starting' | 'running' | 'stopping'
  slot: 'primary' | 'pool'
}

interface AliveJevModel {
  slot: AliveSlot
  entry: ModelEntry
  jev: JevInfo
}

/** The alive Jev model: the primary's if it is one, else the most-recently-used pool slot's.
 *  'stopping' counts as alive so a Jev→Jev switch (stop A, start B) doesn't flicker Workspace
 *  back to Chat for one poll. */
export function jevStatus(d: Deps): JevStatus | null {
  const alive = aliveJevModels(d)
  const chosen = alive.find((m) => m.slot.primary) ?? mostRecentlyUsed(alive)
  return chosen ? toJevStatus(chosen) : null
}

function aliveJevModels(d: Deps): AliveJevModel[] {
  return d.modelRouter.aliveSlots().flatMap((slot) => {
    const entry = d.scanner.get(slot.modelKey)
    return entry?.jev ? [{ slot, entry, jev: entry.jev }] : []
  })
}

function mostRecentlyUsed(models: AliveJevModel[]): AliveJevModel | undefined {
  return models.reduce<AliveJevModel | undefined>(
    (newest, m) => (!newest || m.slot.lastUsedMs > newest.slot.lastUsedMs ? m : newest),
    undefined,
  )
}

function toJevStatus({ slot, entry, jev }: AliveJevModel): JevStatus {
  return { key: entry.key, name: entry.name, labels: jev.labels, state: slot.state, slot: slot.primary ? 'primary' : 'pool' }
}

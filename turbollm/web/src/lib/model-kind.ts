import type { ModelEntry } from './types'

/** A model a chat/code/routine turn can run on. Jev models label text; they never chat. */
export function isChatModel(m: Pick<ModelEntry, 'jev' | 'laya'>): boolean {
  return !isSystemOneModel(m)
}

/** A model that answers through POST /v1/systemone — a Jev NLI classifier (on vLLM) or a Laya
 *  decision model (on its own 'laya' engine). Used by the Jev Playground's model picker
 *  (SwitchModelMenu) to group "not a chat model" rows together regardless of which of the two
 *  it is. */
export function isSystemOneModel(m: Pick<ModelEntry, 'jev' | 'laya'>): boolean {
  return !!m.jev || !!m.laya
}

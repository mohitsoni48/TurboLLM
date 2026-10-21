import type { ModelEntry, TextClassificationRuntime } from './types'

const RUNTIME_LABELS: Record<TextClassificationRuntime, string> = { vllm: 'vLLM', laya: 'Laya engine' }

/** A model a chat/code/routine turn can run on. A text classification model labels or scores text; it never
 *  chats. */
export function isChatModel(m: Pick<ModelEntry, 'jev' | 'laya'>): boolean {
  return !isSystemOneModel(m)
}

/** Whether the Models screen or a model picker lists `m` for loading: when the selected engine can run it, or when the
 *  user turned on Settings → Models, "Show models for every engine" (`showAllEngineModels`). A model listed that way
 *  still loads only on the selected engine: the daemon starts it there, and if the engine cannot load it the load fails
 *  with the engine's own error. Nothing switches engines or suggests another. */
export function listedForLoading(m: Pick<ModelEntry, 'compatibleWithActiveEngine'>, showAllEngineModels: boolean): boolean {
  return showAllEngineModels || m.compatibleWithActiveEngine
}

/** How many chat models a model picker leaves out, and why: what its empty state tells the user to change. */
export type PickerHidden = {
  /** Left out because the selected engine cannot run them and Settings' "Show models for every engine" is off. */
  byEngine: number
}

/** The chat models a model picker (Chat's, the Code composer's and the terminal toolbar's ModelLoadMenu) lists for
 *  loading, and what it leaves out. The pickers filtered the list themselves and handed ModelLoadMenu only what was
 *  left, so a library holding only models the selected engine cannot run (a .litertlm bundle under llama.cpp, GGUFs
 *  under LiteRT-LM) opened a picker reading "No models found" over nothing, with no word that they were hidden or how
 *  to show them. Counted once per key, as the picker lists one row per key, and only over the copies it can list. */
export function chatModelsForPicker(models: ModelEntry[], showAllEngineModels: boolean): { listed: ModelEntry[]; hidden: PickerHidden } {
  const chat = models.filter(isChatModel)
  const listed = chat.filter((m) => listedForLoading(m, showAllEngineModels))
  const listedKeys = new Set(listed.map((m) => m.key))
  // Only what a picker could list at all: ModelLoadMenu drops an unfinished download and a file that failed to parse,
  // whatever the engine, so counting those would name a setting that lists nothing.
  const pickable = chat.filter((m) => !m.incomplete && !m.parseError)
  const byEngine = new Set(pickable.filter((m) => !listedKeys.has(m.key)).map((m) => m.key)).size
  return { listed, hidden: { byEngine } }
}

/** Whether `m`'s Load is offered: always when the selected engine runs it, and once the user shows every model (that
 *  setting, or the Models screen's "Show all") also when it does not, since such a load starts on the selected engine
 *  and fails there with its error rather than being refused up front. A Laya model never runs on the selected engine
 *  (its own Laya engine does), so with no Laya engine installed its Load stays off. */
export function loadOffered(m: Pick<ModelEntry, 'compatibleWithActiveEngine' | 'laya'>, showAllEngineModels: boolean): boolean {
  return m.compatibleWithActiveEngine !== false || (showAllEngineModels && !m.laya)
}

/** A model that answers through POST /v1/systemone — a Jev NLI classifier (on vLLM) or a Laya
 *  decision model (on its own 'laya' engine). Used by the text classification playground's model
 *  picker (SwitchModelMenu) to group "not a chat model" rows together regardless of which of the
 *  two it is. */
export function isSystemOneModel(m: Pick<ModelEntry, 'jev' | 'laya'>): boolean {
  return textClassificationRuntime(m) !== null
}

/** Which runtime serves a text classification model (ADR-444), or null for a chat model. Structural, so a load
 *  target's nullable descriptors fit as well as a catalog entry's. */
export function textClassificationRuntime(m: { jev?: object | null; laya?: object | null }): TextClassificationRuntime | null {
  if (m.jev) return 'vllm'
  if (m.laya) return 'laya'
  return null
}

/** The quiet label that says which runtime serves a text classification model, beside the one name both share. */
export function textClassificationRuntimeLabel(runtime: TextClassificationRuntime): string {
  return RUNTIME_LABELS[runtime]
}

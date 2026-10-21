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

/** Hidden by the user (Models → Library, the model's "Hide"; the daemon's per-model flag) and not loaded. Such a model
 *  leaves the Library list, until its "Show hidden models" switch is on, and every model picker but the draft-model
 *  select in Load settings (a small draft is what one hides from the chat pickers): what the user chose not to see. A
 *  loaded model stays where it is listed, so the model that is running never vanishes from the list that ejects it.
 *  Separate from the selected engine's automatic filter (listedForLoading), which it comes before. */
export function hiddenByUser(m: Pick<ModelEntry, 'hidden' | 'loaded'>): boolean {
  return m.hidden === true && !m.loaded
}

/** How many of `models` the user hid (hiddenByUser), once per key: the flag is the key's, so the same file in two model
 *  folders is one hidden model. Each caller passes what it lists: the Library every model, so its "Show hidden models
 *  (N)" counts a hidden unfinished download, unreadable file or text classification model too; the routine form its
 *  chat models; the text classification playground its classifiers. The chat pickers count once per key as well
 *  (chatModelsForPicker), but only chat models that are neither an unfinished download nor a file that failed to
 *  parse, so their "N hidden by you" can be less than the Library's N. */
export function hiddenByUserCount(models: ModelEntry[]): number {
  return new Set(models.filter(hiddenByUser).map((m) => m.key)).size
}

/** How many chat models a model picker leaves out, and why: what its empty state tells the user to change. */
export type PickerHidden = {
  /** Left out because the selected engine cannot run them and Settings' "Show models for every engine" is off. */
  byEngine: number
  /** Left out because the user hid them (hiddenByUser), whatever the engine. Absent counts as none. */
  byUser?: number
}

/** The chat models a model picker (Chat's, the Code composer's and the terminal toolbar's ModelLoadMenu) lists for
 *  loading, and what it leaves out. The pickers filtered the list themselves and handed ModelLoadMenu only what was
 *  left, so a library holding only models the selected engine cannot run (a .litertlm bundle under llama.cpp, GGUFs
 *  under LiteRT-LM) opened a picker reading "No models found" over nothing, with no word that they were hidden or how
 *  to show them. A model the user hid is counted as theirs (byUser) whatever the engine, never also as the engine's.
 *  Unhiding it lists it only if the engine filter then lets it through: one the selected engine cannot run moves to
 *  byEngine, still left out until "Show models for every engine" is on. Counted once per key, as the picker lists one
 *  row per key, and only over the copies it can list. */
export function chatModelsForPicker(models: ModelEntry[], showAllEngineModels: boolean): { listed: ModelEntry[]; hidden: PickerHidden } {
  const chat = models.filter(isChatModel)
  const shown = chat.filter((m) => !hiddenByUser(m))
  const listed = shown.filter((m) => listedForLoading(m, showAllEngineModels))
  const shownKeys = new Set(shown.map((m) => m.key))
  const listedKeys = new Set(listed.map((m) => m.key))
  // Only what a picker could list at all: ModelLoadMenu drops an unfinished download and a file that failed to parse,
  // whatever the engine or the user's hiding, so counting those would point at a switch that lists nothing.
  const pickable = (m: ModelEntry) => !m.incomplete && !m.parseError
  const byUser = new Set(chat.filter((m) => pickable(m) && !shownKeys.has(m.key)).map((m) => m.key)).size
  const byEngine = new Set(shown.filter((m) => pickable(m) && !listedKeys.has(m.key)).map((m) => m.key)).size
  return { listed, hidden: { byEngine, byUser } }
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

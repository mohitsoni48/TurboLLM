import type { ModelEntry } from './types'

/** A model a chat/code/routine turn can run on. Jev models label text; they never chat. */
export function isChatModel(m: Pick<ModelEntry, 'jev'>): boolean {
  return !m.jev
}

// Load state that has to outlive the component that started the load (ADR-434 (i)(3)).
//
// ModelDetailDialog closes itself the moment it fires a load, so a confirmation owned by the
// dialog would unmount before the user could answer it — and so would any pending state kept
// in the dialog's own mutation. Every field here is app-level, and the store is deliberately
// NOT persisted: a reload must not resurrect a dialog about work that finished, a toast for a
// load this browser never fired, or a spinner for a load that is long over.
import { create } from 'zustand'
import type { ActiveWork, LoadProfile } from '../lib/types'

/** The model a load site asked for — its own `jev` field, not a flag the caller has to
 *  remember, is what decides whether the activity probe runs. Structural, so a
 *  `ModelEntry` and an `HfCheckpoint`'s narrower `jev` both fit. */
export type LoadTarget = { key: string; name: string; jev?: { architecture: string } | null }

/** What a load site asks for beyond the model itself. Carried through the confirmation, so a
 *  confirmed load behaves exactly like one that was never interrupted (ADR-434 (i)(3)). */
export type LoadOptions = {
  overrides?: Partial<LoadProfile>
  onError?: (e: unknown) => void
  onSuccess?: () => void
}

interface JevLoadState {
  /** `work: null` means the activity probe could not be read — which is NOT "nothing is
   *  running", so it still asks, with an honest "couldn't check" line. */
  confirm: { target: LoadTarget; work: ActiveWork | null; opts: LoadOptions } | null
  /** The key of a Jev load THIS browser fired — the one thing that entitles it to a toast. */
  pendingJevKey: string | null
  /** The model being loaded right now, for every surface at once. Each `useModelActions()`
   *  builds its own mutation observer, so a page that reads its own observer is blind to a
   *  load another surface fired. */
  pendingLoadKey: string | null
  /** Why the last load failed, and which model it was — kept against the key so a dialog
   *  cannot show another model's failure. */
  loadError: { key: string; message: string } | null
  setConfirm(c: JevLoadState['confirm']): void
  setPendingJevKey(k: string | null): void
  loadStarted(key: string): void
  loadFailed(key: string, message: string): void
  loadSettled(key: string): void
}

export const useJevLoadStore = create<JevLoadState>((set) => ({
  confirm: null,
  pendingJevKey: null,
  pendingLoadKey: null,
  loadError: null,
  setConfirm: (confirm) => set({ confirm }),
  setPendingJevKey: (pendingJevKey) => set({ pendingJevKey }),
  // The daemon loads one model at a time (ADR-285), so the load that got there first is the
  // one every surface should be reading: a second one is refused and settles at once, and
  // neither claiming the key nor releasing it is that refusal's to do.
  loadStarted: (key) => set((s) => (
    s.pendingLoadKey === null || s.pendingLoadKey === key ? { pendingLoadKey: key, loadError: null } : {}
  )),
  // A failed load also gives back the "is ready" claim it made, so a later swap of the same
  // model by somebody else is not announced as this browser's (ADR-434 (i)(4)).
  loadFailed: (key, message) => set((s) => ({
    loadError: { key, message },
    pendingJevKey: s.pendingJevKey === key ? null : s.pendingJevKey,
  })),
  loadSettled: (key) => set((s) => (s.pendingLoadKey === key ? { pendingLoadKey: null } : {})),
}))

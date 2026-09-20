// Jev load state that has to outlive the component that started the load (ADR-434 (i)(3)).
//
// ModelDetailDialog closes itself the moment it fires a load, so a confirmation owned by the
// dialog would unmount before the user could answer it. Both fields are app-level and the
// store is deliberately NOT persisted: a reload must not resurrect a dialog about work that
// finished, or a toast for a load this browser never fired.
import { create } from 'zustand'
import type { ActiveWork, LoadProfile } from '../lib/types'

/** The model a load site asked for — its own `jev` field, not a flag the caller has to
 *  remember, is what decides whether the activity probe runs (§5 ruling 9). Structural, so a
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
  setConfirm(c: JevLoadState['confirm']): void
  setPendingJevKey(k: string | null): void
}

export const useJevLoadStore = create<JevLoadState>((set) => ({
  confirm: null,
  pendingJevKey: null,
  setConfirm: (confirm) => set({ confirm }),
  setPendingJevKey: (pendingJevKey) => set({ pendingJevKey }),
}))

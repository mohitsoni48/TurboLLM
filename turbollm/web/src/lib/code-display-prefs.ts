import { useSyncExternalStore } from 'react'

// Global display toggles for the Code transcript (`/details`, `/thinking` — ADR-258). These
// complement the existing PER-card/PER-block expand (CodeToolCard's `expanded`, CodeReasoning's
// `open`) with a single switch for reviewing a long run: `/details` force-expands every tool card's
// detail, `/thinking` force-opens every reasoning block. Persisted in localStorage (same convention
// as the thinking-budget slider) and browser-global (not per-session — it's a reviewing preference,
// not session state). Subscribable so toggling updates every already-mounted card/block live, not
// only ones rendered afterward.

const KEYS = {
  details: 'tllm.code.details',
  thinking: 'tllm.code.thinking',
} as const

export type DisplayPref = keyof typeof KEYS

const listeners = new Set<() => void>()

function read(pref: DisplayPref): boolean {
  return localStorage.getItem(KEYS[pref]) === '1'
}

export function getDisplayPref(pref: DisplayPref): boolean {
  return read(pref)
}

/** Flip a display pref, persist it, and notify subscribers. Returns the new value (so a caller can
 *  surface it, e.g. a "Details: on" toast). */
export function toggleDisplayPref(pref: DisplayPref): boolean {
  const next = !read(pref)
  localStorage.setItem(KEYS[pref], next ? '1' : '0')
  listeners.forEach((l) => l())
  return next
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Reactively read a display pref — re-renders the caller whenever the pref is toggled anywhere. */
export function useDisplayPref(pref: DisplayPref): boolean {
  return useSyncExternalStore(subscribe, () => read(pref), () => false)
}

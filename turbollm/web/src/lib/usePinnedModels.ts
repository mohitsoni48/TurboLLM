import { useCallback, useEffect, useState } from 'react'

/** localStorage key for the client-only set of pinned/favourited model keys. Pinned
 *  models float to the top of the library list. Stored as a JSON-serialized array of
 *  model keys (see SettingsScreen for the same localStorage-preference pattern). */
const PINNED_MODELS_KEY = 'tllm.pinnedModels'

function readPinned(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_MODELS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

/** Client-only pinned-models state, persisted to localStorage. Returns the current set
 *  of pinned model keys, a predicate, and a toggle that writes through immediately. */
export function usePinnedModels() {
  const [pinned, setPinned] = useState<Set<string>>(() => readPinned())

  // Persist on every change (no Save round-trip; it's client-only, like the thinking pref).
  useEffect(() => {
    localStorage.setItem(PINNED_MODELS_KEY, JSON.stringify([...pinned]))
  }, [pinned])

  const isPinned = useCallback((key: string) => pinned.has(key), [pinned])

  const togglePinned = useCallback((key: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return { pinned, isPinned, togglePinned }
}

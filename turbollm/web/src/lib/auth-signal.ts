// Tiny external store bridging code-api.ts's 401s to App.tsx's existing AuthGate. App.tsx's
// own key-prompt trigger only watches the global /status poll — which never 401s for Code's
// gate (Chat/most of the app stays open on the LAN; only Code always requires a key from a
// non-host device, see auth.ts's codeAuth). code-api.ts marks this signal on a 401 from any
// Code endpoint; App.tsx subscribes via useSyncExternalStore and shows the SAME AuthGate.
// Cleared on the next SUCCESSFUL Code request (a valid key was entered and something refetched).
let needed = false
const listeners = new Set<() => void>()

export function markCodeAuthNeeded(): void {
  if (needed) return
  needed = true
  listeners.forEach((l) => l())
}

export function clearCodeAuthNeeded(): void {
  if (!needed) return
  needed = false
  listeners.forEach((l) => l())
}

export function isCodeAuthNeeded(): boolean {
  return needed
}

export function subscribeCodeAuthNeeded(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

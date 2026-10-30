// Tiny external store bridging code-api.ts's 401s to App.tsx's existing AuthGate. App.tsx's
// own key-prompt trigger only watches the global /status poll — which never 401s for Code's
// gate (Chat/most of the app stays open on the LAN; only Code always requires a key from a
// non-host device, see auth.ts's codeAuth). code-api.ts marks this signal on a 401 from any
// Code endpoint; App.tsx subscribes via useSyncExternalStore and shows the SAME AuthGate.
// Cleared on the next SUCCESSFUL Code request (a valid key was entered and something refetched),
// or by the prompt's "Not now", which leaves Code for Chat: Code asks again when opened again.
// App.tsx heeds it only where Code requests come from, a Code screen and a routine's page (which
// embeds a Code-flavor run's session), so a Code request that answers after the move to Chat
// cannot bring the prompt back there.
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

// The same bridge for the daemon's `api_key_required` 403: a host-only setting on PATCH
// /api/v1/settings, "Always Allow" on a tool call, or a captured request's bodies (Engines →
// Requests), refused because this browser presented no valid key (routes.ts's hostGate block).
// With requireApiKey off nothing 401s, so neither the /status poll nor Code raises AuthGate, and a
// non-loopback bind's owner (Docker with a published port, a private window, another origin, a
// revoked key) only ever saw a toast with nowhere to enter the key. api.ts and chat-api.ts mark
// this on that code; App.tsx shows AuthGate with a "Not now" that clears it, and clears it once
// the host gate takes the key entered (api.ts hostKeyAccepted), since no later request would: the
// refused change has to be made again. A key it refuses leaves it set, so AuthGate stays up with
// "That key was rejected".
let hostKeyNeeded = false
const hostKeyListeners = new Set<() => void>()

export function markHostKeyNeeded(): void {
  if (hostKeyNeeded) return
  hostKeyNeeded = true
  hostKeyListeners.forEach((l) => l())
}

export function clearHostKeyNeeded(): void {
  if (!hostKeyNeeded) return
  hostKeyNeeded = false
  hostKeyListeners.forEach((l) => l())
}

export function isHostKeyNeeded(): boolean {
  return hostKeyNeeded
}

export function subscribeHostKeyNeeded(listener: () => void): () => void {
  hostKeyListeners.add(listener)
  return () => hostKeyListeners.delete(listener)
}

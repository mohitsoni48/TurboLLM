import { useEffect, useRef } from 'react'
import { onOverlayEntry } from './use-backable-overlay'

// The open chat's id in the address bar, so a reload (or the desktop app's Ctrl+R) reopens it. The address used to keep
// whatever the chat screen was opened with: a new chat never got its id there after its first send, and picking another
// chat left the previous one's, so a reload landed on a blank new chat, or on another chat, and coming Back to the chat
// screen before the daemon had answered a new chat's first send landed on a blank chat that never picked its reply up.
//
// The current history entry's address is REPLACED, never pushed: Back leaves the chat screen as before instead of
// walking through every chat opened. Through history.replaceState with the entry's own state rather than the router's
// navigate(): that keeps the state use-backable-overlay.ts reads (`tllmOverlay`, the overlay entries a drawer or dialog
// holds) and the router's own key and index, and re-renders nothing. The router's location keeps the address the screen
// was opened with, which only that screen's mount reads (the route's chat id).

const WORKSPACE_CHAT = '/workspace/chat'
const STANDALONE_CHAT = '/chat'

/** The address that names `convId` (null: a new chat) for a chat screen at `pathname`, or null when `pathname` is not
 *  a chat screen's (the page has moved on). A standalone /chat/:id view (a LAN share link) keeps its own form; a new
 *  chat is /workspace/chat, which /chat itself redirects to. */
export function chatAddress(pathname: string, convId: string | null): string | null {
  const standalone = pathname === STANDALONE_CHAT || pathname.startsWith(`${STANDALONE_CHAT}/`)
  const workspace = pathname === WORKSPACE_CHAT || pathname.startsWith(`${WORKSPACE_CHAT}/`)
  if (!standalone && !workspace) return null
  if (!convId) return WORKSPACE_CHAT
  return `${standalone ? STANDALONE_CHAT : WORKSPACE_CHAT}/${encodeURIComponent(convId)}`
}

function replaceAddress(path: string): void {
  window.history.replaceState(window.history.state, '', `${path}${window.location.search}${window.location.hash}`)
}

/** Keeps the address naming `convId` while the chat screen shows it (not when `enabled` is false: an embedded chat). */
export function useChatInAddress(convId: string | null, enabled: boolean): void {
  // The address an overlay's entry got: the entry under it (where closing the overlay, or Back, lands) is named on
  // landing there. Without that, picking a chat in the phone's conversation drawer named it only in the drawer's own
  // entry, which closing the drawer goes back over, and the address went back to the previous chat.
  const pending = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    const want = chatAddress(window.location.pathname, convId)
    if (!want) return
    if (window.location.pathname !== want) replaceAddress(want)
    pending.current = onOverlayEntry() ? want : null
  }, [enabled, convId])
  useEffect(() => {
    if (!enabled) return
    const onPopState = () => {
      const want = pending.current
      if (!want || onOverlayEntry()) return
      pending.current = null
      if (chatAddress(window.location.pathname, null) && window.location.pathname !== want) replaceAddress(want)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [enabled])
}

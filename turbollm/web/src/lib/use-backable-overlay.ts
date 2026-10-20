import { useEffect, useRef } from 'react'

/** Makes an open/close boolean state respond to the Android hardware/gesture back action by
 *  pushing a throwaway history entry while `open` is true and closing on `popstate` — the
 *  standard "back closes the overlay" pattern (QA_BUGS.md BUG-02).
 *
 *  Why this is necessary at all: the embedded Android WebView's own back handling
 *  (DaemonWebView.kt) only intercepts the hardware/gesture back action when `webView.canGoBack()`
 *  is true — i.e. when there is a real browser-history entry to go back to. A plain React
 *  open/close boolean never touches history, so with a drawer open, back fell through to the
 *  app's default (exit the Activity) instead of closing it — reproduced live: opening the
 *  conversation drawer and pressing back exited straight to the home screen. Pushing a history
 *  entry while open makes `canGoBack()` true for as long as the overlay is open; this hook's own
 *  `popstate` listener is what actually closes it. This is also what closes the SAME overlay on
 *  desktop/mobile Chrome's own back button, for free.
 *
 *  If the overlay closes some OTHER way while open (a backdrop tap, an explicit close button),
 *  its entry is popped via `history.go()` so no dead entry accumulates for the user to press
 *  back through later.
 *
 *  Every instance shares the one history, so the instances are coordinated at module level (the
 *  code below the hook), not each on its own. Each used to close its overlay on ANY popstate
 *  while it held an entry, and to call `history.back()` itself when its overlay closed. On a
 *  phone, Discover's Import from URL with a model-page link closes the Import sheet and opens
 *  the repo's sheet in the same update: the repo sheet pushed its entry, the Import sheet's
 *  back() then went back over it, and the repo sheet took that popstate for a Back and closed —
 *  it showed for a moment and nothing was left open. The same back() closed any overlay open
 *  under one closed from code, and one real Back closed every open overlay at once, leaving
 *  their other entries behind as dead back presses. Now:
 *  - the open overlays are kept in the order they opened, and each entry pushed for them
 *    records its depth (`tllmOverlay: n`: the overlay entries up to and including it), so the
 *    current entry says how many are held;
 *  - after each open or close, the entries are squared with the open overlays in one place, a
 *    microtask later: pushed for overlays that opened, or dropped in one `history.go(-n)` for
 *    overlays that closed. An overlay closing as another opens in the same update hands its
 *    entry over, with no traversal at all;
 *  - the popstate of that go() closes nothing. Any other popstate is a Back (or Forward) the
 *    user made: it closes the overlays whose entries it went back over (the top one, for one
 *    Back, the next one on the next Back), and nothing else. An entry it lands on that no open
 *    overlay holds any more (Forward onto a closed overlay's, or Back onto one left under a route
 *    navigation) is left alone, as before: going back past it would undo a Forward over it every
 *    time; the next open or close squares it. A real route navigation passes through untouched;
 *  - an overlay that unmounts while open is closed the same way, but only its entry while that
 *    is still the current one: when a route navigation pushed an entry over it (a Link inside
 *    it), the history is left alone rather than undoing the navigation. */
export function useBackableOverlay(open: boolean, onClose: () => void): void {
  // The coordinator reaches `onClose` through a ref, rather than through whatever closure was
  // current when the overlay opened. Depending on it directly looked harmless but silently broke
  // the hook for any caller that passes an inline closure (most of them), back when each
  // instance subscribed its own popstate listener: a real back gets handled by the router's own
  // popstate listener first, that navigation re-renders the caller, `onClose` comes out with a
  // fresh identity, and the listener was torn down and re-added — synchronously, inside the same
  // popstate dispatch. Per the DOM spec a listener removed mid-dispatch is never invoked, so ours
  // was skipped and the overlay stayed open. It looked for all the world like the event wasn't
  // firing: a hand-dispatched `new PopStateEvent('popstate')` (no router work, no re-render, no
  // teardown) closed the dialog every time, while a genuine `history.back()` never did. The one
  // module-level listener below is never removed, and the ref keeps `onClose` current.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    const overlay: OpenOverlay = { close: () => onCloseRef.current() }
    openOverlay(overlay)
    return () => closeOverlay(overlay)
  }, [open])
}

interface OpenOverlay {
  close: () => void
}

/** Open overlays in the order they opened: the last one is the top, the one Back closes. */
const openOverlays: OpenOverlay[] = []
let listening = false
let syncQueued = false
/** Set while a `history.go(-n)` of ours has not fired its popstate yet: nothing is pushed or
 *  gone back meanwhile, since a push made while a traversal is pending is dropped by Chromium
 *  (and cancels the traversal in jsdom). */
let goingBack: ReturnType<typeof setTimeout> | null = null
/** How long a traversal of ours may take before its popstate is given up on, so one that never
 *  fires (jsdom drops it when anything pushes first) cannot swallow the user's next real Back
 *  for good. Chromium fires it within tens of milliseconds. */
const GO_BACK_TIMEOUT_MS = 1000

/** Overlay entries held up to and including the current history entry: 0 for any other entry. */
function heldEntries(): number {
  const depth = (history.state as { tllmOverlay?: unknown } | null)?.tllmOverlay
  return typeof depth === 'number' ? depth : 0
}

function openOverlay(overlay: OpenOverlay) {
  if (!listening) {
    listening = true
    window.addEventListener('popstate', onPopState)
  }
  openOverlays.push(overlay)
  queueSync()
}

function closeOverlay(overlay: OpenOverlay) {
  const i = openOverlays.indexOf(overlay)
  if (i === -1) return // already closed by a Back
  openOverlays.splice(i, 1)
  queueSync()
}

/** One microtask after the change, so every open and close of the same commit (and a StrictMode
 *  effect's mount, unmount and remount) is squared in one go. */
function queueSync() {
  if (syncQueued) return
  syncQueued = true
  queueMicrotask(() => {
    syncQueued = false
    syncHistory(true)
  })
}

function syncHistory(mayGoBack: boolean) {
  if (goingBack !== null) return
  const want = openOverlays.length
  const held = heldEntries()
  if (want > held) {
    for (let depth = held + 1; depth <= want; depth++) history.pushState({ tllmOverlay: depth }, '')
  } else if (want < held && mayGoBack) {
    goingBack = setTimeout(() => wentBack(false), GO_BACK_TIMEOUT_MS)
    history.go(want - held)
  }
}

/** Our traversal is done (its popstate came, or it timed out): push for any overlay that opened
 *  meanwhile. After a timeout the history is not gone back again: a traversal that is only late
 *  would then go back twice. */
function wentBack(popped: boolean) {
  if (goingBack !== null) clearTimeout(goingBack)
  goingBack = null
  syncHistory(popped)
}

function onPopState() {
  if (goingBack !== null) {
    wentBack(true)
    return
  }
  const held = heldEntries()
  if (held < openOverlays.length) {
    // Went back over the entries of the top overlays: close those, newest first.
    for (const overlay of openOverlays.splice(held).reverse()) overlay.close()
  }
}

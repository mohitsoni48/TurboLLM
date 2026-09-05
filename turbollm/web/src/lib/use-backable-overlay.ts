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
 *  this pops the still-pending history entry via `history.back()` so no dead entry accumulates
 *  for the user to press back through later. */
export function useBackableOverlay(open: boolean, onClose: () => void): void {
  const pushedRef = useRef(false)

  useEffect(() => {
    if (open && !pushedRef.current) {
      history.pushState({ tllmOverlay: true }, '')
      pushedRef.current = true
    } else if (!open && pushedRef.current) {
      pushedRef.current = false
      history.back()
    }
  }, [open])

  // The listener is subscribed ONCE and reaches `onClose` through a ref, rather than depending on
  // it. Depending on it looks harmless but silently breaks the hook for any caller that passes an
  // inline closure (most of them): a real back gets handled by the router's own popstate listener
  // first, that navigation re-renders the caller, `onClose` comes out with a fresh identity, and
  // this effect tears down and re-adds its listener — synchronously, inside the same popstate
  // dispatch. Per the DOM spec a listener removed mid-dispatch is never invoked, so ours was
  // skipped and the overlay stayed open. It looked for all the world like the event wasn't firing:
  // a hand-dispatched `new PopStateEvent('popstate')` (no router work, no re-render, no teardown)
  // closed the dialog every time, while a genuine `history.back()` never did.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    function onPopState() {
      // Only react while WE hold the top history entry — a real route-navigation popstate
      // (Link/back to an actual different screen) must pass through untouched.
      if (pushedRef.current) {
        pushedRef.current = false
        onCloseRef.current()
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
}

import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'

/**
 * App-wide scroll mode (issue #178).
 *
 * The shell is a bounded, full-height SPA: `html, body, #root { height: 100%; overflow: hidden }`
 * (index.css) plus `main.overflow-auto` in Shell.tsx. That is correct for Chat / Workspace / Code,
 * where a pane must stay pinned while an inner list scrolls. It is WRONG for the long list-style
 * screens (Models library, Engines, Developer, Customize, Usage, Settings): there the page's own
 * content is the scroller, and locking the document means mobile browsers never collapse their URL
 * bar, the scrollbar is an inner one rather than the window's, and `window.scrollTo` / anchor jumps
 * / find-in-page do nothing. Measured on a 430x850 viewport at /models: the inner scroller was
 * 794/3019 while `document.documentElement.scrollHeight` sat at 850.
 *
 * Rather than keying off the URL — which would break ADR-143's Discover split-pane, a founder-
 * mandated bounded layout living on the SAME `/models` route as the scrollable Library tab — each
 * VIEW opts in for as long as it is mounted, by calling `useDocumentScroll()`. Shell reads the
 * resolved mode and switches its own layout plus the `tllm-doc-scroll` class on <html> that
 * releases the CSS lock.
 *
 * Deliberately a module-level store rather than context: `<Shell>` is mounted once, above the
 * router, so a provider would have to live in App.tsx and every screen would still need a hook.
 * Refcounted (not a boolean) so an overlapping mount/unmount pair — or React StrictMode's
 * double-invoked effects in dev — can't leave the mode latched on or off.
 */
export type ScrollMode = 'bounded' | 'document'

let requests = 0
let snapshot: ScrollMode = 'bounded'
const listeners = new Set<() => void>()

function publish() {
  const next: ScrollMode = requests > 0 ? 'document' : 'bounded'
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Opt this view into document scrolling for as long as it is mounted (and `enabled`).
 *
 * `enabled` exists for views whose scrollability is a sub-state rather than a whole screen —
 * ModelsScreen passes `tab === 'library'` so the Discover split-pane keeps the bounded shell.
 *
 * Layout effect, not a passive one: a tab flip re-renders the screen with its new markup in the
 * same commit, and a passive effect would land AFTER paint, showing one frame of (say) Discover's
 * `h-full` panes measured against an unlocked, auto-height <html>.
 */
export function useDocumentScroll(enabled = true) {
  useLayoutEffect(() => {
    if (!enabled) return
    requests += 1
    publish()
    return () => {
      requests -= 1
      publish()
    }
  }, [enabled])
}

/** Current resolved mode. Only Shell should need this. */
export function useScrollMode(): ScrollMode {
  const getSnapshot = useCallback(() => snapshot, [])
  return useSyncExternalStore(subscribe, getSnapshot, () => 'bounded' as ScrollMode)
}

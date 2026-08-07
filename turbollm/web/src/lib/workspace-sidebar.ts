// Remembers whether the Workspace conversation sidebar (ConversationSidebar.tsx — shared across
// Chat, Code Home, Code Session, Routines Panel, and Routine Edit; five identical
// `useState(true)` call sites before this) is expanded or collapsed, so collapsing it survives
// the same "leave Workspace, come back" flow workspace-nav.ts fixes for which sub-route is open —
// founder-reported as a follow-up to that fix ("you just did the bare minimum").
//
// Session-scoped (sessionStorage), same convention as workspace-nav.ts and for the same reason:
// this is "how I left it this session", not a durable cross-session preference like theme/
// fontSize (stores/ui.ts). ONE shared flag, not one per screen — it's the same physical sidebar
// component reused across every Workspace mode, so collapsing it in Code and then switching to
// Chat should show it collapsed there too, exactly as if it were one persistent piece of UI chrome.

import { useCallback, useState } from 'react'

const KEY = 'tllm.workspace.sidebarOpen'

function readStoredSidebarOpen(): boolean {
  try {
    const v = sessionStorage.getItem(KEY)
    // No stored value yet (fresh session) defaults to expanded — the pre-existing
    // `useState(true)` default at every call site this replaces.
    return v === null ? true : v === '1'
  } catch {
    return true
  }
}

function writeStoredSidebarOpen(open: boolean): void {
  try {
    sessionStorage.setItem(KEY, open ? '1' : '0')
  } catch {
    /* private browsing / storage disabled — falls back to in-memory only for this mount */
  }
}

/** Drop-in replacement for `useState(true)` at each of the five Workspace sidebar call sites —
 *  same `[sidebarOpen, setSidebarOpen]` shape (including functional updater support), so every
 *  existing call site swaps in with a one-line change. Each mounted screen reads the CURRENT
 *  stored value at mount time and writes back on every change, so switching screens within
 *  Workspace (which mounts a different screen component, each with its own call to this hook)
 *  stays in sync without any cross-component subscription machinery — the write from the screen
 *  you're leaving always lands before the read from the screen you're entering. */
export function useWorkspaceSidebarOpen(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [sidebarOpen, setSidebarOpenState] = useState(readStoredSidebarOpen)
  const setSidebarOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setSidebarOpenState((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next
      writeStoredSidebarOpen(resolved)
      return resolved
    })
  }, [])
  return [sidebarOpen, setSidebarOpen]
}

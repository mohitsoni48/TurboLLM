import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

// ── Conversation sidebar width — shared between ChatScreen and CodeHomeScreen ──
//
// Both Workspace modes (Chat and Code) show the same resizable/collapsible
// sidebar column (ConversationSidebar.tsx), so the width-persistence + drag-
// resize logic lives here once instead of being duplicated per screen. Used to
// live inline in ChatScreen.tsx before CodeHomeScreen needed its own sidebar
// instance too.

export const SIDEBAR_WIDTH_KEY = 'tllm-sidebar-w'
export const SIDEBAR_MIN_W = 200

/** Largest the sidebar may grow: always leave the main content at least 480px. */
export function sidebarMaxW(): number {
  return Math.max(SIDEBAR_MIN_W, Math.min(480, window.innerWidth - 480))
}

export function readSavedSidebarWidth(): number {
  try {
    const n = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '', 10)
    return Number.isFinite(n) ? n : 224 // 224px matches the prior fixed w-56
  } catch {
    return 224
  }
}

/** Thin drag handle between the sidebar and the main content column; resizes the
 *  sidebar live via direct style mutation (same pattern as DiscoverTab's
 *  SplitResizeHandle — avoids a React re-render per pointer-move pixel), then
 *  commits + persists the final width on release. */
export function SidebarResizeHandle({
  sidebarRef,
  onCommit,
}: {
  sidebarRef: RefObject<HTMLDivElement | null>
  onCommit: (w: number) => void
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarRef.current?.getBoundingClientRect().width ?? readSavedSidebarWidth()
    document.documentElement.classList.add('tllm-resizing')
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), SIDEBAR_MIN_W), sidebarMaxW())
      if (sidebarRef.current) sidebarRef.current.style.width = `${Math.round(w)}px`
    }
    const onUp = () => {
      document.documentElement.classList.remove('tllm-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const w = sidebarRef.current?.getBoundingClientRect().width
      if (w) {
        const rounded = Math.round(w)
        onCommit(rounded)
        try {
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(rounded))
        } catch {
          /* ignore quota / disabled storage */
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      className="tllm-split-resizer"
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize conversation sidebar"
    />
  )
}

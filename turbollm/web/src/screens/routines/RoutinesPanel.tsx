import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, PanelLeft, Plus } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { track } from '../../lib/api'
import { EmptyState } from '../../components/common'
import { cn } from '../../lib/utils'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { ConversationSidebar } from '../chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from '../chat/SidebarResizeHandle'
import { useWorkspaceSidebarOpen } from '../../lib/workspace-sidebar'

/** Workspace's Routines mode with nothing selected — `/workspace/routines`. The list itself now
 *  lives in ConversationSidebar.tsx (a real peer of the Chat conversation list and Code session
 *  list, spec 20 §2.1's own follow-up: it used to be a link pinned above the Code session list,
 *  with the full list rendered HERE in the main content area — which read as bolted onto Code
 *  mode rather than a third mode of its own). This screen is now just Routines mode's landing
 *  state, same role WorkspaceScreen (bare /workspace/chat) and CodeHomeScreen (bare
 *  /workspace/code) already play for their own modes.
 *
 *  LAYOUT: renders its own two-column shell (ChatScreen/CodeHomeScreen/RoutineEditPage all do
 *  the same — see RoutineEditPage.tsx's RoutinesModeShell for why: Shell.tsx owns only the nav
 *  rail and `<main>`, never the sidebar, and rendering the bare page container instead would
 *  unmount the sidebar/mode-switch on this one route). */
export function RoutinesPanel() {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const [sidebarOpen, setSidebarOpen] = useWorkspaceSidebarOpen()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(Math.max(readSavedSidebarWidth(), SIDEBAR_MIN_W), sidebarMaxW()))
  const sidebarRef = useRef<HTMLDivElement>(null)

  return (
    <div className="flex h-full overflow-hidden">
      {!isDesktop && mobileSidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => { track('routines', 'toggle_sidebar_collapsed'); setMobileSidebarOpen(false) }} aria-hidden />
      )}
      <div
        ref={sidebarRef}
        className={cn(
          'tllm-chat-sidebar',
          isDesktop
            ? sidebarOpen ? 'shrink-0' : 'w-10 shrink-0'
            : cn(
                'fixed inset-y-0 left-0 z-40 w-[84vw] max-w-[300px] shadow-[var(--shadow-2)]',
                mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
              ),
        )}
        style={isDesktop && sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        <ConversationSidebar
          activeId={null}
          onSelect={(id) => { navigate(`/workspace/chat/${id}`); if (!isDesktop) setMobileSidebarOpen(false) }}
          onNew={() => { navigate('/workspace/routines/new'); if (!isDesktop) setMobileSidebarOpen(false) }}
          collapsed={isDesktop ? !sidebarOpen : false}
          onToggle={isDesktop ? () => setSidebarOpen((o) => !o) : () => setMobileSidebarOpen(false)}
        />
      </div>
      {isDesktop && sidebarOpen && <SidebarResizeHandle sidebarRef={sidebarRef} onCommit={setSidebarWidth} />}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Same h-12 chrome bar the other Workspace-mode screens carry, for the mobile sidebar
            trigger — below md the sidebar is off-canvas, so without this there is no way to
            reach it (or anything else in Routines mode) from here at all. */}
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 md:gap-3 md:px-8">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 md:hidden"
            onClick={() => { track('routines', 'toggle_sidebar_collapsed'); setMobileSidebarOpen(true) }}
            title="History"
            aria-label="Open sidebar"
          >
            <PanelLeft size={16} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <EmptyState
            icon={<AlarmClock size={28} />}
            message="Select a routine from the sidebar, or create one to run a task automatically on a schedule — chat or code, no one needs to be watching."
            action={<Button size="sm" onClick={() => { track('routines', 'new_routine'); navigate('/workspace/routines/new') }}><Plus size={14} /> New routine</Button>}
          />
        </div>
      </div>
    </div>
  )
}

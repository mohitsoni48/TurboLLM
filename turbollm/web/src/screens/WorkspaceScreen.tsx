import { MessageSquare, Bot } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'
import { ChatScreen } from './ChatScreen'
import { AgentChatView } from './workspace/AgentChatView'

// ── Workspace: Chat | Agent ──────────────────────────────────────────────────
//
// The "doing work / talking" surface. A thin tab strip switches between plain
// LLM chat and agent conversations. The active tab is derived from the URL
// (/workspace/agent* → Agent, otherwise Chat) so deep links + the back button
// keep working. Agent *definitions* are managed under the Agents nav, not here.

type Tab = 'chat' | 'agent'

const TABS: { id: Tab; label: string; icon: typeof MessageSquare; path: string }[] = [
  { id: 'chat',  label: 'Chat',  icon: MessageSquare, path: '/workspace/chat' },
  { id: 'agent', label: 'Agent', icon: Bot,           path: '/workspace/agent' },
]

export function WorkspaceScreen() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const active: Tab = pathname.startsWith('/workspace/agent') ? 'agent' : 'chat'

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-panel-2 px-3 py-1.5">
        {TABS.map(({ id, label, icon: Icon, path }) => {
          const isActive = id === active
          return (
            <button
              key={id}
              type="button"
              onClick={() => { if (!isActive) navigate(path) }}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                isActive ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-panel hover:text-ink',
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          )
        })}
      </div>

      {/* Active tab body. Both screens own their full-height layout below the strip.
          Keep both mounted? No — each manages heavy SSE/run state; render only the
          active one so an inactive tab isn't streaming in the background. */}
      <div className="min-h-0 flex-1">
        {active === 'agent' ? <AgentChatView /> : <ChatScreen />}
      </div>
    </div>
  )
}

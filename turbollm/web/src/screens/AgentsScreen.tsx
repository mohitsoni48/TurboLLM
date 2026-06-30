import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, Plus, Sparkles } from 'lucide-react'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'
import { agentKeys, fetchAgents } from '../lib/agent-api'
import type { AgentType } from '../lib/agent-types'
import { AgentEditPage } from './agents/AgentEditPage'
import { SkillsLibrary } from './skills/SkillsLibrary'
import { SkillEditPage } from './skills/SkillEditPage'

// ── Management area: Agents | Skills ─────────────────────────────────────────
//
// Two independent libraries behind one nav item. Agents are personas that *use*
// skills; skills live on their own and any agent can pick them.

function AgentCard({ agent, onOpen }: { agent: AgentType; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-xl border border-border bg-panel px-4 py-3.5 text-left transition-colors hover:border-accent hover:bg-panel-2"
    >
      <div className="flex items-center gap-2">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
          style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}
        >
          <Bot size={16} className="text-accent" />
        </div>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{agent.name}</span>
        {agent.builtin && (
          <span className="shrink-0 rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint">built-in</span>
        )}
      </div>
      {agent.description && (
        <p className="line-clamp-2 text-[12px] text-muted">{agent.description}</p>
      )}
      {agent.skills.length > 0 && (
        <p className="mt-auto truncate text-[11px] text-faint">
          Skills: {agent.skills.includes('*') ? 'all' : agent.skills.join(', ')}
        </p>
      )}
    </button>
  )
}

function AgentsGrid() {
  const navigate = useNavigate()
  const agentsQ = useQuery({
    queryKey: agentKeys.list(),
    queryFn: fetchAgents,
    staleTime: 0,
  })
  const agents = agentsQ.data ?? []

  return (
    <div className="flex w-full flex-col gap-5 px-8 py-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-[18px] font-semibold text-ink">Agents</h1>
          <p className="text-[12px] text-muted">
            Personas you talk to in Workspace → Agent. Each one picks the skills it can use.
          </p>
        </div>
        <Button size="sm" onClick={() => navigate('/agents/new')}>
          <Plus size={14} /> New agent
        </Button>
      </div>

      {/* Grid */}
      {agentsQ.isLoading ? (
        <p className="py-12 text-center text-[13px] text-faint">Loading…</p>
      ) : agents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16">
          <Bot size={32} className="text-faint" />
          <p className="text-[14px] text-muted">No agents yet.</p>
          <Button size="sm" variant="outline" onClick={() => navigate('/agents/new')}>
            <Plus size={14} /> Create your first agent
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onOpen={() => navigate(`/agents/${agent.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

const TABS = [
  { id: 'agents', label: 'Agents', icon: Bot, path: '/agents' },
  { id: 'skills', label: 'Skills', icon: Sparkles, path: '/agents/skills' },
] as const

export function AgentsScreen() {
  const { id, skillId } = useParams<{ id?: string; skillId?: string }>()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const onSkills = pathname.startsWith('/agents/skills')

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip — Agents | Skills */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-panel-2 px-3 py-1.5">
        {TABS.map(({ id: tab, label, icon: Icon, path }) => {
          const active = tab === 'skills' ? onSkills : !onSkills
          return (
            <button
              key={tab}
              type="button"
              onClick={() => { if (!active) navigate(path) }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                active ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-panel hover:text-ink',
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          )
        })}
      </div>

      {/* Active tab body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {onSkills
          ? (skillId ? <SkillEditPage skillId={skillId} /> : <SkillsLibrary />)
          : (id ? <AgentEditPage agentId={id} /> : <AgentsGrid />)}
      </div>
    </div>
  )
}

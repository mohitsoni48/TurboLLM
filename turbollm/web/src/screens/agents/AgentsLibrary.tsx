import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Plus, RotateCcw, Star, Wrench } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { useBuiltinAgentOverrideMutations, useBuiltinAgentOverrides, useChatAgents } from '../../lib/queries'
import { resolveAgents, getDefaultAgentId, setDefaultAgentId, type ResolvedAgent } from '../../lib/personas'
import { ApiError } from '../../lib/api'

function AgentCard({ agent, isDefault, onOpen, onSetDefault, onReset }: {
  agent: ResolvedAgent; isDefault: boolean; onOpen: () => void; onSetDefault: () => void; onReset: () => void
}) {
  const skillCount = agent.skillIds?.length
  const toolCount = agent.tools?.length
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      className="flex flex-col gap-2 rounded-xl border border-border bg-panel px-4 py-3.5 text-left transition-colors hover:border-accent hover:bg-panel-2"
    >
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
          <Bot size={15} className="text-accent" />
        </div>
        {/* The name only competes with the two icon buttons for this row — the built-in/modified
            badge lives in the footer instead (GitHub #84: with the badge here, every title on a
            185px card collapsed to "De…"/"Bla…", so the cards were unidentifiable). */}
        <span title={agent.name} className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{agent.name}</span>
        <button
          type="button"
          title={isDefault ? 'Default agent for new chats' : 'Set as default agent'}
          onClick={(e) => { e.stopPropagation(); onSetDefault() }}
          className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-accent"
        >
          <Star size={14} className={isDefault ? 'fill-current text-accent' : undefined} />
        </button>
        {agent.overridden && (
          <button
            type="button"
            title="Reset to default"
            onClick={(e) => { e.stopPropagation(); onReset() }}
            className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-accent"
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {agent.description && <p className="line-clamp-2 text-[12px] text-muted">{agent.description}</p>}
      {(agent.builtin || skillCount || toolCount) ? (
        <div className="mt-auto flex items-center gap-2">
          {(skillCount || toolCount) ? (
            // `truncate` has to sit on the text itself, not on this flex row: text-overflow
            // doesn't apply to flex items, so a clamped row would hard-cut mid-glyph with no
            // ellipsis. The row keeps min-w-0 so it can actually shrink.
            <p className="flex min-w-0 items-center gap-1 text-[11px] text-faint">
              <Wrench size={10} className="shrink-0" />
              <span className="truncate">
                {skillCount ? `${skillCount} skill${skillCount === 1 ? '' : 's'}` : null}
                {skillCount && toolCount ? ' · ' : null}
                {toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null}
              </span>
            </p>
          ) : null}
          {agent.builtin && (
            <span className="ml-auto shrink-0 rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint">
              {agent.overridden ? 'modified' : 'built-in'}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function AgentsLibrary() {
  const navigate = useNavigate()
  const customQ = useChatAgents()
  const overridesQ = useBuiltinAgentOverrides()
  const overrideMut = useBuiltinAgentOverrideMutations()
  const agents = resolveAgents(customQ.data ?? [], overridesQ.data ?? {})

  const [defaultId, setDefaultIdLocal] = useState(() => getDefaultAgentId())
  const handleSetDefault = (agent: ResolvedAgent) => {
    setDefaultAgentId(agent.id)
    setDefaultIdLocal(agent.id)
    toast.success(`${agent.name} is now the default agent for new chats.`)
  }

  const handleReset = (agent: ResolvedAgent) => {
    overrideMut.reset.mutate(agent.id, {
      onSuccess: () => toast.success(`${agent.name} reset to its default.`),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not reset agent.'),
    })
  }

  const loading = customQ.isLoading || overridesQ.isLoading

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Agents</h2>
          <p className="text-[12px] text-muted">
            Pick one when starting a new chat. Built-in agents can be edited in place (Reset restores the default) — or create your own with a custom system prompt and a skill/tool allow-list.
          </p>
        </div>
        <Button size="sm" onClick={() => navigate('/agents/new')} className="shrink-0">
          <Plus size={14} /> New agent
        </Button>
      </div>

      {loading ? (
        <p className="py-8 text-center text-[13px] text-faint">Loading…</p>
      ) : (
        // 240px, not 185px: at 185 a card's title row had ~25px left for the name after the icon,
        // the star and the badge, so nothing was readable (GitHub #84).
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              isDefault={agent.id === defaultId}
              onOpen={() => navigate(`/agents/${agent.id}`)}
              onSetDefault={() => handleSetDefault(agent)}
              onReset={() => handleReset(agent)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

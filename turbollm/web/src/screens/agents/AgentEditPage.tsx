import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError, track } from '../../lib/api'
import { fetchAvailableTools } from '../../lib/chat-api'
import { fetchSkills, skillKeys } from '../../lib/agent-api'
import { useBuiltinAgentOverrideMutations, useBuiltinAgentOverrides, useChatAgentMutations, useChatAgents } from '../../lib/queries'
import { PERSONAS } from '../../lib/personas'
import { cn } from '../../lib/utils'

interface AgentForm {
  name: string
  description: string
  systemPrompt: string
  skillIds: string[]
  tools: string[]
}

const emptyForm = (): AgentForm => ({ name: '', description: '', systemPrompt: '', skillIds: [], tools: [] })

// ── Grouped tools (built-ins flat, MCP tools bucketed by server with a
//    select-all-children parent checkbox) ─────────────────────────────────────

interface ToolEntry { name: string; description: string }
interface ToolGroup { key: string; label: string; tools: ToolEntry[] }

function groupTools(tools: ToolEntry[]): { builtin: ToolEntry[]; groups: ToolGroup[] } {
  const builtin: ToolEntry[] = []
  const byKey = new Map<string, ToolGroup>()
  for (const t of tools) {
    const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(t.name)
    if (!m) { builtin.push(t); continue }
    const key = m[1]
    const bracket = /^\[([^\]]+)\]/.exec(t.description)
    const label = bracket ? bracket[1] : key.replace(/_/g, ' ')
    if (!byKey.has(key)) byKey.set(key, { key, label, tools: [] })
    byKey.get(key)!.tools.push(t)
  }
  return { builtin, groups: [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label)) }
}

function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
}
function bareDescription(desc: string): string {
  return desc.replace(/^\[[^\]]+\]\s*/, '')
}

function ToolCheckboxRow({ tool, checked, onToggle }: { tool: ToolEntry; checked: boolean; onToggle: () => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12px]">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={onToggle} />
      <span className="flex flex-col">
        <span className="font-mono text-ink">{bareToolName(tool.name)}</span>
        {tool.description && <span className="text-faint">{bareDescription(tool.description)}</span>}
      </span>
    </label>
  )
}

function ToolGroupRow({ group, selected, onToggleAll, onToggleOne }: {
  group: ToolGroup; selected: Set<string>
  onToggleAll: (names: string[], checked: boolean) => void
  onToggleOne: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const names = group.tools.map((t) => t.name)
  const checkedCount = names.filter((n) => selected.has(n)).length
  const allChecked = checkedCount === names.length
  const someChecked = checkedCount > 0 && !allChecked
  const checkboxRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (checkboxRef.current) checkboxRef.current.indeterminate = someChecked }, [someChecked])

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <input ref={checkboxRef} type="checkbox" checked={allChecked} onChange={() => onToggleAll(names, !allChecked)} />
        <button type="button" onClick={() => { track('agents', 'toggle_agent_tool_group'); setOpen((o) => !o) }} className="flex flex-1 items-center gap-1.5 text-left text-[13px] text-ink">
          <ChevronRight size={12} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
          {group.label}
          <span className="text-[11px] text-faint">({checkedCount}/{names.length})</span>
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2 pl-9">
          {group.tools.map((t) => (
            <ToolCheckboxRow key={t.name} tool={t} checked={selected.has(t.name)} onToggle={() => onToggleOne(t.name)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolsChecklist({ tools, selected, onChange }: { tools: ToolEntry[]; selected: string[]; onChange: (tools: string[]) => void }) {
  const set = new Set(selected)
  const { builtin, groups } = groupTools(tools)

  const toggleOne = (name: string) => onChange(set.has(name) ? selected.filter((t) => t !== name) : [...selected, name])
  const toggleAll = (names: string[], checked: boolean) => {
    const rest = selected.filter((t) => !names.includes(t))
    onChange(checked ? [...rest, ...names] : rest)
  }

  if (tools.length === 0) return <p className="text-[12px] text-faint">No tools available yet.</p>

  return (
    <div className="flex flex-col gap-2">
      {builtin.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-3">
          {builtin.map((t) => <ToolCheckboxRow key={t.name} tool={t} checked={set.has(t.name)} onToggle={() => toggleOne(t.name)} />)}
        </div>
      )}
      {groups.map((g) => (
        <ToolGroupRow key={g.key} group={g} selected={set} onToggleAll={toggleAll} onToggleOne={toggleOne} />
      ))}
    </div>
  )
}

// ── Agent edit form (shared by built-in "edit + reset" and custom "create/edit") ──

export function AgentEditPage() {
  const { agentId = 'new' } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isNew = agentId === 'new'
  const isBuiltin = !isNew && PERSONAS.some((p) => p.id === agentId)
  const builtinBase = isBuiltin ? PERSONAS.find((p) => p.id === agentId) : undefined

  const customQ = useChatAgents()
  const custom = !isNew && !isBuiltin ? (customQ.data ?? []).find((a) => a.id === agentId) : undefined
  const mut = useChatAgentMutations()

  const overridesQ = useBuiltinAgentOverrides()
  const overrideMut = useBuiltinAgentOverrideMutations()
  const override = isBuiltin ? overridesQ.data?.[agentId] : undefined

  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, staleTime: 0 })
  const skills = skillsQ.data ?? []
  const toolsQ = useQuery({ queryKey: ['available-tools'], queryFn: fetchAvailableTools })
  const tools = toolsQ.data ?? []

  const [form, setForm] = useState<AgentForm>(emptyForm())
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [formTab, setFormTab] = useState<'skills' | 'tools'>('skills')

  // New agent: default the checklists to "everything checked" once the lists load.
  if (isNew && !hydrated && (skills.length || tools.length)) {
    setForm((f) => ({ ...f, skillIds: skills.map((s) => s.id), tools: tools.map((t) => t.name) }))
    setHydrated(true)
  }
  // Existing custom agent: hydrate once its data arrives.
  if (!isNew && !isBuiltin && !hydrated && custom) {
    setForm({ name: custom.name, description: custom.description, systemPrompt: custom.systemPrompt, skillIds: custom.skillIds, tools: custom.tools })
    setHydrated(true)
  }
  // Built-in agent: hydrate from its saved override (if any), else the hardcoded
  // default with every skill/tool checked (same "all checked" convention as new).
  if (isBuiltin && !hydrated && builtinBase && overridesQ.isSuccess && (skills.length || tools.length)) {
    setForm({
      name: override?.name ?? builtinBase.name,
      description: override?.description ?? builtinBase.description,
      systemPrompt: override?.systemPrompt ?? builtinBase.systemPrompt,
      skillIds: override?.skillIds ?? skills.map((s) => s.id),
      tools: override?.tools ?? tools.map((t) => t.name),
    })
    setHydrated(true)
  }

  const goBack = () => { track('agents', 'back_to_agents'); navigate('/customize') }

  const toggleSkill = (id: string) =>
    setForm((f) => ({ ...f, skillIds: f.skillIds.includes(id) ? f.skillIds.filter((s) => s !== id) : [...f.skillIds, id] }))

  const handleSave = () => {
    if (!form.name.trim()) { toast.error('Name is required.'); return }
    setSaving(true)
    const payload = { name: form.name.trim(), description: form.description.trim(), systemPrompt: form.systemPrompt, skillIds: form.skillIds, tools: form.tools }
    if (isBuiltin) {
      overrideMut.save.mutate({ id: agentId, override: payload }, {
        onSuccess: () => { toast.success('Agent saved.'); goBack() },
        onError: (e) => { toast.error(e instanceof ApiError ? e.message : 'Could not save agent.'); setSaving(false) },
      })
      return
    }
    const opts = {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['chat-agents'] })
        toast.success(isNew ? 'Agent created.' : 'Agent saved.')
        goBack()
      },
      onError: (e: unknown) => { toast.error(e instanceof ApiError ? e.message : 'Could not save agent.'); setSaving(false) },
    }
    if (isNew) mut.add.mutate(payload, opts)
    else mut.update.mutate({ id: agentId, patch: payload }, opts)
  }

  const handleReset = () => {
    overrideMut.reset.mutate(agentId, {
      onSuccess: () => {
        toast.success('Reset to default.')
        if (builtinBase) {
          setForm({
            name: builtinBase.name, description: builtinBase.description, systemPrompt: builtinBase.systemPrompt,
            skillIds: skills.map((s) => s.id), tools: tools.map((t) => t.name),
          })
        }
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not reset agent.'),
    })
  }

  const handleDelete = () => {
    mut.remove.mutate(agentId, {
      onSuccess: () => { toast.success('Agent deleted.'); goBack() },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete agent.'),
    })
  }

  if (!isNew && !isBuiltin && customQ.isSuccess && !custom) {
    return (
      <div className="flex w-full flex-col items-center gap-3 px-8 py-16">
        <p className="text-[14px] text-muted">That agent no longer exists.</p>
        <Button size="sm" variant="outline" onClick={goBack}>Back to agents</Button>
      </div>
    )
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to agents"><ChevronLeft size={18} /></button>
        <span className="text-[15px] font-medium text-ink">
          {isNew ? 'New agent' : isBuiltin ? (override ? 'Edit agent (modified built-in)' : 'Edit agent (built-in)') : 'Edit agent'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {isBuiltin && (
            <Button size="sm" variant="outline" onClick={() => { track('agents', 'reset_agent_to_default'); handleReset() }} disabled={overrideMut.reset.isPending}>
              <RotateCcw size={13} /> Reset to default
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={goBack}>Cancel</Button>
          <Button size="sm" onClick={() => { track('agents', 'save_agent'); handleSave() }} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {isBuiltin && (
        <p className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] text-muted">
          Built-in agents can be edited in place — Reset to default discards your changes and restores TurboLLM's original prompt and access.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">Name</label>
        <input
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
          placeholder="Release Notes Writer"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">Description</label>
        <input
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
          placeholder="What this agent is for, in one line"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">System prompt</label>
        <textarea
          className="min-h-[160px] resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent placeholder:text-faint"
          placeholder="You are…"
          value={form.systemPrompt}
          onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="inline-flex w-fit rounded-md border border-border p-0.5">
          {(['skills', 'tools'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { track('agents', 'switch_agent_form_tab'); setFormTab(t) }}
              className={cn(
                'rounded px-3 py-1.5 text-[13px] font-medium transition-colors',
                formTab === t ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink',
              )}
            >
              {t === 'skills' ? `Skills (${form.skillIds.length})` : `Tools (${form.tools.length})`}
            </button>
          ))}
        </div>

        {formTab === 'skills' ? (
          skillsQ.isLoading ? (
            <p className="text-[12px] text-faint">Loading…</p>
          ) : skills.length === 0 ? (
            <p className="text-[12px] text-faint">No skills yet — create one under Customize → Skills.</p>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-3">
              {skills.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-start gap-2 text-[13px]">
                  <input type="checkbox" className="mt-0.5" checked={form.skillIds.includes(s.id)} onChange={() => toggleSkill(s.id)} />
                  <span className="flex flex-col">
                    <span className="text-ink">{s.name}</span>
                    {s.description && <span className="text-[12px] text-muted">{s.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          )
        ) : toolsQ.isLoading ? (
          <p className="text-[12px] text-faint">Loading…</p>
        ) : (
          <ToolsChecklist tools={tools} selected={form.tools} onChange={(t) => setForm((f) => ({ ...f, tools: t }))} />
        )}
      </div>

      {!isNew && !isBuiltin && (
        deleteConfirm ? (
          <div className="flex items-center gap-2 self-start rounded-md border border-border bg-panel p-2 text-[12px]">
            <span className="flex-1 text-muted">Delete this agent?</span>
            <button type="button" onClick={() => { track('agents', 'delete_agent'); handleDelete() }} className="rounded px-2 py-1 text-[color:var(--err)] hover:bg-[color:color-mix(in_srgb,var(--err)_12%,transparent)]">Delete</button>
            <button type="button" onClick={() => { track('agents', 'cancel_delete_agent'); setDeleteConfirm(false) }} className="rounded px-2 py-1 text-faint hover:text-ink">Cancel</button>
          </div>
        ) : (
          <button type="button" onClick={() => setDeleteConfirm(true)} className="flex items-center gap-1.5 self-start text-[12px] text-faint hover:text-[color:var(--err)]">
            <Trash2 size={13} /> Delete agent
          </button>
        )
      )}
    </div>
  )
}

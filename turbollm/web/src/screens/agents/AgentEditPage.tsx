import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Trash2, Wand2, Wrench } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError } from '../../lib/api'
import {
  agentKeys, fetchAgents, createAgent, updateAgent, deleteAgent, fetchSkills, fetchAvailableTools,
} from '../../lib/agent-api'
import type { AgentType, Skill, ToolInfo } from '../../lib/agent-types'

// ── Form model ────────────────────────────────────────────────────────────────

interface AgentFormState {
  name: string
  description: string
  systemPrompt: string
  skills: string[]
  disabledTools: string[]
}

const emptyForm = (): AgentFormState => ({
  name: '',
  description: '',
  systemPrompt: '',
  skills: [],
  disabledTools: [],
})

function agentToForm(a: AgentType): AgentFormState {
  return {
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt ?? '',
    skills: a.skills,
    disabledTools: a.disabledTools ?? [],
  }
}

// ── Skill picker (which library skills this agent may use) ───────────────────
//
// Skills are an independent library (managed under the Skills tab). Here an agent
// just *references* them by id. `['*']` grants every skill, including ones added
// later, without listing them individually.

function SkillsPicker({
  skills,
  setSkills,
}: {
  skills: string[]
  setSkills: (next: string[]) => void
}) {
  const skillsQ = useQuery({ queryKey: ['skills'], queryFn: fetchSkills, staleTime: 30_000 })
  const library: Skill[] = skillsQ.data ?? []
  const grantAll = skills.includes('*')

  const toggleAll = () => setSkills(grantAll ? [] : ['*'])
  const toggle = (id: string) =>
    setSkills(
      skills.includes(id)
        ? skills.filter((s) => s !== id)
        // picking a specific skill turns off blanket grant-all
        : [...skills.filter((s) => s !== '*'), id],
    )

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted">Skills</span>
        <span className="text-[11px] text-faint">
          {grantAll ? 'all skills' : `${skills.filter((s) => s !== '*').length} selected`}
        </span>
      </div>

      {/* Grant-all toggle */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg px-3 py-2 text-[12px] hover:border-accent">
        <input
          type="checkbox"
          className="mt-0.5 shrink-0 accent-[var(--accent)]"
          checked={grantAll}
          onChange={toggleAll}
        />
        <div>
          <p className="flex items-center gap-1 font-medium text-ink"><Wand2 size={12} className="text-accent" /> Grant all skills</p>
          <p className="text-faint">Includes every skill in the library, plus any added later.</p>
        </div>
      </label>

      {/* The library */}
      {skillsQ.isLoading ? (
        <p className="px-1 py-2 text-[12px] text-faint">Loading skills…</p>
      ) : library.length === 0 ? (
        <p className="px-1 py-2 text-[12px] text-faint">
          No skills yet — add some under the <Link to="/agents/skills" className="text-accent hover:underline">Skills</Link> tab.
        </p>
      ) : (
        <div className={`flex flex-col gap-1.5 ${grantAll ? 'pointer-events-none opacity-50' : ''}`}>
          {library.map((sk) => (
            <label
              key={sk.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg px-3 py-2 text-[12px] hover:border-accent"
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 accent-[var(--accent)]"
                checked={grantAll || skills.includes(sk.id)}
                onChange={() => toggle(sk.id)}
              />
              <div className="min-w-0">
                <p className="flex items-center gap-1 font-medium text-ink">
                  {sk.name}
                  {sk.builtin && <span className="rounded-sm bg-panel-2 px-1 text-[10px] text-faint">built-in</span>}
                </p>
                {sk.description && <p className="text-faint">{sk.description}</p>}
              </div>
            </label>
          ))}
        </div>
      )}

      <Link to="/agents/skills" className="self-start text-[11px] text-faint hover:text-accent">
        Manage the skill library →
      </Link>
    </div>
  )
}

// ── Tools picker (Pass D: every tool on by default; toggle off per agent) ────
//
// The full catalog — built-ins + connected MCP servers. Checked = the agent may
// use it; unchecking adds the tool to the agent's `disabledTools` denylist.

function ToolsPicker({
  disabled,
  setDisabled,
}: {
  disabled: string[]
  setDisabled: (next: string[]) => void
}) {
  const toolsQ = useQuery({ queryKey: ['agent-tools'], queryFn: fetchAvailableTools, staleTime: 30_000 })
  const tools: ToolInfo[] = toolsQ.data ?? []
  const off = new Set(disabled)
  const toggle = (name: string) =>
    setDisabled(off.has(name) ? disabled.filter((d) => d !== name) : [...disabled, name])

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted"><Wrench size={12} className="text-accent" /> Tools</span>
        {tools.length > 0 && <span className="text-[11px] text-faint">{tools.length - off.size}/{tools.length} on</span>}
      </div>
      {toolsQ.isLoading ? (
        <p className="px-1 py-2 text-[12px] text-faint">Loading tools…</p>
      ) : tools.length === 0 ? (
        <p className="px-1 py-2 text-[12px] text-faint">
          No optional tools yet. Connect an MCP server or a web-search provider in Settings → Tools.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tools.map((t) => (
            <label
              key={t.name}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg px-3 py-2 text-[12px] hover:border-accent"
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 accent-[var(--accent)]"
                checked={!off.has(t.name)}
                onChange={() => toggle(t.name)}
              />
              <div className="min-w-0">
                <p className="truncate font-mono text-[11px] font-medium text-ink">{t.name}</p>
                {t.description && <p className="text-faint">{t.description}</p>}
              </div>
            </label>
          ))}
        </div>
      )}
      <p className="text-[11px] text-faint">Read / shell / edit / write are controlled per-chat by the permission mode.</p>
    </div>
  )
}

// ── Edit page (routed: /agents/new and /agents/:id) ──────────────────────────

export function AgentEditPage({ agentId }: { agentId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isNew = agentId === 'new'

  const agentsQ = useQuery({
    queryKey: agentKeys.list(),
    queryFn: fetchAgents,
    staleTime: 0,
  })
  const agents = agentsQ.data ?? []
  const agent = isNew ? undefined : agents.find((a) => a.id === agentId)

  const [form, setForm] = useState<AgentFormState>(emptyForm())
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  // Hydrate the form from the loaded agent once (edit mode).
  if (!isNew && !hydrated && agent) {
    setForm(agentToForm(agent))
    setHydrated(true)
  }

  const goBack = () => navigate('/agents')

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Agent name is required.'); return }
    setSaving(true)
    try {
      const payload: Partial<AgentType> = {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt.trim() || undefined,
        skills: form.skills,
        disabledTools: form.disabledTools,
        // Read access is per-conversation now; agents carry no read roots.
        readRoots: [],
      }
      if (isNew) {
        await createAgent(payload)
        toast.success('Agent created.')
      } else {
        await updateAgent(agentId, payload)
        toast.success('Agent saved.')
      }
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      goBack()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save agent.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteAgent(agentId)
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      toast.success('Agent deleted.')
      goBack()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete agent.')
    }
  }

  // Edit mode but the agent id wasn't found (deleted / bad link).
  if (!isNew && agentsQ.isSuccess && !agent) {
    return (
      <div className="flex w-full flex-col items-center gap-3 px-8 py-16">
        <p className="text-[14px] text-muted">That agent no longer exists.</p>
        <Button size="sm" variant="outline" onClick={goBack}>Back to agents</Button>
      </div>
    )
  }

  const canDelete = !isNew && agent && !agent.builtin

  return (
    <div className="flex w-full flex-col gap-5 px-8 py-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to agents">
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-medium text-ink">
          {isNew ? 'New agent' : 'Edit agent'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={goBack}>Cancel</Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Two columns on wide screens: identity left, skills right. */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* ── Left: identity / persona ── */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted">Name</label>
            <input
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
              placeholder="My Agent"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted">Description</label>
            <input
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
              placeholder="What does this agent do?"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted">System prompt</label>
            <textarea
              className="min-h-[220px] flex-1 resize-y rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
              placeholder="You are a helpful assistant that…"
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            />
          </div>

          {/* Read access is per-conversation (attach a file/folder in the chat), and
              writes always go to ~/.turbollm — neither is configured here. */}

          {/* Delete — only for existing non-builtin agents */}
          {canDelete && (
            deleteConfirm ? (
              <div className="flex items-center gap-2 self-start rounded-md border border-border bg-panel p-2 text-[12px]">
                <span className="flex-1 text-muted">Delete this agent?</span>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  className="rounded px-2 py-1 text-[color:var(--err)] hover:bg-[color:color-mix(in_srgb,var(--err)_12%,transparent)]"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  className="rounded px-2 py-1 text-faint hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirm(true)}
                className="flex items-center gap-1.5 self-start text-[12px] text-faint hover:text-[color:var(--err)]"
              >
                <Trash2 size={13} />
                Delete agent
              </button>
            )
          )}
        </div>

        {/* ── Right: what the agent may use — skills + tools ── */}
        <div className="flex flex-col gap-5">
          <SkillsPicker skills={form.skills} setSkills={(next) => setForm((f) => ({ ...f, skills: next }))} />
          <div className="border-t border-border" />
          <ToolsPicker disabled={form.disabledTools} setDisabled={(next) => setForm((f) => ({ ...f, disabledTools: next }))} />
        </div>
      </div>
    </div>
  )
}

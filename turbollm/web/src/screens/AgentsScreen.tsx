import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bot, Plus, Trash2, X, Loader2, Wrench,
  CheckCircle2, XCircle, Clock, CircleDot, BookOpen,
  Play, FolderOpen, UserPlus, Shield, Target,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from '../components/ui/button'
import { toast } from '../components/ui/sonner'
import { ApiError } from '../lib/api'
import {
  agentKeys, skillKeys, agentRunKeys,
  fetchAgents, createAgent, updateAgent, deleteAgent,
  fetchSkills, saveSkill, deleteSkill,
  fetchAgentRuns, fetchAgentRun, createAgentRun, cancelAgentRun,
  subscribeRunStream,
} from '../lib/agent-api'
import type { AgentType, Skill, AgentRun, AgentRunStatus, AgentToolCall } from '../lib/agent-types'

// ── Status helpers ─────────────────────────────────────────────────────────────

const STATUS_ICON: Record<AgentRunStatus, React.ReactNode> = {
  queued:      <Clock size={12} />,
  running:     <Loader2 size={12} className="animate-spin" />,
  done:        <CheckCircle2 size={12} />,
  failed:      <XCircle size={12} />,
  cancelled:   <XCircle size={12} />,
  interrupted: <XCircle size={12} />,
}

const STATUS_COLOR: Record<AgentRunStatus, string> = {
  queued:      'text-muted',
  running:     'text-accent',
  done:        'text-green-500',
  failed:      'text-red-500',
  cancelled:   'text-muted',
  interrupted: 'text-orange-500',
}

function StatusBadge({ status }: { status: AgentRunStatus }) {
  return (
    <span className={cn('flex items-center gap-1 text-[11px] capitalize', STATUS_COLOR[status])}>
      {STATUS_ICON[status]}{status}
    </span>
  )
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString()
}

// ── Tool call row ──────────────────────────────────────────────────────────────

interface LiveToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'pending' | 'done' | 'error'
  result?: string
}

function ToolCallRow({ call }: { call: AgentToolCall | LiveToolCall }) {
  const [open, setOpen] = useState(false)
  const liveStatus = 'status' in call ? (call as LiveToolCall).status : 'done'
  const summary =
    typeof call.args?.query === 'string' ? call.args.query
    : typeof call.args?.url === 'string' ? call.args.url
    : typeof call.args?.path === 'string' ? call.args.path
    : JSON.stringify(call.args ?? {}).slice(0, 80)
  const result = 'result' in call ? call.result : undefined

  return (
    <div className="w-full max-w-[85%] rounded-lg border border-border bg-panel px-2.5 py-1.5 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left text-muted hover:text-ink"
      >
        {liveStatus === 'pending'
          ? <Loader2 size={12} className="shrink-0 text-accent animate-spin" />
          : liveStatus === 'error'
          ? <XCircle size={12} className="shrink-0 text-red-500" />
          : <Wrench size={12} className="shrink-0 text-accent" />}
        <span className="font-medium text-ink">{call.name}</span>
        <span className="truncate text-faint">{summary}</span>
      </button>
      {open && (
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-2 text-[11px] text-muted">
          {result ?? JSON.stringify(call.args, null, 2)}
        </pre>
      )}
    </div>
  )
}

// ── Run detail (streaming) ─────────────────────────────────────────────────────

function RunDetail({ run }: { run: AgentRun }) {
  const qc = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)
  const [liveContent, setLiveContent] = useState('')
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  const cancel = useMutation({
    mutationFn: () => cancelAgentRun(run.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentRunKeys.list() }),
  })

  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'queued') return
    const ac = new AbortController()
    abortRef.current = ac
    let content = ''

    void (async () => {
      try {
        for await (const ev of subscribeRunStream(run.id, 0, ac.signal)) {
          if (ev.event === 'delta') {
            content += (ev.data as { delta: string }).delta
            setLiveContent(content)
          } else if (ev.event === 'tool_call') {
            const tc = ev.data as LiveToolCall
            setLiveToolCalls((prev) => {
              const idx = prev.findIndex((t) => t.id === tc.id)
              if (idx >= 0) {
                const next = [...prev]; next[idx] = tc; return next
              }
              return [...prev, tc]
            })
          } else if (ev.event === 'done' || ev.event === 'error') {
            setLiveContent('')
            setLiveToolCalls([])
            void qc.invalidateQueries({ queryKey: agentRunKeys.detail(run.id) })
            void qc.invalidateQueries({ queryKey: agentRunKeys.list() })
            break
          }
        }
      } catch { /* aborted or closed */ }
    })()

    return () => { ac.abort(); abortRef.current = null }
  }, [run.id, run.status, qc])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveContent, run.messages?.length, liveToolCalls.length])

  const messages = run.messages ?? []
  const isActive = run.status === 'running' || run.status === 'queued'

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{run.title}</p>
          <StatusBadge status={run.status} />
        </div>
        {isActive && (
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="ml-3 shrink-0 rounded-lg border border-border px-3 py-1 text-[12px] text-muted transition-colors hover:border-red-400 hover:text-red-500 disabled:opacity-50"
          >
            {cancel.isPending ? <Loader2 size={12} className="inline animate-spin" /> : 'Cancel'}
          </button>
        )}
      </div>

      <div className="slim-scroll flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((msg) => (
          <div key={msg.id} className={cn('flex flex-col gap-1.5', msg.role === 'user' ? 'items-end' : 'items-start')}>
            {msg.toolCalls?.map((tc) => <ToolCallRow key={tc.id} call={tc} />)}
            {(msg.content || (msg.role === 'assistant' && isActive)) && (
              <div className={cn(
                'max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed',
                msg.role === 'user' ? 'bg-accent/15 text-ink' : 'bg-panel-2 text-ink',
              )}>
                <p className="whitespace-pre-wrap break-words">{msg.content || '…'}</p>
              </div>
            )}
          </div>
        ))}

        {liveToolCalls.map((tc) => (
          <div key={tc.id} className="flex flex-col items-start gap-1.5">
            <ToolCallRow call={tc} />
          </div>
        ))}

        {liveContent && (
          <div className="flex items-start">
            <div className="max-w-[85%] rounded-xl bg-panel-2 px-3 py-2 text-[13px] leading-relaxed text-ink">
              <p className="whitespace-pre-wrap break-words">{liveContent}</p>
            </div>
          </div>
        )}

        {isActive && !liveContent && liveToolCalls.length === 0 && messages.length === 0 && (
          <div className="flex items-center gap-2 py-4">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span className="text-[12px] text-muted">Starting…</span>
          </div>
        )}

        {run.error && (
          <div
            className="rounded-lg px-3 py-2 text-[12px]"
            style={{ background: 'color-mix(in srgb, var(--err) 10%, transparent)', color: 'var(--err)' }}
          >
            Error: {run.error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ── New Contract dialog ────────────────────────────────────────────────────────

function NewContractDialog({
  agents,
  onClose,
  onCreated,
}: {
  agents: AgentType[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [task, setTask] = useState('')
  const qc = useQueryClient()

  const create = useMutation({
    mutationFn: () =>
      createAgentRun(agentId, {
        title: task.slice(0, 60) || 'Contract',
        userMessage: task,
      }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: agentRunKeys.list() })
      onCreated(run.id)
      onClose()
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not start contract.'),
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target size={15} className="text-accent" />
            <h2 className="text-[15px] font-semibold text-ink">New contract</h2>
          </div>
          <button type="button" onClick={onClose} className="text-faint hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <label className="mb-1 block text-[12px] text-muted">Assign to agent</label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="mb-3 w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        <label className="mb-1 block text-[12px] text-muted">Task</label>
        <textarea
          autoFocus
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe what the agent should do…"
          rows={5}
          className="mb-4 w-full resize-none rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:text-ink"
          >
            Cancel
          </button>
          <Button
            size="sm"
            disabled={!task.trim() || !agentId || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            Run
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Contracts tab ──────────────────────────────────────────────────────────────

function ContractsTab({ agents }: { agents: AgentType[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)

  const runsQ = useQuery({
    queryKey: agentRunKeys.list(),
    queryFn: fetchAgentRuns,
    refetchInterval: (q) => {
      const runs = q.state.data ?? []
      return runs.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false
    },
  })

  const detailQ = useQuery({
    queryKey: agentRunKeys.detail(selectedId ?? ''),
    queryFn: () => fetchAgentRun(selectedId!),
    enabled: !!selectedId,
    refetchInterval: (q) => {
      const r = q.state.data
      return (r?.status === 'queued' || r?.status === 'running') ? 5000 : false
    },
  })

  const runs = runsQ.data ?? []
  const selected = detailQ.data
  const agentMap: Record<string, string> = Object.fromEntries(agents.map((a) => [a.id, a.name]))

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[13px] font-semibold text-ink">Contracts</span>
          <Button size="sm" onClick={() => setShowNew(true)} className="h-6 px-2 text-[11px]">
            <Plus size={11} /> New
          </Button>
        </div>

        <div className="slim-scroll flex-1 overflow-y-auto">
          {runsQ.isLoading && (
            <div className="flex h-20 items-center justify-center">
              <Loader2 size={16} className="animate-spin text-faint" />
            </div>
          )}
          {!runsQ.isLoading && runs.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Target size={24} className="mx-auto mb-2 text-faint" />
              <p className="text-[12px] text-muted">No contracts yet.</p>
              <p className="mt-0.5 text-[11px] text-faint">Click "New" to assign a task.</p>
            </div>
          )}
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => setSelectedId(run.id)}
              className={cn(
                'w-full border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-panel-2',
                selectedId === run.id && 'bg-panel-2',
              )}
            >
              <p className="mb-0.5 truncate text-[13px] font-medium text-ink">{run.title}</p>
              {run.agentId && agentMap[run.agentId] && (
                <p className="mb-0.5 truncate text-[11px] text-faint">{agentMap[run.agentId]}</p>
              )}
              <div className="flex items-center justify-between">
                <StatusBadge status={run.status} />
                <span className="text-[10px] text-faint">{relTime(run.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedId ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <CircleDot size={32} className="mb-3 text-faint" />
            <p className="text-[14px] font-medium text-ink">Select a contract</p>
            <p className="mt-1 text-[12px] text-muted">or assign a new task to an agent</p>
            <Button className="mt-4" size="sm" onClick={() => setShowNew(true)}>
              <Play size={13} /> New contract
            </Button>
          </div>
        ) : detailQ.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-faint" />
          </div>
        ) : selected ? (
          <RunDetail run={selected} />
        ) : null}
      </div>

      {showNew && (
        <NewContractDialog
          agents={agents}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setSelectedId(id); void runsQ.refetch() }}
        />
      )}
    </div>
  )
}

// ── Agent form ─────────────────────────────────────────────────────────────────

type AgentFormState = {
  name: string
  description: string
  skillsAllStar: boolean
  selectedSkillIds: string[]
  readRootsText: string
  maxIterations: string
}

function agentToForm(agent: AgentType): AgentFormState {
  const allStar = agent.skills.includes('*')
  return {
    name: agent.name,
    description: agent.description,
    skillsAllStar: allStar,
    selectedSkillIds: allStar ? [] : [...agent.skills],
    readRootsText: agent.readRoots.join('\n'),
    maxIterations: agent.maxIterations != null ? String(agent.maxIterations) : '',
  }
}

function formToAgentPatch(form: AgentFormState): Partial<AgentType> {
  const skills = form.skillsAllStar ? ['*'] : form.selectedSkillIds
  const readRoots = form.readRootsText.split('\n').map((s) => s.trim()).filter(Boolean)
  const maxIter = form.maxIterations.trim() ? parseInt(form.maxIterations, 10) : undefined
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    skills,
    readRoots,
    ...(maxIter != null && !isNaN(maxIter) ? { maxIterations: maxIter } : {}),
  }
}

function AgentFormPanel({
  agent,
  skills,
  onSave,
  onCancel,
  onDelete,
  busy,
}: {
  agent: AgentType | null
  skills: Skill[]
  onSave: (patch: Partial<AgentType>) => void
  onCancel: () => void
  onDelete?: () => void
  busy: boolean
}) {
  const [form, setForm] = useState<AgentFormState>(() =>
    agent ? agentToForm(agent) : {
      name: '', description: '', skillsAllStar: false,
      selectedSkillIds: [], readRootsText: '', maxIterations: '',
    }
  )
  const set = (patch: Partial<AgentFormState>) => setForm((p) => ({ ...p, ...patch }))

  const isBuiltin = agent?.builtin ?? false
  const writeRoot = (agent?.writeRoots[0]) ?? '~/.turbollm'

  const toggleSkill = (id: string) => {
    set({
      selectedSkillIds: form.selectedSkillIds.includes(id)
        ? form.selectedSkillIds.filter((s) => s !== id)
        : [...form.selectedSkillIds, id],
    })
  }

  const handleSave = () => {
    if (!form.name.trim()) { toast.error('Name is required.'); return }
    onSave(formToAgentPatch(form))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={15} className="text-accent" />
          <span className="text-[14px] font-semibold text-ink">
            {agent ? (isBuiltin ? 'Default agent' : 'Edit agent') : 'Hire a hitman'}
          </span>
          {isBuiltin && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' }}
            >
              built-in
            </span>
          )}
        </div>
        <button type="button" onClick={onCancel} className="text-faint hover:text-ink">
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="slim-scroll flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* Name */}
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">
            Name <span style={{ color: 'var(--err)' }}>*</span>
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            disabled={isBuiltin}
            placeholder="e.g. Research Agent"
            className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="What does this agent specialise in?"
            rows={2}
            className="resize-none rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>

        {/* Skills */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] text-muted">Skills</label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-panel-2">
            <input
              type="checkbox"
              checked={form.skillsAllStar}
              onChange={(e) => set({ skillsAllStar: e.target.checked, selectedSkillIds: [] })}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            <span className="text-[13px] font-medium text-ink">All skills</span>
            <span className="ml-auto text-[11px] text-faint">grants every skill</span>
          </label>

          {!form.skillsAllStar && skills.length > 0 && (
            <div className="space-y-0.5 rounded-lg border border-border p-2">
              {skills.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2"
                >
                  <input
                    type="checkbox"
                    checked={form.selectedSkillIds.includes(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{skill.name}</span>
                    {skill.description && (
                      <span className="block text-[11px] leading-snug text-faint">{skill.description}</span>
                    )}
                  </span>
                  {skill.builtin && (
                    <span
                      className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
                      style={{ background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' }}
                    >
                      built-in
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}

          {!form.skillsAllStar && skills.length === 0 && (
            <p className="text-[12px] text-faint">
              No skills yet — create some in the Skills tab.
            </p>
          )}
        </div>

        {/* Read folders */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <FolderOpen size={12} className="text-muted" />
            <label className="text-[12px] text-muted">Read folders</label>
          </div>
          <textarea
            value={form.readRootsText}
            onChange={(e) => set({ readRootsText: e.target.value })}
            placeholder={'/home/user/projects\n/home/user/docs'}
            rows={3}
            className="resize-none rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <p className="text-[11px] text-faint">One absolute path per line.</p>
        </div>

        {/* Write root (read-only) */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Shield size={12} className="text-muted" />
            <label className="text-[12px] text-muted">Write root <span className="text-faint">(read-only)</span></label>
          </div>
          <input
            type="text"
            value={writeRoot}
            readOnly
            className="rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-[12px] text-faint focus:outline-none"
          />
        </div>

        {/* Max iterations */}
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">Max iterations <span className="text-faint">(optional)</span></label>
          <input
            type="number"
            value={form.maxIterations}
            onChange={(e) => set({ maxIterations: e.target.value })}
            placeholder="e.g. 20"
            min={1}
            max={500}
            className="w-28 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
        <div>
          {!isBuiltin && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="flex items-center gap-1.5 text-[12px] disabled:opacity-40"
              style={{ color: 'var(--err)' }}
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="text-[13px] text-muted hover:text-ink">
            Cancel
          </button>
          <Button size="sm" onClick={handleSave} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {agent ? 'Save' : 'Hire'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Agents tab ─────────────────────────────────────────────────────────────────

type AgentPaneMode =
  | { type: 'none' }
  | { type: 'create' }
  | { type: 'edit'; agent: AgentType }

function AgentsTab({ skills }: { skills: Skill[] }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<AgentPaneMode>({ type: 'none' })

  const agentsQ = useQuery({ queryKey: agentKeys.list(), queryFn: fetchAgents })
  const agents = agentsQ.data ?? []

  const createMut = useMutation({
    mutationFn: (patch: Partial<AgentType>) => createAgent(patch),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      toast.success(`Agent "${created.name}" hired.`)
      setMode({ type: 'edit', agent: created })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create agent.'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AgentType> }) => updateAgent(id, patch),
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      toast.success('Agent saved.')
      setMode({ type: 'edit', agent: updated })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save agent.'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      toast.success('Agent removed.')
      setMode({ type: 'none' })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove agent.'),
  })

  const busy = createMut.isPending || updateMut.isPending || deleteMut.isPending

  const handleSave = (patch: Partial<AgentType>) => {
    if (mode.type === 'create') createMut.mutate(patch)
    else if (mode.type === 'edit') updateMut.mutate({ id: mode.agent.id, patch })
  }

  const handleDelete = () => {
    if (mode.type !== 'edit') return
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove agent "${mode.agent.name}"?`)) return
    deleteMut.mutate(mode.agent.id)
  }

  const formKey =
    mode.type === 'none' ? 'none'
    : mode.type === 'create' ? 'create'
    : mode.agent.id

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[13px] font-semibold text-ink">Agents</span>
          <Button size="sm" onClick={() => setMode({ type: 'create' })} className="h-6 px-2 text-[11px]">
            <UserPlus size={11} /> Hire
          </Button>
        </div>

        <div className="slim-scroll flex-1 overflow-y-auto">
          {agentsQ.isLoading && (
            <div className="flex h-20 items-center justify-center">
              <Loader2 size={16} className="animate-spin text-faint" />
            </div>
          )}
          {agents.map((agent) => {
            const isSelected = mode.type === 'edit' && mode.agent.id === agent.id
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => setMode({ type: 'edit', agent })}
                className={cn(
                  'w-full border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-panel-2',
                  isSelected && 'bg-panel-2',
                )}
              >
                <div className="flex items-center gap-2">
                  <Bot
                    size={14}
                    className={cn('shrink-0', isSelected ? 'text-accent' : 'text-faint')}
                  />
                  <span className="flex-1 truncate text-[13px] font-medium text-ink">{agent.name}</span>
                  {agent.builtin && (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
                      style={{ background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' }}
                    >
                      default
                    </span>
                  )}
                </div>
                {agent.description && (
                  <p className="ml-5 mt-0.5 line-clamp-1 text-[11px] text-faint">{agent.description}</p>
                )}
              </button>
            )
          })}
          {!agentsQ.isLoading && agents.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Bot size={24} className="mx-auto mb-2 text-faint" />
              <p className="text-[12px] text-muted">No agents yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {mode.type === 'none' && (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <Bot size={36} className="mb-3 text-faint" />
            <p className="text-[14px] font-medium text-ink">Select an agent to edit</p>
            <p className="mt-1 text-[13px] text-muted">or hire a new one</p>
            <Button className="mt-4" size="sm" onClick={() => setMode({ type: 'create' })}>
              <UserPlus size={13} /> Hire a hitman
            </Button>
          </div>
        )}
        {mode.type !== 'none' && (
          <AgentFormPanel
            key={formKey}
            agent={mode.type === 'edit' ? mode.agent : null}
            skills={skills}
            onSave={handleSave}
            onCancel={() => setMode({ type: 'none' })}
            onDelete={mode.type === 'edit' && !mode.agent.builtin ? handleDelete : undefined}
            busy={busy}
          />
        )}
      </div>
    </div>
  )
}

// ── Skill form ─────────────────────────────────────────────────────────────────

type SkillFormState = {
  id: string
  name: string
  description: string
  instructions: string
  toolsText: string
}

function skillToForm(skill: Skill): SkillFormState {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    toolsText: skill.tools.join(', '),
  }
}

function formToSkill(form: SkillFormState): Skill {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    instructions: form.instructions,
    tools: form.toolsText.split(',').map((s) => s.trim()).filter(Boolean),
  }
}

function SkillFormPanel({
  skill,
  onSave,
  onCancel,
  onDelete,
  busy,
}: {
  skill: Skill | null
  onSave: (s: Skill) => void
  onCancel: () => void
  onDelete?: () => void
  busy: boolean
}) {
  const [form, setForm] = useState<SkillFormState>(() =>
    skill ? skillToForm(skill) : { id: '', name: '', description: '', instructions: '', toolsText: '' }
  )
  const set = (patch: Partial<SkillFormState>) => setForm((p) => ({ ...p, ...patch }))
  const isBuiltin = skill?.builtin ?? false

  const handleSave = () => {
    if (!form.id.trim()) { toast.error('ID is required.'); return }
    if (!form.name.trim()) { toast.error('Name is required.'); return }
    if (!/^[a-z0-9-]+$/.test(form.id.trim())) {
      toast.error('ID must be kebab-case: lowercase letters, numbers, and hyphens only.')
      return
    }
    onSave(formToSkill(form))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <BookOpen size={15} className="text-accent" />
          <span className="text-[14px] font-semibold text-ink">
            {skill ? (isBuiltin ? 'Built-in skill' : 'Edit skill') : 'New skill'}
          </span>
          {isBuiltin && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' }}
            >
              built-in
            </span>
          )}
        </div>
        <button type="button" onClick={onCancel} className="text-faint hover:text-ink">
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="slim-scroll flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-[12px] text-muted">
              ID <span style={{ color: 'var(--err)' }}>*</span>
            </label>
            <input
              type="text"
              value={form.id}
              onChange={(e) =>
                set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
              }
              disabled={!!skill}
              placeholder="my-skill"
              className="rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-[12px] text-muted">
              Name <span style={{ color: 'var(--err)' }}>*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              disabled={isBuiltin}
              placeholder="My Skill"
              className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            disabled={isBuiltin}
            placeholder="Short summary of what this skill enables"
            className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">Instructions</label>
          <textarea
            value={form.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            disabled={isBuiltin}
            placeholder="Describe what the agent should do when this skill is active…"
            rows={7}
            className="resize-none rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">
            Tools <span className="text-faint">(comma-separated)</span>
          </label>
          <input
            type="text"
            value={form.toolsText}
            onChange={(e) => set({ toolsText: e.target.value })}
            disabled={isBuiltin}
            placeholder="read_file, write_file, search_web"
            className="rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
        <div>
          {!isBuiltin && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="flex items-center gap-1.5 text-[12px] disabled:opacity-40"
              style={{ color: 'var(--err)' }}
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="text-[13px] text-muted hover:text-ink">
            {isBuiltin ? 'Close' : 'Cancel'}
          </button>
          {!isBuiltin && (
            <Button size="sm" onClick={handleSave} disabled={busy}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              {skill ? 'Save' : 'Create'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Skills tab ─────────────────────────────────────────────────────────────────

type SkillPaneMode =
  | { type: 'none' }
  | { type: 'create' }
  | { type: 'edit'; skill: Skill }

function SkillsTab() {
  const qc = useQueryClient()
  const [mode, setMode] = useState<SkillPaneMode>({ type: 'none' })

  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills })
  const skills = skillsQ.data ?? []

  const saveMut = useMutation({
    mutationFn: (skill: Skill) => saveSkill(skill),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: skillKeys.list() })
      toast.success(mode.type === 'create' ? `Skill "${saved.name}" created.` : 'Skill saved.')
      setMode({ type: 'edit', skill: saved })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save skill.'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSkill(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: skillKeys.list() })
      toast.success('Skill removed.')
      setMode({ type: 'none' })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove skill.'),
  })

  const busy = saveMut.isPending || deleteMut.isPending

  const handleDelete = () => {
    if (mode.type !== 'edit') return
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove skill "${mode.skill.name}"?`)) return
    deleteMut.mutate(mode.skill.id)
  }

  const formKey =
    mode.type === 'none' ? 'none'
    : mode.type === 'create' ? 'create'
    : mode.skill.id

  const builtin = skills.filter((s) => s.builtin)
  const custom = skills.filter((s) => !s.builtin)

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[13px] font-semibold text-ink">Skills</span>
          <Button size="sm" onClick={() => setMode({ type: 'create' })} className="h-6 px-2 text-[11px]">
            <Plus size={11} /> New
          </Button>
        </div>

        <div className="slim-scroll flex-1 overflow-y-auto">
          {skillsQ.isLoading && (
            <div className="flex h-20 items-center justify-center">
              <Loader2 size={16} className="animate-spin text-faint" />
            </div>
          )}

          {builtin.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                Built-in
              </div>
              {builtin.map((skill) => {
                const isSelected = mode.type === 'edit' && mode.skill.id === skill.id
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setMode({ type: 'edit', skill })}
                    className={cn(
                      'w-full border-b border-border px-3 py-2 text-left transition-colors hover:bg-panel-2',
                      isSelected && 'bg-panel-2',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Wrench size={12} className={isSelected ? 'text-accent' : 'text-faint'} />
                      <span className="flex-1 truncate text-[13px] text-ink">{skill.name}</span>
                    </div>
                  </button>
                )
              })}
            </>
          )}

          {custom.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                Custom
              </div>
              {custom.map((skill) => {
                const isSelected = mode.type === 'edit' && mode.skill.id === skill.id
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setMode({ type: 'edit', skill })}
                    className={cn(
                      'w-full border-b border-border px-3 py-2 text-left transition-colors hover:bg-panel-2',
                      isSelected && 'bg-panel-2',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <BookOpen size={12} className={isSelected ? 'text-accent' : 'text-faint'} />
                      <span className="flex-1 truncate text-[13px] text-ink">{skill.name}</span>
                    </div>
                    {skill.description && (
                      <p className="ml-4 mt-0.5 line-clamp-1 text-[11px] text-faint">{skill.description}</p>
                    )}
                  </button>
                )
              })}
            </>
          )}

          {!skillsQ.isLoading && skills.length === 0 && (
            <div className="px-4 py-8 text-center">
              <BookOpen size={24} className="mx-auto mb-2 text-faint" />
              <p className="text-[12px] text-muted">No skills yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {mode.type === 'none' && (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <BookOpen size={36} className="mb-3 text-faint" />
            <p className="text-[14px] font-medium text-ink">Select a skill to view</p>
            <p className="mt-1 text-[13px] text-muted">or create a new one</p>
            <Button className="mt-4" size="sm" onClick={() => setMode({ type: 'create' })}>
              <Plus size={13} /> New skill
            </Button>
          </div>
        )}
        {mode.type !== 'none' && (
          <SkillFormPanel
            key={formKey}
            skill={mode.type === 'edit' ? mode.skill : null}
            onSave={(s) => saveMut.mutate(s)}
            onCancel={() => setMode({ type: 'none' })}
            onDelete={mode.type === 'edit' && !mode.skill.builtin ? handleDelete : undefined}
            busy={busy}
          />
        )}
      </div>
    </div>
  )
}

// ── Main screen ────────────────────────────────────────────────────────────────

type Tab = 'agents' | 'skills' | 'contracts'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'agents',    label: 'Agents',    icon: <Bot size={14} /> },
  { id: 'skills',    label: 'Skills',    icon: <BookOpen size={14} /> },
  { id: 'contracts', label: 'Contracts', icon: <Target size={14} /> },
]

export function AgentsScreen() {
  const [tab, setTab] = useState<Tab>('agents')

  // Pre-fetch both at root so child tabs share the cache without duplicate requests
  const agentsQ = useQuery({ queryKey: agentKeys.list(), queryFn: fetchAgents })
  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills })

  const agents = agentsQ.data ?? []
  const skills = skillsQ.data ?? []

  return (
    <div className="flex h-full flex-col">
      {/* Top bar with title + tab nav */}
      <div className="flex shrink-0 items-end gap-0 border-b border-border px-4 pt-3">
        <div className="mb-2.5 mr-6 shrink-0">
          <h1 className="text-[15px] font-semibold tracking-tight text-ink">Agents</h1>
          <p className="text-[11px] text-faint">Hire, configure, and run autonomous workers</p>
        </div>
        <div className="flex gap-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-0.5 text-[13px] font-medium transition-colors',
                tab === t.id
                  ? 'border-accent text-ink'
                  : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'agents'    && <AgentsTab skills={skills} />}
        {tab === 'skills'    && <SkillsTab />}
        {tab === 'contracts' && <ContractsTab agents={agents} />}
      </div>
    </div>
  )
}

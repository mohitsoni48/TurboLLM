import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown, Bot, ChevronLeft, ChevronRight, FolderOpen,
  Pencil, Plus, Search, SendHorizontal, Settings2, Square,
  Trash2, X,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { toast } from '../components/ui/sonner'
import { cn } from '../lib/utils'
import { ApiError } from '../lib/api'
import {
  agentKeys, fetchAgents, createAgent, updateAgent, deleteAgent,
} from '../lib/agent-api'
import type { AgentType } from '../lib/agent-types'
import {
  createConversation, listConversations, sendMessage, stopGeneration,
} from '../lib/chat-api'
import { useConversation, useConversationMutations } from '../lib/chat-queries'
import type { ChatSseEvent, Conversation, LiveToolCall } from '../lib/chat-types'
import { MessageBubble, StreamingBubble } from './chat/MessageBubble'
import { useStatus } from '../lib/queries'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

// ── Live streaming state ──────────────────────────────────────────────────────

interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number
  genTokens: number
  toolCalls: LiveToolCall[]
}

// ── Agent sidebar: lists agents as clickable items ───────────────────────────

function AgentConvSidebar({
  activeId,
  agentConvs,
  onSelect,
  onNew,
  collapsed,
  onToggle,
  q,
  setQ,
}: {
  activeId: string | null
  agentConvs: Conversation[]
  onSelect: (id: string) => void
  onNew: () => void
  collapsed: boolean
  onToggle: () => void
  q: string
  setQ: (v: string) => void
}) {
  const mut = useConversationMutations()
  const qc = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleDelete = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    mut.remove.mutate(conv.id, {
      onSuccess: () => {
        toast.success('Conversation deleted')
        void qc.invalidateQueries({ queryKey: ['conversations'] })
      },
      onError: () => toast.error('Could not delete conversation.'),
    })
  }

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 border-r border-border bg-panel-2 py-3">
        <Button size="icon" variant="ghost" onClick={onToggle} title="Expand sidebar" className="h-7 w-7">
          <ChevronRight size={15} />
        </Button>
        <Button size="icon" variant="ghost" onClick={onNew} title="New agent chat" className="h-7 w-7">
          <Plus size={15} />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-panel-2">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-3">
        <Button size="icon" variant="ghost" onClick={onToggle} title="Collapse sidebar" className="h-7 w-7 shrink-0">
          <ChevronLeft size={15} />
        </Button>
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-7 w-full rounded-md border border-border bg-bg pl-7 pr-2 text-[12px] text-ink outline-none placeholder:text-faint"
          />
        </div>
        <Button size="icon" variant="ghost" onClick={onNew} title="New agent chat" className="h-7 w-7 shrink-0">
          <Plus size={15} />
        </Button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {agentConvs.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-faint">
            {q ? 'No results.' : 'No agent conversations yet.'}
          </p>
        )}
        {agentConvs.map((conv) => (
          <AgentConvItem
            key={conv.id}
            conv={conv}
            active={conv.id === activeId}
            onSelect={onSelect}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  )
}

function AgentConvItem({
  conv,
  active,
  onSelect,
  onDelete,
}: {
  conv: Conversation
  active: boolean
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const mut = useConversationMutations()

  const commitRename = () => {
    setEditing(false)
    const title = draft.trim()
    if (!title || title === conv.title) { setDraft(conv.title); return }
    mut.update.mutate(
      { id: conv.id, title },
      { onError: () => { setDraft(conv.title); toast.error('Could not rename.') } },
    )
  }

  return (
    <div
      onClick={() => !editing && onSelect(conv.id)}
      className="group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 transition-colors"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
    >
      {editing ? (
        <input
          autoFocus
          className="w-full bg-transparent text-[13px] font-medium text-ink outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setDraft(conv.title); setEditing(false) }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="truncate text-[13px] font-medium text-ink"
          style={{ color: active ? 'var(--accent)' : undefined }}
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
        >
          {conv.title}
        </span>
      )}
      <span className="text-[11px] text-faint">{relTime(conv.updatedAt)}</span>
      {!editing && (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDraft(conv.title); setEditing(true) }}
            className="rounded p-1 text-faint transition-colors hover:text-ink"
            title="Rename"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => onDelete(e, conv)}
            className="rounded p-1 text-faint transition-colors hover:text-err"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Agent picker: shown when starting a new agent conversation ───────────────

function AgentPicker({
  agents,
  onPick,
}: {
  agents: AgentType[]
  onPick: (agent: AgentType) => void
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 px-8">
      <Bot size={32} className="text-faint" />
      <p className="text-[15px] font-medium text-ink">Choose an agent to chat with</p>
      <p className="text-[13px] text-muted text-center max-w-sm">
        Each agent has its own persona, skills, and folder access. Pick one to start a conversation.
      </p>
      <div className="mt-2 flex flex-col gap-2 w-full max-w-sm">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onPick(agent)}
            className="flex items-start gap-3 rounded-lg border border-border bg-panel px-4 py-3 text-left transition-colors hover:border-accent hover:bg-panel-2"
          >
            <Bot size={16} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">{agent.name}</p>
              {agent.description && (
                <p className="mt-0.5 truncate text-[12px] text-muted">{agent.description}</p>
              )}
              {agent.skills.length > 0 && (
                <p className="mt-0.5 text-[11px] text-faint">
                  Skills: {agent.skills.join(', ')}
                </p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Manage agents panel ───────────────────────────────────────────────────────

interface AgentFormState {
  name: string
  description: string
  systemPrompt: string
  skills: string[]
  readRoots: string
}

const emptyForm = (): AgentFormState => ({
  name: '',
  description: '',
  systemPrompt: '',
  skills: [],
  readRoots: '',
})

function agentToForm(a: AgentType): AgentFormState {
  return {
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt ?? '',
    skills: a.skills,
    readRoots: a.readRoots.join('\n'),
  }
}

const KNOWN_SKILLS = [
  { id: 'filesystem', label: 'Filesystem', description: 'Read files from allowed folders' },
  { id: 'code', label: 'Code execution', description: 'Run sandboxed code snippets' },
]

function ManageAgentsPanel({
  onClose,
}: {
  onClose: () => void
}) {
  const qc = useQueryClient()
  const agentsQ = useQuery({
    queryKey: agentKeys.list(),
    queryFn: fetchAgents,
    staleTime: 0,
  })
  const agents = agentsQ.data ?? []

  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<AgentFormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const openNew = () => {
    setForm(emptyForm())
    setEditingId('new')
    setDeleteConfirm(null)
  }

  const openEdit = (agent: AgentType) => {
    setForm(agentToForm(agent))
    setEditingId(agent.id)
    setDeleteConfirm(null)
  }

  const closeEdit = () => {
    setEditingId(null)
    setForm(emptyForm())
  }

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Agent name is required.'); return }
    setSaving(true)
    try {
      const payload: Partial<AgentType> = {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt.trim() || undefined,
        skills: form.skills,
        readRoots: form.readRoots.split('\n').map((l) => l.trim()).filter(Boolean),
      }
      if (editingId === 'new') {
        await createAgent(payload)
        toast.success('Agent created.')
      } else if (editingId) {
        await updateAgent(editingId, payload)
        toast.success('Agent saved.')
      }
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      closeEdit()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save agent.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAgent(id)
      void qc.invalidateQueries({ queryKey: agentKeys.list() })
      toast.success('Agent deleted.')
      if (editingId === id) closeEdit()
      setDeleteConfirm(null)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete agent.')
    }
  }

  const toggleSkill = (id: string) => {
    setForm((f) => ({
      ...f,
      skills: f.skills.includes(id) ? f.skills.filter((s) => s !== id) : [...f.skills, id],
    }))
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-panel-2">
      {/* Panel header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <span className="text-[13px] font-medium text-ink">Manage Agents</span>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={openNew} title="New agent" className="h-7 w-7">
            <Plus size={14} />
          </Button>
          <Button size="icon" variant="ghost" onClick={onClose} title="Close panel" className="h-7 w-7">
            <X size={14} />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {editingId ? (
          // ── Editor form ────────────────────────────────────────────────────
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
              <button type="button" onClick={closeEdit} className="text-faint hover:text-ink">
                <ChevronLeft size={16} />
              </button>
              <span className="text-[13px] font-medium text-ink">
                {editingId === 'new' ? 'New agent' : 'Edit agent'}
              </span>
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-muted">Name</label>
              <input
                className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
                placeholder="My Agent"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Description */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-muted">Description</label>
              <input
                className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
                placeholder="What does this agent do?"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            {/* System prompt */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-muted">System prompt</label>
              <textarea
                rows={5}
                className="resize-none rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint"
                placeholder="You are a helpful assistant that…"
                value={form.systemPrompt}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              />
            </div>

            {/* Skills */}
            <div className="flex flex-col gap-2">
              <label className="text-[12px] font-medium text-muted">Skills</label>
              {KNOWN_SKILLS.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg px-3 py-2 text-[12px] hover:border-accent"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0 accent-[var(--accent)]"
                    checked={form.skills.includes(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <div>
                    <p className="font-medium text-ink">{skill.label}</p>
                    <p className="text-faint">{skill.description}</p>
                  </div>
                </label>
              ))}
            </div>

            {/* Read folders */}
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                <FolderOpen size={13} />
                Read-access folders
              </label>
              <textarea
                rows={3}
                className="resize-none rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent placeholder:text-faint"
                placeholder={'/home/user/docs\n/home/user/projects'}
                value={form.readRoots}
                onChange={(e) => setForm((f) => ({ ...f, readRoots: e.target.value }))}
              />
              <p className="text-[11px] text-faint">One absolute path per line.</p>
            </div>

            {/* Write folder — read-only */}
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                <FolderOpen size={13} />
                Write folder
              </label>
              <div className="rounded-md border border-border bg-panel px-3 py-1.5 font-mono text-[12px] text-faint select-none">
                ~/.turbollm
              </div>
              <p className="text-[11px] text-faint">Writes go to TurboLLM's data folder — not configurable.</p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !form.name.trim()}
                className="flex-1"
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" onClick={closeEdit}>
                Cancel
              </Button>
            </div>

            {/* Delete — only for existing non-builtin agents */}
            {editingId !== 'new' && (() => {
              const agent = agents.find((a) => a.id === editingId)
              if (!agent || agent.builtin) return null
              return deleteConfirm === editingId ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-panel p-2 text-[12px]">
                  <span className="flex-1 text-muted">Delete this agent?</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(editingId)}
                    className="rounded px-2 py-1 text-[color:var(--err)] hover:bg-[color:color-mix(in_srgb,var(--err)_12%,transparent)]"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(null)}
                    className="rounded px-2 py-1 text-faint hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(editingId)}
                  className="flex items-center gap-1.5 self-start text-[12px] text-faint hover:text-[color:var(--err)]"
                >
                  <Trash2 size={13} />
                  Delete agent
                </button>
              )
            })()}
          </div>
        ) : (
          // ── Agent cards list ───────────────────────────────────────────────
          <div className="flex flex-col gap-2 p-3">
            {agentsQ.isLoading && (
              <p className="px-1 py-4 text-[12px] text-faint">Loading…</p>
            )}
            {!agentsQ.isLoading && agents.length === 0 && (
              <p className="px-1 py-4 text-[12px] text-faint">No agents yet. Create one above.</p>
            )}
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-panel px-3 py-2.5"
              >
                <Bot size={15} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{agent.name}</p>
                  {agent.description && (
                    <p className="truncate text-[11px] text-muted">{agent.description}</p>
                  )}
                  {agent.builtin && (
                    <span className="mt-0.5 inline-block text-[10px] text-faint">built-in</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => openEdit(agent)}
                  className="shrink-0 rounded p-1 text-faint hover:text-ink"
                  title="Edit agent"
                >
                  <Pencil size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function AgentsScreen() {
  const { data: status } = useStatus()
  const model = status?.model
  const engineState = status?.engine.state
  const ready = engineState === 'running' && !!model

  const qc = useQueryClient()

  // Conversation state
  const [activeId, setActiveId] = useState<string | null>(null)
  const [pickingAgent, setPickingAgent] = useState(false) // show agent picker overlay
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [manageOpen, setManageOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')

  // Chat state
  const [live, setLive] = useState<LiveState | null>(null)
  const [input, setInput] = useState('')
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const deltaTimestamps = useRef<number[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const userScrolledUp = useRef(false)

  const mut = useConversationMutations()
  const convQ = useConversation(activeId)
  const conv = convQ.data
  const messages = conv?.messages ?? []

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ), 200)
    return () => clearTimeout(t)
  }, [searchQ])

  // All conversations — filter to agent-bound ones client-side
  const allConvsQ = useQuery({
    queryKey: ['conversations', debouncedQ],
    queryFn: () => listConversations(debouncedQ || undefined),
    staleTime: 0,
    retry: false,
  })
  const agentConvs = (allConvsQ.data?.conversations ?? []).filter((c) => !!c.agentId)

  // All agents (for picker)
  const agentsQ = useQuery({
    queryKey: agentKeys.list(),
    queryFn: fetchAgents,
    staleTime: 30_000,
  })
  const agents = agentsQ.data ?? []

  // Scroll helpers
  const scrollToBottom = useCallback((force = false) => {
    const el = scrollerRef.current
    if (!el) return
    if (force || !userScrolledUp.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setShowScrollBtn(false)
    }
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const handler = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !atBottom
      setShowScrollBtn(!atBottom && !!live)
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [live])

  useEffect(() => {
    if (live) scrollToBottom()
  }, [live, scrollToBottom])

  // Auto-resize textarea
  const autoResize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // Rolling tok/s
  const pushGenToken = () => {
    const now = Date.now()
    deltaTimestamps.current.push(now)
    deltaTimestamps.current = deltaTimestamps.current.filter((t) => t > now - 2000)
    return Math.round((deltaTimestamps.current.length / 2) * 10) / 10
  }

  // SSE stream driver — same pattern as ChatScreen
  const streamFrom = async (convId: string, gen: AsyncGenerator<ChatSseEvent>) => {
    try {
      for await (const evt of gen) {
        if (evt.event === 'meta') {
          deltaTimestamps.current = []
          setLive({
            assistantId: evt.data.assistantMessageId,
            content: '',
            reasoning: '',
            progress: null,
            liveGenTps: 0,
            genTokens: 0,
            toolCalls: [],
          })
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
        } else if (evt.event === 'progress') {
          setLive((l) => l ? { ...l, progress: { phase: evt.data.phase, pct: evt.data.pct, tps: evt.data.tps } } : l)
        } else if (evt.event === 'reasoning') {
          const liveTps = pushGenToken()
          setLive((l) => l ? { ...l, reasoning: l.reasoning + evt.data.delta, progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 } : l)
        } else if (evt.event === 'delta') {
          const liveTps = pushGenToken()
          setLive((l) => l ? { ...l, content: l.content + evt.data.delta, progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 } : l)
        } else if (evt.event === 'tool_call') {
          const tc = evt.data
          setLive((l) => {
            if (!l) return l
            const existing = l.toolCalls.findIndex((x) => x.id === tc.id)
            if (existing >= 0) {
              const updated = [...l.toolCalls]
              updated[existing] = { ...updated[existing], status: tc.status, result: tc.result }
              return { ...l, toolCalls: updated }
            }
            return { ...l, toolCalls: [...l.toolCalls, { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result }] }
          })
        } else if (evt.event === 'done') {
          setLive(null)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          void qc.invalidateQueries({ queryKey: ['conversations'] })
          setTimeout(() => scrollToBottom(true), 80)
        } else if (evt.event === 'error') {
          setLive(null)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          toast.error(evt.data.message)
        }
      }
      setLive(null)
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } catch (e) {
      setLive(null)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    }
  }

  // Start a new agent conversation (after user picks an agent)
  const handleAgentPick = async (agent: AgentType) => {
    if (!ready) { toast.error('Load a model first.'); return }
    try {
      const newConv = await createConversation({
        agentId: agent.id,
        systemPrompt: agent.systemPrompt || undefined,
      })
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      setPickingAgent(false)
      setActiveId(newConv.id)
      userScrolledUp.current = false
      setInput('')
      setLive(null)
      setTimeout(() => inputRef.current?.focus(), 50)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start conversation.')
    }
  }

  const handleNew = () => {
    abortRef.current?.abort()
    setLive(null)
    setActiveId(null)
    setInput('')
    setEditingMsgId(null)
    setPickingAgent(true)
  }

  const handleSelect = (id: string) => {
    if (live) { abortRef.current?.abort(); setLive(null) }
    setActiveId(id)
    setEditingMsgId(null)
    setPickingAgent(false)
    userScrolledUp.current = false
    setTimeout(() => scrollToBottom(true), 50)
  }

  const handleStop = async () => {
    abortRef.current?.abort()
    if (activeId) await stopGeneration(activeId).catch(() => {})
  }

  const send = async () => {
    const text = input.trim()
    if (!text || live) return
    if (!ready) { toast.error('Load a model first.'); return }
    if (!activeId) { toast.error('Pick an agent first.'); return }

    setInput('')
    setTimeout(autoResize, 0)
    userScrolledUp.current = false

    const ac = new AbortController()
    abortRef.current = ac

    try {
      await streamFrom(activeId, sendMessage(activeId, text, ac.signal))
    } catch (e) {
      setLive(null)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      void qc.invalidateQueries({ queryKey: ['conversation', activeId] })
    }
  }

  const handleDelete = (m: import('../lib/chat-types').Message) => {
    if (!activeId) return
    mut.deleteMsg.mutate(
      { convId: activeId, msgId: m.id },
      { onError: () => toast.error('Could not delete message.') },
    )
  }

  // Find the agent name for the active conversation
  const activeAgent = conv?.agentId ? agents.find((a) => a.id === conv.agentId) : undefined

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: agent conversation sidebar */}
      <div
        className="shrink-0"
        style={{ width: sidebarOpen ? '14rem' : '2.5rem', transition: 'width 0.15s' }}
      >
        <AgentConvSidebar
          activeId={activeId}
          agentConvs={agentConvs}
          onSelect={handleSelect}
          onNew={handleNew}
          collapsed={!sidebarOpen}
          onToggle={() => setSidebarOpen((o) => !o)}
          q={searchQ}
          setQ={setSearchQ}
        />
      </div>

      {/* Center: chat thread */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Chat header */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          {activeAgent && (
            <div className="flex items-center gap-1.5">
              <Bot size={15} className="text-accent shrink-0" />
              <span className="text-[13px] font-medium text-ink">{activeAgent.name}</span>
              {activeAgent.skills.length > 0 && (
                <span className="text-[11px] text-faint">
                  · {activeAgent.skills.join(', ')}
                </span>
              )}
            </div>
          )}
          {!activeAgent && !pickingAgent && (
            <span className="text-[13px] text-muted">Agents</span>
          )}
          {pickingAgent && (
            <span className="text-[13px] text-muted">New conversation</span>
          )}

          {/* Manage agents toggle — right side */}
          <Button
            size="icon"
            variant="ghost"
            className={cn('ml-auto h-8 w-8', manageOpen && 'bg-panel-2')}
            onClick={() => setManageOpen((o) => !o)}
            title="Manage agents"
          >
            <Settings2 size={15} />
          </Button>
        </div>

        {/* Message area */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex w-full flex-col gap-6 px-8 py-6">

            {/* Agent picker (new conversation state) */}
            {pickingAgent && agents.length > 0 && (
              <AgentPicker agents={agents} onPick={(a) => void handleAgentPick(a)} />
            )}
            {pickingAgent && agents.length === 0 && !agentsQ.isLoading && (
              <div className="flex flex-col items-center gap-3 py-16">
                <Bot size={32} className="text-faint" />
                <p className="text-[14px] text-muted">No agents yet.</p>
                <Button size="sm" variant="outline" onClick={() => { setPickingAgent(false); setManageOpen(true) }}>
                  Create an agent
                </Button>
              </div>
            )}

            {/* Empty state (no conversation selected, not picking) */}
            {!pickingAgent && !activeId && (
              <div className="flex flex-col items-center gap-3 py-16">
                <Bot size={32} className="text-faint" />
                <p className="text-[14px] text-muted">
                  {agentConvs.length > 0
                    ? 'Select a conversation or start a new one.'
                    : 'Start a conversation with an agent.'}
                </p>
                <Button size="sm" variant="outline" onClick={handleNew}>
                  <Plus size={14} />
                  New conversation
                </Button>
              </div>
            )}

            {/* Messages */}
            {!pickingAgent && messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                isLast={i === messages.length - 1 && !live}
                onDelete={handleDelete}
                editingId={editingMsgId}
                onEdit={(msg) => setEditingMsgId(msg.id)}
                onEditSave={() => setEditingMsgId(null)}
                onEditCancel={() => setEditingMsgId(null)}
              />
            ))}

            {/* Streaming bubble */}
            {live && (
              <StreamingBubble
                content={live.content}
                reasoning={live.reasoning}
                progress={live.progress}
                liveGenTps={live.liveGenTps}
                genTokens={live.genTokens}
                toolCalls={live.toolCalls}
              />
            )}
          </div>
        </div>

        {/* Scroll-to-bottom pill */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={() => { userScrolledUp.current = false; scrollToBottom(true) }}
            className="absolute bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1.5 text-[12px] text-muted shadow-[var(--shadow-1)] hover:text-ink"
          >
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}

        {/* Composer — only shown when a conversation is active */}
        {activeId && !pickingAgent && (
          <div className="px-8 pb-5">
            <div className="w-full">
              <div className="rounded-[var(--radius-lg)] border border-border bg-panel shadow-[var(--shadow-2)] focus-within:border-[color:var(--accent)]">
                <div className="flex items-end gap-2 p-2">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-ink outline-none placeholder:overflow-hidden placeholder:whitespace-nowrap placeholder:text-faint"
                    placeholder={
                      ready
                        ? activeAgent
                          ? `Message ${activeAgent.name}…`
                          : 'Type a message…'
                        : 'Load a model to start chatting'
                    }
                    value={input}
                    disabled={!ready || !!live || !!editingMsgId}
                    onChange={(e) => { setInput(e.target.value); autoResize() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                    }}
                  />
                  {live ? (
                    <Button size="icon" variant="outline" onClick={() => void handleStop()} title="Stop (Esc)">
                      <Square size={15} />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      onClick={() => void send()}
                      disabled={!ready || !input.trim() || !!editingMsgId}
                      aria-label="Send"
                    >
                      <SendHorizontal size={15} />
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-1.5 px-1 text-[11px] text-faint">
                {model ? `${model.name} · Enter to send · Shift+Enter for newline` : 'Load a model above to start chatting'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Right: manage agents panel */}
      {manageOpen && (
        <ManageAgentsPanel onClose={() => setManageOpen(false)} />
      )}
    </div>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, FolderInput, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError } from '../../lib/api'
import {
  agentKeys, fetchAgents, createAgent, updateAgent, deleteAgent,
  learnFromFolder, fetchLearned, deleteLearnedSkill,
} from '../../lib/agent-api'
import type { LearnedSkill, LearnedLesson } from '../../lib/agent-api'
import type { AgentType } from '../../lib/agent-types'

// ── Form model ────────────────────────────────────────────────────────────────

interface AgentFormState {
  name: string
  description: string
  systemPrompt: string
  skills: string[]
}

const emptyForm = (): AgentFormState => ({
  name: '',
  description: '',
  systemPrompt: '',
  skills: [],
})

function agentToForm(a: AgentType): AgentFormState {
  return {
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt ?? '',
    skills: a.skills,
  }
}

const KNOWN_SKILLS = [
  { id: 'filesystem', label: 'Filesystem', description: 'Read files from allowed folders' },
  { id: 'code', label: 'Code execution', description: 'Run sandboxed code snippets' },
]

// ── Learned skills + lessons section (shown when editing an existing agent) ───

function LearnedSection({ agentId }: { agentId: string }) {
  const qc = useQueryClient()
  const [folder, setFolder] = useState('')
  const [learning, setLearning] = useState(false)

  const learnedQ = useQuery({
    queryKey: ['learned', agentId],
    queryFn: () => fetchLearned(agentId),
    staleTime: 0,
    refetchInterval: 4000,
  })
  const skills: LearnedSkill[] = learnedQ.data?.skills ?? []
  const lessons: LearnedLesson[] = learnedQ.data?.lessons ?? []

  const handleLearnFolder = async () => {
    const f = folder.trim()
    if (!f) return
    setLearning(true)
    try {
      await learnFromFolder(agentId, f)
      toast.success(`Learning a skill from ${f}… (runs in the background)`)
      setFolder('')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start learning.')
    } finally {
      setLearning(false)
    }
  }

  const handleDelete = async (skillId: string) => {
    try {
      await deleteLearnedSkill(agentId, skillId)
      void qc.invalidateQueries({ queryKey: ['learned', agentId] })
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete skill.')
    }
  }

  const empty = skills.length === 0 && lessons.length === 0

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[12px] font-medium text-muted">Skill library</span>

      {/* Learn from folder row */}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1.5 text-[12px] text-faint">
          <FolderInput size={12} />
          Learn from a folder
        </label>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent placeholder:text-faint"
            placeholder="/absolute/path/to/folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleLearnFolder() }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={learning || !folder.trim()}
            onClick={() => void handleLearnFolder()}
          >
            Learn
          </Button>
        </div>
      </div>

      {/* Skills + lessons list */}
      {empty ? (
        <p className="text-[12px] text-faint">
          No skills yet — tell an agent to "save this as a skill" in chat, or learn from a folder.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {skills.map((sk) => (
            <div
              key={sk.id}
              className="flex items-start gap-2 rounded-lg border border-border bg-panel px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{sk.name}</p>
                {sk.description && (
                  <p className="mt-0.5 text-[12px] text-muted">{sk.description}</p>
                )}
                {sk.source && (
                  <span className="mt-1 inline-block rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint">
                    from {sk.source}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(sk.id)}
                className="mt-0.5 shrink-0 rounded p-1 text-faint transition-colors hover:text-[color:var(--err)]"
                title="Delete skill"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {lessons.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-panel px-3 py-2.5">
              <p className="mb-1 text-[11px] font-medium text-muted">Lessons</p>
              {lessons.map((ls) => (
                <p key={ls.id} className="text-[12px] text-ink">· {ls.lesson}</p>
              ))}
            </div>
          )}
        </div>
      )}
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

  const toggleSkill = (id: string) => {
    setForm((f) => ({
      ...f,
      skills: f.skills.includes(id) ? f.skills.filter((s) => s !== id) : [...f.skills, id],
    }))
  }

  // Edit mode but the agent id wasn't found (deleted / bad link).
  if (!isNew && agentsQ.isSuccess && !agent) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 px-6 py-16">
        <p className="text-[14px] text-muted">That agent no longer exists.</p>
        <Button size="sm" variant="outline" onClick={goBack}>Back to agents</Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to agents">
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-medium text-ink">
          {isNew ? 'New agent' : 'Edit agent'}
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
          rows={6}
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

      {/* Read access is per-conversation (attach a file/folder in the chat), and
          writes always go to ~/.turbollm — neither is configured here. */}

      {/* Learned skills + lessons — only for existing agents */}
      {!isNew && (
        <>
          <div className="border-t border-border" />
          <LearnedSection agentId={agentId} />
          <div className="border-t border-border" />
        </>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !form.name.trim()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="outline" onClick={goBack}>
          Cancel
        </Button>
      </div>

      {/* Delete — only for existing non-builtin agents */}
      {!isNew && agent && !agent.builtin && (
        deleteConfirm ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-panel p-2 text-[12px]">
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
  )
}

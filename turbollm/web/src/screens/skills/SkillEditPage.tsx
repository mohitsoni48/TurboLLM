import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError } from '../../lib/api'
import { fetchSkills, saveSkill, deleteSkill } from '../../lib/agent-api'
import type { Skill } from '../../lib/agent-types'

interface SkillForm {
  id: string
  name: string
  description: string
  instructions: string
  tools: string[]
}

const emptyForm = (): SkillForm => ({ id: '', name: '', description: '', instructions: '', tools: [] })

function toForm(s: Skill): SkillForm {
  return { id: s.id, name: s.name, description: s.description, instructions: s.instructions, tools: s.tools }
}

// Derive a kebab-case id from a name (used to prefill the id for new skills).
function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export function SkillEditPage({ skillId }: { skillId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isNew = skillId === 'new'

  const skillsQ = useQuery({ queryKey: ['skills'], queryFn: fetchSkills, staleTime: 0 })
  const skill = isNew ? undefined : (skillsQ.data ?? []).find((s) => s.id === skillId)
  const readOnly = !!skill?.builtin

  const [form, setForm] = useState<SkillForm>(emptyForm())
  const [idEdited, setIdEdited] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  if (!isNew && !hydrated && skill) {
    setForm(toForm(skill))
    setHydrated(true)
  }

  const goBack = () => navigate('/agents/skills')

  const setName = (name: string) =>
    setForm((f) => ({ ...f, name, id: isNew && !idEdited ? slugify(name) : f.id }))

  const handleSave = async () => {
    const id = form.id.trim()
    if (!form.name.trim()) { toast.error('Name is required.'); return }
    if (!id || !/^[a-z0-9-]+$/.test(id)) { toast.error('ID must be kebab-case (a-z, 0-9, -).'); return }
    if (!form.instructions.trim()) { toast.error('Instructions are required.'); return }
    setSaving(true)
    try {
      await saveSkill({
        id,
        name: form.name.trim(),
        description: form.description.trim(),
        instructions: form.instructions,
        tools: form.tools,
      })
      void qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success(isNew ? 'Skill created.' : 'Skill saved.')
      goBack()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save skill.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteSkill(skillId)
      void qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success('Skill deleted.')
      goBack()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete skill.')
    }
  }

  if (!isNew && skillsQ.isSuccess && !skill) {
    return (
      <div className="flex w-full flex-col items-center gap-3 px-8 py-16">
        <p className="text-[14px] text-muted">That skill no longer exists.</p>
        <Button size="sm" variant="outline" onClick={goBack}>Back to skills</Button>
      </div>
    )
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5 px-8 py-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to skills">
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-medium text-ink">
          {isNew ? 'New skill' : readOnly ? 'Skill (built-in)' : 'Edit skill'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={goBack}>{readOnly ? 'Back' : 'Cancel'}</Button>
          {!readOnly && (
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !form.name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>
      </div>

      {readOnly && (
        <p className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] text-muted">
          Built-in skills are read-only. Duplicate the instructions into a new skill to customise.
        </p>
      )}

      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">Name</label>
        <input
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-60"
          placeholder="Architecture Diagram"
          value={form.name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {/* ID — only editable when creating */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">ID <span className="text-faint">(kebab-case, permanent)</span></label>
        <input
          className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-60"
          placeholder="architecture-diagram"
          value={form.id}
          disabled={!isNew}
          onChange={(e) => { setIdEdited(true); setForm((f) => ({ ...f, id: e.target.value })) }}
        />
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">Description</label>
        <input
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-60"
          placeholder="What the skill does, in one line"
          value={form.description}
          disabled={readOnly}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </div>

      {/* Tools */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">Tools <span className="text-faint">(space or comma separated; optional)</span></label>
        <input
          className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-60"
          placeholder="web_search fetch_url"
          value={form.tools.join(' ')}
          disabled={readOnly}
          onChange={(e) => setForm((f) => ({ ...f, tools: e.target.value.split(/[\s,]+/).filter(Boolean) }))}
        />
      </div>

      {/* Instructions (the SKILL.md body) */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted">Instructions</label>
        <textarea
          className="min-h-[260px] resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-60"
          placeholder={'When to use this skill, and the step-by-step instructions the agent should follow…'}
          value={form.instructions}
          disabled={readOnly}
          onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
        />
      </div>

      {/* Delete — existing, non-builtin */}
      {!isNew && !readOnly && (
        deleteConfirm ? (
          <div className="flex items-center gap-2 self-start rounded-md border border-border bg-panel p-2 text-[12px]">
            <span className="flex-1 text-muted">Delete this skill?</span>
            <button type="button" onClick={() => void handleDelete()} className="rounded px-2 py-1 text-[color:var(--err)] hover:bg-[color:color-mix(in_srgb,var(--err)_12%,transparent)]">Delete</button>
            <button type="button" onClick={() => setDeleteConfirm(false)} className="rounded px-2 py-1 text-faint hover:text-ink">Cancel</button>
          </div>
        ) : (
          <button type="button" onClick={() => setDeleteConfirm(true)} className="flex items-center gap-1.5 self-start text-[12px] text-faint hover:text-[color:var(--err)]">
            <Trash2 size={13} /> Delete skill
          </button>
        )
      )}
    </div>
  )
}

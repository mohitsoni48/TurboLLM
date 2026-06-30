import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { FolderInput, Plus, Sparkles, Wrench } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError } from '../../lib/api'
import { fetchSkills, learnFromFolder } from '../../lib/agent-api'
import type { Skill } from '../../lib/agent-types'

// The shared skill library — independent of any agent. Agents reference these by
// id in their Skills picker. Learning grows the same library (the trigger agent is
// just plumbing; the resulting SKILL.md is global).
const LEARN_TRIGGER_AGENT = 'default'

function SkillCard({ skill, onOpen }: { skill: Skill; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-xl border border-border bg-panel px-4 py-3.5 text-left transition-colors hover:border-accent hover:bg-panel-2"
    >
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
          <Sparkles size={15} className="text-accent" />
        </div>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{skill.name}</span>
        {skill.builtin && <span className="shrink-0 rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint">built-in</span>}
      </div>
      {skill.description && <p className="line-clamp-2 text-[12px] text-muted">{skill.description}</p>}
      {skill.tools.length > 0 && (
        <p className="mt-auto flex items-center gap-1 truncate text-[11px] text-faint">
          <Wrench size={10} /> {skill.tools.join(', ')}
        </p>
      )}
    </button>
  )
}

export function SkillsLibrary() {
  const navigate = useNavigate()
  const skillsQ = useQuery({ queryKey: ['skills'], queryFn: fetchSkills, staleTime: 0 })
  const skills = skillsQ.data ?? []

  const [folder, setFolder] = useState('')
  const [learning, setLearning] = useState(false)
  const handleLearn = async () => {
    const f = folder.trim()
    if (!f) return
    setLearning(true)
    try {
      await learnFromFolder(LEARN_TRIGGER_AGENT, f)
      toast.success(`Learning a skill from ${f}… (runs in the background)`)
      setFolder('')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start learning.')
    } finally {
      setLearning(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-5 px-8 py-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-[18px] font-semibold text-ink">Skills</h1>
          <p className="text-[12px] text-muted">The shared library. Agents pick these in their editor; skills live independently here.</p>
        </div>
        <Button size="sm" onClick={() => navigate('/agents/skills/new')}>
          <Plus size={14} /> New skill
        </Button>
      </div>

      {/* Learn from folder */}
      <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <FolderInput size={12} /> Learn a skill from a folder
        </label>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent placeholder:text-faint"
            placeholder="/absolute/path/to/folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleLearn() }}
          />
          <Button size="sm" variant="outline" disabled={learning || !folder.trim()} onClick={() => void handleLearn()}>
            Learn
          </Button>
        </div>
      </div>

      {/* Grid */}
      {skillsQ.isLoading ? (
        <p className="py-12 text-center text-[13px] text-faint">Loading…</p>
      ) : skills.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16">
          <Sparkles size={32} className="text-faint" />
          <p className="text-[14px] text-muted">No skills yet.</p>
          <Button size="sm" variant="outline" onClick={() => navigate('/agents/skills/new')}>
            <Plus size={14} /> Create your first skill
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {skills.map((sk) => (
            <SkillCard key={sk.id} skill={sk} onOpen={() => navigate(`/agents/skills/${sk.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

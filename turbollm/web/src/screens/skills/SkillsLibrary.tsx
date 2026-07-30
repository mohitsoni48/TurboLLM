import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderInput, Plus, Sparkles, Upload, Wrench } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError } from '../../lib/api'
import { fetchSkills, importSkillText, learnFromFolder, skillKeys } from '../../lib/agent-api'
import type { Skill } from '../../lib/agent-types'

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
        {/* Badge moved to the footer so the name owns this row — see AgentsLibrary (GitHub #84). */}
        <span title={skill.name} className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{skill.name}</span>
      </div>
      {skill.description && <p className="line-clamp-2 text-[12px] text-muted">{skill.description}</p>}
      {(skill.builtin || skill.tools.length > 0) && (
        <div className="mt-auto flex items-center gap-2">
          {skill.tools.length > 0 && (
            <p className="flex min-w-0 items-center gap-1 truncate text-[11px] text-faint" title={skill.tools.join(', ')}>
              <Wrench size={10} className="shrink-0" /> {skill.tools.join(', ')}
            </p>
          )}
          {skill.builtin && (
            <span className="ml-auto shrink-0 rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint">built-in</span>
          )}
        </div>
      )}
    </button>
  )
}

export function SkillsLibrary() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, staleTime: 0 })
  const skills = skillsQ.data ?? []

  const [folder, setFolder] = useState('')
  const [learning, setLearning] = useState(false)
  const handleLearn = async () => {
    const f = folder.trim()
    if (!f) return
    setLearning(true)
    try {
      await learnFromFolder(f)
      toast.success(`Learning a skill from ${f}… (runs in the background)`)
      setFolder('')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start learning.')
    } finally {
      setLearning(false)
    }
  }

  const uploadRef = useRef<HTMLInputElement>(null)
  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    try {
      const text = await file.text()
      const skill = await importSkillText(text)
      void qc.invalidateQueries({ queryKey: skillKeys.list() })
      toast.success(`Imported skill: ${skill.name}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not import that file.')
    }
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Skills</h2>
          <p className="text-[12px] text-muted">The shared library — enable any of these in a chat, or via '/' in the composer.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input ref={uploadRef} type="file" accept=".md,text/markdown" hidden onChange={(e) => void handleUpload(e)} />
          <Button size="sm" variant="outline" onClick={() => uploadRef.current?.click()}>
            <Upload size={14} /> Upload SKILL.md
          </Button>
          <Button size="sm" onClick={() => navigate('/skills/new')}>
            <Plus size={14} /> New skill
          </Button>
        </div>
      </div>

      {/* Learn from folder */}
      <div className="mb-3 flex flex-col gap-1.5 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
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
        <p className="py-8 text-center text-[13px] text-faint">Loading…</p>
      ) : skills.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10">
          <Sparkles size={28} className="text-faint" />
          <p className="text-[13px] text-muted">No skills yet.</p>
          <Button size="sm" variant="outline" onClick={() => navigate('/skills/new')}>
            <Plus size={14} /> Create your first skill
          </Button>
        </div>
      ) : (
        // 240px, not 185px — see AgentsLibrary (GitHub #84).
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {skills.map((sk) => (
            <SkillCard key={sk.id} skill={sk} onOpen={() => navigate(`/skills/${sk.id}`)} />
          ))}
        </div>
      )}
    </section>
  )
}

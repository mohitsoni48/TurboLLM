import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { fetchSkills, skillKeys } from '../../lib/agent-api'
import { CHAT_UNSUPPORTED_SKILLS } from '../../lib/agent-types'
import { ApiError } from '../../lib/api'
import { toast } from '../../components/ui/sonner'

/** Skills every NEW chat starts with (GitHub #340), so a skill used everywhere need not be ticked per chat. A blank
 *  chat starts with these ticked in its Thread settings, where one chat can still untick them; chats that already
 *  exist keep the skills they have. Saved on each change, like the other sections here. */
export function ChatSkillsSection() {
  const { query: settingsQ, save } = useSettings()
  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, staleTime: 30_000 })
  const skills = (skillsQ.data ?? []).filter((s) => !CHAT_UNSUPPORTED_SKILLS.has(s.id))
  const selected = settingsQ.data?.defaultChatSkillIds ?? []

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((s) => s !== id)
    save.mutate(
      { defaultChatSkillIds: next },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update the skills for new chats.') },
    )
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Skills in new chats</h2>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Every new chat starts with these skills on. Untick one for a single chat in its Thread settings, or type
        <span className="font-mono"> /skill-name </span>
        in a chat to add another. Chats you already have keep their own skills.
      </p>
      {skillsQ.isLoading && <p className="text-[13px] text-faint">Loading skills…</p>}
      {!skillsQ.isLoading && skills.length === 0 && <p className="text-[13px] text-faint">No skills yet. Add them in Customize → Skills.</p>}
      {skills.length > 0 && (
        <div className="divide-y divide-border rounded-md border border-border">
          {skills.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">{s.name}</div>
                {s.description && <div className="truncate text-[11px] text-faint">{s.description}</div>}
              </div>
              <input
                type="checkbox"
                aria-label={`Start new chats with ${s.name}`}
                checked={selected.includes(s.id)}
                disabled={save.isPending}
                onChange={(e) => toggle(s.id, e.target.checked)}
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

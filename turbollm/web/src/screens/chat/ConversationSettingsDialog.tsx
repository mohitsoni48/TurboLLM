import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Settings2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTrigger,
} from '../../components/ui/dialog'
import { useConversationMutations } from '../../lib/chat-queries'
import type { Conversation } from '../../lib/chat-types'
import { ApiError } from '../../lib/api'
import { toast } from '../../components/ui/sonner'
import { skillKeys, fetchSkills } from '../../lib/agent-api'

// Skills a plain chat can't use yet — they grant filesystem tools that aren't wired
// into chat (reserved for the future Code surface). Hidden from the picker so toggling
// them on never promises a capability that silently doesn't work.
const CHAT_UNSUPPORTED_SKILLS = new Set(['filesystem'])

// Sampling fields per spec 07 §5 (identical to spec 05 §2 sliders)
const SAMPLING_FIELDS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2,   step: 0.01, def: 0.8 },
  { key: 'top_p',       label: 'Top P',       min: 0, max: 1,   step: 0.01, def: 0.95 },
  { key: 'top_k',       label: 'Top K',       min: 0, max: 200, step: 1,    def: 40 },
  { key: 'min_p',       label: 'Min P',       min: 0, max: 1,   step: 0.01, def: 0.05 },
] as const

/**
 * Per-thread settings dialog: system prompt textarea + sampling overrides.
 * Renders as a trigger button; opens a dialog on click. Changes apply to
 * the next message and don't require a model reload (spec 07 §5).
 */
export function ConversationSettingsDialog({ conv }: { conv: Conversation | undefined }) {
  const mut = useConversationMutations()
  const [open, setOpen] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [sampling, setSampling] = useState<Record<string, number>>({})
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [preserveThinking, setPreserveThinking] = useState(false)

  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, enabled: open, staleTime: 0 })
  const pickableSkills = (skillsQ.data ?? []).filter((s) => !CHAT_UNSUPPORTED_SKILLS.has(s.id))

  useEffect(() => {
    if (open && conv) {
      setSystemPrompt(conv.systemPrompt ?? '')
      setSampling(conv.sampling ?? {})
      setSkillIds(conv.skillIds ?? [])
      setPreserveThinking(conv.preserveThinking ?? false)
    }
  }, [open, conv])

  const toggleSkill = (id: string) =>
    setSkillIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))

  const hasOverrides = Object.keys(sampling).length > 0
  const isExpert = conv?.expertMode ?? false

  const setValue = (field: string, val: number) =>
    setSampling((prev) => ({ ...prev, [field]: val }))

  const resetSampling = () => setSampling({})

  const save = () => {
    if (!conv) return
    // Expert threads keep their server-managed system prompt — only sampling is editable.
    const patch = isExpert
      ? { id: conv.id, sampling, skillIds, preserveThinking }
      : { id: conv.id, systemPrompt, sampling, skillIds, preserveThinking }
    mut.update.mutate(
      patch,
      {
        onSuccess: () => { toast.success('Thread settings saved'); setOpen(false) },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save settings.'),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title="Thread settings — system prompt & sampling overrides"
          disabled={!conv}
        >
          <Settings2 size={15} />
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <div className="mb-4">
          <span className="text-[15px] font-semibold text-ink">Thread settings</span>
        </div>

        <div className="flex flex-col gap-5">
          {/* System prompt */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-faint">
              System prompt
            </label>
            {isExpert ? (
              <p className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-muted">
                System prompt is managed by TurboLLM for the Expert assistant.
              </p>
            ) : (
              <textarea
                rows={4}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Leave blank to use the model's built-in default"
                className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[14px] leading-[1.6] text-ink outline-none placeholder:text-faint focus:border-[color:var(--accent)]"
              />
            )}
          </div>

          {/* Sampling overrides */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
                Sampling overrides
              </span>
              {hasOverrides && (
                <button
                  type="button"
                  onClick={resetSampling}
                  className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Reset to model defaults
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3.5">
              {SAMPLING_FIELDS.map((f) => {
                const isSet = f.key in sampling
                const val = isSet ? (sampling[f.key] ?? f.def) : f.def
                return (
                  <div key={f.key} className="flex items-center gap-3">
                    <span
                      className="w-24 shrink-0 text-[13px]"
                      style={{ color: isSet ? 'var(--ink)' : 'var(--muted)' }}
                    >
                      {f.label}
                    </span>
                    <input
                      type="range"
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      value={val}
                      onChange={(e) => setValue(f.key, parseFloat(e.target.value))}
                      className="flex-1"
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span className="w-10 shrink-0 text-right font-mono text-[13px] tabular-nums text-ink">
                      {f.step < 1 ? val.toFixed(2) : String(Math.round(val))}
                    </span>
                  </div>
                )
              })}
            </div>

            {!hasOverrides && (
              <p className="mt-2.5 text-[12px] text-faint">
                Using model defaults · move any slider to override for this thread
              </p>
            )}
          </div>

          {/* Skills — the shared SKILL.md library, enabled per thread. Also toggleable
              inline via the '/' picker in the composer. */}
          <div>
            <span className="mb-2.5 block text-[11px] font-medium uppercase tracking-wide text-faint">
              Skills
            </span>
            {skillsQ.isLoading ? (
              <p className="text-[12px] text-faint">Loading…</p>
            ) : pickableSkills.length === 0 ? (
              <p className="text-[12px] text-faint">No skills yet — create one under Skills.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {pickableSkills.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-start gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={skillIds.includes(s.id)}
                      onChange={() => toggleSkill(s.id)}
                    />
                    <span className="flex flex-col">
                      <span className="text-ink">{s.name}</span>
                      {s.description && <span className="text-[12px] text-muted">{s.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* GitHub #52: fold past reasoning back into what's resent to the model,
              instead of only ever resending each turn's final answer. */}
          <div>
            <label className="flex cursor-pointer items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={preserveThinking}
                onChange={(e) => setPreserveThinking(e.target.checked)}
              />
              <span className="flex flex-col">
                <span className="text-ink">Preserve thinking across turns</span>
                <span className="text-[12px] text-muted">
                  Resend the model's past reasoning on later turns, not just its final answers. Off by default — uses more tokens per request.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Cancel</Button>
          </DialogClose>
          <Button size="sm" onClick={save} disabled={mut.update.isPending}>
            {mut.update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

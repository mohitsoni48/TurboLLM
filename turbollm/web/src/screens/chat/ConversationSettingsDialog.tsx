import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Settings2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog'
import { Switch } from '../../components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { useConversationMutations } from '../../lib/chat-queries'
import type { Conversation } from '../../lib/chat-types'
import { ApiError } from '../../lib/api'
import { toast } from '../../components/ui/sonner'
import { skillKeys, fetchSkills } from '../../lib/agent-api'
import { cn } from '../../lib/utils'

// Skills a plain chat can't use yet — they grant filesystem tools that aren't wired
// into chat (reserved for the future Code surface). Hidden from the picker so toggling
// them on never promises a capability that silently doesn't work.
const CHAT_UNSUPPORTED_SKILLS = new Set(['filesystem'])

// Sampling fields per spec 07 §5 (identical to spec 05 §2 sliders). `modelField` maps
// each slider to the matching key on the currently-loaded model's own Sampling block,
// so the resting position reflects that model's real defaults instead of one fixed
// constant for every model; `def` is the last-resort fallback when no model is loaded.
const SAMPLING_FIELDS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2,   step: 0.01, def: 0.8,  modelField: 'temp' as const },
  { key: 'top_p',       label: 'Top P',       min: 0, max: 1,   step: 0.01, def: 0.95, modelField: 'topP' as const },
  { key: 'top_k',       label: 'Top K',       min: 0, max: 200, step: 1,    def: 40,   modelField: 'topK' as const },
  { key: 'min_p',       label: 'Min P',       min: 0, max: 1,   step: 0.01, def: 0.05, modelField: 'minP' as const },
] as const

/** Draft thread settings for a not-yet-created conversation (a blank chat screen with a
 *  model loaded but no first message sent yet). Mirrors ChatScreen's existing
 *  `pendingSkillIds` pattern, extended to the other three thread-settings fields. */
export interface ConversationSettingsDraft {
  systemPrompt: string
  sampling: Record<string, number>
  skillIds: string[]
  preserveThinking: boolean
  onChange: (patch: Partial<{
    systemPrompt: string
    sampling: Record<string, number>
    skillIds: string[]
    preserveThinking: boolean
  }>) => void
}

/**
 * Per-thread settings dialog: system prompt textarea + sampling overrides.
 * Renders as a trigger button; opens a dialog on click. Changes apply to
 * the next message and don't require a model reload (spec 07 §5).
 *
 * Works in two modes: "live" (conv exists — Save PATCHes it) and "draft" (conv
 * doesn't exist yet but a model is loaded — Save just commits local draft state via
 * `draft.onChange`, no network call, since there's nothing to PATCH).
 */
export function ConversationSettingsDialog({
  conv,
  draft,
  modelSampling,
}: {
  conv: Conversation | undefined
  draft?: ConversationSettingsDraft
  modelSampling?: { temp: number; topP: number; topK: number; minP: number }
}) {
  const mut = useConversationMutations()
  const [open, setOpen] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [sampling, setSampling] = useState<Record<string, number>>({})
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [preserveThinking, setPreserveThinking] = useState(true)
  const [skillsOpen, setSkillsOpen] = useState(false)

  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, enabled: open, staleTime: 0 })
  const pickableSkills = (skillsQ.data ?? []).filter((s) => !CHAT_UNSUPPORTED_SKILLS.has(s.id))

  useEffect(() => {
    if (!open) return
    // The dialog component stays mounted for the lifetime of the chat screen (only
    // Radix's portal content mounts/unmounts), so local state like skillsOpen would
    // otherwise carry over from a previous open — always start the skills section
    // collapsed on every open, not just the first.
    setSkillsOpen(false)
    if (conv) {
      setSystemPrompt(conv.systemPrompt ?? '')
      setSampling(conv.sampling ?? {})
      setSkillIds(conv.skillIds ?? [])
      setPreserveThinking(conv.preserveThinking ?? false)
    } else if (draft) {
      setSystemPrompt(draft.systemPrompt ?? '')
      setSampling(draft.sampling ?? {})
      setSkillIds(draft.skillIds ?? [])
      setPreserveThinking(draft.preserveThinking ?? true)
    }
  }, [open, conv, draft])

  const toggleSkill = (id: string) =>
    setSkillIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))

  const allSkillsSelected = pickableSkills.length > 0 && pickableSkills.every((s) => skillIds.includes(s.id))
  const someSkillsSelected = pickableSkills.some((s) => skillIds.includes(s.id))
  const masterCheckboxRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (masterCheckboxRef.current) masterCheckboxRef.current.indeterminate = someSkillsSelected && !allSkillsSelected
  }, [someSkillsSelected, allSkillsSelected])
  const toggleAllSkills = () =>
    setSkillIds(allSkillsSelected ? [] : pickableSkills.map((s) => s.id))

  const hasOverrides = Object.keys(sampling).length > 0
  const isExpert = conv?.expertMode ?? false

  const setValue = (field: string, val: number) =>
    setSampling((prev) => ({ ...prev, [field]: val }))

  const resetSampling = () => setSampling({})

  const save = () => {
    if (!conv) {
      // Draft mode: nothing to PATCH yet — just commit the local draft state.
      draft?.onChange({ systemPrompt, sampling, skillIds, preserveThinking })
      setOpen(false)
      return
    }
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
          disabled={!conv && !draft}
        >
          <Settings2 size={15} />
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Thread settings</DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
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
                const modelDef = modelSampling?.[f.modelField]
                const effectiveDef = modelDef ?? f.def
                const val = isSet ? (sampling[f.key] ?? effectiveDef) : effectiveDef
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
              inline via the '/' picker in the composer. Collapsed by default; a master
              checkbox in the trigger row selects/deselects all skills at once. */}
          <Collapsible open={skillsOpen} onOpenChange={setSkillsOpen}>
            <div className="flex items-center gap-2">
              <CollapsibleTrigger className="flex flex-1 items-center gap-2 text-left">
                <ChevronRight size={14} className={cn('shrink-0 text-faint transition-transform', skillsOpen && 'rotate-90')} />
                <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
                  Skills{skillIds.length > 0 ? ` (${skillIds.length})` : ''}
                </span>
              </CollapsibleTrigger>
              {pickableSkills.length > 0 && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                  <input
                    ref={masterCheckboxRef}
                    type="checkbox"
                    checked={allSkillsSelected}
                    onChange={toggleAllSkills}
                  />
                  All
                </label>
              )}
            </div>
            <CollapsibleContent>
              <div className="mt-2.5">
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
            </CollapsibleContent>
          </Collapsible>

          {/* GitHub #52: fold past reasoning back into what's resent to the model,
              instead of only ever resending each turn's final answer. A persistent
              behavior toggle, not a feature to enable — styled as its own settings
              row (Switch) rather than a checkbox like the skills above, so it doesn't
              read as just another item in that list. */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
            <span className="flex flex-col">
              <span className="text-[13px] text-ink">Preserve thinking across turns</span>
              <span className="text-[12px] text-muted">
                Resend the model's past reasoning on later turns, not just its final answers — uses more tokens per request.
              </span>
            </span>
            <Switch checked={preserveThinking} onCheckedChange={setPreserveThinking} />
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

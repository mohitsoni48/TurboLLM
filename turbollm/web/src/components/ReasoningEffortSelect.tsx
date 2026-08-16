import { Brain } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu'

// ── Reasoning effort control (Qwen3.8) ───────────────────────────────────────────────
//
// A DIFFERENT control from ThinkingBudgetSlider, not a relabeling of it. That slider sends
// `thinking_budget_tokens` — a real sampler-enforced token cap the TurboQuant llama.cpp fork
// truncates reasoning generation at, and it works on any model that emits <think> tags.
// `reasoning_effort` is a soft, model-TRAINED tendency: it's sent as `chat_template_kwargs.
// reasoning_effort` and only has an effect on the handful of models (Qwen3.8 family, so far)
// whose own chat template branches on it — see gguf.ts's GgufMeta.reasoningEffort /
// scanner.ts's ModelEntry.reasoningEffort, which is what gates showing this control instead
// of the slider in the first place.
//
// IMPORTANT: the template `raise_exception`s on any value outside low/medium/xhigh (verified
// against the real Qwen3.8-27B chat_template.jinja) — 'off' is NOT a template value, it's
// this control's own way of disabling thinking entirely (mirrors the old slider's 0
// position); the backend (reasoning-effort.ts) translates it into `enable_thinking: false`
// rather than ever sending the literal string "off" as `reasoning_effort`.

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'xhigh'

// Labels match Qwen's own terminology verbatim for the three real template values (its chat
// template literally checks for 'low'/'medium'/'xhigh') rather than a friendlier "High" that
// would hide the real value.
const OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'xhigh', label: 'xhigh' },
]

// The template's own default when the field is omitted entirely — matches today's
// always-on-thinking behavior, so a user who never touches this control sees no change.
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'xhigh'

/** Shared with CodeStatsFooter.tsx so the footer's "Reasoning" stat and this control's own
 *  wording can never drift (same rule ThinkingBudgetSlider's formatBudget follows). */
export function reasoningEffortLabel(value: ReasoningEffort): string {
  return OPTIONS.find((o) => o.value === value)?.label ?? value
}

// Slider position <-> value — 3 discrete stops, same interaction model as
// ThinkingBudgetSlider's <input type="range"> rather than a segmented-button panel.
function indexOf(value: ReasoningEffort): number {
  return OPTIONS.findIndex((o) => o.value === value)
}

export function ReasoningEffortSelect({
  value,
  onChange,
}: {
  value: ReasoningEffort
  onChange: (v: ReasoningEffort) => void
}) {
  const active = value !== DEFAULT_REASONING_EFFORT

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Reasoning effort: ${reasoningEffortLabel(value)} — click to adjust`}
          aria-label="Reasoning effort"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-panel-2"
          style={{ color: active ? 'var(--accent)' : 'var(--faint)' }}
        >
          <Brain size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="font-medium text-ink">Reasoning effort</span>
          <span className="text-muted">{reasoningEffortLabel(value)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={OPTIONS.length - 1}
          step={1}
          value={indexOf(value)}
          onChange={(e) => onChange(OPTIONS[Number(e.target.value)].value)}
          className="w-full"
          style={{ accentColor: 'var(--accent)' }}
          aria-label="Reasoning effort"
        />
        <div className="mt-1 flex justify-between text-[10px] text-faint">
          {OPTIONS.map((o) => (
            <span key={o.value}>{o.label}</span>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

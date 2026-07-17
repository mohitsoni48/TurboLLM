import { Brain } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu'

// ── Thinking budget control ──────────────────────────────────────────────────
//
// Replaces the old on/off Brain toggle (ADR-042) with a real graduated control: the
// TurboQuant llama.cpp fork genuinely enforces a numeric reasoning token cap via a
// sampler (`thinking_budget_tokens` in the request body — see generation.ts/chat-routes.ts
// and code-session.ts's before_provider_request hook for where this value is actually
// applied). `value` is that same number: -1 = unlimited (today's default "on" behavior,
// no cap sent at all), 0 = off (no thinking generated), 1..MAX = a real token budget.
//
// The far-right slider position is deliberately "Unlimited", not a literal MAX-token
// ceiling — dragging all the way right must reproduce today's always-on-thinking default
// exactly (no cap sent), not silently introduce a new cap for users who never asked for one.
//
// Built on the shared portaled DropdownMenu primitive (same one ModelLoadMenu/CodeComposer's
// mode picker already use) rather than a hand-rolled `position: absolute` popover. The old
// version lived directly inside CodeComposer.tsx's toolbar row, which has `overflow-x-auto` as
// a narrow-viewport safety net — per the CSS Overflow spec, a container can't mix
// `overflow-x: auto` with `overflow-y: visible` (the browser forces the other axis to `auto`
// too), which silently clipped the popover's `bottom-full` panel to zero visible height. That
// read exactly like "the slider doesn't open" (confirmed live 2026-07-15), not a positioning
// bug. Rendering into `document.body` via Radix's Portal escapes that ancestor's clipping
// entirely, and Radix's Popper collision detection positions the panel automatically (matching
// how the mode picker already avoids the viewport edge) instead of a hardcoded `bottom-full`.

const MAX_BUDGET = 16_000
const STEP = 500

function formatBudget(value: number): string {
  if (value < 0) return 'Unlimited'
  if (value === 0) return 'Off'
  return `${value.toLocaleString()} tokens`
}

export function ThinkingBudgetSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const sliderValue = value < 0 ? MAX_BUDGET : Math.min(value, MAX_BUDGET)
  const active = value !== -1

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Thinking: ${formatBudget(value)} — click to adjust`}
          aria-label="Thinking budget"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-panel-2"
          style={{ color: active ? 'var(--accent)' : 'var(--faint)' }}
        >
          <Brain size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="font-medium text-ink">Thinking budget</span>
          <span className="text-muted">{formatBudget(value)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={MAX_BUDGET}
          step={STEP}
          value={sliderValue}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange(n >= MAX_BUDGET ? -1 : n)
          }}
          className="w-full"
          style={{ accentColor: 'var(--accent)' }}
          aria-label="Thinking token budget"
        />
        <div className="mt-1 flex justify-between text-[10px] text-faint">
          <span>Off</span>
          <span>Unlimited</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

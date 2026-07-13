import { useEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'

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

const MAX_BUDGET = 16_000
const STEP = 500

function formatBudget(value: number): string {
  if (value < 0) return 'Unlimited'
  if (value === 0) return 'Off'
  return `${value.toLocaleString()} tokens`
}

export function ThinkingBudgetSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const sliderValue = value < 0 ? MAX_BUDGET : Math.min(value, MAX_BUDGET)
  const active = value !== -1

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Thinking: ${formatBudget(value)} — click to adjust`}
        aria-label="Thinking budget"
        className="grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-panel-2"
        style={{ color: active ? 'var(--accent)' : 'var(--faint)' }}
      >
        <Brain size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-[var(--radius-lg)] border border-border bg-panel p-3 shadow-[var(--shadow-2)]">
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
        </div>
      )}
    </div>
  )
}

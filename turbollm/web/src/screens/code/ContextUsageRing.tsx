import { useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { track } from '../../lib/api'

// ── Context usage ring ────────────────────────────────────────────────────────
//
// A compact circular fill indicator for the composer toolbar, plus the side
// panel it opens. Deliberately NOT `ContextMeter.tsx` (the chat header's linear
// bar with 3 discrete color thresholds normal/warn/danger) — this is a ring, and
// its fill color interpolates continuously with the percentage rather than
// snapping between fixed bands. The percentage math (used/max → clamped pct) is
// the same idea as ContextMeter, just rendered differently.

const SIZE = 26
const STROKE = 3

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Continuous green→amber→red blend as a function of fill %, built from the
 *  app's own status tokens (--ok/--warn/--err) via two chained `color-mix`
 *  stages — so it stays token-driven (spec 11 §1: no hardcoded hex) while still
 *  varying smoothly with `pct`, unlike ContextMeter's hard 75%/90% cutoffs. */
function ringColor(pct: number): string {
  const p = Math.max(0, Math.min(1, pct))
  if (p <= 0.5) {
    const t = Math.round((p / 0.5) * 100)
    return `color-mix(in srgb, var(--warn) ${t}%, var(--ok) ${100 - t}%)`
  }
  const t = Math.round(((p - 0.5) / 0.5) * 100)
  return `color-mix(in srgb, var(--err) ${t}%, var(--warn) ${100 - t}%)`
}

function Ring({ pct, size = SIZE, stroke = STROKE }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = c * pct
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={ringColor(pct)}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 0.3s ease, stroke 0.3s ease' }}
      />
    </svg>
  )
}

export function ContextUsageRing({ used, max }: { used: number; max: number }) {
  const [open, setOpen] = useState(false)
  const pct = max > 0 ? used / max : 0
  const pctClamped = Math.min(1, pct)
  const pctDisplay = Math.round(pctClamped * 100)

  return (
    <>
      <button
        type="button"
        onClick={() => { track('code', 'open_context_usage_detail'); setOpen(true) }}
        title={`Context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens · ${pctDisplay}%`}
        aria-label={`Context usage, ${pctDisplay} percent — open details`}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-panel-2"
      >
        <Ring pct={pctClamped} />
      </button>

      {/* Push panel (not modal), same pattern as ModelDetailDialog — right-docked via
          the shared `.tllm-sheet` CSS, so it keeps that panel's width/animation
          instead of inventing a custom one. No explicit id/aria-labelledby here:
          Radix wires SheetTitle to the dialog's accessible name automatically —
          overriding its id (an earlier version of this file did) breaks that
          auto-detection and trips Radix's "missing DialogTitle" dev warning. */}
      <Sheet open={open} onOpenChange={setOpen} modal={false}>
        <SheetContent className="overflow-y-auto p-5" onPointerDownOutside={(e) => e.preventDefault()}>
          <SheetHeader>
            <SheetTitle>Context usage</SheetTitle>
            <SheetDescription>How much of this task's context window is filled.</SheetDescription>
          </SheetHeader>

          <div className="mt-2 flex flex-col items-center gap-3 rounded-lg border border-border bg-panel-2 py-6">
            <div className="relative grid place-items-center">
              <Ring pct={pctClamped} size={96} stroke={9} />
              <span className="absolute text-[22px] font-semibold tracking-[-0.01em] text-ink tabular-nums">{pctDisplay}%</span>
            </div>
            <span className="text-[12px] text-muted">of context window used</span>
          </div>

          <div className="mt-4 flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-[13px] text-muted">Used</span>
              <span className="text-[13px] font-medium text-ink tabular-nums">{used.toLocaleString()} tokens ({fmtTokens(used)})</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-[13px] text-muted">Max</span>
              <span className="text-[13px] font-medium text-ink tabular-nums">{max.toLocaleString()} tokens ({fmtTokens(max)})</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-[13px] text-muted">Percentage</span>
              <span className="text-[13px] font-medium tabular-nums" style={{ color: ringColor(pctClamped) }}>{pctDisplay}%</span>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

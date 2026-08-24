// Pure formatting / threshold / aggregation helpers for the hardware monitor (ADR-383).
//
// Everything the HardwareBar and the Settings gauges render flows through this module, so the
// rules live in ONE testable place instead of being re-derived (and re-drifted) in each
// component. The rules themselves are ADR-383's: fail open (null renders as —, never 0, never
// an error), amber at ≥ 85 %, red at ≥ 95 %, unified memory is ONE pool the GPU slice sits
// inside, and a CPU-only box shows no GPU groups at all (ADR-239: no dead UI).
import type { HwGpuUsage, HwUsage } from './types'

/** MB → "GB" with one decimal (the /1000, not /1024, convention this codebase uses for
 *  memory everywhere — SysInfo, profiles, the bench UI). Null → the em-dash placeholder. */
export function fmtGb(mb: number | null): string {
  if (mb === null) return '—'
  return (mb / 1000).toFixed(1)
}

/** Percent with a % sign, whole numbers only. Null → the em-dash placeholder. */
export function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${Math.round(v)}%`
}

/** Threshold tone: danger at ≥ 95, warn at ≥ 85, ok below. Null is ok — an absent value is
 *  "nothing to alarm about", and failing open means it must not paint the bar red. */
export function tone(pct: number | null): 'ok' | 'warn' | 'danger' {
  if (pct === null) return 'ok'
  if (pct >= 95) return 'danger'
  if (pct >= 85) return 'warn'
  return 'ok'
}

/** Theme-token colour for a tone. `ok` deliberately uses the ACCENT, not a success green:
 *  a healthy meter is neutral furniture, and only warn/danger may demand attention. */
export function toneColor(t: 'ok' | 'warn' | 'danger'): string {
  if (t === 'warn') return 'var(--warn)'
  if (t === 'danger') return 'var(--err)'
  return 'var(--accent)'
}

/** One pool or several? True iff the box has GPUs AND every one of them is unified. A mixed
 *  box (a dGPU beside an iGPU) is NOT unified — the dGPU has its own VRAM pool, and treating
 *  the box as unified would hide that pool inside RAM. Empty (CPU-only) is not unified either,
 *  which is what lets the bar omit the GPU groups entirely. */
export function isUnifiedBox(u: HwUsage): boolean {
  return u.gpus.length > 0 && u.gpus.every((g) => g.unified)
}

/** Collapse many cards to the one number the status bar shows: MAX utilization (a box is as
 *  busy as its busiest card) and SUMMED VRAM (the pools are separate, so the total is the
 *  total).
 *
 *  Fail-open, strictly (ADR-383): if ANY card's value is null the aggregate is null, not a
 *  sum-over-the-known-ones. Adding known and unknown bytes would print a number that LOOKS
 *  measured while silently understating usage — and a max over the known cards could show
 *  "40%" on a box whose other card is actually at 100%. A missing value means "unknown",
 *  and unknown must render as —, never as a plausible-looking wrong number. */
export function aggregateGpu(u: HwUsage): { utilPct: number | null; usedMb: number | null; totalMb: number } {
  if (u.gpus.length === 0) return { utilPct: null, usedMb: null, totalMb: 0 }
  const utils = u.gpus.map((g) => g.utilPct)
  const used = u.gpus.map((g) => g.vramUsedMb)
  const allKnown = (vs: (number | null)[]) => vs.every((v) => v !== null)
  return {
    utilPct: allKnown(utils) ? Math.max(...(utils as number[])) : null,
    usedMb: allKnown(used) ? (used as number[]).reduce((a, b) => a + b, 0) : null,
    totalMb: u.gpus.reduce((a, g) => a + g.vramTotalMb, 0),
  }
}

/** used/total as a whole percent. Null when there is nothing to divide (total 0) or the used
 *  side is unknown. */
export function ramPct(u: HwUsage): number | null {
  const { usedMb, totalMb } = u.ram
  if (totalMb <= 0) return null
  return Math.round((usedMb / totalMb) * 100)
}

/** The percent for the aggregated discrete-VRAM gauge. Null when the aggregate has no usage
 *  or no total to divide by. */
export function vramPct(u: HwUsage): number | null {
  const a = aggregateGpu(u)
  if (a.usedMb === null || a.totalMb <= 0) return null
  return Math.round((a.usedMb / a.totalMb) * 100)
}

/** The GPU's slice of the shared pool, in MB — the segmented portion inside the unified box's
 *  single memory bar. Null when the box is not unified or any card's slice is unknown
 *  (segmenting with a guessed slice would misstate both the GPU's and the rest's usage). */
export function unifiedGpuMb(u: HwUsage): number | null {
  if (!isUnifiedBox(u)) return null
  const used = u.gpus.map((g) => g.vramUsedMb)
  if (used.some((v) => v === null)) return null
  return (used as number[]).reduce((a, b) => a + b, 0)
}

/** Convenience pair used by the gauges: the percent and its tone for a (possibly null) value. */
export function pctAndTone(pct: number | null): { pct: number | null; tone: 'ok' | 'warn' | 'danger' } {
  return { pct, tone: tone(pct) }
}

export type { HwGpuUsage, HwUsage }

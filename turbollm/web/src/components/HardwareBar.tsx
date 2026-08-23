// The global hardware status bar (ADR-383): CPU, RAM, GPU and VRAM — values AND percent —
// visible on every screen, minimised to a 1.5rem strip so it reads as furniture, not a panel.
//
// Self-contained on purpose: it reads the store's `hwBar` toggle and the hwstats query itself,
// so mounting it in the Shell is one line and no screen has to plumb props through. The
// polling is tied to BOTH the toggle and this component's mountedness (`useHwUsage(enabled)`),
// and the daemon's sampler idle-stops 6 s after the last subscriber leaves — so a user who
// turns the monitor off, or navigates away from every screen that mounts it, costs the daemon
// nothing at all.
//
// Every display rule (thresholds, tones, unified-box branching, the em-dash placeholder)
// lives in hw-format.ts — this component only lays pixels out.
import { useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { track } from '../lib/api'
import { useHwUsage } from '../lib/queries'
import { useUiStore } from '../stores/ui'
import {
  aggregateGpu,
  fmtGb,
  fmtPct,
  isUnifiedBox,
  ramPct,
  tone,
  toneColor,
  unifiedGpuMb,
  vramPct,
} from '../lib/hw-format'
/** One metric: a faint label, a 3px micro-bar coloured by its tone, and the value. The bar
 *  track always renders (even at 0/unknown) so the strip's height never jitters as values
 *  land; only the fill appears when there is a number. `segment` overlays a second fill —
 *  the GPU's slice inside the unified box's single memory bar. */
function Metric({
  label,
  pct,
  display,
  segment,
}: {
  label: string
  pct: number | null
  display: string
  segment?: { widthPct: number; color: string } | null
}) {
  const fill = pct === null ? null : Math.min(100, Math.max(0, pct))
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="relative h-[3px] w-12 overflow-hidden rounded-full bg-panel">
        {fill !== null && (
          <span
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{ width: `${fill}%`, background: toneColor(tone(pct)) }}
          />
        )}
        {segment && segment.widthPct > 0 && (
          <span
            className="absolute inset-y-0 rounded-r-full"
            style={{ width: `${Math.min(100, segment.widthPct)}%`, left: 0, background: segment.color, opacity: 0.55 }}
          />
        )}
      </span>
      <span className="text-[11px] tabular-nums text-muted">{display}</span>
    </span>
  )
}

export function HardwareBar() {
  const hwBar = useUiStore((s) => s.hwBar)
  const navigate = useNavigate()

  // The bar's own height must clear the sticky Save bar in Settings (issue #178's successor):
  // index.css maps `html.tllm-hw-bar` to --tllm-hw-bar-h, which that Save bar adds to its
  // bottom offset. Toggle the class for the bar's lifetime, exactly like Shell does for
  // tllm-doc-scroll.
  useLayoutEffect(() => {
    if (!hwBar) return
    const root = document.documentElement
    root.classList.add('tllm-hw-bar')
    return () => root.classList.remove('tllm-hw-bar')
  }, [hwBar])

  // Poll only while the toggle is on AND this bar is mounted (we are mounted by the Shell,
  // which is the app's lifetime — so this is really just the toggle).
  const { data } = useHwUsage(hwBar)

  if (!hwBar) return null

  const unified = data ? isUnifiedBox(data) : false
  const agg = data ? aggregateGpu(data) : null
  const hasGpu = data ? data.gpus.length > 0 : false

  // Per-card split for the tooltip on multi-GPU boxes: the aggregate hides which card is the
  // busy one, and that is the question a user staring at a red gauge asks first.
  const tooltip: string | undefined =
    data && data.gpus.length > 1
      ? data.gpus
          .map((g) => `${g.name}: ${fmtPct(g.utilPct)} util · ${fmtGb(g.vramUsedMb)}/${fmtGb(g.vramTotalMb)} GB VRAM`)
          .join('\n')
      : undefined

  const metrics: ReactNode[] = []
  if (data) {
    metrics.push(<Metric key="cpu" label="CPU" pct={data.cpuPct} display={fmtPct(data.cpuPct)} />)
  } else {
    // Placeholders while the first sample is in flight — the strip renders at full height
    // immediately, so nothing below it jumps when the numbers land.
    metrics.push(<Metric key="cpu" label="CPU" pct={null} display="—" />)
  }

  if (unified) {
    // One pool: a single MEMORY bar for the whole shared RAM, with the GPU's slice segmented
    // inside it. Never a separate VRAM bar — that would double-count the same bytes (ADR-306).
    const p = data ? ramPct(data) : null
    const slice = data ? unifiedGpuMb(data) : null
    metrics.push(
      <Metric
        key="gpu"
        label="GPU"
        pct={agg?.utilPct ?? null}
        display={fmtPct(agg?.utilPct ?? null)}
      />,
      <Metric
        key="memory"
        label="MEMORY"
        pct={p}
        display={data ? `${fmtGb(data.ram.usedMb)} / ${fmtGb(data.ram.totalMb)} GB` : '—'}
        segment={
          slice !== null && data && data.ram.totalMb > 0
            ? { widthPct: (slice / data.ram.totalMb) * 100, color: 'var(--accent)' }
            : null
        }
      />,
    )
  } else {
    metrics.push(
      <Metric
        key="ram"
        label="RAM"
        pct={data ? ramPct(data) : null}
        display={data ? `${fmtGb(data.ram.usedMb)} / ${fmtGb(data.ram.totalMb)} GB` : '—'}
      />,
    )
    if (hasGpu || !data) {
      metrics.push(
        <Metric key="gpu" label="GPU" pct={agg?.utilPct ?? null} display={fmtPct(agg?.utilPct ?? null)} />,
        <Metric
          key="vram"
          label="VRAM"
          pct={data ? vramPct(data) : null}
          display={data ? `${fmtGb(agg?.usedMb ?? null)} / ${fmtGb(agg?.totalMb ?? 0)} GB` : '—'}
        />,
      )
    }
  }

  return (
    <button
      type="button"
      title={tooltip}
      onClick={() => {
        track('settings', 'open_system_from_hw_bar')
        navigate('/settings')
      }}
      className="sticky bottom-[var(--tllm-mobile-nav-h)] z-30 flex h-6 shrink-0 items-center gap-4 overflow-x-auto border-t border-border bg-panel-2 px-3"
      aria-label="System usage — open Settings"
    >
      {metrics}
    </button>
  )
}

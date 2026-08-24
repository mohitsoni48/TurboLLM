// Settings → System: the hardware detail view (ADR-383, plan task 7).
//
// An extraction of the old inline `HardwarePanel` from SettingsScreen.tsx — the static specs
// block renders exactly as it always did — PLUS a live layer beneath it: a gauge per metric
// (value / total + percent, coloured by tone) and a ~60 s sparkline under each gauge (30
// samples × 2 s cadence, built client-side by useUsageHistory; the daemon keeps no history).
//
// No charting library: the sparklines are inline `<svg>` polylines. Nulls are gaps, not zeros
// (fail open, ADR-383) — a run of consecutive non-null samples becomes one polyline, and a
// gap shorter than two points draws nothing at all.
import { useHwUsage, useSysInfo } from '../../lib/queries'
import {
  aggregateGpu,
  fmtGb,
  fmtPct,
  isUnifiedBox,
  ramPct,
  tone,
  toneColor,
  vramPct,
} from '../../lib/hw-format'
import { useUsageHistory } from '../../lib/use-usage-history'
import type { HwGpuUsage, HwUsage } from '../../lib/types'

/** Static spec row, kept byte-for-byte from the old HardwarePanel. */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-[13px] text-ink">{value}</dd>
    </>
  )
}

/** A ~60 s sparkline: inline SVG polylines, one per unbroken run of non-null samples.
 *  X position follows the sample's slot in the window (so a null reads as a visible gap in
 *  time), Y is the value on 0–100. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const W = 220
  const H = 28
  const runs: { x: number; y: number }[][] = []
  let run: { x: number; y: number }[] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) runs.push(run)
      run = []
      return
    }
    run.push({ x: (i / Math.max(1, values.length - 1)) * W, y: H - (Math.min(100, Math.max(0, v)) / 100) * H })
  })
  if (run.length > 1) runs.push(run)

  return (
    <svg width={W} height={H} className="block" aria-hidden="true">
      {runs.map((pts, i) => (
        <polyline
          key={i}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
        />
      ))}
    </svg>
  )
}

/** One live gauge: label, value line, a tone-coloured bar, and the sparkline beneath it. */
function Gauge({
  label,
  pct,
  detail,
  history,
}: {
  label: string
  pct: number | null
  detail?: string
  history: (number | null)[]
}) {
  const fill = pct === null ? null : Math.min(100, Math.max(0, pct))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-ink">
          {detail ? `${detail} · ` : ''}
          {fmtPct(pct)}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-panel-2">
        {fill !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{ width: `${fill}%`, background: toneColor(tone(pct)) }}
          />
        )}
      </div>
      <Sparkline values={history} />
    </div>
  )
}

export function HardwareSection() {
  const { data: sys, isLoading } = useSysInfo()
  // Poll while this section is mounted: the user opened System to look at this, so a live
  // reading is the point. The Shell's HardwareBar polls the SAME query (same key) when it is
  // on, so the two never sample twice — and whoever the last subscriber is, the daemon's
  // sampler idle-stops 6 s after they leave.
  const { data: usage } = useHwUsage(true)
  const history = useUsageHistory(usage)
  const unified = usage ? isUnifiedBox(usage) : false
  const agg = usage ? aggregateGpu(usage) : null

  const gpuHistory = (pick: (g: HwGpuUsage) => number | null, u: HwUsage | undefined, index: number): (number | null)[] =>
    history.map((h) => (h.gpus[index] ? pick(h.gpus[index]) : u?.gpus[index] ? pick(u.gpus[index]) : null))

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Hardware</h2>

      {isLoading || !sys ? (
        <p className="text-[13px] text-faint">Detecting hardware…</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {sys.gpus.length > 0 ? (
            sys.gpus.map((g, i) => (
              <StatRow
                key={i}
                label={sys.gpus.length > 1 ? `GPU ${i + 1}` : 'GPU'}
                value={`${g.name}${g.vramMb > 0 ? ` · ${(g.vramMb / 1000).toFixed(1)} GB VRAM` : ''}`}
              />
            ))
          ) : (
            <StatRow label="GPU" value="None detected (CPU-only)" />
          )}
          <StatRow label="CPU" value={`${sys.cpu || 'Unknown'} · ${sys.cores} cores`} />
          <StatRow label="RAM" value={`${(sys.ramMB / 1000).toFixed(1)} GB`} />
          <StatRow label="OS" value={sys.os} />
        </dl>
      )}

      {/* The live layer: gauges + ~60 s sparklines (ADR-383). */}
      <div className="mt-4 space-y-4 border-t border-border pt-4">
        {usage ? (
          <>
            <Gauge label="CPU" pct={usage.cpuPct} history={history.map((h) => h.cpuPct)} />
            {unified ? (
              <>
                <Gauge
                  label="Memory (unified)"
                  pct={ramPct(usage)}
                  detail={`${fmtGb(usage.ram.usedMb)} / ${fmtGb(usage.ram.totalMb)} GB`}
                  history={history.map((h) => ramPct(h))}
                />
                {usage.gpus.map((g, i) => (
                  <Gauge
                    key={i}
                    label={usage.gpus.length > 1 ? `GPU ${i + 1} · ${g.name} (utilization)` : `GPU · ${g.name} (utilization)`}
                    pct={g.utilPct}
                    history={gpuHistory((x) => x.utilPct, usage, i)}
                  />
                ))}
              </>
            ) : (
              <>
                <Gauge
                  label="RAM"
                  pct={ramPct(usage)}
                  detail={`${fmtGb(usage.ram.usedMb)} / ${fmtGb(usage.ram.totalMb)} GB`}
                  history={history.map((h) => ramPct(h))}
                />
                {usage.gpus.length > 0 ? (
                  <>
                    <Gauge
                      label={usage.gpus.length > 1 ? 'GPU (busiest card)' : 'GPU utilization'}
                      pct={agg?.utilPct ?? null}
                      history={history.map((h) => aggregateGpu(h).utilPct)}
                    />
                    <Gauge
                      label={usage.gpus.length > 1 ? 'VRAM (all cards)' : 'VRAM'}
                      pct={vramPct(usage)}
                      detail={`${fmtGb(agg?.usedMb ?? null)} / ${fmtGb(agg?.totalMb ?? 0)} GB`}
                      history={history.map((h) => vramPct(h))}
                    />
                    {usage.gpus.length > 1 &&
                      usage.gpus.map((g, i) => (
                        <Gauge
                          key={i}
                          label={`GPU ${i + 1} · ${g.name}`}
                          pct={g.utilPct}
                          detail={`${fmtGb(g.vramUsedMb)} / ${fmtGb(g.vramTotalMb)} GB`}
                          history={gpuHistory((x) => x.utilPct, usage, i)}
                        />
                      ))}
                  </>
                ) : (
                  <p className="text-[13px] text-faint">CPU-only box — nothing to gauge beyond CPU and RAM.</p>
                )}
              </>
            )}
          </>
        ) : (
          <p className="text-[13px] text-faint">Waiting for the first sample…</p>
        )}
      </div>
    </section>
  )
}

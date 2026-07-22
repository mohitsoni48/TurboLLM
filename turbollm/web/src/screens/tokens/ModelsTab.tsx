import { useState } from 'react'
import type { DailyModelBreakdown, ModelUsage } from '../../lib/types'
import { DailyBarChart } from './DailyBarChart'

const INITIAL_VISIBLE = 6

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return n.toLocaleString()
}

/** Rank-based accent shade — top model gets the full accent, later ranks fade toward
 *  the panel color. Keeps the legend and chart colors identical and theme-automatic. */
function colorForRank(rank: number): string {
  const intensity = Math.max(20, 85 - rank * 12)
  return `color-mix(in srgb, var(--accent) ${intensity}%, var(--panel-2))`
}

/** Per-model breakdown — stacked usage chart + a ranked legend with in/out split and
 *  share of total (Release 3, Models tab). This tab only ever lists CHAT models (API/gateway
 *  usage has its own tab + models list) — the "% of total" baseline is this list's own sum,
 *  not the page-level total, since that total is the combined chat+API figure (2026-07-22) and
 *  would otherwise make percentages under-report by however much of overall usage was API. */
export function ModelsTab({
  models, dailyByModel,
}: { models: ModelUsage[]; dailyByModel: DailyModelBreakdown[] }) {
  const [expanded, setExpanded] = useState(false)

  if (!models.length) {
    return <p className="py-8 text-center text-[13px] text-faint">No model usage in this range yet.</p>
  }

  const totalTokens = models.reduce((sum, m) => sum + m.totalTokens, 0)
  const rankOf = new Map(models.map((m, i) => [m.modelKey, i]))
  const chartDays = dailyByModel.map((d) => ({
    date: d.date,
    totalTokens: d.totalTokens,
    segments: [...d.byModel]
      .sort((a, b) => (rankOf.get(a.modelKey) ?? 999) - (rankOf.get(b.modelKey) ?? 999))
      .map((m) => ({ key: m.modelKey, tokens: m.tokens, color: colorForRank(rankOf.get(m.modelKey) ?? models.length) })),
  }))

  const visible = expanded ? models : models.slice(0, INITIAL_VISIBLE)
  const hiddenCount = models.length - visible.length

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-panel p-4">
        <DailyBarChart days={chartDays} />
      </div>

      <div className="flex flex-col gap-1">
        {visible.map((m, i) => (
          <div key={m.modelKey} className="flex items-center gap-3 rounded-md px-2 py-2 text-[13px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorForRank(i) }} />
            <span className="min-w-0 flex-1 truncate text-ink">{m.displayName}</span>
            <span className="shrink-0 tabular-nums text-muted">
              {formatTokenCount(m.promptTokens)} in · {formatTokenCount(m.genTokens)} out
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-faint">
              {totalTokens > 0 ? `${((m.totalTokens / totalTokens) * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-2 py-1 text-left text-[12px] text-accent hover:underline"
          >
            Show {hiddenCount} more
          </button>
        )}
      </div>
    </div>
  )
}

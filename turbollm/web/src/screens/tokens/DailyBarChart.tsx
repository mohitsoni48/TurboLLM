const CHART_HEIGHT = 160
const BAR_GAP = 2
const MIN_TOTAL_WIDTH = 320
const MIN_BAR_WIDTH = 4

export interface BarSegment {
  key: string
  tokens: number
  color: string
}

export interface BarChartDay {
  date: string
  totalTokens: number
  segments: BarSegment[]
}

function niceMax(n: number): number {
  if (n <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(n))
  const normalized = n / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function formatAxisTick(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(Math.round(n))
}

/** Daily (optionally stacked) token usage bar chart — shared by the Tokens dashboard's
 *  Overview (single series) and Models (stacked by model) tabs. Hand-rolled with plain
 *  divs, no charting library. The y-axis scale is always derived from the days actually
 *  passed in, so it re-scales per range (7d/30d/all) instead of looking blank against a
 *  fixed axis sized for a much longer window. Stretches to fill its container's full
 *  width — only falls back to a fixed (scrollable) width when there are genuinely too
 *  many days to render legibly at the container's width. */
export function DailyBarChart({ days }: { days: BarChartDay[] }) {
  if (!days.length) return null

  const rawMax = Math.max(...days.map((d) => d.totalTokens), 0)
  const axisMax = niceMax(rawMax)
  const ticks = [axisMax, axisMax * 0.75, axisMax * 0.5, axisMax * 0.25, 0]
  const labelEvery = Math.max(1, Math.ceil(days.length / 8))
  const contentMinWidth = days.length * (MIN_BAR_WIDTH + BAR_GAP)

  return (
    <div className="overflow-x-auto">
      <div className="flex" style={{ width: '100%', minWidth: Math.max(MIN_TOTAL_WIDTH, contentMinWidth) }}>
        <div
          className="flex shrink-0 flex-col justify-between pr-2 text-right text-[10px] text-faint"
          style={{ height: CHART_HEIGHT }}
        >
          {ticks.map((t) => <div key={t}>{formatAxisTick(t)}</div>)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-end border-b border-border" style={{ height: CHART_HEIGHT, gap: BAR_GAP }}>
            {days.map((d) => (
              <div
                key={d.date}
                className="flex min-w-0 flex-1 flex-col-reverse"
                title={`${d.date}: ${d.totalTokens.toLocaleString()} tokens`}
              >
                {d.segments.map((s) => (
                  <div
                    key={s.key}
                    style={{ height: axisMax > 0 ? (s.tokens / axisMax) * CHART_HEIGHT : 0, background: s.color }}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-1 flex text-[10px] text-faint" style={{ gap: BAR_GAP }}>
            {days.map((d, i) => (
              <div key={d.date} className="min-w-0 flex-1 text-center">
                {i % labelEvery === 0 || i === days.length - 1 ? d.date.slice(5) : ''}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

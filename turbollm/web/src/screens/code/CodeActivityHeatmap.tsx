import { useLayoutEffect, useRef } from 'react'
import type { CodeStatsDay as SessionDay } from '../../lib/code-types'

// ── Session heatmap (Code launchpad) ─────────────────────────────────────────
//
// Visually identical to the Usage screen's ActivityHeatmap (same cell size, gap,
// radius, and accent-tint ladder) but a separate component on purpose: the units
// differ (agent sessions per day, not tokens), so sharing the token-labelled
// tooltip/legend logic would mean threading label props through a shipped Usage
// component for a preview screen. Day-granularity only — the launchpad always
// shows the classic GitHub-style grid regardless of the stats range.

const LEVELS = [0, 20, 45, 70, 100]
const CELL = 20
const GAP = 4
const RADIUS = 4
const WEEKDAY_LABELS: Record<number, string> = { 1: 'Mon', 3: 'Wed', 5: 'Fri' }

function levelFor(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0
  const frac = total / max
  if (frac > 0.75) return 4
  if (frac > 0.5) return 3
  if (frac > 0.25) return 2
  return 1
}

function cellBg(level: number): string {
  return level === 0 ? 'var(--panel-2)' : `color-mix(in srgb, var(--accent) ${LEVELS[level]}%, var(--panel-2))`
}

function tooltipFor(day: SessionDay): string {
  return `${day.date}: ${day.sessions} agent session${day.sessions === 1 ? '' : 's'}`
}

export function CodeActivityHeatmap({ days }: { days: SessionDay[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Land scrolled to the right edge — the recent (lit-up) weeks are the point.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [days])

  if (!days.length) return null
  const max = Math.max(1, ...days.map((d) => d.sessions))

  // Weekday-align into GitHub-style columns: 7 rows (Sun–Sat), one column/week.
  const firstWeekday = new Date(`${days[0].date}T00:00:00`).getDay()
  const padded: (SessionDay | null)[] = [...(Array(firstWeekday).fill(null) as null[]), ...days]
  const weeks = Math.ceil(padded.length / 7)
  const cells: (SessionDay | null)[] = [...padded, ...(Array(weeks * 7 - padded.length).fill(null) as null[])]

  const monthLabels: { col: number; label: string }[] = []
  let lastMonth = -1
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const cell = cells[col * 7 + row]
      if (!cell) continue
      const d = new Date(`${cell.date}T00:00:00`)
      if (d.getDate() <= 7) {
        if (d.getMonth() !== lastMonth) {
          lastMonth = d.getMonth()
          monthLabels.push({ col, label: d.toLocaleDateString(undefined, { month: 'short' }) })
        }
        break
      }
    }
  }

  return (
    <div className="overflow-x-auto" ref={scrollRef}>
      <div className="inline-block">
        <div
          className="relative mb-1"
          style={{ height: 14, display: 'grid', gridTemplateColumns: `repeat(${weeks}, ${CELL}px)`, columnGap: GAP, marginLeft: 34 }}
        >
          {monthLabels.map(({ col, label }) => (
            <span key={col} style={{ gridColumn: col + 1 }} className="text-[10px] text-faint">{label}</span>
          ))}
        </div>
        <div className="flex" style={{ gap: GAP }}>
          <div className="flex w-[30px] shrink-0 flex-col pr-1" style={{ gap: GAP }}>
            {[0, 1, 2, 3, 4, 5, 6].map((row) => (
              <div key={row} style={{ height: CELL }} className="flex items-center text-[10px] text-faint">
                {WEEKDAY_LABELS[row] ?? ''}
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, gridAutoFlow: 'column', gap: GAP }}>
            {cells.map((cell, i) =>
              cell ? (
                <div
                  key={i}
                  title={tooltipFor(cell)}
                  style={{ width: CELL, height: CELL, borderRadius: RADIUS, background: cellBg(levelFor(cell.sessions, max)) }}
                />
              ) : (
                <div key={i} style={{ width: CELL, height: CELL }} />
              ),
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-muted">
          <span>Less</span>
          {LEVELS.map((l, i) => (
            <div key={l} style={{ width: 14, height: 14, borderRadius: RADIUS, background: cellBg(i) }} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  )
}

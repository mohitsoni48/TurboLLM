import { useLayoutEffect, useRef } from 'react'
import type { ActivityBucket, TokenActivity } from '../../lib/types'

// GitHub-contribution-graph style intensity ladder — reuses the app's existing
// color-mix idiom against the accent color, so dark/light theming is automatic.
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

const dayPart = (start: string) => start.slice(0, 10)
const subPart = (start: string) => start.slice(11)

function hourLabel(h: number): string {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

function tooltipFor(bucket: ActivityBucket, granularityHours: 1 | 12 | 24): string {
  const tokens = bucket.totalTokens.toLocaleString()
  if (granularityHours === 24) return `${bucket.start}: ${tokens} tokens`
  const day = dayPart(bucket.start)
  if (granularityHours === 12) return `${day} ${subPart(bucket.start)}: ${tokens} tokens`
  return `${day} ${hourLabel(Number(subPart(bucket.start)))}: ${tokens} tokens`
}

/** Classic GitHub-style weekly grid: 7 rows (Sun-Sat), one column per week, one box per
 *  day. Used for the "all" range, where day-level granularity gives a rich, familiar grid. */
function DailyGrid({ buckets, max }: { buckets: ActivityBucket[]; max: number }) {
  const firstWeekday = new Date(`${buckets[0].start}T00:00:00Z`).getUTCDay()
  const padded: (ActivityBucket | null)[] = [...(Array(firstWeekday).fill(null) as null[]), ...buckets]
  const weeks = Math.ceil(padded.length / 7)
  const cells: (ActivityBucket | null)[] = [...padded, ...(Array(weeks * 7 - padded.length).fill(null) as null[])]

  const monthLabels: { col: number; label: string }[] = []
  let lastMonth = -1
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const cell = cells[col * 7 + row]
      if (!cell) continue
      const d = new Date(`${cell.start}T00:00:00Z`)
      if (d.getUTCDate() <= 7) {
        if (d.getUTCMonth() !== lastMonth) {
          lastMonth = d.getUTCMonth()
          monthLabels.push({ col, label: d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) })
        }
        break
      }
    }
  }

  return (
    <div>
      <div
        className="relative mb-1"
        style={{ height: 14, display: 'grid', gridTemplateColumns: `repeat(${weeks}, ${CELL}px)`, columnGap: GAP }}
      >
        {monthLabels.map(({ col, label }) => (
          <span key={col} style={{ gridColumn: col + 1 }} className="text-[10px] text-faint">{label}</span>
        ))}
      </div>
      <div className="flex" style={{ gap: GAP }}>
        <div className="flex shrink-0 flex-col pr-1" style={{ gap: GAP }}>
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
                title={tooltipFor(cell, 24)}
                style={{ width: CELL, height: CELL, borderRadius: RADIUS, background: cellBg(levelFor(cell.totalTokens, max)) }}
              />
            ) : (
              <div key={i} style={{ width: CELL, height: CELL }} />
            ),
          )}
        </div>
      </div>
    </div>
  )
}

/** 30d: the SAME weekday-aligned week grid as DailyGrid (still 7 rows — keeps the
 *  overall rectangle the same height as the "all" range) but each day gets 2 adjacent
 *  columns (AM, PM) instead of 1, doubling the in-week resolution to 12h boxes. */
function HalfDayGrid({ buckets, max }: { buckets: ActivityBucket[]; max: number }) {
  const days: { am: ActivityBucket; pm: ActivityBucket }[] = []
  for (let i = 0; i < buckets.length; i += 2) days.push({ am: buckets[i], pm: buckets[i + 1] })

  const firstWeekday = new Date(`${dayPart(days[0].am.start)}T00:00:00Z`).getUTCDay()
  const weeks = Math.ceil((firstWeekday + days.length) / 7)

  const monthLabels: { col: number; label: string }[] = []
  let lastMonth = -1
  days.forEach((d, i) => {
    const week = Math.floor((firstWeekday + i) / 7)
    const date = new Date(`${dayPart(d.am.start)}T00:00:00Z`)
    if (date.getUTCDate() <= 7 && date.getUTCMonth() !== lastMonth) {
      lastMonth = date.getUTCMonth()
      monthLabels.push({ col: week * 2, label: date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) })
    }
  })

  return (
    <div>
      <div
        className="relative mb-1"
        style={{ height: 14, display: 'grid', gridTemplateColumns: `repeat(${weeks * 2}, ${CELL}px)`, columnGap: GAP }}
      >
        {monthLabels.map(({ col, label }) => (
          <span key={col} style={{ gridColumn: col + 1 }} className="text-[10px] text-faint">{label}</span>
        ))}
      </div>
      <div className="flex" style={{ gap: GAP }}>
        <div className="flex shrink-0 flex-col pr-1" style={{ gap: GAP }}>
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <div key={row} style={{ height: CELL }} className="flex items-center text-[10px] text-faint">
              {WEEKDAY_LABELS[row] ?? ''}
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`,
            gridTemplateColumns: `repeat(${weeks * 2}, ${CELL}px)`, gap: GAP,
          }}
        >
          {days.flatMap((d, i) => {
            const row = (firstWeekday + i) % 7
            const week = Math.floor((firstWeekday + i) / 7)
            return [
              <div
                key={`${i}-am`}
                title={tooltipFor(d.am, 12)}
                style={{
                  gridRow: row + 1, gridColumn: week * 2 + 1, width: CELL, height: CELL,
                  borderRadius: RADIUS, background: cellBg(levelFor(d.am.totalTokens, max)),
                }}
              />,
              <div
                key={`${i}-pm`}
                title={tooltipFor(d.pm, 12)}
                style={{
                  gridRow: row + 1, gridColumn: week * 2 + 2, width: CELL, height: CELL,
                  borderRadius: RADIUS, background: cellBg(levelFor(d.pm.totalTokens, max)),
                }}
              />,
            ]
          })}
        </div>
      </div>
    </div>
  )
}

/** 7d: one row per day (the 7 real days in the window, oldest to newest — not weekday-
 *  aligned, since a 7-day window would mostly land on empty padding rows in a weekly
 *  grid), one column per hour (0-23). Still exactly 7 rows, so the rectangle is the same
 *  height as the other two ranges. Buckets already arrive day-major (24 consecutive
 *  hours per day), so a plain row-major grid fill lines up correctly with no padding. */
function HourGrid({ buckets, max }: { buckets: ActivityBucket[]; max: number }) {
  const days = buckets.length / 24
  const rowLabels = Array.from({ length: days }, (_, i) => dayPart(buckets[i * 24].start))

  return (
    <div>
      <div className="flex" style={{ gap: GAP }}>
        <div className="flex shrink-0 flex-col pr-1" style={{ gap: GAP }}>
          {rowLabels.map((d, row) => (
            <div key={row} style={{ height: CELL }} className="flex items-center text-[10px] text-faint">
              {d.slice(5)}
            </div>
          ))}
        </div>
        <div>
          <div
            style={{
              display: 'grid', gridTemplateRows: `repeat(${days}, ${CELL}px)`,
              gridTemplateColumns: `repeat(24, ${CELL}px)`, gridAutoFlow: 'row', gap: GAP,
            }}
          >
            {buckets.map((b, i) => (
              <div
                key={i}
                title={tooltipFor(b, 1)}
                style={{ width: CELL, height: CELL, borderRadius: RADIUS, background: cellBg(levelFor(b.totalTokens, max)) }}
              />
            ))}
          </div>
          <div className="mt-1 flex text-[10px] text-faint" style={{ gap: GAP }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{ width: CELL }} className="text-center">{h % 6 === 0 ? h : ''}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Adaptive-resolution activity heatmap (Release 3) — hand-rolled, no charting library.
 *  Box granularity comes from the backend (`activity.granularityHours`): 1h boxes for the
 *  7d range, 12h boxes for 30d, and the classic GitHub-style 1-day boxes for all. Every
 *  layout uses exactly 7 rows, so the overall rectangle is the same height regardless of
 *  which range is selected — only the column count (and box meaning) changes. */
export function ActivityHeatmap({ activity }: { activity: TokenActivity }) {
  const { buckets, granularityHours } = activity
  const scrollRef = useRef<HTMLDivElement>(null)

  // Default scrolled to the right edge — the most recent (and usually most interesting)
  // activity should be visible without the user having to scroll past a year of padding.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [buckets])

  if (!buckets.length) return null
  const max = Math.max(1, ...buckets.map((b) => b.totalTokens))

  return (
    <div className="overflow-x-auto" ref={scrollRef}>
      <div className="inline-block">
        {granularityHours === 24 && <DailyGrid buckets={buckets} max={max} />}
        {granularityHours === 12 && <HalfDayGrid buckets={buckets} max={max} />}
        {granularityHours === 1 && <HourGrid buckets={buckets} max={max} />}
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

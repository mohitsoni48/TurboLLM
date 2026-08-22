import { useMemo, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { EmptyState, InlineError, ScreenHeader } from '../components/common'
import { Skeleton } from '../components/ui/skeleton'
import { useTokenUsage } from '../lib/queries'
import { track } from '../lib/api'
import type { TokenUsageRange } from '../lib/types'
import { useDocumentScroll } from '../lib/scroll-mode'
import { ActivityHeatmap } from './tokens/ActivityHeatmap'
import { ModelsTab } from './tokens/ModelsTab'
import { ApiUsageTab } from './tokens/ApiUsageTab'

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return n.toLocaleString()
}

function formatHour(h: number): string {
  const period = h < 12 ? 'AM' : 'PM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12} ${period}`
}

// Rough word-count × ~1.3 tokens/word estimates — good enough for a novelty comparison,
// not meant to be precise. Bucketed by order of magnitude of the user's lifetime total so
// the picked reference is always a meaningfully SMALLER thing (never a weak "~1x" fact) —
// each band's own pool is sized comfortably below that band's lower bound.
const FUN_FACT_BANDS: { min: number; refs: { name: string; tokens: number }[] }[] = [
  { min: 1, refs: [
    { name: 'a haiku', tokens: 20 },
    { name: 'a text message', tokens: 50 },
    { name: 'a tweet', tokens: 70 },
  ] },
  { min: 10_000, refs: [
    { name: 'a short email', tokens: 300 },
    { name: 'a news article', tokens: 1_200 },
    { name: '"The Tell-Tale Heart"', tokens: 4_800 },
  ] },
  { min: 100_000, refs: [
    { name: '"The Little Prince"', tokens: 26_000 },
  ] },
  { min: 1_000_000, refs: [
    { name: '"The Great Gatsby"', tokens: 68_000 },
    { name: "Harry Potter and the Philosopher's Stone", tokens: 100_000 },
    { name: '"The Hobbit"', tokens: 125_000 },
  ] },
  { min: 10_000_000, refs: [
    { name: 'The Lord of the Rings', tokens: 590_000 },
    { name: 'War and Peace', tokens: 760_000 },
    { name: 'the King James Bible', tokens: 1_020_000 },
    { name: 'the complete works of Shakespeare', tokens: 1_170_000 },
  ] },
  { min: 100_000_000, refs: [
    { name: 'the Encyclopedia Britannica', tokens: 57_000_000 },
  ] },
]

/** Picks one reference from the band matching the user's lifetime total's order of
 *  magnitude, so the multiplier always lands in a meaningful (never ~1x) range. */
function pickFunFact(lifetimeTotalTokens: number): string | null {
  let band = null
  for (const b of FUN_FACT_BANDS) {
    if (lifetimeTotalTokens >= b.min) band = b
    else break
  }
  if (!band) return null
  const pick = band.refs[Math.floor(Math.random() * band.refs.length)]
  const multiplier = Math.round(lifetimeTotalTokens / pick.tokens)
  // A total near a band's own lower boundary can still land a weak "~1x" against that
  // band's smallest reference, depending on which ref the random pick landed on — bump the
  // floor to 2x so the fact is either meaningfully large or (consistently) absent, never a
  // coin-flip between "~1x" and no fact at all for two nearby totals in the same band.
  if (multiplier < 2) return null
  return `You've used ~${multiplier.toLocaleString()}x more tokens than ${pick.name}.`
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">{value}</div>
    </div>
  )
}

function MilestoneBar({
  lifetimeTotalTokens, next, progressPct, funFact,
}: { lifetimeTotalTokens: number; next: number | null; progressPct: number | null; funFact: string | null }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-5">
      {funFact && (
        <div className="mb-4 text-center text-[17px] font-semibold leading-snug tracking-[-0.01em] text-ink">
          {funFact}
        </div>
      )}
      {next === null ? (
        <div className="text-center text-[13px] text-muted">Every milestone on the ladder is cleared 🎉</div>
      ) : (
        <>
          <div className="flex items-baseline justify-between text-[12px] text-muted">
            <span>{formatTokenCount(lifetimeTotalTokens)} tokens</span>
            <span>Next: {formatTokenCount(next)} tokens</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full" style={{ width: `${progressPct ?? 0}%`, background: 'var(--accent)' }} />
          </div>
        </>
      )}
    </div>
  )
}

function Segmented<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background: value === o.value ? 'var(--accent)' : 'transparent',
            color: value === o.value ? 'var(--on-accent)' : 'var(--muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Token usage dashboard (Release 3) — GitHub-style per-day heatmap, gamified stats
 *  (streaks, peak hour, favorite model), a per-model breakdown, and a range filter —
 *  sourced entirely from message-level stats already persisted per turn. */
export function TokensScreen() {
  // Issue #178: a long, plain list screen — the window scrolls it, not an inner box.
  useDocumentScroll()
  const [range, setRange] = useState<TokenUsageRange>('all')
  const [tab, setTab] = useState<'overview' | 'models' | 'api'>('overview')
  const { data, isLoading, isError, refetch } = useTokenUsage(range)

  // Lifetime-driven, not range-scoped, and re-rolled only when the underlying lifetime
  // total actually changes (new messages sent) — never on a tab/range switch.
  const lifetimeTotalTokens = data?.lifetimeTotalTokens ?? 0
  const funFact = useMemo(
    () => (lifetimeTotalTokens > 0 ? pickFunFact(lifetimeTotalTokens) : null),
    [lifetimeTotalTokens],
  )
  // A user with zero in-app chats but real gateway (Claude Code / extension) traffic
  // still has something to show — only the true both-empty case gets the empty state.
  const isEmpty = data?.firstMessageAt === null && (data?.api.requests ?? 0) === 0

  return (
    <div className="w-full px-4 py-6 md:px-6">
      <ScreenHeader title="Usage" description="How much you've generated locally, over time." />

      {isLoading && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-[70px]" />)}
          </div>
          <Skeleton className="h-[180px]" />
        </div>
      )}

      {isError && !isLoading && (
        <InlineError message="Couldn't load token usage." onRetry={() => void refetch()} screen="tokens" />
      )}

      {!isLoading && !isError && data && isEmpty && (
        <EmptyState icon={<BarChart3 size={28} />} message="Start a chat to see your token usage here." />
      )}

      {!isLoading && !isError && data && !isEmpty && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              value={tab}
              onChange={(v) => { track('tokens', 'switch_token_tab'); setTab(v) }}
              options={[
                { value: 'overview', label: 'Overview' },
                { value: 'models', label: 'Models' },
                { value: 'api', label: 'API' },
              ]}
            />
            <Segmented
              value={range}
              onChange={(v) => { track('tokens', 'switch_token_range'); setRange(v) }}
              options={[{ value: 'all', label: 'All' }, { value: '30d', label: '30d' }, { value: '7d', label: '7d' }]}
            />
          </div>

          {tab === 'overview' && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatTile label="Sessions" value={data.sessions.toLocaleString()} />
                <StatTile label="Messages" value={data.messages.toLocaleString()} />
                <StatTile label="Total tokens" value={formatTokenCount(data.totalTokens)} />
                <StatTile label="Active days" value={data.activeDays.toLocaleString()} />
                <StatTile label="Current streak" value={`${data.currentStreak}d`} />
                <StatTile label="Longest streak" value={`${data.longestStreak}d`} />
                <StatTile label="Peak hour" value={data.peakHour !== null ? formatHour(data.peakHour) : '—'} />
                <StatTile label="Favorite model" value={data.favoriteModel ?? '—'} />
              </div>

              <MilestoneBar
                lifetimeTotalTokens={data.lifetimeTotalTokens}
                next={data.milestone.next}
                progressPct={data.milestone.progressPct}
                funFact={funFact}
              />

              <div className="rounded-lg border border-border bg-panel p-4">
                <div className="mb-3 text-[13px] font-medium text-ink">Daily activity</div>
                <ActivityHeatmap activity={data.activity} />
              </div>
            </>
          )}

          {tab === 'models' && (
            <ModelsTab models={data.byModel} dailyByModel={data.dailyByModel} />
          )}

          {tab === 'api' && <ApiUsageTab api={data.api} />}
        </div>
      )}
    </div>
  )
}

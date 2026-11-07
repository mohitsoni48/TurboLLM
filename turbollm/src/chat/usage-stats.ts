// Usage statistics over the chat database (scalability review 5.7): the Tokens and Code dashboards,
// the daily roll-ups the telemetry reads, and the gateway's per-request usage rows with their
// retention roll-up. ConversationStore delegates to this with the same method names.
import { randomUUID } from 'node:crypto'
import { inTransaction, type SqlDb } from './store/sqlite-adapter.js'
import { safeJson, type P } from './db-support.js'

import type { ActivityBucket, ApiModelUsage, ApiUsageCursor, ApiUsageSource, ApiUsageStats, CodeStatsDay, CodeStatsRange, CodeStatsResult, DailyModelBreakdown, ModelUsage, TokenActivity, TokenUsageDay, TokenUsageRange, TokenUsageStats, ToolCallRecord } from './db.js'

interface ApiUsageRollupRow {
  seq: number
  id: string
  created_at: string
  source: string
  model_key: string | null
  harness: string | null
  code_session_id: string | null
  prompt_tokens: number
  gen_tokens: number
}

const RANGE_WINDOW_DAYS: Record<'30d' | '7d', number> = { '30d': 30, '7d': 7 }

const TOKEN_MILESTONES = [
  1_000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000,
  10_000_000, 50_000_000, 100_000_000, 500_000_000, 1_000_000_000,
]

/** Where a lifetime token total sits on the milestone ladder. Shared by both branches of
 *  tokenUsageStats (empty-rows and the real computation) — as of 2026-07-22 the lifetime
 *  total fed in is the COMBINED chat+API figure, so this only ever computes, never decides
 *  which figure to use. */
function milestoneFor(lifetimeTotalTokens: number): { achieved: number | null; next: number | null; progressPct: number | null } {
  const achieved = [...TOKEN_MILESTONES].reverse().find((m) => m <= lifetimeTotalTokens) ?? null
  const next = TOKEN_MILESTONES.find((m) => m > lifetimeTotalTokens) ?? null
  const progressPct = next !== null
    ? Math.round(((lifetimeTotalTokens - (achieved ?? 0)) / (next - (achieved ?? 0))) * 1000) / 10
    : null
  return { achieved, next, progressPct }
}

/** "gemma 4 e4b|Q6_K|6217256480" -> "Gemma 4 E4b". Good enough for a dashboard label —
 *  the model may since have been renamed/deleted, so this derives purely from the stored
 *  key rather than cross-referencing the live model list. */
function titleCaseModelName(modelKey: string): string {
  const raw = modelKey.split('|')[0] ?? modelKey
  return raw.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Local calendar date key ("YYYY-MM-DD") for a timestamp — this daemon and its user are
 *  always the same machine, so local time (not UTC) is what "today"/"yesterday" means.
 *  Shared by tokenUsageStats and codeStats so both bucket days identically. */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `key` shifted by `n` local calendar days (negative goes back). */
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** Counts +/- lines in a unified diff (skips the +++/--- file-header lines, which start with
 *  the same characters but aren't real changes) — server-side twin of CodeTranscript.tsx's own
 *  diffStats, used to aggregate real "diff shipped" totals for the Code activity stats. */
function countDiffLines(diff: string): { add: number; del: number } {
  let add = 0, del = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }

  return { add, del }
}

/** `stats.<field>` when it is a JSON number, else 0: the dashboards' old
 *  `typeof s.field === 'number' ? s.field : 0` over safeJson, evaluated by SQLite so the rows
 *  never reach JavaScript. Malformed stats read as 0 (CASE checks validity first; json_type on
 *  malformed text throws). */
function statsNumber(field: string): string {
  return `CASE WHEN NOT json_valid(stats) THEN 0 WHEN json_type(stats, '$.${field}') IN ('integer', 'real') THEN json_extract(stats, '$.${field}') ELSE 0 END`
}

/** The UTC quarter hour an ISO `created_at` falls in, as `YYYY-MM-DDTHH:MM`. Every real time
 *  zone's offset is a whole number of quarter hours, so all instants in one quarter share a
 *  local day and a local hour: grouping by this in SQL keeps everything dayKey and getHours need
 *  while handing JavaScript one row per quarter instead of one per message. */
function quarterHour(column: string): string {
  return `substr(${column}, 1, 14) || printf('%02d', CAST(substr(${column}, 15, 2) AS INTEGER) / 15 * 15)`
}

/** A `quarterHour` key back as an ISO instant, for dayKey / getHours. */
function quarterStartIso(quarter: string): string {
  return `${quarter}:00.000Z`
}

/** The usage queries, over the same open handle as the ConversationStore that owns it. */
export class UsageStatsQueries {
  constructor(private readonly db: SqlDb) {}

  /** Token usage dashboard (Release 3): sessions/messages/tokens/active-days scoped to
   *  `range`, lifetime streaks (a streak isn't a "last N days" concept), the local hour
   *  with the most activity, a per-model breakdown, and the heatmap day buckets. Days are
   *  bucketed by LOCAL calendar date (this daemon and its user are always the same machine),
   *  not UTC, so a late-night session lands on the day the user actually thinks of as "today".
   *
   *  The lifetime streaks need every day ever active whatever `range` is, so SQLite sums the
   *  whole history per (UTC quarter hour, model) — see quarterHour for why that keeps local days
   *  and hours exact — and JavaScript gets one row per active quarter, not one per reply, with no
   *  stats JSON to parse. Rows come in order of first appearance, so Map insertion order (which
   *  breaks peak-hour and favorite-model ties) is what the per-reply pass it replaced had.
   *  Still one aggregate pass over the table per call; a daily roll-up table would make it
   *  O(days), but has to stay in step with every stats write, so it is left for later. */
  tokenUsageStats(range: TokenUsageRange = 'all'): TokenUsageStats {
    const quarters = (this.db.prepare(`
      SELECT ${quarterHour('created_at')} AS quarter, model_key, COUNT(*) AS messages,
        SUM(${statsNumber('promptTokens')}) AS prompt_tokens, SUM(${statsNumber('genTokens')}) AS gen_tokens
      FROM messages WHERE role = 'assistant'
      GROUP BY quarter, model_key
      ORDER BY quarter, MIN(created_at), MIN(rowid)
    `).all() as unknown as { quarter: string; model_key: string | null; messages: number; prompt_tokens: number; gen_tokens: number }[])
      .map((q) => ({ at: quarterStartIso(q.quarter), modelKey: q.model_key, messages: q.messages, promptTokens: q.prompt_tokens, genTokens: q.gen_tokens }))

    if (quarters.length === 0) {
      // Computed independently — a user with zero in-app chats but real gateway (Claude
      // Code / extension) traffic still has something to show here. "Total tokens" /
      // "Lifetime tokens" (below and in the main branch) are the founder-directed
      // combined figure (2026-07-22) — Overview must reflect ALL usage, not just chat,
      // so a chat-less API-only user still gets a real milestone reading instead of a
      // permanently-stuck-at-zero one.
      const api = this.apiUsageStats(range)
      const milestone = milestoneFor(api.lifetimeTotalTokens)
      return {
        range, sessions: 0, messages: 0, totalTokens: api.totalTokens, activeDays: 0,
        currentStreak: 0, longestStreak: 0, peakHour: null, favoriteModel: null,
        firstMessageAt: null, lifetimeTotalTokens: api.lifetimeTotalTokens, milestone,
        activity: { granularityHours: 24, buckets: [] }, dailyByModel: [], byModel: [],
        api,
      }
    }

    // Per-local-day totals across the FULL history — needed for the lifetime streaks
    // regardless of `range`, and reused below for the heatmap window.
    const dayBuckets = new Map<string, { promptTokens: number; genTokens: number; messageCount: number }>()
    for (const q of quarters) {
      const key = dayKey(q.at)
      const b = dayBuckets.get(key) ?? { promptTokens: 0, genTokens: 0, messageCount: 0 }
      b.promptTokens += q.promptTokens
      b.genTokens += q.genTokens
      b.messageCount += q.messages
      dayBuckets.set(key, b)
    }
    const firstMessageAt = (this.db.prepare(`SELECT MIN(created_at) AS at FROM messages WHERE role = 'assistant'`).get() as { at: string }).at

    const todayKey = dayKey(new Date().toISOString())
    const firstKey = dayKey(firstMessageAt)

    let longestStreak = 0, run = 0
    for (let key = firstKey; key <= todayKey; key = addDays(key, 1)) {
      if (dayBuckets.has(key)) { run++; longestStreak = Math.max(longestStreak, run) } else { run = 0 }
    }
    let currentStreak = 0
    {
      // Grace period: if today has no activity yet, the streak isn't broken until
      // tomorrow — check from yesterday instead of reporting 0 the moment you wake up.
      let key = dayBuckets.has(todayKey) ? todayKey : addDays(todayKey, -1)
      while (key >= firstKey && dayBuckets.has(key)) { currentStreak++; key = addDays(key, -1) }
    }

    // "all" always shows at least 180 days of boxes (GitHub-graph convention, scaled
    // down) — a brand-new account pads out with empty cells before its first message
    // instead of rendering a tiny, sparse-looking grid. An account older than that still
    // shows its full real history (never truncated).
    const minAllStart = addDays(todayKey, -179)
    const heatStart = range === 'all'
      ? (firstKey < minAllStart ? firstKey : minAllStart)
      : addDays(todayKey, -(RANGE_WINDOW_DAYS[range] - 1))
    // String comparison is safe and deliberately used over Date parsing here — both sides
    // are zero-padded "YYYY-MM-DD" keys, and `new Date("YYYY-MM-DD")` parses as UTC
    // midnight (not local), a classic footgun this sidesteps entirely.
    const scoped = range === 'all' ? quarters : quarters.filter((q) => dayKey(q.at) >= heatStart)
    const sessions = this.chatSessionsSince(range === 'all' ? null : this.dayWindow(heatStart).start)

    const hourTally = new Map<number, number>()
    const modelTally = new Map<string, { messageCount: number; promptTokens: number; genTokens: number }>()
    const dayModelTally = new Map<string, Map<string, number>>()
    let totalTokens = 0, messages = 0
    for (const q of scoped) {
      const tokens = q.promptTokens + q.genTokens
      totalTokens += tokens
      messages += q.messages
      const hour = new Date(q.at).getHours()
      hourTally.set(hour, (hourTally.get(hour) ?? 0) + q.messages)
      if (q.modelKey) {
        const m = modelTally.get(q.modelKey) ?? { messageCount: 0, promptTokens: 0, genTokens: 0 }
        m.messageCount += q.messages; m.promptTokens += q.promptTokens; m.genTokens += q.genTokens
        modelTally.set(q.modelKey, m)

        const day = dayKey(q.at)
        const dm = dayModelTally.get(day) ?? new Map<string, number>()
        dm.set(q.modelKey, (dm.get(q.modelKey) ?? 0) + tokens)
        dayModelTally.set(day, dm)
      }
    }

    let peakHour: number | null = null, peakHourCount = -1
    for (const [hour, count] of hourTally) if (count > peakHourCount) { peakHour = hour; peakHourCount = count }

    const byModel: ModelUsage[] = [...modelTally.entries()]
      .map(([modelKey, m]) => ({
        modelKey, displayName: titleCaseModelName(modelKey),
        messageCount: m.messageCount, promptTokens: m.promptTokens, genTokens: m.genTokens,
        totalTokens: m.promptTokens + m.genTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)

    const days: TokenUsageDay[] = []
    const dailyByModel: DailyModelBreakdown[] = []
    let activeDays = 0
    for (let key = heatStart; key <= todayKey; key = addDays(key, 1)) {
      const b = dayBuckets.get(key)
      if (b && b.messageCount > 0) activeDays++
      const dayTotalTokens = (b?.promptTokens ?? 0) + (b?.genTokens ?? 0)
      days.push({
        date: key,
        promptTokens: b?.promptTokens ?? 0, genTokens: b?.genTokens ?? 0,
        totalTokens: dayTotalTokens, messageCount: b?.messageCount ?? 0,
      })
      const dm = dayModelTally.get(key)
      dailyByModel.push({
        date: key, totalTokens: dayTotalTokens,
        byModel: dm ? [...dm.entries()].map(([modelKey, tokens]) => ({ modelKey, tokens })) : [],
      })
    }

    // Overview heatmap: box granularity zooms in as the range narrows so the grid stays
    // visually dense (a 7-cell or 30-cell day-level grid looks broken/sparse) — 1h boxes
    // for 7d, 12h boxes for 30d, 1-day boxes (the classic GitHub-style grid) for all.
    let activity: TokenActivity
    if (range === 'all') {
      activity = {
        granularityHours: 24,
        buckets: days.map((d) => ({ start: d.date, totalTokens: d.totalTokens, messageCount: d.messageCount })),
      }
    } else {
      const granularityHours = range === '7d' ? 1 : 12
      const subTally = new Map<string, { totalTokens: number; messageCount: number }>()
      for (const q of scoped) {
        const d = new Date(q.at)
        const day = dayKey(q.at)
        const bucketKey = granularityHours === 1
          ? `${day}T${String(d.getHours()).padStart(2, '0')}`
          : `${day}-${d.getHours() < 12 ? 'AM' : 'PM'}`
        const b = subTally.get(bucketKey) ?? { totalTokens: 0, messageCount: 0 }
        b.totalTokens += q.promptTokens + q.genTokens; b.messageCount += q.messages
        subTally.set(bucketKey, b)
      }
      const buckets: ActivityBucket[] = []
      for (let key = heatStart; key <= todayKey; key = addDays(key, 1)) {
        if (granularityHours === 1) {
          for (let h = 0; h < 24; h++) {
            const bucketKey = `${key}T${String(h).padStart(2, '0')}`
            const b = subTally.get(bucketKey)
            buckets.push({ start: bucketKey, totalTokens: b?.totalTokens ?? 0, messageCount: b?.messageCount ?? 0 })
          }
        } else {
          for (const half of ['AM', 'PM'] as const) {
            const bucketKey = `${key}-${half}`
            const b = subTally.get(bucketKey)
            buckets.push({ start: bucketKey, totalTokens: b?.totalTokens ?? 0, messageCount: b?.messageCount ?? 0 })
          }
        }
      }
      activity = { granularityHours, buckets }
    }

    let chatLifetimeTotalTokens = 0
    for (const b of dayBuckets.values()) chatLifetimeTotalTokens += b.promptTokens + b.genTokens

    // Founder-directed (2026-07-22): Overview's "Total tokens" / "Lifetime tokens" / milestone
    // ladder must reflect ALL usage, not just in-app chat — a heavy Claude Code / extension user
    // was seeing a headline total that silently excluded most of their real usage, with the API
    // figures only visible by switching to a separate tab. `sessions`/`messages`/streak/peak-hour/
    // favorite-model stay chat-only below: those are chat-conversation-shaped concepts (a gateway
    // request has no conv_id, isn't a "session") with no clean 1:1 API equivalent, and the founder
    // asked specifically about "usage" totals, not those. The isolated `api` breakdown (by source,
    // by model) remains available in its own tab for anyone who wants the split.
    const api = this.apiUsageStats(range)
    const combinedTotalTokens = totalTokens + api.totalTokens
    const combinedLifetimeTotalTokens = chatLifetimeTotalTokens + api.lifetimeTotalTokens
    const milestone = milestoneFor(combinedLifetimeTotalTokens)

    return {
      range, sessions, messages, totalTokens: combinedTotalTokens, activeDays,
      currentStreak, longestStreak, peakHour,
      favoriteModel: byModel[0]?.displayName ?? null,
      firstMessageAt, lifetimeTotalTokens: combinedLifetimeTotalTokens, milestone,
      activity, dailyByModel, byModel,
      api,
    }
  }

  /** Conversations with an assistant reply at or after `since` (an ISO instant; null: ever). */
  private chatSessionsSince(since: string | null): number {
    // INDEXED BY: for a DISTINCT, SQLite's planner otherwise prefers walking idx_messages_conv
    // (sorted conv_ids, no temp sort) over the whole table instead of seeking the date range.
    const range = since === null ? '' : ' INDEXED BY idx_messages_created WHERE created_at >= $since AND'
    return (this.db.prepare(`SELECT COUNT(DISTINCT conv_id) AS n FROM messages${range || ' WHERE'} role = 'assistant'`)
      .get(since === null ? {} : { $since: since } as P) as { n: number }).n
  }

  /** Insert one completed gateway request (GitHub #71) — called from the two gateway entry
   *  points (gateway.ts) right where in-app chat already records into `messages`. Fully
   *  additive/fail-safe: callers wrap this the same way `recordCompletion` is wrapped.
   *  `codeSessionId`/`durationMs` (ADR-284) are only populated for a terminal-agent session's
   *  own token-identified traffic — undefined for every other gateway client, same as before. */
  recordApiUsage(rec: { source: ApiUsageSource; modelKey: string | null; promptTokens: number; genTokens: number; codeSessionId?: string | null; durationMs?: number | null; promptTps?: number | null; genTps?: number | null; harness?: string | null }): void {
    // `promptTps`/`genTps` (ADR-300) are the ENGINE's own measurements, straight from the
    // llama.cpp response's `timings` — not anything computed here. Passing them through is the
    // whole point: each phase gets its own real rate instead of both being divided by one
    // wall-clock. Absent (an engine that reports no timings) → null, and the reader falls back.
    const rate = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null)
    this.db.prepare(`
      INSERT INTO api_usage (id, created_at, source, model_key, prompt_tokens, gen_tokens, code_session_id, duration_ms, prompt_tps, gen_tps, harness, ctx_used)
      VALUES ($id, $createdAt, $source, $modelKey, $promptTokens, $genTokens, $codeSessionId, $durationMs, $promptTps, $genTps, $harness, $ctxUsed)
    `).run({
      $id: randomUUID(),
      $createdAt: new Date().toISOString(),
      $source: rec.source,
      $modelKey: rec.modelKey,
      $promptTokens: Math.max(0, Math.floor(rec.promptTokens) || 0),
      $genTokens: Math.max(0, Math.floor(rec.genTokens) || 0),
      $codeSessionId: rec.codeSessionId ?? null,
      $durationMs: rec.durationMs != null && Number.isFinite(rec.durationMs) ? Math.max(0, Math.floor(rec.durationMs)) : null,
      $promptTps: rate(rec.promptTps),
      $genTps: rate(rec.genTps),
      $harness: rec.harness ?? null,
      $ctxUsed: Math.max(0, Math.floor(rec.promptTokens) || 0),
    } as P)
  }

  /** Lower the current context size for a Code session after /compact, so the ctx gauge
   *  reflects post-compaction reality (ADR-386). Updates the row with the MAX ctx_used
   *  to the new value — this is what allows /compact to lower the ring's frozen ceiling.
   *  If no row exists yet (fresh session compacted before first gateway request), creates one. */
  setCodeSessionCtxUsed(codeSessionId: string, ctxUsed: number): void {
    // Try to update the row with the MAX ctx_used first
    const maxRow = this.db.prepare(`
      SELECT id FROM api_usage
      WHERE code_session_id = $codeSessionId AND ctx_used = (
        SELECT MAX(ctx_used) FROM api_usage WHERE code_session_id = $codeSessionId
      )
      LIMIT 1
    `).get({ $codeSessionId: codeSessionId } as P) as { id: string } | undefined
    if (maxRow) {
      this.db.prepare(`
        UPDATE api_usage SET ctx_used = $ctxUsed, prompt_tokens = $promptTokens, created_at = $createdAt
        WHERE id = $id
      `).run({ $ctxUsed: ctxUsed, $promptTokens: ctxUsed, $createdAt: new Date().toISOString(), $id: maxRow.id } as P)
    } else {
      // No row exists yet — create one (fresh session compacted before first gateway request)
      this.db.prepare(`
        INSERT INTO api_usage (id, created_at, source, prompt_tokens, gen_tokens, code_session_id, ctx_used)
        VALUES ($id, $createdAt, 'compact', $promptTokens, 0, $codeSessionId, $ctxUsed)
      `).run({
        $id: randomUUID(),
        $createdAt: new Date().toISOString(),
        $promptTokens: ctxUsed,
        $codeSessionId: codeSessionId,
        $ctxUsed: ctxUsed,
      } as P)
    }
  }

  /** The session's own gateway-request stats (ADR-284, revised twice — founder-reported "ctx
   *  fill jumps between full and empty in the same session", then a review pass on that same fix
   *  catching that it had gone on to freeze the LAST-TURN stats too). Two different questions,
   *  two different rows:
   *
   *  `ctxUsed` is the MAX prompt_tokens row, not literally the most-recently-INSERTED one. Every
   *  request a real `claude` CLI process makes — the main conversation's own turn AND every
   *  parallel Task-tool sub-agent it spawns — shares the SAME code_session_id: `resolveCodeSession`
   *  (gateway.ts) derives it purely from the bearer token, and the CLI mints exactly one token
   *  (ANTHROPIC_AUTH_TOKEN, set once at launch) for its whole process, sub-agents included. A
   *  sub-agent's own prompt is a small, isolated sub-task — nothing like the full resent
   *  conversation — so whichever of the two finishes last used to decide what the ring showed:
   *  the real, large, ever-growing main-turn prompt one poll, a tiny sub-agent prompt the next,
   *  with no change to the actual conversation in between. The MAX is the honest answer to "how
   *  full has this session's context gotten" — a real Claude Code CLI resends the whole
   *  conversation every turn, so its size only grows within one continuous conversation, and a
   *  sub-agent (always smaller) can never legitimately raise that high-water mark. Trade-off,
   *  accepted: after a real `/clear` inside the CLI (invisible to the daemon — a terminal-agent
   *  session's turns are never persisted here, see ADR-297), this keeps reporting the pre-clear
   *  high-water mark until the new conversation grows past it. A temporarily-stale-high ring
   *  reading after a rare, deliberate user action beats an unpredictable full/empty flicker on
   *  every ordinary agentic turn with sub-agents.
   *
   *  `promptTokens`/`genTokens`/`promptTps`/`genTps` are the temporally-LAST row instead — these
   *  power TerminalToolbar.tsx's composer-parity stats row, which reads as "your last turn", not
   *  "session high-water mark". Sharing the MAX row here (the original version of this fix) meant
   *  a sub-agent call landing after the real turn hid its own genTokens/tps behind the earlier,
   *  larger turn's numbers, and after a `/clear` these froze at the pre-clear turn's numbers
   *  forever, same failure shape as the ctxUsed bug this method was written to fix in the first
   *  place. null when the session has made no gateway requests yet (fresh session, or a
   *  non-terminal-agent one). */
  getLastApiUsageForSession(codeSessionId: string): { ctxUsed: number; promptTokens: number; genTokens: number; promptTps: number | null; genTps: number | null } | null {
    const row = this.db.prepare(`
      SELECT prompt_tokens, gen_tokens, duration_ms, prompt_tps, gen_tps, ctx_used FROM api_usage
      WHERE code_session_id = $codeSessionId
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get({ $codeSessionId: codeSessionId } as P) as unknown as { prompt_tokens: number; gen_tokens: number; duration_ms: number | null; prompt_tps: number | null; gen_tps: number | null; ctx_used: number } | undefined
    if (!row) return null
    // ctx_used is the MAX across all rows — same high-water-mark semantics as the old
    // MAX(prompt_tokens) approach, but now /compact can lower it via setCodeSessionCtxUsed.
    // Sub-agent calls (smaller prompts) can't drag the ring down because MAX ignores them.
    const ctxUsed = (this.db.prepare(`
      SELECT MAX(ctx_used) as maxCtxUsed FROM api_usage WHERE code_session_id = $codeSessionId
    `).get({ $codeSessionId: codeSessionId } as P) as unknown as { maxCtxUsed: number }).maxCtxUsed
    const seconds = row.duration_ms != null && row.duration_ms > 0 ? row.duration_ms / 1000 : null
    return {
      ctxUsed,
      promptTokens: row.prompt_tokens,
      genTokens: row.gen_tokens,
      promptTps: row.prompt_tps ?? (seconds ? row.prompt_tokens / seconds : null),
      genTps: row.gen_tps ?? (seconds ? row.gen_tokens / seconds : null),
    }
  }

  /** Gateway (external-client) token usage — see `ApiUsageStats`'s doc comment for why this
   *  is a separate bucket from `tokenUsageStats`. Same local-day range scoping as the chat
   *  stats above, but no streak/session concepts (a gateway request isn't a chat turn).
   *  SQLite does the sums: the range is a WHERE on the indexed created_at, and JavaScript gets
   *  one row per (source, model), in order of first appearance like the per-request pass it
   *  replaced (Map order breaks byModel ties). */
  apiUsageStats(range: TokenUsageRange = 'all'): ApiUsageStats {
    const lifetimeTotalTokens = (this.db.prepare(`
      SELECT (SELECT COALESCE(SUM(prompt_tokens + gen_tokens), 0) FROM api_usage)
           + (SELECT COALESCE(SUM(prompt_tokens + gen_tokens), 0) FROM api_usage_daily) AS n
    `).get() as { n: number }).n

    const todayKey = dayKey(new Date().toISOString())
    const sinceDay = range === 'all' ? null : addDays(todayKey, -(RANGE_WINDOW_DAYS[range] - 1))
    const params = sinceDay === null ? {} : { $since: this.dayWindow(sinceDay).start, $sinceDay: sinceDay }
    // Raw rows and the retention sweep's daily totals (v55) together: a row is in exactly one.
    const groups = this.db.prepare(`
      SELECT source, model_key, SUM(requests) AS requests, SUM(prompt_tokens) AS prompt_tokens, SUM(gen_tokens) AS gen_tokens
      FROM (
        SELECT source, model_key, 1 AS requests, prompt_tokens, gen_tokens, created_at AS first_at, rowid AS first_seq
        FROM api_usage${sinceDay === null ? '' : ' WHERE created_at >= $since'}
        UNION ALL
        SELECT source, NULLIF(model_key, ''), requests, prompt_tokens, gen_tokens, first_at, first_seq
        FROM api_usage_daily${sinceDay === null ? '' : ' WHERE day >= $sinceDay'}
      )
      GROUP BY source, model_key
      ORDER BY MIN(first_at), MIN(first_seq)
    `).all(params as P) as unknown as { source: ApiUsageSource; model_key: string | null; requests: number; prompt_tokens: number; gen_tokens: number }[]

    const sourceTally = new Map<ApiUsageSource, { requests: number; totalTokens: number }>()
    const modelTally = new Map<string, { requests: number; promptTokens: number; genTokens: number }>()
    let totalTokens = 0, requests = 0
    for (const g of groups) {
      const tokens = g.prompt_tokens + g.gen_tokens
      totalTokens += tokens
      requests += g.requests
      const st = sourceTally.get(g.source) ?? { requests: 0, totalTokens: 0 }
      st.requests += g.requests; st.totalTokens += tokens
      sourceTally.set(g.source, st)
      if (g.model_key) {
        const mt = modelTally.get(g.model_key) ?? { requests: 0, promptTokens: 0, genTokens: 0 }
        mt.requests += g.requests; mt.promptTokens += g.prompt_tokens; mt.genTokens += g.gen_tokens
        modelTally.set(g.model_key, mt)
      }
    }

    const byModel: ApiModelUsage[] = [...modelTally.entries()]
      .map(([modelKey, m]) => ({
        modelKey, displayName: titleCaseModelName(modelKey),
        requests: m.requests, promptTokens: m.promptTokens, genTokens: m.genTokens,
        totalTokens: m.promptTokens + m.genTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)

    return {
      range, requests, totalTokens, lifetimeTotalTokens,
      bySource: [...sourceTally.entries()].map(([source, s]) => ({ source, ...s })),
      byModel,
    }
  }

  /** Retention (scalability review 2.4): folds up to `limit` raw `api_usage` rows created before
   *  `before` into `api_usage_daily` and deletes them, in one transaction. Walks in (created_at,
   *  rowid) order from `after`; `next` is where the following batch starts, null once done.
   *  A Code session's latest and peak-context rows stay raw: getLastApiUsageForSession reads
   *  them, and the rows it skips are walked past, never revisited. */
  rollUpApiUsageBatch(before: string, limit: number, after: ApiUsageCursor | null = null): { rolledUp: number; next: ApiUsageCursor | null } {
    return inTransaction(this.db, () => {
      const rows = this.db.prepare(`
        SELECT rowid AS seq, id, created_at, source, model_key, harness, code_session_id, prompt_tokens, gen_tokens FROM api_usage
        WHERE created_at < $before${after ? ' AND created_at >= $afterAt AND (created_at > $afterAt OR rowid > $afterSeq)' : ''}
        ORDER BY created_at, rowid LIMIT $limit
      `).all({ $before: before, $limit: limit, ...(after ? { $afterAt: after.createdAt, $afterSeq: after.seq } : {}) } as P) as unknown as ApiUsageRollupRow[]
      const kept = this.codeSessionGaugeRowIds(rows)
      const folded = rows.filter((r) => !kept.has(r.id))
      this.addToDailyApiUsage(folded)
      const del = this.db.prepare(`DELETE FROM api_usage WHERE rowid = $seq`)
      for (const r of folded) del.run({ $seq: r.seq } as P)
      const last = rows[rows.length - 1]
      return { rolledUp: folded.length, next: rows.length < limit ? null : { createdAt: last.created_at, seq: last.seq } }
    })
  }

  /** The ids of the rows getLastApiUsageForSession reads for each Code session among `rows`:
   *  its newest, and one holding its peak ctx_used. */
  private codeSessionGaugeRowIds(rows: ApiUsageRollupRow[]): Set<string> {
    const sessions = new Set(rows.map((r) => r.code_session_id).filter((s): s is string => s !== null))
    const latest = this.db.prepare(`SELECT id FROM api_usage WHERE code_session_id = $s ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    const peak = this.db.prepare(`SELECT id FROM api_usage WHERE code_session_id = $s ORDER BY ctx_used DESC LIMIT 1`)
    const ids = new Set<string>()
    for (const s of sessions) {
      for (const stmt of [latest, peak]) ids.add((stmt.get({ $s: s } as P) as { id: string }).id)
    }
    return ids
  }

  private addToDailyApiUsage(rows: ApiUsageRollupRow[]): void {
    const groups = new Map<string, { day: string; source: string; model: string; harness: string; requests: number; prompt: number; gen: number; firstAt: string; firstSeq: number }>()
    for (const r of rows) {
      const day = dayKey(r.created_at)
      const key = [day, r.source, r.model_key ?? '', r.harness ?? ''].join('\x00')
      const g = groups.get(key) ?? { day, source: r.source, model: r.model_key ?? '', harness: r.harness ?? '', requests: 0, prompt: 0, gen: 0, firstAt: r.created_at, firstSeq: r.seq }
      g.requests++; g.prompt += r.prompt_tokens; g.gen += r.gen_tokens
      if (r.created_at < g.firstAt) g.firstAt = r.created_at
      if (r.seq < g.firstSeq) g.firstSeq = r.seq
      groups.set(key, g)
    }
    const upsert = this.db.prepare(`
      INSERT INTO api_usage_daily (day, source, model_key, harness, requests, prompt_tokens, gen_tokens, first_at, first_seq)
      VALUES ($day, $source, $model, $harness, $requests, $prompt, $gen, $firstAt, $firstSeq)
      ON CONFLICT (day, source, model_key, harness) DO UPDATE SET
        requests = requests + excluded.requests,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        gen_tokens = gen_tokens + excluded.gen_tokens,
        first_at = MIN(first_at, excluded.first_at),
        first_seq = MIN(first_seq, excluded.first_seq)
    `)
    for (const g of groups.values()) {
      upsert.run({
        $day: g.day, $source: g.source, $model: g.model, $harness: g.harness, $requests: g.requests,
        $prompt: g.prompt, $gen: g.gen, $firstAt: g.firstAt, $firstSeq: g.firstSeq,
      } as P)
    }
  }

  /**
   * A single UTC-comparable `[start, end)` window for `chat_daily`/`gateway_daily`/
   * `code_daily` (spec 23 §3.4/3.5/3.8, ADR-333) — read-only aggregations over
   * tables that already durably record everything needed, computed once at
   * day-rollover rather than accumulated in memory (unlike `feature_used_daily`,
   * which has no backing table to query and genuinely needs `runtime/rollup.ts`'s
   * accumulator). `dayIso` is a `YYYY-MM-DD` local-calendar-day key, matching
   * `dayKey()`'s own convention above.
   */
  private dayWindow(dayIso: string): { start: string; end: string } {
    const [y, m, d] = dayIso.split('-').map(Number)
    return {
      start: new Date(y, m - 1, d).toISOString(),
      end: new Date(y, m - 1, d + 1).toISOString(),
    }
  }

  /** `chat_daily`'s config block (spec 23 §3.4) for the local calendar day `dayIso`.
   *  `toolCalls` sums `json_array_length(tool_calls)` rather than counting messages
   *  that merely HAVE a tool call, so a message with 3 calls in one turn counts as 3.
   *  `regenerates` counts deactivated variant-group siblings — each one is a message
   *  a real regenerate action superseded (see the `variant_group`/`is_active`
   *  migration note above). `stops` reads `stats.aborted`, the same flag the chat UI
   *  itself uses to render a stopped reply. Median is computed in JS — SQLite has no
   *  built-in median aggregate, and pulling one row per touched conversation is cheap
   *  (a real day's conversation count is nowhere near enough to matter). */
  chatDailyStats(dayIso: string): {
    conversations: number; messages: number; maxMessagesInConversation: number
    medianMessagesInConversation: number; distinctModels: number; toolCalls: number
    regenerates: number; stops: number
  } {
    const { start, end } = this.dayWindow(dayIso)
    const rows = this.db.prepare(`
      SELECT conv_id, model_key, tool_calls, stats FROM messages
      WHERE created_at >= ? AND created_at < ? AND is_active = 1
    `).all(start, end) as unknown as { conv_id: string; model_key: string | null; tool_calls: string | null; stats: string }[]

    const perConv = new Map<string, number>()
    const models = new Set<string>()
    let toolCalls = 0
    let stops = 0
    for (const r of rows) {
      perConv.set(r.conv_id, (perConv.get(r.conv_id) ?? 0) + 1)
      if (r.model_key) models.add(r.model_key)
      if (r.tool_calls) {
        try {
          const parsed: unknown = JSON.parse(r.tool_calls)
          if (Array.isArray(parsed)) toolCalls += parsed.length
        } catch {
          // malformed tool_calls JSON — skip rather than crash a periodic rollup
        }
      }
      try {
        const s: unknown = JSON.parse(r.stats)
        if (typeof s === 'object' && s !== null && (s as { aborted?: unknown }).aborted === true) stops++
      } catch {
        // malformed stats JSON — same treatment
      }
    }

    const counts = [...perConv.values()].sort((a, b) => a - b)
    const median = counts.length === 0 ? 0
      : counts.length % 2 === 1 ? counts[(counts.length - 1) / 2]
      : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2

    const regenerates = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE created_at >= ? AND created_at < ? AND variant_group IS NOT NULL AND is_active = 0
    `).get(start, end) as unknown as { n: number }).n

    return {
      conversations: perConv.size,
      messages: rows.length,
      maxMessagesInConversation: counts.length === 0 ? 0 : counts[counts.length - 1],
      medianMessagesInConversation: median,
      distinctModels: models.size,
      toolCalls,
      regenerates,
      stops,
    }
  }

  /** `gateway_daily`'s config block (spec 23 §3.5) for the local calendar day
   *  `dayIso`, grouped by `source` (protocol) — a read-only aggregation over the
   *  ALREADY-INDEXED `api_usage` table, so this adds no write to the gateway's own
   *  hot request path. Grouped by harness too once Phase 5's client-detection
   *  ships; until then every row reports `harness: 'unknown'` rather than waiting
   *  on that phase to start collecting protocol-level volume at all. */
  /** Grouped by (protocol, harness) — spec 23 §3.5, telemetry Phase 5. Pre-Phase-5 rows (and
   *  any client the gateway didn't classify) have `harness IS NULL`, which reads as `'unknown'`
   *  here rather than a distinct group of its own — that's the same bucket a genuinely
   *  unrecognized live client falls into, so the two cases don't need telling apart downstream. */
  gatewayDailyStats(dayIso: string): { protocol: ApiUsageSource; harness: string; requests: number; promptTokens: number; genTokens: number; distinctModels: number }[] {
    const { start, end } = this.dayWindow(dayIso)
    // Raw rows and the retention sweep's daily totals for the day (v55), which keep the same
    // (source, model, harness) detail. In order of first appearance, so the groups come out in
    // the same order whether or not the day has been rolled up.
    const rows = this.db.prepare(`
      SELECT source, model_key, harness, 1 AS requests, prompt_tokens, gen_tokens, created_at AS first_at, rowid AS first_seq FROM api_usage
      WHERE created_at >= ? AND created_at < ?
      UNION ALL
      SELECT source, NULLIF(model_key, ''), NULLIF(harness, ''), requests, prompt_tokens, gen_tokens, first_at, first_seq FROM api_usage_daily
      WHERE day = ?
      ORDER BY first_at, first_seq
    `).all(start, end, dayIso) as unknown as { source: ApiUsageSource; model_key: string | null; harness: string | null; requests: number; prompt_tokens: number; gen_tokens: number }[]

    const byGroup = new Map<string, { protocol: ApiUsageSource; harness: string; requests: number; promptTokens: number; genTokens: number; models: Set<string> }>()
    for (const r of rows) {
      const harness = r.harness ?? 'unknown'
      const key = `${r.source}\x00${harness}`
      const t = byGroup.get(key) ?? { protocol: r.source, harness, requests: 0, promptTokens: 0, genTokens: 0, models: new Set<string>() }
      t.requests += r.requests
      t.promptTokens += r.prompt_tokens
      t.genTokens += r.gen_tokens
      if (r.model_key) t.models.add(r.model_key)
      byGroup.set(key, t)
    }

    return [...byGroup.values()].map((t) => ({
      protocol: t.protocol, harness: t.harness, requests: t.requests, promptTokens: t.promptTokens, genTokens: t.genTokens, distinctModels: t.models.size,
    }))
  }

  /** `code_daily`'s config block (spec 23 §3.6) for the local calendar day `dayIso`
   *  — `sessions`/`turns`/`toolCalls` only. `toolApprovals`/`toolDenials`/
   *  `compactions`/`worktreeSessions` need new instrumentation inside
   *  `code-session.ts` itself (no table records per-call approval decisions or
   *  compaction events today) and are a deliberate, tracked follow-up (TODO.md)
   *  rather than fabricated here. `agent_runs` is a Code session (`codeStats`'s own
   *  precedent for this join); `turns` counts assistant replies within one, the same
   *  unit `chatDailyStats` counts for regular chat. */
  codeDailyStats(dayIso: string): { sessions: number; turns: number; toolCalls: number } {
    const { start, end } = this.dayWindow(dayIso)
    const sessions = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM agent_runs ar JOIN conversations c ON c.id = ar.conv_id
      WHERE c.kind = 'code' AND ar.created_at >= ? AND ar.created_at < ?
    `).get(start, end) as unknown as { n: number }).n

    // CROSS JOIN keeps messages the outer loop, so the day is a seek on idx_messages_created
    // (v53) rather than every code conversation's messages read and filtered.
    const rows = this.db.prepare(`
      SELECT m.tool_calls FROM messages m CROSS JOIN conversations c ON c.id = m.conv_id
      WHERE c.kind = 'code' AND m.role = 'assistant' AND m.is_active = 1
        AND m.created_at >= ? AND m.created_at < ?
    `).all(start, end) as unknown as { tool_calls: string | null }[]

    let toolCalls = 0
    for (const r of rows) {
      if (!r.tool_calls) continue
      try {
        const parsed: unknown = JSON.parse(r.tool_calls)
        if (Array.isArray(parsed)) toolCalls += parsed.length
      } catch {
        // malformed tool_calls JSON — skip rather than crash a periodic rollup
      }
    }

    return { sessions, turns: rows.length, toolCalls }
  }

  /** Code launchpad's "Coding activity" stats — real numbers, replacing code-mock.ts's
   *  CODE_STATS/mockSessionDays (which were always fake). Mirrors tokenUsageStats' own
   *  day-bucket/streak/range pattern closely (dayKey/addDays are the same shared helpers) —
   *  everything computed fresh from agent_runs + messages on each call, not from a maintained
   *  running counter, so it's always internally consistent with whatever data actually exists.
   *  As in tokenUsageStats, SQLite does the counting: lifetime runs per quarter hour for the
   *  streaks, the range's runs per model, and only the range's tool calls reach JavaScript. */
  codeStats(range: CodeStatsRange = 'all'): CodeStatsResult {
    const quarters = this.db.prepare(`
      SELECT ${quarterHour('ar.created_at')} AS quarter, COUNT(*) AS runs
      FROM agent_runs ar JOIN conversations c ON c.id = ar.conv_id
      WHERE c.kind = 'code'
      GROUP BY quarter ORDER BY quarter
    `).all() as unknown as { quarter: string; runs: number }[]

    if (quarters.length === 0) {
      return {
        range, sessions: 0, tasksShipped: 0, filesTouched: 0, diffAdded: 0, diffRemoved: 0,
        activeDays: 0, currentStreak: 0, longestStreak: 0, favoriteModel: null, heatmap: [],
      }
    }

    // Per-local-day run counts across the FULL history — needed for lifetime streaks
    // regardless of `range`, and reused below for the heatmap window.
    const dayBuckets = new Map<string, number>()
    for (const q of quarters) {
      const key = dayKey(quarterStartIso(q.quarter))
      dayBuckets.set(key, (dayBuckets.get(key) ?? 0) + q.runs)
    }
    const firstKey = dayKey(quarterStartIso(quarters[0].quarter))
    const todayKey = dayKey(new Date().toISOString())

    let longestStreak = 0, run = 0
    for (let key = firstKey; key <= todayKey; key = addDays(key, 1)) {
      if (dayBuckets.has(key)) { run++; longestStreak = Math.max(longestStreak, run) } else { run = 0 }
    }
    let currentStreak = 0
    {
      // Grace period: if today has no session yet, the streak isn't broken until tomorrow.
      let key = dayBuckets.has(todayKey) ? todayKey : addDays(todayKey, -1)
      while (key >= firstKey && dayBuckets.has(key)) { currentStreak++; key = addDays(key, -1) }
    }

    const minAllStart = addDays(todayKey, -179)
    const heatStart = range === 'all'
      ? (firstKey < minAllStart ? firstKey : minAllStart)
      : addDays(todayKey, -(RANGE_WINDOW_DAYS[range] - 1))

    const since = range === 'all' ? null : this.dayWindow(heatStart).start
    const sinceClause = since === null ? '' : ' AND ar.created_at >= $since'
    const sinceParams = since === null ? {} : { $since: since } as P
    // Per model in order of first appearance, so Map order breaks favorite-model ties as before.
    const byModel = this.db.prepare(`
      SELECT c.model_key, COUNT(*) AS runs, SUM(ar.status = 'done') AS done
      FROM agent_runs ar JOIN conversations c ON c.id = ar.conv_id
      WHERE c.kind = 'code'${sinceClause}
      GROUP BY c.model_key ORDER BY MIN(ar.created_at), MIN(ar.rowid)
    `).all(sinceParams) as unknown as { model_key: string; runs: number; done: number }[]

    const modelTally = new Map<string, number>()
    let sessions = 0, tasksShipped = 0
    for (const m of byModel) {
      sessions += m.runs
      tasksShipped += m.done
      if (m.model_key) modelTally.set(m.model_key, m.runs)
    }
    const activeDays = [...dayBuckets.keys()].filter((key) => key >= heatStart).length
    let favoriteModelKey: string | null = null, favoriteCount = -1
    for (const [k, n] of modelTally) if (n > favoriteCount) { favoriteModelKey = k; favoriteCount = n }

    const heatmap: CodeStatsDay[] = []
    for (let key = heatStart; key <= todayKey; key = addDays(key, 1)) {
      heatmap.push({ date: key, sessions: dayBuckets.get(key) ?? 0 })
    }

    // filesTouched + diffAdded/diffRemoved: scoped by each MESSAGE's own created_at (when the
    // tool call actually ran), not the owning run's — a long session's later turns land on a
    // later day than its first message, so this is the more honest scoping of the two.
    // With a range, CROSS JOIN pins messages as the outer loop (SQLite keeps the written join
    // order for it), so the date range is an index seek rather than every code message read.
    const msgRows = this.db.prepare(since === null ? `
      SELECT m.tool_calls FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE c.kind = 'code' AND m.role = 'assistant' AND m.tool_calls IS NOT NULL
    ` : `
      SELECT m.tool_calls FROM messages m CROSS JOIN conversations c ON c.id = m.conv_id
      WHERE c.kind = 'code' AND m.role = 'assistant' AND m.tool_calls IS NOT NULL AND m.created_at >= $since
    `).all(sinceParams) as unknown as { tool_calls: string }[]

    const filePaths = new Set<string>()
    let diffAdded = 0, diffRemoved = 0
    for (const r of msgRows) {
      const calls = safeJson(r.tool_calls) as ToolCallRecord[] | undefined
      if (!Array.isArray(calls)) continue
      for (const tc of calls) {
        const path = typeof tc.args?.path === 'string' ? tc.args.path : undefined
        if (path && (tc.name === 'edit' || tc.name === 'write')) filePaths.add(path)
        if (tc.name === 'edit' && tc.diff) {
          const { add, del } = countDiffLines(tc.diff)
          diffAdded += add
          diffRemoved += del
        }
      }
    }

    return {
      range, sessions, tasksShipped, filesTouched: filePaths.size,
      diffAdded, diffRemoved, activeDays, currentStreak, longestStreak,
      favoriteModel: favoriteModelKey ? titleCaseModelName(favoriteModelKey) : null,
      heatmap,
    }
  }
}

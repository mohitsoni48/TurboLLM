// Chat compaction (ADR-420) — ports Code's cut-point + summary shape (/compact,
// ADR-132/ADR-412) to Chat. This module owns everything PURE: prompt assembly (including
// withCurrentDate, moved here from chat-routes.ts since it's the same responsibility),
// cut resolution, the 80% auto-trigger check, and tail sizing. The async half
// (compactConversation, the actual summarization call) lives at the bottom and is the
// only part that touches the network or the DB write path.
//
// The single rule everything else here serves: resolveCompactionCut is re-run against the
// CURRENT active message list on every prompt build, never cached, and an unresolvable cut
// NEVER silently drops the summary — see resolveCompactionCut's own doc comment. This is a
// direct port of the fix in code-session.ts's resolveEffectiveHistory, not a re-derivation
// of it; when in doubt, that function is the reference implementation.
//
// Task 3 appends compactConversation/maybeAutoCompact below and extends this import list
// with callChatUpstream/resolveChatUpstream/ChatUpstream/Deps at that point — NOT
// here, even though they're logically "for this file": this project's tsconfig has
// noUnusedLocals: true, so importing them before anything in the file uses them would fail
// Task 2's OWN typecheck step. Keep this file's imports exactly matched to what's actually
// referenced at the end of whichever task last touched it.
import type { Conversation, Message } from './db.js'
import { estimateTokens } from '../ext/context-limit.js'
import { callChatUpstream, resolveChatUpstream, type ChatUpstream } from './chat-upstream.js'
import type { Deps } from '../deps.js'

// ── current-date injection (moved from chat-routes.ts, unchanged behavior) ─────────────
// The date used to be baked into conv.systemPrompt once, client-side, at conversation
// creation — so a chat started in March still told the model it was March in July.
// It is now assembled per request instead, on every path that builds engineMessages.

/** Matches the app's own injected date line so a prompt persisted with a stale copy can be
 *  cleaned before the fresh one is appended (the model must never see two dates). Deliberately
 *  narrow — whole line, our exact opening, length-bounded — so user-authored prose that merely
 *  mentions a date survives. Also matches the line this file emits, keeping the strip idempotent. */
const BAKED_DATE_LINE = /^Today['’]s date is [^\n]{0,140}$\n?/gm

/** DATE ONLY, never a clock time: llama.cpp prefix-caching keys on the prompt prefix, so a
 *  per-turn timestamp would invalidate the prefill cache on every single turn. */
function currentDateLine(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `Today's date is ${y}-${m}-${d}. Use it only when the request depends on the current date; otherwise ignore it.`
}

/** Stored system prompt + today's date, appended LAST so everything ahead of it stays a stable
 *  cache prefix across a date rollover. Callers must keep gating on a non-empty stored prompt —
 *  the Blank agent means zero system message, and that still holds. */
export function withCurrentDate(systemPrompt: string, now = new Date()): string {
  const base = systemPrompt.replace(BAKED_DATE_LINE, '').replace(/\n{3,}/g, '\n\n').trim()
  return base ? `${base}\n\n${currentDateLine(now)}` : currentDateLine(now)
}

// ── auto-trigger threshold ──────────────────────────────────────────────────────────────

/** Fixed at 80% — matches Code's own /compact threshold (ADR-132), which explicitly
 *  rejected making this configurable. Chat matches Code's number rather than inventing a
 *  second one. */
export const AUTO_COMPACT_THRESHOLD = 0.8

export function shouldAutoCompact(ctxUsed: number, ctxMax: number): boolean {
  if (ctxMax <= 0) return false
  return ctxUsed / ctxMax > AUTO_COMPACT_THRESHOLD
}

/** The context usage the NEXT turn should be judged against: whatever the last assistant
 *  reply that actually completed a generation reported. Mirrors ChatScreen.tsx's own
 *  `messages.findLast((m) => m.role === 'assistant')?.stats` read for the context meter —
 *  same source of truth on both sides. A fresh placeholder row (empty stats, mid-generation)
 *  is skipped rather than zeroing the result out. */
export function lastCtxUsage(messages: Message[]): { ctxUsed: number; ctxMax: number } {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.stats?.ctxUsed !== undefined)
  return { ctxUsed: last?.stats?.ctxUsed ?? 0, ctxMax: last?.stats?.ctxMax ?? 0 }
}

// ── cut resolution ───────────────────────────────────────────────────────────────────

/** Resolves a conversation's persisted compaction cut against its CURRENT active message
 *  list. Mirrors code-session.ts's resolveEffectiveHistory exactly: an unresolvable cut
 *  (the message was deactivated by a branch switch/edit-freeze, or deleted outright) still
 *  surfaces its summary — replaying every active message alongside a redundant summary
 *  loses nothing, whereas dropping the summary would lose a real (if now unanchored) one.
 *  Never returns a PARTIAL cut. No edit/branch/delete route needs to know this function
 *  exists — it is re-run fresh on every prompt build, purely as a function of
 *  (compactionUpToMessageId, activeMessages), so nothing is ever cleared out from under it
 *  except an explicit undo (clearConversationCompaction) or a new compaction overwriting it. */
export function resolveCompactionCut(
  conv: Pick<Conversation, 'compactionSummary' | 'compactionUpToMessageId'>,
  activeMessages: Message[],
): { summary: string | null; rest: Message[] } {
  if (!conv.compactionUpToMessageId || !conv.compactionSummary) return { summary: null, rest: activeMessages }
  const cutIdx = activeMessages.findIndex((m) => m.id === conv.compactionUpToMessageId)
  const rest = cutIdx === -1 ? activeMessages : activeMessages.slice(cutIdx + 1)
  return { summary: conv.compactionSummary, rest }
}

// ── prompt assembly ──────────────────────────────────────────────────────────────────

/** The one place engine messages get built — replaces the two inline copies that used to
 *  live in chat-routes.ts's POST /messages and POST /continue handlers. `activeMessages`
 *  is the caller's responsibility to have already filtered to the turn's real history (e.g.
 *  excluding the just-inserted placeholder assistant row), exactly as those two call sites
 *  already did before this extraction. */
export function buildEngineMessages(conv: Conversation, activeMessages: Message[]): { role: string; content: unknown }[] {
  const { summary, rest } = resolveCompactionCut(conv, activeMessages)
  const out: { role: string; content: unknown }[] = []
  if (conv.systemPrompt) out.push({ role: 'system', content: withCurrentDate(conv.systemPrompt) })
  if (summary) out.push({ role: 'system', content: `Earlier conversation summary:\n\n${summary}` })
  for (const m of rest) {
    // GitHub #52: when preserveThinking is on, fold past reasoning back into what's resent
    // so the model sees its own prior thinking, not just the final answer — the default
    // behavior (off) matches what's always been sent. Only ever applies to the raw tail;
    // reasoning behind the cut is already folded into the summary text itself, not resent.
    const content = (conv.preserveThinking && m.role === 'assistant' && m.reasoning?.trim())
      ? `<think>\n${m.reasoning}\n</think>\n\n${m.content}`
      : m.content
    out.push({ role: m.role, content })
  }
  return out
}

// ── tail sizing ──────────────────────────────────────────────────────────────────────

/** How much of ctxMax the RAW tail (messages left uncompacted, sent verbatim) should try
 *  to occupy. Mirrors Code's own compactionSettingsFor keepRecentTokens (~35% of context),
 *  slightly more generous since Chat has no tool-loop/skill overhead competing for the
 *  same budget. */
const KEEP_RECENT_FRACTION = 0.4

/** Below this many messages, compacting saves nothing worth a model call. */
const MIN_MESSAGES_TO_COMPACT = 4

/** Chooses how much of `pool` (already past any earlier compaction cut — see
 *  resolveCompactionCut's `rest`) to fold into a NEW summary, leaving a raw tail sized to
 *  ~40% of ctxMax (estimateTokens, context-limit.ts's existing chars/token heuristic) so
 *  the very next reply isn't answered from a summary-only prompt. Always keeps at least
 *  the single most recent message in the tail, even if it alone exceeds budget — an
 *  oversized tail is better than an empty one. Returns null when there is nothing worth
 *  compacting: too few messages, or the whole pool already fits the tail budget. */
export function pickCompactionCut(pool: Message[], ctxMax: number): { toSummarize: Message[]; cutMessageId: string } | null {
  if (pool.length < MIN_MESSAGES_TO_COMPACT) return null
  const keepBudget = Math.max(1, Math.round(ctxMax * KEEP_RECENT_FRACTION))
  let tailStart = pool.length
  let tailTokens = 0
  while (tailStart > 0) {
    const next = pool[tailStart - 1]
    const nextTokens = estimateTokens([{ role: next.role, content: next.content }])
    if (tailStart < pool.length && tailTokens + nextTokens > keepBudget) break
    tailTokens += nextTokens
    tailStart--
  }
  if (tailStart <= 0) return null // the whole pool already fits the tail budget
  const toSummarize = pool.slice(0, tailStart)
  return { toSummarize, cutMessageId: toSummarize[toSummarize.length - 1].id }
}

// ── the summarization call ──────────────────────────────────────────────────────────

function buildSummarizationPrompt(priorSummary: string | null, toSummarize: Message[]): { role: string; content: string }[] {
  const transcript = toSummarize.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
  const priorBlock = priorSummary ? `Summary of the conversation so far:\n${priorSummary}\n\n---\n\n` : ''
  return [
    {
      role: 'system',
      content: 'Summarize the conversation below so it can replace the raw messages while preserving everything a later reply would need: decisions made, facts stated, ongoing tasks, and the user\'s stated preferences. Be concise but do not drop anything load-bearing. Reply with ONLY the summary — no preamble, no "Here is a summary". /no_think',
    },
    { role: 'user', content: `${priorBlock}${transcript}` },
  ]
}

/** Manual /compact-equivalent AND the async half auto-compact calls into. Summarizes
 *  everything in the pool past any EARLIER compaction cut (resolveCompactionCut's `rest`),
 *  seeding the old summary as context so a second compaction compounds instead of
 *  re-summarizing from scratch. Always runs through the chat's OWN upstream — the same
 *  local-or-linked-host resolution every other chat turn uses (chat-upstream.ts) — never a
 *  second model or a second server. Throws (never silently no-ops) on: conversation not
 *  found, upstream unavailable, nothing worth compacting, or a failed/empty summary — the
 *  caller (maybeAutoCompact for the auto path; the /compact route for the manual path)
 *  decides what "throws" means for its own contract. */
export async function compactConversation(
  d: Deps,
  convId: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ summary: string; upToMessageId: string; tokensBefore: number }> {
  const conv = d.db.getConversation(convId, true)
  if (!conv) throw new Error('not_found')
  const activeMessages = conv.messages ?? []

  const { summary: priorSummary, rest: pool } = resolveCompactionCut(conv, activeMessages)

  const resolved = resolveChatUpstream(d)
  if (!resolved.ok) throw new Error(resolved.code)
  const upstream: ChatUpstream = resolved.upstream

  const picked = pickCompactionCut(pool, upstream.ctxMax)
  if (!picked) throw new Error('nothing_to_compact')

  const promptMessages = buildSummarizationPrompt(priorSummary, picked.toSummarize)
  const tokensBefore = estimateTokens(picked.toSummarize.map((m) => ({ role: m.role, content: m.content })))

  // Same low-priority-background gate acquisition autoTitle uses (chat-routes.ts) — a
  // compaction call must never contend with real foreground chat/agent work for the
  // local engine's slot queue. Remote turns cost this machine nothing but a socket.
  const release = d.gate && !upstream.remote ? await d.gate.acquire('bg') : null
  let res: Response
  try {
    res = await callChatUpstream(upstream, {
      model: upstream.modelField,
      messages: promptMessages,
      stream: false,
      temperature: 0.3,
      max_tokens: 1024,
      thinking_budget_tokens: 0,
      chat_template_kwargs: { enable_thinking: false },
    }, AbortSignal.timeout(60_000), opts?.fetchImpl, d)
  } finally {
    release?.()
  }
  if (!res.ok) throw new Error(`summarization_failed_${res.status}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const summary = (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!summary) throw new Error('empty_summary')

  d.db.setConversationCompaction(convId, { summary, upToMessageId: picked.cutMessageId, tokensBefore })
  return { summary, upToMessageId: picked.cutMessageId, tokensBefore }
}

/** Called from both turn-starting routes (chat-routes.ts) right after the 'meta' SSE
 *  event, BEFORE the new turn's messages are built — so a successful compaction is
 *  reflected in the very same turn's prompt. `conv` is mutated in place with the fresh
 *  compaction fields on success so the caller's own buildEngineMessages call (right after
 *  this returns) sees them without a second DB read. Best-effort, same contract as
 *  autoTitle: a failed compaction must never surface to the user or block the turn — it
 *  just proceeds against the full (uncompacted) history, exactly today's behavior. */
export async function maybeAutoCompact(
  d: Deps,
  convId: string,
  conv: Conversation,
  emitCompactionEvent: (phase: 'start' | 'end') => Promise<void>,
): Promise<void> {
  const { ctxUsed, ctxMax } = lastCtxUsage(conv.messages ?? [])
  if (!shouldAutoCompact(ctxUsed, ctxMax)) return
  try { await emitCompactionEvent('start') } catch { /* client gone — same best-effort contract as the compaction call below */ }
  try {
    const fetchImpl = (d as unknown as { __fetchImplForTest?: typeof fetch }).__fetchImplForTest
    const result = await compactConversation(d, convId, fetchImpl ? { fetchImpl } : undefined)
    conv.compactionSummary = result.summary
    conv.compactionUpToMessageId = result.upToMessageId
    conv.compactionTokensBefore = result.tokensBefore
  } catch {
    // Best-effort — see doc comment above.
  }
  try { await emitCompactionEvent('end') } catch { /* client gone */ }
}

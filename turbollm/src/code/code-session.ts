// Code session adapter — the corrected pi-SDK integration (Phase 1 plan §3).
//
// This is a FRESH adapter, not a recovery of the old deleted one. It uses pi's real,
// documented SDK surface, which the old adapter never exercised:
//   • a real pre-execute `tool_call` extension hook that can {block} a call (containment +
//     mode-based approval), registered in-process via DefaultResourceLoader.extensionFactories;
//   • the edit tool's real returned diff/patch, read off the `tool_result` event;
//   • a real custom provider pointed at TurboLLM's own local gateway with the REAL loaded
//     model context window (not a hardcoded 32768);
//   • a real system-prompt via appendSystemPrompt (a genuine system-role field, not smuggled
//     into a user turn).
//
// Everything is in-memory (auth/models/sessions/settings) so a run touches no global pi config
// on disk; the pi cwd is a caller-supplied scratch/repo folder that is ALSO the containment root.
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Type, Unsafe, type TSchema } from 'typebox'
import {
  createAgentSession,
  createBashTool,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
  SessionManager,
  SettingsManager,
  isEditToolResult,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import { createRobustBashOperations } from './robust-bash'
import type { TextContent, ToolCall as PiToolCall, Usage } from '@earendil-works/pi-ai'
import type { Deps } from '../deps'
import type { Message as DbMessage } from '../chat/db'
import { engineModelAlias } from '../engines/compat'
import { SkillStore, type Skill } from '../agents/skills'
import { isContainedFromRoot } from './containment'
import { buildAppendPrompt, toolsForMode, type CodeMode } from './persona'
import { waitForToolApproval } from '../tools/approval-gate'
import { LspClient, type LspDiagnostic } from './lsp-client'
import { lspSpecForPath, lspSpecForLanguage, SUPPORTED_LSP_LANGUAGES, type LspServerSpec } from './lsp-registry'

// A fabricated zero Usage for replayed history entries — pi requires the field on
// AssistantMessage, but exact historical token counts don't matter for replay; pi recomputes
// real usage for the actual new turn regardless.
const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** Replay this conversation's prior turns into a FRESH SessionManager as real pi session
 *  entries — not a flattened text blob — before the new turn is prompted.
 *
 *  Why this exists: runCodeSession creates a brand-new, memoryless pi AgentSession on EVERY
 *  call (SessionManager.inMemory() gets a fresh random session id each time; session.prompt()
 *  takes just the new task string). Without this, a follow-up message has ZERO awareness of
 *  anything said or done in earlier turns of the SAME Code session — confirmed live: told a
 *  session to remember a value, asked for it back in the very next turn, got back "I don't
 *  have any memory of a previous conversation — this is our first interaction in this
 *  session," followed by the model trying to `ls` the repo hunting for it on disk instead.
 *
 *  Using real appendMessage() entries (matching pi's own Message/AssistantMessage/
 *  ToolResultMessage shapes) rather than prepending a serialized text summary to the task
 *  means pi's own context-window accounting sees genuine history, and manual /compact
 *  (compactCodeSession below) has actual entries to compact instead of one giant synthetic
 *  user turn.
 *
 *  `onEntry`, when passed, fires once per appendMessage() call with the new pi entry id and
 *  the index (into `messages`) of the DB message it came from — compactCodeSession uses this
 *  to translate pi's post-compaction `firstKeptEntryId` back into "which DB message is the new
 *  cut point," since a fresh SessionManager has no entries of its own to already know this. */
function seedPriorHistory(
  sessionManager: SessionManager,
  messages: DbMessage[],
  modelId: string,
  onEntry?: (piEntryId: string, msgIndex: number) => void,
): void {
  messages.forEach((m, msgIndex) => {
    const timestamp = Date.parse(m.createdAt) || Date.now()
    if (m.role === 'user') {
      onEntry?.(sessionManager.appendMessage({ role: 'user', content: m.content, timestamp }), msgIndex)
      return
    }
    // m.role === 'assistant'
    const content: (TextContent | PiToolCall)[] = []
    if (m.content.trim()) content.push({ type: 'text', text: m.content })
    for (const tc of m.toolCalls) content.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.args })
    if (content.length === 0) return // an empty/aborted turn — nothing worth replaying
    onEntry?.(sessionManager.appendMessage({
      role: 'assistant', content, api: 'openai-completions', provider: 'local', model: modelId,
      usage: ZERO_USAGE, stopReason: 'stop', timestamp,
    }), msgIndex)
    for (const tc of m.toolCalls) {
      onEntry?.(sessionManager.appendMessage({
        role: 'toolResult', toolCallId: tc.id, toolName: tc.name,
        content: [{ type: 'text', text: tc.result ?? tc.error ?? '' }], isError: !!tc.error, timestamp,
      }), msgIndex)
    }
  })
}

/** How many pi session entries seedPriorHistory WILL append for these messages, mirroring its
 *  own qualification logic exactly (one entry per user message; one assistant entry + one
 *  toolResult entry per tool call for a non-empty assistant turn; nothing for an empty/aborted
 *  one) — the expected count to verify seeding actually took effect against. */
function countReplayEntries(messages: DbMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role === 'user') { n++; continue }
    if (!m.content.trim() && m.toolCalls.length === 0) continue
    n += 1 + m.toolCalls.length
  }
  return n
}

/** Plain-text fallback rendering of history, used only when structured replay (seedPriorHistory)
 *  demonstrably failed to register its entries — see the retry/fallback block in runCodeSession.
 *  Not pi session entries, just a text block prepended to the new turn's prompt so the model has
 *  SOME truthful record of prior turns rather than silently answering with none. */
function renderHistoryFallbackText(summaryText: string | null, messages: DbMessage[]): string {
  const parts: string[] = []
  if (summaryText) parts.push(summaryText)
  for (const m of messages) {
    if (m.role === 'user') { parts.push(`User: ${m.content}`); continue }
    if (m.content.trim()) parts.push(`Assistant: ${m.content}`)
    for (const tc of m.toolCalls) {
      parts.push(`Assistant used tool ${tc.name}(${JSON.stringify(tc.args)}) → ${(tc.result ?? tc.error ?? '').slice(0, 500)}`)
    }
  }
  return parts.join('\n\n')
}

const HISTORY_FALLBACK_PREFIX = 'Earlier turns in this conversation (structured history replay failed — shown as plain text):\n\n'
const HISTORY_FALLBACK_SUFFIX = '\n\n(End of earlier turns — the current message follows.)\n\n'

const COMPACTION_PREFIX = 'Summary of earlier conversation in this session (compacted to save context):\n\n'
const COMPACTION_SUFFIX = '\n\n(End of summary — the actual conversation continues below.)'

/** Everything a fresh pi session needs replayed for this conversation, respecting any existing
 *  manual compaction AND a more recent manual /clear: a synthetic summary message standing in
 *  for everything at/before agent_runs.compaction_upto_message_id, followed by the real DB
 *  messages after it — UNLESS agent_runs.cleared_upto_message_id sits at or after that point, in
 *  which case the clear wins: a blank slate (no summary carried forward) from the clear point
 *  onward. /resume sets cleared_upto_message_id back to null, which falls straight through to
 *  the compaction-only behavior again (exactly as if the clear never happened). Shared by
 *  runCodeSession (normal turns) and compactCodeSession (re-summarizing), so both always agree
 *  on what "history so far" means. */
export function resolveEffectiveHistory(d: Deps, convId: string, sessionId: string): { summaryText: string | null; messages: DbMessage[] } {
  const all = d.db.getConversation(convId, true)?.messages ?? []
  const run = d.db.getAgentRun(sessionId)
  // /clear (v34, ADR-261) now DEACTIVATES its messages (is_active=0), so getConversation →
  // getMessages has already dropped them from `all` — no cursor slice needed here anymore. A
  // cleared session is a blank slate: also drop any earlier compaction summary (it summarized
  // history that now sits behind the clear), returning just the still-active post-clear messages.
  // /resume reactivates that history and nulls this marker, falling straight through to the
  // compaction/full path below again (exactly as if the clear never happened).
  if (run?.clearedUpToMessageId) return { summaryText: null, messages: all }
  if (!run?.compactionUpToMessageId) return { summaryText: null, messages: all }
  // An unresolvable compaction marker (cut message deleted/corrupt) still surfaces its summary —
  // replaying every raw message alongside a redundant summary loses nothing, whereas resolving
  // it as "no compaction at all" would silently discard a real (if now unanchored) summary.
  const compactionIdx = all.findIndex((m) => m.id === run.compactionUpToMessageId)
  const rest = compactionIdx === -1 ? all : all.slice(compactionIdx + 1)
  return { summaryText: `${COMPACTION_PREFIX}${run.compactionSummary}${COMPACTION_SUFFIX}`, messages: rest }
}

// pi's own auto-compaction defaults (reserveTokens: 16384, keepRecentTokens: 20000 — 36384 total)
// assume a large HOSTED model's context window (100K+ tokens). A local model's real context is
// often far smaller — 8K-32K is common on consumer GPUs — and left unscaled, reserve+keepRecent
// ALONE can exceed the model's whole window. That makes compaction self-defeating: pi "compacts"
// but still aims to keep ~20000 tokens of recent history, which the very next request can't fit
// under either, immediately overflowing again — and pi only auto-retries an overflow ONCE before
// giving up for good with "Context overflow recovery failed..." (GitHub #60: "ran out of
// context... it just failed", with no attempt to roll up context that could actually succeed).
const PI_DEFAULT_RESERVE_TOKENS = 16384
const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000

/** Auto-compaction settings scaled to the REAL loaded model's context window instead of pi's
 *  hosted-model-sized defaults — reserve ~15% and keep-recent ~35% of `contextWindow` (leaving
 *  the other ~50% for the compaction summary, system prompt/skills, and the new turn), capped at
 *  pi's own defaults so a large-context local setup (e.g. a 200K-ctx build) is unaffected. */
export function compactionSettingsFor(contextWindow: number): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
  const reserveTokens = Math.max(512, Math.min(PI_DEFAULT_RESERVE_TOKENS, Math.round(contextWindow * 0.15)))
  const keepRecentTokens = Math.max(1024, Math.min(PI_DEFAULT_KEEP_RECENT_TOKENS, Math.round(contextWindow * 0.35)))
  return { enabled: true, reserveTokens, keepRecentTokens }
}

/** Hard-abort safety margin for the near-overflow check below — deliberately TIGHTER than
 *  compactionSettingsFor's own reserveTokens (~15% of contextWindow). That reserve is the normal
 *  "compact soon" signal pi's own threshold check already handles correctly BETWEEN turns; this
 *  is a separate, later, genuine last-resort "about to actually overflow and error" signal for
 *  the one case a turn-boundary-only check structurally cannot reach — a single CONTINUOUS turn
 *  running dozens of rounds with no boundary to trigger at (root-caused, see decision log: pi's
 *  _checkCompaction is only ever invoked before a new session.prompt() or after the whole
 *  agentic loop settles, never mid-loop). Small and fixed-fraction rather than reusing
 *  reserveTokens, so this only fires meaningfully AFTER the normal reserve has already been
 *  crossed within one unbroken turn — proof the boundary check truly never got a chance to run,
 *  not a duplicate of it firing early. */
export function nearOverflowReserveTokens(contextWindow: number): number {
  return Math.max(256, Math.round(contextWindow * 0.05))
}

/** Rough chars/4 token estimate for one DB message + its tool calls' args/results — mirrors pi's
 *  own heuristic (compaction.js's estimateTokens) closely enough to size a safety margin against
 *  (see keepRecentTokensFor below), not to reproduce pi's count exactly. */
export function estimateMessageTokensRough(m: DbMessage): number {
  let chars = m.content.length
  for (const tc of m.toolCalls) {
    chars += tc.name.length + JSON.stringify(tc.args).length // the assistant's own toolCall block
    chars += (tc.result ?? tc.error ?? '').length // the separate toolResult entry
  }
  return Math.ceil(chars / 4)
}

/** Founder-reported, 2026-07-17 ("I have never yet successfully compacted... keeps saying
 *  conversation is short") — root-caused against a real 272K-token AMOLEDBurnFix session: pi's
 *  bundled findCutPoint (compaction.js) has a genuine bug. It walks backward from the newest
 *  entry accumulating token estimates until `keepRecentTokens` is reached, then searches for the
 *  closest valid cut point AT OR AFTER that position — but a "cut point" can only be a user/
 *  assistant/etc. message, never a tool result (pi's own rule: never cut a tool call apart from
 *  its result). When a session's LAST turn is a heavy tool-call turn (common in agentic coding —
 *  a single turn easily has dozens of tool results with no later user/assistant message), and
 *  `keepRecentTokens` is smaller than that whole trailing run's size, the threshold gets crossed
 *  entirely INSIDE that run — where there is no valid cut point at or after the crossing position
 *  — so the search comes up empty and silently falls back to keeping EVERYTHING (cutIndex 0)
 *  instead of the last real cut point, reporting "nothing to compact" no matter how large the
 *  actual conversation is. Reproduced directly: a real session's trailing tool-call run alone
 *  summed to ~12K estimated tokens; keepRecentTokens=2867/11469 (compactionSettingsFor's own
 *  scaled values for an 8K/32K local context — ADR-224) both hit the bug, 12000+ did not.
 *  Can't patch the bundled dependency, so work around it here: never let keepRecentTokens end up
 *  smaller than the conversation's own last turn, so pi's threshold-crossing walk always lands at
 *  or before a real cut point instead of running past every one of them. `messages` should be
 *  whatever pi is about to have seeded (repriorMessages for auto-compaction, the full
 *  effectiveMessages for manual /compact) — NOT the live in-flight turn, which isn't seeded yet. */
export function keepRecentTokensFor(messages: DbMessage[], baseKeepRecentTokens: number): number {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
  if (lastUserIdx === -1) return baseKeepRecentTokens
  let lastTurnTokens = 0
  for (let i = lastUserIdx; i < messages.length; i++) lastTurnTokens += estimateMessageTokensRough(messages[i])
  return Math.max(baseKeepRecentTokens, lastTurnTokens + 512) // margin past the exact boundary
}

/** A minimal SSE sink — matches the chat wire shape so the existing frontend parser works. */
export type CodeSseSink = (ev: { event: string; data: unknown }) => void | Promise<void>

/** Injects a message into the CURRENTLY ACTIVE turn via pi's real `session.steer()` (Phase 1,
 *  ADR-246). Resolves `true` when the message was actually handed to the live agent loop, `false`
 *  when the turn is no longer streaming (a race — it just finished), so the caller can fall back
 *  to follow-up/queue behavior instead of dropping the message into a dead session. */
export type SteerHandle = (text: string) => Promise<boolean>

export interface RunCodeParams {
  d: Deps
  convId: string
  /** agent_runs.id — used only to look up an existing manual-compaction marker
   *  (resolveEffectiveHistory); the run/turn lifecycle itself is owned by code-run-manager.ts. */
  sessionId: string
  /** cwd for the pi session AND the containment root — a scratch/repo folder. */
  repoRoot: string
  mode: CodeMode
  /** Reasoning token budget for this turn: -1 = unlimited (default), 0 = thinking off
   *  entirely, N>0 = a real sampler-enforced cap — same semantics and wire field
   *  (`thinking_budget_tokens`) as chat's own thinkingBudget (chat-routes.ts). Applied via
   *  the before_provider_request hook below since pi makes its own provider HTTP calls. */
  thinkingBudget: number
  /** The user's task text (first prompt of the run). */
  task: string
  /** Fires when the HTTP request is aborted / the run is stopped. */
  signal: AbortSignal
  sink: CodeSseSink
  /** Registers (and later clears) a {@link SteerHandle} the daemon-side run manager can call to
   *  STEER a message into THIS live turn instead of queueing a fresh one behind it (Phase 1,
   *  ADR-246). Called with the handle once the pi session exists, and again with `null` in the
   *  finally when the turn settles, so the manager never routes a steer into a disposed session.
   *  Optional: the reconnect tests' injected runners don't steer and simply omit it. */
  onSteerable?: (steer: SteerHandle | null) => void
}

export interface RunCodeResult {
  /** Final assistant text (the plan, in plan mode; the summary, otherwise). */
  finalText: string
  /** Real context usage this run, for the context ring. */
  contextUsed: number
  contextMax: number
  aborted: boolean
  /** Real per-turn token/timing stats — see foldTurnUsage's doc comment. Omitted entirely
   *  (not zeroed) when the engine returned no usable usage at all. */
  promptTokens?: number
  genTokens?: number
  cachedTokens?: number
  promptMs?: number
  genMs?: number
  promptTps?: number
  tps?: number
  ttftMs?: number
  totalMs?: number
}

/** Folds pi's own SessionStats.tokens (already turn-scoped — replayed prior-turn history is
 *  seeded with ZERO_USAGE, see below, so the sum reflects only this turn's real provider
 *  rounds) together with wall-clock timing accumulated across every agentic round of this turn
 *  into the same MessageStats shape Chat's own engine-agnostic fallback produces
 *  (chat-routes.ts's `else` branch) — no llama.cpp-specific `timings` object is available here,
 *  since Code goes through pi's OpenAI-compatible client rather than a raw fetch. Never
 *  fabricates a 0: if the engine returned no real usage at all (e.g. ignores
 *  `include_usage`), every field is omitted so the UI leaves the stat off rather than showing a
 *  misleadingly precise zero (mirrors CodeComposer's own `!== undefined` render guard). */
export function foldTurnUsage(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  timing: { promptMsTotal: number; genMsTotal: number; ttftMs?: number; totalMs: number },
): Pick<RunCodeResult, 'promptTokens' | 'genTokens' | 'cachedTokens' | 'promptMs' | 'genMs' | 'promptTps' | 'tps' | 'ttftMs' | 'totalMs'> {
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const genTokens = tokens.output
  if (promptTokens === 0 && genTokens === 0) return {}
  return {
    promptTokens,
    genTokens,
    cachedTokens: tokens.cacheRead,
    promptMs: timing.promptMsTotal,
    genMs: timing.genMsTotal,
    promptTps: timing.promptMsTotal > 0 ? Math.round((promptTokens / timing.promptMsTotal) * 1000 * 10) / 10 : 0,
    tps: timing.genMsTotal > 0 ? Math.round((genTokens / timing.genMsTotal) * 1000 * 10) / 10 : 0,
    ttftMs: timing.ttftMs,
    totalMs: timing.totalMs,
  }
}

// pi's built-in mutating tools that require approval in ASK mode. read/grep/find/ls are
// read-only and never gated. bash has no path argument, so containment can't confine it —
// the mode system is its only guard (ask = approval, plan = not in toolset, auto = unconfined).
export const MUTATING_TOOLS = new Set(['edit', 'write', 'bash'])
// Tools whose path argument routes through the containment gate below (plan §3b) — not all of
// them are actually BLOCKED by it, see WRITE_PATH_TOOLS. bash is deliberately absent — it takes
// `command`, not `path` (see risk flag 1).
export const PATH_TOOLS = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls'])
// The subset of PATH_TOOLS actually CONFINED to repoRoot (loosened 2026-07-25, founder ask:
// "allow reads outside the repo folder while keeping writes confined to it"). edit/write stay
// hard-confined — writing outside the project is the real safety boundary. read/grep/find/ls may
// now target any path on the host filesystem: referencing a sibling repo, a shared lib, or system
// docs while investigating is a normal, safe read. containment.ts's isContainedFromRoot is only
// actually enforced (as a block) for entries in this set — see the shared PATH_TOOLS gate below.
export const WRITE_PATH_TOOLS = new Set(['edit', 'write'])

// ── Consecutive identical tool-call loop breaker (founder-reported) ────────────
// A weak local model can get stuck firing the SAME tool with the SAME arguments over and over,
// making no progress — the turn never settles and reads to the user as a hung agent. After
// LOOP_BREAK_AFTER consecutive identical calls the tool_call hook stops EXECUTING the tool and
// hands the model a direct break-the-loop instruction instead (delivered as the blocked call's
// result, which the model is guaranteed to read). Silent to the user — no prompt, no
// confirmation; the run self-heals. A different tool, different arguments, or a new top-level
// turn resets the count. The first LOOP_BREAK_AFTER identical calls still run normally, so a
// model that legitimately repeats a call a few times is unaffected — only a genuine loop is cut.
export const LOOP_BREAK_AFTER = 3

// The soft nudge above assumes the model actually reads and acts on the blocked-call result — a
// genuinely stuck weak/local model can just re-emit the exact same call again anyway, and
// ToolLoopTracker.record() has no ceiling (a re-tripped signature keeps incrementing forever, see
// its own test), so nothing was stopping this from repeating indefinitely — reproduced live
// (founder-reported, 2026-07-24: the nudge fired and had "no effect", the run stayed stuck).
// LOOP_ABORT_AFTER is the hard ceiling: after this many consecutive identical calls (i.e. the
// model ignored LOOP_ABORT_AFTER - LOOP_BREAK_AFTER separate nudges), stop assuming it'll
// self-heal and abort the run outright via session.abort() — the same real-stop path a user's own
// Stop button uses, so it surfaces as a genuinely stopped run (stats.aborted), not a silent hang.
export const LOOP_ABORT_AFTER = LOOP_BREAK_AFTER + 3

/** Order-stable signature of a tool call: the name plus its arguments with object keys sorted at
 *  every depth, so a model re-emitting the same call with its keys in a different order still
 *  compares equal. Pure. */
export function toolCallSignature(name: string, input: unknown): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return `${name}\u0000${stable(input)}`
}

/** Tracks consecutive identical tool calls within a turn. `record()` returns the running count
 *  for the current (tool, args) signature — 1 for a fresh call, N for the Nth identical one in a
 *  row; any different call resets it to 1. The caller breaks the loop once the count exceeds
 *  {@link LOOP_BREAK_AFTER}. Deliberately isolable so it's unit-testable without pi or a model. */
export class ToolLoopTracker {
  private lastSig: string | null = null
  private count = 0
  record(name: string, input: unknown): number {
    const sig = toolCallSignature(name, input)
    if (sig === this.lastSig) this.count += 1
    else { this.lastSig = sig; this.count = 1 }
    return this.count
  }
  reset(): void { this.lastSig = null; this.count = 0 }
}

// Mechanical half of the dependency-discipline fix (founder-reported gap, 2026-07-13, item 2,
// see persona.ts's dependencyDisciplineGuidance for the full rationale): matches shell commands
// that add a NEW dependency across common package managers, deliberately requiring an argument
// after the add/install verb so a bare `npm install`/`pip install -r requirements.txt` (installing
// from an existing manifest, not deciding on a new dependency) doesn't false-positive. This only
// covers CLI installs — a precise, well-defined signal, same quality bar as Fix 1's `isError`.
// Manifest edits made by hand (e.g. Gradle's `dependencies {}` block) have no equally precise
// signal without false-positiving on unrelated edits to the same file, so those aren't checked
// here and rely on the prompt guidance alone.
const DEPENDENCY_ADD_PATTERNS = [
  /\bnpm\s+(i|install|add)\s+\S/,
  /\byarn\s+add\s+\S/,
  /\bpnpm\s+add\s+\S/,
  /\bpip3?\s+install\s+(?!-r\b)(?!-e\s+\.)\S/,
  /\bpoetry\s+add\s+\S/,
  /\bcargo\s+add\s+\S/,
  /\bgo\s+get\s+\S/,
  /\bgem\s+install\s+\S/,
  /\bbundle\s+add\s+\S/,
  /\bcomposer\s+require\s+\S/,
]
export function isDependencyAddCommand(command: string): boolean {
  return DEPENDENCY_ADD_PATTERNS.some((re) => re.test(command))
}

// LSP integration (item 3) — MODULE-level, keyed by convId (not per-runCodeSession-call): a code
// session is one function call PER TURN (see code-run-manager.ts's own comment, "the one function
// the manager drives per turn"), so a per-turn-scoped client would pay the npx cold-start cost
// (up to LspClient's own ~60s ceiling) on EVERY turn instead of once per session — defeating the
// entire point of keeping a warm, already-initialized language-server process. Persists for the
// life of the daemon process; disposed explicitly on session delete (see
// disposeLspClientsForConv, called from code-routes.ts's DELETE route) rather than an idle
// timeout — simpler, and bounded by "one entry per code session that actually used an LSP, until
// that session is deleted," which is a small, self-limiting number in practice.
const lspClientsByConv = new Map<string, Map<string, LspClient>>()

/** Disposes and forgets every LSP client running for `convId` (all languages). Called on session
 *  delete so a deleted session's language-server child processes don't outlive it. */
export function disposeLspClientsForConv(convId: string): void {
  const clients = lspClientsByConv.get(convId)
  if (!clients) return
  for (const c of clients.values()) c.dispose()
  lspClientsByConv.delete(convId)
}

/** Extract the plain text out of a pi tool `partialResult` (tool_execution_update) — pi's bash
 *  tool streams `{ content: [{ type: 'text', text }], details }` snapshots through it (verified in
 *  the bundled bash tool's `onUpdate`). Mirrors the tool_result hook's own content-flattening;
 *  tool-agnostic and defensive since `partialResult` is typed `any` and other tools could differ. */
function extractPartialText(partialResult: unknown): string {
  const pr = partialResult as { content?: Array<{ type?: string; text?: string }> } | null | undefined
  if (!pr || !Array.isArray(pr.content)) return ''
  return pr.content.map((c) => (c?.type === 'text' ? c.text ?? '' : '')).join('')
}

/** One SSE frame the relay emits, or null for an event we deliberately don't surface. */
export type CodeRelayFrame = { event: string; data: Record<string, unknown> } | null

/** Pure map from a pi `AgentSessionEvent` to the SSE frame the Code relay emits for it (Phase 2,
 *  ADR-250). Extracted from runCodeSession's session.subscribe closure so the whole event→frame
 *  contract is unit-testable without a live pi session or a loaded model (the live loop itself
 *  stays out of scope, same as the rest of code-session.test.ts).
 *
 *  Surfaces, beyond the original text/thinking deltas and compaction:
 *   • turn_start / turn_end        → a `turn` frame (phase + a monotonic index the caller threads
 *     via `turnCounter`, incremented on turn_end so a start/end pair share one index) so the UI can
 *     group a turn's deltas + tool calls into one visual unit.
 *   • auto_retry_start / _end      → a `retry` frame (attempt / maxAttempts / delayMs / message) so
 *     the UI can show a real "Retrying…" banner when pi auto-retries a transient provider failure,
 *     instead of a silent stall.
 *   • tool_execution_update        → a `tool_progress` frame carrying the tool call's incremental
 *     output snapshot. pi's built-in bash tool streams stdout/stderr through this (verified); the
 *     edit tool is atomic and never emits it. DISTINCT from the `tool_call` frames the tool_call/
 *     tool_result extension hooks already emit (pending → done): this fills the live gap between
 *     them. tool_execution_start/_end are intentionally NOT surfaced — they'd duplicate those
 *     pending/done `tool_call` frames and double-render every call.
 *
 *  All the new frames are ephemeral live signals: code-run-manager's sink persists nothing for
 *  them (it keys DB accumulation off delta/reasoning/tool_call), so they only ever cost a
 *  live-tail + reconnect-replay frame, never DB writes. */
export function codeEventToFrame(ev: AgentSessionEvent, turnCounter: { index: number }): CodeRelayFrame {
  switch (ev.type) {
    case 'message_update': {
      const ame = ev.assistantMessageEvent
      if (ame.type === 'text_delta') return { event: 'delta', data: { delta: ame.delta } }
      if (ame.type === 'thinking_delta') return { event: 'reasoning', data: { delta: ame.delta } }
      return null
    }
    case 'compaction_start':
      return { event: 'compaction', data: { phase: 'start', reason: ev.reason } }
    case 'compaction_end':
      return { event: 'compaction', data: { phase: 'end', reason: ev.reason, aborted: ev.aborted, tokensBefore: ev.result?.tokensBefore } }
    case 'turn_start':
      return { event: 'turn', data: { phase: 'start', index: turnCounter.index } }
    case 'turn_end': {
      const frame: CodeRelayFrame = { event: 'turn', data: { phase: 'end', index: turnCounter.index, toolResults: ev.toolResults.length } }
      turnCounter.index++
      return frame
    }
    case 'auto_retry_start':
      return { event: 'retry', data: { phase: 'start', attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, message: ev.errorMessage } }
    case 'auto_retry_end':
      return { event: 'retry', data: { phase: 'end', attempt: ev.attempt, success: ev.success, message: ev.finalError } }
    case 'tool_execution_update':
      return { event: 'tool_progress', data: { id: ev.toolCallId, name: ev.toolName, partial: extractPartialText(ev.partialResult) } }
    default:
      return null
  }
}

// ── Delegated sub-tasks (delegate_task tool, ADR-259) ──────────────────────────────
// Hard ceiling on ONE delegated sub-task's wall-clock time. A delegated sub-agent runs a full
// nested agentic loop; without a bound a stuck/looping sub-task could hold a background engine slot
// (via d.gate) far longer than the parent — or any waiting foreground Chat — should tolerate. On
// expiry the sub-session is aborted and whatever it produced so far is returned as an explicit
// "did not finish" result, never a silent hang. A parent Stop aborts it immediately too (sooner).
export const DELEGATE_SUBAGENT_TIMEOUT_MS = 5 * 60_000

/** Validate the `task` argument the model passes to delegate_task. Pure/exported so the tool's
 *  input contract is unit-testable without a live pi session or a loaded model. */
export function validateDelegateTask(raw: unknown): { ok: true; task: string } | { ok: false; message: string } {
  const task = typeof raw === 'string' ? raw.trim() : ''
  if (!task) return { ok: false, message: 'delegate_task: `task` must be a non-empty description of the sub-task to delegate.' }
  return { ok: true, task }
}

/** Fold a delegated sub-agent's final text into the single string returned to the PARENT as the
 *  tool result — the ONLY thing that crosses back (the sub-agent's step-by-step transcript never
 *  enters the parent's context). Pure/exported for unit testing. A timed-out / stopped run is
 *  reported as explicitly INCOMPLETE (with any partial text) rather than passed off as a finished
 *  answer, so the parent doesn't build on a half-done result believing it succeeded. */
export function normalizeDelegateResult(finalText: string, opts?: { timedOut?: boolean; timeoutMs?: number }): string {
  const text = finalText.trim()
  if (opts?.timedOut) {
    const mins = Math.max(1, Math.round((opts.timeoutMs ?? DELEGATE_SUBAGENT_TIMEOUT_MS) / 60_000))
    const partial = text ? `\n\nPartial progress before it was stopped:\n${text}` : ''
    return `(the delegated sub-task did not finish within ~${mins} minute(s) and was stopped — treat it as INCOMPLETE; consider doing it yourself or delegating a smaller piece.${partial})`
  }
  return text || '(the delegated sub-agent produced no output.)'
}

// System-prompt preamble appended AFTER the normal mode persona for a delegated sub-agent, so it
// behaves as a focused, self-contained worker: it never sees the parent conversation, cannot
// delegate further or invoke skills (enforced structurally — those tools are simply not registered
// on the sub-session, giving a hard nesting depth of 1), and must end with a self-contained summary
// since that summary is all the parent receives.
const DELEGATED_SUBAGENT_PREAMBLE = 'You are an isolated sub-agent handling ONE delegated sub-task on behalf of a parent coding agent. ' +
  'You do NOT see the parent conversation or its history — everything you need is in the task message below. ' +
  'Do exactly that task and nothing more, using your tools against the same repository. You cannot delegate ' +
  'further or invoke skills. When finished, end your reply with a concise, self-contained summary of what you ' +
  'did, what you found, and anything the parent needs in order to continue — that summary is the ONLY thing ' +
  'returned to the parent.'

// ── Todo / step progress tracker (update_todos tool, ADR-255) ──────────────────────
// A structured checklist the model maintains for a multi-step task so the UI can show live
// progress ("3/7 done") instead of an opaque stream of tool calls. The model re-sends the WHOLE
// list each call (replace, not diff — the simplest model to call correctly); it's emitted as an
// ephemeral `todos` SSE frame and held in the run's live state for reconnect (code-run-manager.ts),
// never a DB column. Registered ONLY on the top-level session — a delegated/skill sub-session never
// gets update_todos, so a sub-agent's internal steps stay out of the parent's list (one list per
// top-level turn; see the delegate_task interaction note in this task's write-up).
export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed'])
// A real multi-step task is a handful of steps, not hundreds — this caps a confused/looping model
// from emitting an unbounded list (and bounds the frame size).
export const MAX_TODOS = 50

/** Coerce the model's raw update_todos argument into a clean TodoItem[] (pure/exported for
 *  testing). Local models send messy input, so this is defensive: a non-array → []; each entry
 *  must be an object with non-empty `content` (trimmed) or it's dropped; an unknown/missing status
 *  defaults to 'pending'; the list is capped at MAX_TODOS. The result REPLACES the prior list —
 *  the tool's contract is "re-send the full current list each call", not incremental diffs. */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content.trim() : ''
    if (!content) continue
    const status = typeof rec.status === 'string' && TODO_STATUSES.has(rec.status as TodoItem['status'])
      ? (rec.status as TodoItem['status']) : 'pending'
    out.push({ content, status })
    if (out.length >= MAX_TODOS) break
  }
  return out
}

/** One-line confirmation returned to the model after an update_todos call (pure/exported), so it
 *  gets concrete feedback that the list registered and where it stands — e.g. "Tracking 7 step(s):
 *  3 done, 1 in progress." An empty list reads as an explicit clear. */
export function summarizeTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list cleared.'
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length
  const parts = [`${completed}/${todos.length} done`]
  if (inProgress > 0) parts.push(`${inProgress} in progress`)
  return `Tracking ${todos.length} step(s): ${parts.join(', ')}.`
}

// ── Real prefill (prompt-processing) progress via llama.cpp /slots ─────────────────
// Founder-reported: Code shows the prompt-processing phase as a generic "thinking" spinner while
// Chat shows a real progress bar. Chat gets it by hand-parsing llama.cpp's own `prompt_progress`
// SSE field from its own raw HTTP call; Code goes through pi's `openai` client, which never
// surfaces that field. So we read progress OUT OF BAND from the engine's own `/slots` endpoint
// (enabled by default, no --slots flag) while a provider request is in flight — independent of pi's
// request entirely. `pct = n_prompt_tokens_processed / n_prompt_tokens`.
export const PREFILL_POLL_MS = 300

export interface PrefillProgress { processed: number; total: number; pct: number }

function isProcessingSlot(s: unknown): s is { n_prompt_tokens: number; n_prompt_tokens_processed: number } {
  if (!s || typeof s !== 'object') return false
  const r = s as Record<string, unknown>
  return r.is_processing === true && typeof r.n_prompt_tokens === 'number' && typeof r.n_prompt_tokens_processed === 'number'
}

/** Pick THIS request's prefill progress out of a llama.cpp `/slots` response — pure/exported so the
 *  slot-matching + percentage logic is testable without a live engine (mirrors codeEventToFrame's
 *  extract-pure-decision-logic pattern). Returns null ("emit nothing this poll") for anything
 *  unusable: a non-array body, no slot actively processing, a zero/absent prompt-token total, or
 *  processed<0.
 *
 *  Slot matching: returns null when MORE THAN ONE slot is processing at once. The in-app gate
 *  (gate.ts) serializes Code+Chat generations and llama.cpp defaults to --parallel 1 (a single
 *  slot), so the normal case has exactly one processing slot that is unambiguously ours. Only a
 *  user-set --parallel>1 running a genuinely concurrent generation the gate does NOT cover (gateway
 *  / Claude-Code traffic never takes the gate) can light up two slots simultaneously — and pi's
 *  openai client never exposes the llama.cpp `id_task` needed to correlate precisely, so we refuse
 *  to guess and show nothing rather than risk attributing another request's progress to this turn. */
export function pickPrefillProgress(slots: unknown): PrefillProgress | null {
  if (!Array.isArray(slots)) return null
  const processing = slots.filter(isProcessingSlot)
  if (processing.length !== 1) return null
  const total = processing[0].n_prompt_tokens
  const processed = processing[0].n_prompt_tokens_processed
  if (!(total > 0) || processed < 0) return null
  const pct = Math.min(100, Math.max(0, Math.round((processed / total) * 100)))
  return { processed, total, pct }
}

/**
 * Run a Code session end-to-end against `repoRoot`, streaming SSE to `sink`.
 * Resolves when the pi agentic loop settles (or the run is aborted).
 */
export async function runCodeSession(params: RunCodeParams): Promise<RunCodeResult> {
  const { d, convId, sessionId, repoRoot, mode, thinkingBudget, task: rawTask, signal, sink } = params

  const ms = d.manager.status()
  if (ms.state !== 'running' || !ms.model) throw new Error('model_not_loaded')
  const target = d.manager.target()
  if (!target) throw new Error('model_not_loaded')

  // The model id the engine expects: an engine may expose an alias (e.g. vLLM) instead of
  // TurboLLM's model key — mirror exactly how chat-routes resolves it.
  const engineKind = d.registry.active()?.kind ?? ''
  const modelId = engineModelAlias(engineKind) ?? ms.model.key
  // REAL context window from the loaded model (plan §3, point 3) — never a hardcoded 32768.
  const contextWindow = ms.model.ctx > 0 ? ms.model.ctx : 8192
  // Captured once here (rather than re-read as `ms.model.name` at each registration site)
  // because TS's null-narrowing of `ms.model` from the guard above doesn't reliably propagate
  // into runSkillSubSession's nested function declaration below.
  const modelDisplayName = ms.model.name || 'Local Model'

  // The FULL shared SkillStore — the main prompt only ever sees names+descriptions of these
  // (persona.ts's skillCatalogBlock); invoke_skill (registered below) looks a specific one up
  // by id here and loads its full instructions ONLY for that one isolated subagent call.
  const skills = new SkillStore(d.store.dir()).list()

  // ── in-memory pi services (no global pi config on disk) ──────────────────────
  const authStorage = AuthStorage.inMemory()
  const modelRegistry = ModelRegistry.inMemory(authStorage)
  // Seed prior turns (see seedPriorHistory's own comment), respecting any existing manual
  // /compact — everything up to but NOT including the current turn's user message.
  // code-run-manager.ts's pump() has already appended both `task`'s own user message AND an
  // empty assistant placeholder for THIS turn by the time we get here, so the current turn is
  // excluded by cutting at the last user message, not by seq. Computed BEFORE settingsManager
  // below (moved up from its original spot) since keepRecentTokensFor needs priorMessages.
  const { summaryText, messages: effectiveMessages } = resolveEffectiveHistory(d, convId, sessionId)
  const lastUserIdx = effectiveMessages.findLastIndex((m) => m.role === 'user')
  const priorMessages = lastUserIdx > 0 ? effectiveMessages.slice(0, lastUserIdx) : []
  // Auto-compaction settings scaled to THIS model's real ctx (see compactionSettingsFor) — pi's
  // own hosted-model-sized defaults would otherwise make auto-compaction self-defeating here.
  // keepRecentTokens further guarded by keepRecentTokensFor — see its doc comment for the real
  // pi-side bug this works around (a heavy-tool-call-ending turn otherwise makes pi's own
  // findCutPoint silently keep everything and report nothing left to compact).
  const autoCompactionSettings = compactionSettingsFor(contextWindow)
  autoCompactionSettings.keepRecentTokens = keepRecentTokensFor(priorMessages, autoCompactionSettings.keepRecentTokens)
  const settingsManager = SettingsManager.inMemory({ compaction: autoCompactionSettings })
  const seedHistoryInto = (sm: SessionManager): void => {
    if (summaryText) sm.appendMessage({ role: 'user', content: summaryText, timestamp: Date.now() })
    if (priorMessages.length > 0) seedPriorHistory(sm, priorMessages, modelId)
  }
  const sessionManager = SessionManager.inMemory(repoRoot)
  seedHistoryInto(sessionManager)
  // Defensive check + text fallback: live testing of a founder-reported "Code forgot my last
  // message" bug (2026-07-13, ADR-194) caught this exact seed silently registering FEWER entries
  // than it should have — sometimes zero, sometimes only a partial subset (e.g. the user's
  // message but not the assistant's reply) — in roughly 1 of every 5-6 turns, and occasionally
  // in a long unbroken streak. The root cause inside pi's SessionManager/tree-building was never
  // pinned down. This used to retry on a second fresh SessionManager before falling back to text;
  // removed 2026-07-15 (ADR-210) after confirming, by reading pi's own SessionManager.appendMessage/
  // getEntries source, that seedHistoryInto is fully synchronous, in-memory, and has no I/O — so
  // re-running it on the SAME unmutated priorMessages/summaryText can never produce a different
  // entry count than the first attempt did. The retry was dead weight; the plain-text fallback
  // below is the one path proven reliable in every trial (it's the actual turn — always
  // exercised), so it can't fail the same way appendMessage() apparently can. Always log so a
  // recurrence leaves forensic evidence (session id, expected vs actual count) instead of a
  // silent wrong answer.
  const expectedEntries = (summaryText ? 1 : 0) + countReplayEntries(priorMessages)
  let task = rawTask
  if (expectedEntries > 0 && sessionManager.getEntries().length < expectedEntries) {
    console.warn(`[code-session] history seed for session ${sessionId} produced ${sessionManager.getEntries().length}/${expectedEntries} expected entries — falling back to a plain-text history prefix on this turn's prompt`)
    task = `${HISTORY_FALLBACK_PREFIX}${renderHistoryFallbackText(summaryText, priorMessages)}${HISTORY_FALLBACK_SUFFIX}${rawTask}`
  }
  // Isolated, shippable agent-config dir under TurboLLM's own data dir (never an arbitrary
  // system path). It's a fresh empty dir, so no user global extensions/skills are discovered.
  const agentDir = join(d.store.dir(), 'pi-agent')

  // Register TurboLLM's own local gateway as a custom OpenAI-completions provider (plan §3a).
  modelRegistry.registerProvider('local', {
    baseUrl: `${target}/v1`,
    apiKey: 'agent-key',
    authHeader: true,
    api: 'openai-completions',
    models: [
      {
        id: modelId,
        name: modelDisplayName,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
        // qwen-chat-template thinking control matches how TurboLLM drives local chat models.
        compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen-chat-template' },
      },
    ],
  })
  const model = modelRegistry.find('local', modelId)
  if (!model) throw new Error('Failed to register local model with pi.')

  // ── gate integration (plan §3) ───────────────────────────────────────────────
  // Yield the single engine slot to foreground chat at background priority. pi makes its own
  // provider HTTP calls, so we hook them: acquire bg before each request, release after the
  // response — exactly the per-engine-call granularity chat's generation.ts uses, so fg chat
  // can preempt a Code run between pi turns.
  let heldGate: (() => void) | undefined
  const releaseGate = () => { const r = heldGate; heldGate = undefined; r?.() }

  // Mechanical anti-fallback tracker (founder-reported gap, 2026-07-13, item 1): counts REAL
  // consecutive tool failures across the run. Soft system-prompt guidance alone repeats the same
  // reliability problem being fixed here — a local model can just not follow it — so once this
  // hits the threshold, the tool_result hook below injects a hard nudge directly into the
  // failing tool's own result text, which the model is guaranteed to see next (it can't skip its
  // own tool result the way it can skip a system-prompt aside). Reset on any success AND at the
  // start of each new top-level turn, so failures from a past, already-resolved task don't leak
  // into an unrelated new one.
  let consecutiveToolFailures = 0

  // Mechanical half of the dependency-discipline fix (item 2, see isDependencyAddCommand's own
  // comment and persona.ts's dependencyDisciplineGuidance). Tracks whether a web_search/fetch_url
  // call has succeeded so far THIS turn — a coarse but honest proxy for "did you actually research
  // this" (not tied to any specific package name, which would require unreliable parsing). Reset
  // at turn_start, same lifecycle as consecutiveToolFailures.
  let hasSearchedWebThisTurn = false

  // Consecutive identical tool-call loop breaker (see ToolLoopTracker's own comment). Scoped to
  // this whole user task: constructed once here (runCodeSession runs once per task), and NOT reset
  // on pi's `turn_start` — that fires per agentic round, so resetting there would clear the count
  // between the very repeats it needs to catch (see the no-turn_start-reset note below).
  const toolLoop = new ToolLoopTracker()

  // LSP integration (item 3): one running language-server process per `language`, cached at
  // MODULE scope keyed by convId so it survives across turns — see lspClientsByConv's own
  // comment for why (this function runs once PER TURN, not once per whole session). TS/JS share
  // one typescript-language-server process (lsp-registry.ts). Lazily started on first use (an
  // explicit install_lsp call OR the first edit/write to a matching file).
  const getLspClient = (spec: LspServerSpec): LspClient => {
    let clients = lspClientsByConv.get(convId)
    if (!clients) { clients = new Map(); lspClientsByConv.set(convId, clients) }
    let client = clients.get(spec.language)
    if (!client) {
      client = new LspClient(spec, repoRoot)
      clients.set(spec.language, client)
    }
    return client
  }

  /** Runs one skill as a REAL, contained agentic sub-session — a separate pi session (its own
   *  history, not seeded with the outer conversation) but with the SAME mode-based tool access
   *  and safety boundary as the outer session: `auto`/`ask` get the default read/bash/edit/write
   *  toolset, `plan` gets the read-only set, and every path-taking tool is containment-checked
   *  against the SAME repoRoot regardless of mode. `ask` additionally gates mutating tools
   *  through the SAME waitForToolApproval() the outer session's own tool_call hook uses, keyed
   *  the same way (`${convId}:${toolCallId}`) — the existing approval UI picks these up for free
   *  since they're plumbed through the SAME sink with the SAME event shape.
   *
   *  Replaces an earlier version that ran the skill as one isolated, tool-less text completion —
   *  safe, but meant a skill whose whole point is real execution (e.g. shelling out to a script,
   *  submitting a ComfyUI job) could only ever narrate what it would have done, never actually do
   *  it. Founder-reported live: asked for a skill that downloads+processes a video, got a
   *  confidently-worded "done" with nothing on disk to show for it — exactly what a tool-less
   *  completion given instructions that assume real tool access will always produce. */
  async function runSkillSubSession(skillMode: CodeMode, skill: Skill, task: string): Promise<string> {
    const skillAuth = AuthStorage.inMemory()
    const skillRegistry = ModelRegistry.inMemory(skillAuth)
    skillRegistry.registerProvider('local', {
      baseUrl: `${target}/v1`,
      apiKey: 'agent-key',
      authHeader: true,
      api: 'openai-completions',
      models: [{
        id: modelId,
        name: modelDisplayName,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen-chat-template' },
      }],
    })
    const skillModel = skillRegistry.find('local', modelId)
    if (!skillModel) throw new Error('Failed to register local model with pi.')

    let skillHeldGate: (() => void) | undefined
    const releaseSkillGate = () => { const r = skillHeldGate; skillHeldGate = undefined; r?.() }

    const skillExtension = (pi: ExtensionAPI): void => {
      pi.on('before_provider_request', async (event) => {
        releaseSkillGate()
        if (d.gate) skillHeldGate = await d.gate.acquire('bg', { signal })
        // Same stale-ceiling strip as the outer session's own hook above — this sub-session
        // declares the identical maxTokens: 8192 and would otherwise forward it verbatim too.
        const payload = { ...(event.payload as Record<string, unknown>) }
        delete payload.max_tokens
        delete payload.max_completion_tokens
        return payload
      })
      pi.on('after_provider_response', () => { releaseSkillGate() })

      // Same containment + approval boundary as the outer session's own tool_call hook
      // (deliberately duplicated rather than shared — this runs against a DIFFERENT pi session
      // object, and the two hooks are already small enough that factoring them out would cost
      // more in indirection than it saves).
      pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
        const toolName = event.toolName
        const toolCallId = event.toolCallId
        const input = event.input as Record<string, unknown>
        await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'pending' } })

        // Only WRITE_PATH_TOOLS members (edit/write) are actually confined to repoRoot — same
        // loosened boundary as the outer session's own hook (2026-07-25).
        if (PATH_TOOLS.has(toolName)) {
          const p = input.path
          const pathRequired = toolName === 'read' || toolName === 'edit' || toolName === 'write'
          if (p !== undefined && typeof p === 'string') {
            if (WRITE_PATH_TOOLS.has(toolName) && !isContainedFromRoot(p, repoRoot)) {
              const reason = 'path is outside the allowed repo root'
              await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
              return { block: true, reason }
            }
          } else if (pathRequired) {
            const reason = `${toolName}: a valid path is required`
            await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
            return { block: true, reason }
          }
        }

        if (skillMode === 'ask' && MUTATING_TOOLS.has(toolName)) {
          await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'awaiting_approval' } })
          const decision = await waitForToolApproval(`${convId}:${toolCallId}`, signal)
          if (decision === 'deny') {
            const reason = 'denied by user'
            await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
            return { block: true, reason }
          }
        }
        return
      })

      pi.on('tool_result', async (event: ToolResultEvent): Promise<void> => {
        const text = event.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
        const data: Record<string, unknown> = {
          id: event.toolCallId, name: event.toolName, args: event.input,
          status: event.isError ? 'error' : 'done', result: text,
        }
        if (isEditToolResult(event) && event.details) {
          data.diff = event.details.diff
          data.patch = event.details.patch
          data.firstChangedLine = event.details.firstChangedLine
        }
        await sink({ event: 'tool_call', data })
      })
    }

    const skillAgentDir = join(d.store.dir(), 'pi-agent')
    const skillResourceLoader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir: skillAgentDir,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [{ name: 'turbollm-skill', factory: skillExtension }],
      appendSystemPrompt: [skill.instructions.trim()],
      noSkills: true,
      // pi's own DefaultResourceLoader has a BUILT-IN AGENTS.md/CLAUDE.md loader
      // (loadProjectContextFiles, resource-loader.js) that injects a second, separate
      // <project_context> block into the system prompt — on top of, and overlapping with,
      // persona.ts's own hand-rolled version (buildAppendPrompt's agentsMd block, fed via
      // appendSystemPrompt above). Found 2026-07-25 (pi-SDK audit): any repo with a top-level
      // AGENTS.md/CLAUDE.md was getting its content sent to the model TWICE every turn. pi's
      // native path is also uncapped (no MAX_AGENTS_MD_CHARS) and ignores containment entirely —
      // persona.ts's version is strictly better, so disable pi's native one rather than the
      // reverse. Same fix at all 5 DefaultResourceLoader construction sites in this file.
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    })
    await skillResourceLoader.reload()

    // No invoke_skill tool registered here — a skill cannot invoke another skill (v1 scope).
    const skillTools = toolsForMode(skillMode)
    // Same verified-kill bash tool the main session uses (see its own registration above for the
    // full root-cause writeup) — a skill sub-session runs real bash calls too and deserves the
    // same reliable Stop behavior, not just the outer session.
    const skillBash = createBashTool(repoRoot, { operations: createRobustBashOperations({ sessionLabel: `${sessionId}:skill:${skill.id}` }) })
    const { session: skillSession } = await createAgentSession({
      cwd: repoRoot,
      agentDir: skillAgentDir,
      model: skillModel,
      authStorage: skillAuth,
      modelRegistry: skillRegistry,
      resourceLoader: skillResourceLoader,
      sessionManager: SessionManager.inMemory(repoRoot),
      // Same ctx-scaled auto-compaction settings as the outer session (compactionSettingsFor) —
      // a skill sub-session shares the same model/contextWindow, so the same defaults apply.
      settingsManager: SettingsManager.inMemory({ compaction: compactionSettingsFor(contextWindow) }),
      customTools: [skillBash],
      ...(skillTools ? { tools: skillTools } : {}),
    })

    try {
      await skillSession.prompt(task)
    } finally {
      releaseSkillGate()
    }
    const finalText = skillSession.getLastAssistantText() ?? ''
    skillSession.dispose()
    return finalText.trim() || '(the skill produced no output)'
  }

  /** Runs one free-form DELEGATED sub-task as a REAL, contained agentic sub-session (delegate_task
   *  tool, ADR-259) — a sibling of runSkillSubSession with the same isolation, containment, mode-
   *  based tool access, and ask-mode approval boundary, but driven by a caller-supplied task string
   *  instead of a pre-authored skill's fixed instructions. Its own history is NOT seeded with the
   *  parent conversation (the whole point: keep the sub-task's step-by-step work out of the parent's
   *  token budget); only its final summary is returned.
   *
   *  Nesting depth is hard-capped at 1: the sub-session registers NO invoke_skill and NO
   *  delegate_task tool (they're only registered on the outer session below), so a delegated
   *  sub-agent structurally cannot spawn its own sub-agents — no runaway recursion.
   *
   *  Resource contention (the real correctness concern): a delegated sub-task runs INSIDE the
   *  parent's tool_call execution, which pi runs BETWEEN provider requests — the parent's own
   *  provider request already completed when the model emitted this tool call, and the parent's
   *  before/after_provider_request hooks release d.gate around each request, so the parent holds NO
   *  gate while this sub-session runs. The sub-session acquires d.gate('bg') around its OWN provider
   *  requests exactly as runSkillSubSession does, so it serializes cleanly against foreground Chat
   *  (which preempts at 'fg') and any other background work, WITHOUT self-deadlocking against its
   *  own parent. It is therefore not true concurrent engine load — it runs while the parent turn is
   *  parked awaiting this result. Bounded by DELEGATE_SUBAGENT_TIMEOUT_MS and the parent's Stop
   *  signal (whichever fires first), so a stuck sub-task can never hold a slot indefinitely. */
  async function runDelegatedSubSession(subMode: CodeMode, task: string): Promise<string> {
    const subAuth = AuthStorage.inMemory()
    const subRegistry = ModelRegistry.inMemory(subAuth)
    subRegistry.registerProvider('local', {
      baseUrl: `${target}/v1`,
      apiKey: 'agent-key',
      authHeader: true,
      api: 'openai-completions',
      models: [{
        id: modelId,
        name: modelDisplayName,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen-chat-template' },
      }],
    })
    const subModel = subRegistry.find('local', modelId)
    if (!subModel) throw new Error('Failed to register local model with pi.')

    // Bounded lifetime: the parent's Stop (signal) OR a hard timeout aborts the sub-agent. subAc
    // is what the sub-session's gate acquires and its own session.abort() key off, so both causes
    // unstick a queued gate wait and stop the loop the same way.
    const subAc = new AbortController()
    let timedOut = false
    const onParentAbort = () => subAc.abort()
    if (signal.aborted) subAc.abort()
    else signal.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; subAc.abort() }, DELEGATE_SUBAGENT_TIMEOUT_MS)

    let subHeldGate: (() => void) | undefined
    const releaseSubGate = () => { const r = subHeldGate; subHeldGate = undefined; r?.() }

    const subExtension = (pi: ExtensionAPI): void => {
      pi.on('before_provider_request', async (event) => {
        releaseSubGate()
        // 'bg' priority + subAc.signal: foreground Chat preempts, and a parent Stop / timeout gives
        // up a queued wait instead of hanging (see gate.ts). The parent isn't holding the gate here
        // (it released before executing this tool), so this acquire can't deadlock against it.
        if (d.gate) subHeldGate = await d.gate.acquire('bg', { signal: subAc.signal })
        const payload = { ...(event.payload as Record<string, unknown>) }
        delete payload.max_tokens
        delete payload.max_completion_tokens
        return payload
      })
      pi.on('after_provider_response', () => { releaseSubGate() })

      // Same containment + approval boundary as the outer/skill sessions (deliberately duplicated,
      // per the note on runSkillSubSession's own hooks — a different pi session object, and the hook
      // is small enough that sharing would cost more in indirection than it saves). Approval waits
      // key off subAc.signal so a parent Stop / timeout also cancels a pending approval prompt.
      pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
        const toolName = event.toolName
        const toolCallId = event.toolCallId
        const input = event.input as Record<string, unknown>
        await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'pending' } })

        // Only WRITE_PATH_TOOLS members (edit/write) are actually confined to repoRoot — same
        // loosened boundary as the outer session's own hook (2026-07-25).
        if (PATH_TOOLS.has(toolName)) {
          const p = input.path
          const pathRequired = toolName === 'read' || toolName === 'edit' || toolName === 'write'
          if (p !== undefined && typeof p === 'string') {
            if (WRITE_PATH_TOOLS.has(toolName) && !isContainedFromRoot(p, repoRoot)) {
              const reason = 'path is outside the allowed repo root'
              await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
              return { block: true, reason }
            }
          } else if (pathRequired) {
            const reason = `${toolName}: a valid path is required`
            await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
            return { block: true, reason }
          }
        }

        if (subMode === 'ask' && MUTATING_TOOLS.has(toolName)) {
          await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'awaiting_approval' } })
          const decision = await waitForToolApproval(`${convId}:${toolCallId}`, subAc.signal)
          if (decision === 'deny') {
            const reason = 'denied by user'
            await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
            return { block: true, reason }
          }
        }
        return
      })

      pi.on('tool_result', async (event: ToolResultEvent): Promise<void> => {
        const text = event.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
        const data: Record<string, unknown> = {
          id: event.toolCallId, name: event.toolName, args: event.input,
          status: event.isError ? 'error' : 'done', result: text,
        }
        if (isEditToolResult(event) && event.details) {
          data.diff = event.details.diff
          data.patch = event.details.patch
          data.firstChangedLine = event.details.firstChangedLine
        }
        await sink({ event: 'tool_call', data })
      })
    }

    const subAgentDir = join(d.store.dir(), 'pi-agent')
    const subResourceLoader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir: subAgentDir,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [{ name: 'turbollm-delegate', factory: subExtension }],
      // The normal mode persona (no skill catalog — a delegated sub-agent can't invoke skills),
      // plus the delegation preamble that frames it as a focused, summary-returning worker.
      appendSystemPrompt: [...buildAppendPrompt(subMode, [], {
        repoRoot,
        globalDir: d.store.dir(),
        projectCandidates: d.store.snapshot().code.agentsMdProjectCandidates,
        globalCandidates: d.store.snapshot().code.agentsMdGlobalCandidates,
      }, !!d.tools), DELEGATED_SUBAGENT_PREAMBLE],
      noSkills: true,
      // Disables pi's own native AGENTS.md/CLAUDE.md loader — see the skill sub-session's
      // identical construction above for the full double-injection writeup.
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    })
    await subResourceLoader.reload()

    const subTools = toolsForMode(subMode)
    const subBash = createBashTool(repoRoot, { operations: createRobustBashOperations({ sessionLabel: `${sessionId}:delegate` }) })
    const { session: subSession } = await createAgentSession({
      cwd: repoRoot,
      agentDir: subAgentDir,
      model: subModel,
      authStorage: subAuth,
      modelRegistry: subRegistry,
      resourceLoader: subResourceLoader,
      sessionManager: SessionManager.inMemory(repoRoot),
      settingsManager: SettingsManager.inMemory({ compaction: compactionSettingsFor(contextWindow) }),
      customTools: [subBash],
      ...(subTools ? { tools: subTools } : {}),
      // No invoke_skill / delegate_task / web / mcp / lsp tools registered → depth-1, bounded set.
    })

    const onSubAbort = () => { void subSession.abort() }
    if (subAc.signal.aborted) onSubAbort()
    else subAc.signal.addEventListener('abort', onSubAbort, { once: true })

    try {
      await subSession.prompt(task)
    } catch (e) {
      // A Stop / timeout aborts mid-prompt (AbortError, or a gate give-up) — return whatever the
      // sub-agent produced so far as an explicit "incomplete" result rather than throwing. Any
      // OTHER error is a real failure and propagates to delegate_task's execute catch.
      if (!timedOut && !subAc.signal.aborted) throw e
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onParentAbort)
      releaseSubGate()
    }
    const finalText = subSession.getLastAssistantText() ?? ''
    subSession.dispose()
    return normalizeDelegateResult(finalText, timedOut ? { timedOut: true, timeoutMs: DELEGATE_SUBAGENT_TIMEOUT_MS } : undefined)
  }

  // MCP tools (Customize → MCP Servers) — the same tools Chat gets from any user-connected MCP
  // server, extended to Code (founder decision, 2026-07-13: "all the tools built from customize
  // that are added in chat should be available in code as well"). Fetched HERE, once, before the
  // sync `extension` closure below (pi's extensionFactories are sync — buildToolDefinitions() is
  // async, so it can't be called inside that closure) — a fresh list per turn is correct anyway,
  // since MCP servers can be connected/disconnected between turns via Customize while a session
  // is open. Filtered to MCP-prefixed names only (web_search/fetch_url are already registered
  // above; run_code is registered unconditionally below) — see mcpToolDefs' own safety note by
  // the tool_call hook for why these are treated differently from web_search/fetch_url.
  const mcpToolDefs = d.tools ? (await d.tools.buildToolDefinitions()).filter((t) => t.function.name.startsWith('mcp__')) : []
  const mcpToolNames = new Set(mcpToolDefs.map((t) => t.function.name))

  // ── the inline extension: containment + approval + diff plumbing ──────────────
  // Prefill progress poller (see pickPrefillProgress above) — reads the engine's /slots endpoint
  // while a provider request is in flight and relays a `prefill` SSE frame. Lifecycle is per
  // agentic ROUND: started in before_provider_request, stopped the instant prefill completes
  // (processed>=total), the first real token streams (message_update, a cross-check against stale
  // slot numbers), the response ends, or the turn aborts. A self-rearming setTimeout — NOT
  // setInterval — so a slow /slots fetch never stacks overlapping polls; every /slots failure or
  // odd shape is swallowed, because prefill telemetry must never break the actual generation.
  let prefillTimer: ReturnType<typeof setTimeout> | undefined
  let prefillActive = false

  // ── real per-turn token/timing stats (foldTurnUsage above) ────────────────────
  // Wall-clock timing accumulated across every agentic ROUND of this turn (a Code turn can run
  // dozens of rounds — see runLoop in pi-agent-core). Each round: roundStartedAt is set the
  // instant the gate is acquired and the request is about to go out (before_provider_request,
  // below); roundFirstTokenAt is set on that round's first message_update; the round closes out
  // on message_end, folding (firstToken - start) into promptMsTotal and (end - firstToken) into
  // genMsTotal. ttftMs is captured once, on the very first token of the whole turn.
  let turnStartedAt = 0
  let promptMsTotal = 0
  let genMsTotal = 0
  let ttftMs: number | undefined
  let roundStartedAt: number | undefined
  let roundFirstTokenAt: number | undefined
  const stopPrefillPoll = (): void => {
    prefillActive = false
    if (prefillTimer) { clearTimeout(prefillTimer); prefillTimer = undefined }
  }
  const startPrefillPoll = (): void => {
    stopPrefillPoll()
    prefillActive = true
    let lastPct = -1
    const tick = async (): Promise<void> => {
      if (!prefillActive) return
      try {
        const res = await fetch(`${target}/slots`, { signal })
        if (res.ok) {
          const progress = pickPrefillProgress(await res.json())
          if (progress && prefillActive) {
            if (progress.pct !== lastPct) { lastPct = progress.pct; void sink({ event: 'prefill', data: { ...progress } }) }
            if (progress.processed >= progress.total) { stopPrefillPoll(); return }
          }
        }
      } catch { /* /slots must never break generation — skip this turn's prefill silently */ }
      if (prefillActive) prefillTimer = setTimeout(() => void tick(), PREFILL_POLL_MS)
    }
    prefillTimer = setTimeout(() => void tick(), PREFILL_POLL_MS)
  }

  const extension = (pi: ExtensionAPI): void => {
    // Background-priority engine slot, acquired/released around each provider request. Also
    // where the thinking budget is injected: pi makes its own provider HTTP call (registered
    // above as the 'local' openai-completions provider), so there's no raw reqBody to touch
    // the way chat-routes.ts's runGeneration does — this hook's return value REPLACES the
    // outgoing payload (pi-coding-agent's BeforeProviderRequestEventResult contract).
    pi.on('before_provider_request', async (event) => {
      releaseGate() // defensive: never hold two
      // `signal` is this turn's own abort signal (Stop / connection drop) — passed through so a
      // stuck queue wait can actually be given up on. A genuinely stuck/leaked gate now rejects
      // (see gate.ts's own comment for the incident this fixed) rather than hanging the whole
      // turn forever with no way to cancel it.
      if (d.gate) heldGate = await d.gate.acquire('bg', { signal })
      // Gate acquired, request is about to go out — begin polling /slots for prefill progress for
      // THIS round (stopped on first token / completion / response end / abort). Best-effort.
      startPrefillPoll()
      roundStartedAt = Date.now()
      roundFirstTokenAt = undefined
      const payload = { ...(event.payload as Record<string, unknown>) }
      // Strip the completion-length cap pi derives from this model's declared `maxTokens` (a
      // fixed ceiling set once in the model metadata above, at model-load time). Sent verbatim as
      // max_tokens/max_completion_tokens on every turn, it ignores how many tokens THIS turn's
      // prompt already used — once prompt + that stale ceiling exceeds the loaded context window,
      // llama.cpp stops generation almost immediately (reproduced live: a tool-schema-heavy Code
      // prompt near a small loaded ctx produced one reasoning token then hard-stopped, aborted:
      // false). chat-routes.ts avoids this via clampMaxTokens + deleting the field when uncapped
      // (its own before-send step) — mirror that here so generation is bounded only by the
      // model's real remaining context, not a number fixed before this turn's prompt existed.
      delete payload.max_tokens
      delete payload.max_completion_tokens
      if (thinkingBudget === 0) {
        return {
          ...payload,
          thinking_budget_tokens: 0,
          chat_template_kwargs: { ...(payload.chat_template_kwargs as Record<string, unknown> ?? {}), enable_thinking: false },
        }
      }
      if (thinkingBudget > 0) {
        return { ...payload, thinking_budget_tokens: thinkingBudget }
      }
      return payload // unlimited (default) — still stripped of the stale max_tokens ceiling
    })
    pi.on('after_provider_response', () => { stopPrefillPoll(); releaseGate() })

    // No turn_start reset — deliberately. pi fires `turn_start` once per agentic ROUND (it carries
    // an incrementing turnIndex; `agent_start` is the per-task boundary), so resetting here cleared
    // these counters between rounds, which silently defeated ALL THREE: the loop breaker (identical
    // calls span rounds), the anti-fallback nudge (a failing retry loop spans rounds), and the
    // dependency-discipline check. All three are already scoped to one user task by being
    // (re)created per runCodeSession call; consecutiveToolFailures additionally clears on any tool
    // SUCCESS in the tool_result hook below, which is the correct "made real progress" reset.

    // The ENTIRE containment/approval boundary (plan risk flag 2). Runs before tool.execute().
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
      const toolName = event.toolName
      const toolCallId = event.toolCallId
      const input = event.input as Record<string, unknown>

      // Always surface the call as pending so the UI shows an inline step immediately.
      await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'pending' } })

      // 0. Loop breaker — BEFORE containment/mode, so it catches a stuck model regardless of tool
      //    or mode. A weak local model can fire the SAME call with the SAME args indefinitely; once
      //    it has done so more than LOOP_BREAK_AFTER times in a row, stop executing it and hand the
      //    model a break-the-loop instruction as the (blocked) result instead.
      const loopCount = toolLoop.record(toolName, input)
      if (loopCount > LOOP_ABORT_AFTER) {
        // The nudge below didn't work — LOOP_ABORT_AFTER - LOOP_BREAK_AFTER separate nudges were
        // sent and the model kept re-emitting the exact same call anyway. Stop assuming it'll
        // self-heal: abort the run for real (same path the user's own Stop button uses, so this
        // surfaces as a genuinely stopped run — stats.aborted — not a silent hang) rather than
        // trip the same soft block forever (founder-reported live, 2026-07-24: "no effect").
        const reason = `[SYSTEM: \`${toolName}\` was called with identical arguments ${loopCount} times ` +
          'in a row, including after being told to stop — this run has been stopped automatically ' +
          'rather than continue looping. Start a new turn with different instructions to try again.]'
        await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
        // Pre-existing gap, fixed alongside the near-overflow check below (both call session.abort()
        // directly, not through the external `signal` the `aborted` flag was originally wired to):
        // without this, the comment above ("surfaces as... stats.aborted") was not actually true —
        // `aborted` was only ever set by the Stop-button/connection-drop listener.
        aborted = true
        void session.abort()
        return { block: true, reason }
      }
      if (loopCount > LOOP_BREAK_AFTER) {
        const reason = `[SYSTEM: you have called \`${toolName}\` with identical arguments too many ` +
          'times in a row and it is not making progress — this call was NOT executed. Stop repeating ' +
          'it: take a different action, call it with different arguments, or, if you already have what ' +
          'you need, give your final answer now.]'
        await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
        return { block: true, reason }
      }

      // 1. Containment (plan §3b) — BEFORE any mode logic, so it applies in every mode
      //    including auto. Only tools that take a `path` are checkable here. Only
      //    WRITE_PATH_TOOLS members (edit/write) are actually confined to repoRoot — read/grep/
      //    find/ls may target any path on the host filesystem (loosened 2026-07-25).
      if (PATH_TOOLS.has(toolName)) {
        const p = input.path
        // grep/find/ls accept an optional path defaulting to cwd (contained by definition);
        // only reject when a path was actually supplied and falls outside the root.
        const pathRequired = toolName === 'read' || toolName === 'edit' || toolName === 'write'
        if (p !== undefined && typeof p === 'string') {
          // Resolve a RELATIVE path against the session repoRoot, NOT the daemon's own cwd —
          // pi's read/edit/write/ls tools emit repo-relative paths, and resolving those against
          // process.cwd() falsely rejected legitimate in-bounds calls in every mode.
          if (WRITE_PATH_TOOLS.has(toolName) && !isContainedFromRoot(p, repoRoot)) {
            const reason = 'path is outside the allowed repo root'
            await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
            return { block: true, reason }
          }
        } else if (pathRequired) {
          const reason = `${toolName}: a valid path is required`
          await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
          return { block: true, reason }
        }
      }

      // 2. Mode-based approval.
      //    auto  → containment only, no approval await (built above).
      //    plan  → mutating tools aren't in the toolset at all, so nothing reaches here to gate.
      //    ask   → write/edit/bash get an approval gate; reads pass straight through.
      //
      // Re-read the mode FRESH from the DB on every tool_call (a cheap single-row
      // read) instead of using the closed-over `mode` param, so a mid-run switch
      // (PATCH /code/sessions/:id/mode → conv.agentMode) takes effect live for the
      // ask-approval gate — e.g. switching ask→auto stops approval prompts for the
      // rest of THIS run. `mode` (the run's start mode) is still used for the
      // structural pieces baked at session creation (toolsForMode/appendSystemPrompt).
      //
      // Plan is deliberately excluded from the live switch: its toolset is fixed at
      // createAgentSession time (mutating tools are simply not registered), so a
      // mid-run switch TO/FROM plan cannot change the live toolset and only takes
      // effect on the next run. When the DB says 'plan' we therefore keep the run's
      // START mode for the approval decision — this also closes a footgun: switching
      // an ask run to plan mid-run keeps mutations gated rather than silently letting
      // the already-registered edit/write/bash tools run unapproved.
      const dbMode = (d.db.getConversation(convId)?.agentMode ?? mode) as CodeMode
      const liveMode: CodeMode = dbMode === 'plan' ? mode : dbMode
      // mcpToolNames: MCP-server tools (Customize → MCP Servers) get the SAME ask-mode approval
      // gate as edit/write/bash — see mcpToolDefs' own comment for why they're treated as
      // mutating despite not being in the hardcoded MUTATING_TOOLS set (their names are dynamic,
      // resolved per-run from whatever MCP servers are currently connected).
      if (liveMode === 'ask' && (MUTATING_TOOLS.has(toolName) || mcpToolNames.has(toolName))) {
        await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'awaiting_approval' } })
        const decision = await waitForToolApproval(`${convId}:${toolCallId}`, signal)
        if (decision === 'deny') {
          const reason = 'denied by user'
          await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'error', result: reason } })
          return { block: true, reason }
        }
        // approved → fall through, let pi execute; the tool_result hook emits 'done' + diff.
      }
      return
    })

    // After a tool executes, emit the terminal tool_call event carrying the tool's own real
    // result — and, for the edit tool, its real diff/patch/firstChangedLine (plan §3d). No
    // diff is computed here; this is pi's own output, just plumbed through to the SSE stream.
    pi.on('tool_result', async (event: ToolResultEvent): Promise<void> => {
      // Mechanical anti-fallback nudge — see consecutiveToolFailures' own comment above. Skip
      // web_search/fetch_url themselves so a flaky search doesn't nudge the model to... search.
      if (event.isError) {
        consecutiveToolFailures++
        if (consecutiveToolFailures >= 2 && event.toolName !== 'web_search' && event.toolName !== 'fetch_url') {
          event.content.push({
            type: 'text',
            text: `\n\n[SYSTEM: failed attempt #${consecutiveToolFailures} in a row on this task. Stop ` +
              'retrying blindly, and do NOT silently substitute an easier or different feature instead of ' +
              'the one actually requested. Call web_search for the official documentation (Stack Overflow ' +
              'as a fallback, official docs weighted higher) on the exact error or API you are stuck on, ' +
              'read it, then retry the ORIGINAL task with what you learned.]',
          })
        }
      } else {
        consecutiveToolFailures = 0
      }

      // Mechanical dependency-discipline nudge (item 2) — see isDependencyAddCommand's own
      // comment. Fires regardless of isError: even a SUCCESSFUL install without prior research is
      // exactly the behavior being discouraged. Applies to whichever result comes first — a
      // successful web_search/fetch_url flips the flag for the rest of the turn.
      if (event.toolName === 'web_search' || event.toolName === 'fetch_url') {
        if (!event.isError) hasSearchedWebThisTurn = true
      } else if (event.toolName === 'bash' && !hasSearchedWebThisTurn) {
        const command = typeof event.input.command === 'string' ? event.input.command : ''
        if (isDependencyAddCommand(command)) {
          event.content.push({
            type: 'text',
            text: '\n\n[SYSTEM: this looks like a new-dependency install with no web_search/fetch_url ' +
              'call yet this turn. If you have not already verified the LATEST version and read its real ' +
              'official documentation, do that now (web_search then fetch_url) before continuing to use ' +
              'this dependency — do not implement against assumed/remembered version knowledge.]',
          })
        }
      }

      // LSP diagnostics (item 3) — "always use lsp whenever making a code change in a file".
      // Fires on every SUCCESSFUL edit/write to a file in a supported language (see
      // lsp-registry.ts): starts (or reuses) that language's server, opens/updates the file with
      // its just-written content, and appends real compiler/type-checker diagnostics onto the
      // edit/write's own result — same content-mutation pattern as the nudges above. Silent when
      // there are zero diagnostics (a clean edit shouldn't add noise to every single tool result).
      // Best-effort by design: a file read failure or a language server that never starts must
      // never block or fail the edit itself — diagnostics are a bonus signal, not a gate. Known,
      // accepted cost: the FIRST edit to a given language in a fresh session may add real latency
      // (up to LspClient's own ~60s ceiling) while npx downloads the server package on a cold
      // cache — every edit after that reuses the already-running process.
      if (!event.isError && (event.toolName === 'edit' || event.toolName === 'write')) {
        const relPath = typeof event.input.path === 'string' ? event.input.path : ''
        const spec = relPath ? lspSpecForPath(relPath) : null
        if (spec) {
          try {
            const absPath = resolve(repoRoot, relPath)
            const content = await readFile(absPath, 'utf8')
            const diagnostics: LspDiagnostic[] = await getLspClient(spec).getDiagnostics(absPath, content)
            if (diagnostics.length > 0) {
              const shown = diagnostics.slice(0, 20)
              const lines = shown.map((d) => `  ${d.severity} ${d.line}:${d.character} ${d.message}${d.source ? ` (${d.source})` : ''}`)
              const more = diagnostics.length > shown.length ? `\n  …and ${diagnostics.length - shown.length} more` : ''
              event.content.push({
                type: 'text',
                text: `\n\n[LSP diagnostics for ${relPath} (${spec.language}):\n${lines.join('\n')}${more}]`,
              })
            }
          } catch {
            // Best-effort — see comment above.
          }
        }
      }

      // Near-overflow hard-abort, root-caused and decided 2026-07-25 (see decision log) — a long
      // CONTINUOUS turn can run dozens of rounds without ever hitting a turn boundary, so pi's own
      // auto-compaction threshold check (only ever invoked before a new session.prompt() or after
      // the whole agentic loop settles) structurally never gets a chance to run. Rather than let
      // the NEXT round's request genuinely overflow and error, check the real live context usage
      // after every round and abort cleanly — same session.abort() path the loop breaker above
      // uses, so this surfaces as a real stopped run (stats.aborted), not a crash. The next turn
      // then starts through the normal, already-working turn-boundary compaction path. Uses
      // session.getContextUsage() directly (pi's real provider-reported usage, not an estimate) —
      // NOT session.compact() — a mid-loop compact() call was investigated and found NOT to
      // actually prevent this turn's own request from continuing to grow (runLoop snapshots the
      // message context once at turn start; nothing re-syncs it mid-loop), so this deliberately
      // does not attempt that. worst case is a turn stopping a bit early with partial progress
      // instead of a hard overflow crash.
      const usage = session.getContextUsage()
      if (typeof usage?.tokens === 'number' && usage.tokens > usage.contextWindow - nearOverflowReserveTokens(usage.contextWindow)) {
        event.content.push({
          type: 'text',
          text: '\n\n[SYSTEM: this turn is approaching the model\'s real context limit and has been ' +
            'stopped automatically to avoid a hard overflow error. Continue the task in a new message ' +
            '— the next turn starts from freshly compacted history.]',
        })
        aborted = true
        void session.abort()
      }

      const text = event.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
      const data: Record<string, unknown> = {
        id: event.toolCallId,
        name: event.toolName,
        args: event.input,
        status: event.isError ? 'error' : 'done',
        result: text,
      }
      if (isEditToolResult(event) && event.details) {
        data.diff = event.details.diff
        data.patch = event.details.patch
        data.firstChangedLine = event.details.firstChangedLine
      }
      await sink({ event: 'tool_call', data })
    })

    // The main prompt only ever sees a skill's name + description (persona.ts's
    // skillCatalogBlock) — this is how the model actually USES one: a real, contained agentic
    // sub-session (runSkillSubSession, above) with the CURRENT mode's own tool access and
    // safety boundary — auto/ask get real read/bash/edit/write against this session's own
    // repoRoot, plan gets read-only, ask gates mutations through the same approval UI the main
    // session uses. The result (the skill's final reply) comes back as this tool's output; the
    // full instructions never enter the MAIN session's own context.
    pi.registerTool({
      name: 'invoke_skill',
      label: 'Invoke skill',
      description: 'Load a skill from the catalog above and use it for a specific task. Runs the ' +
        'skill\'s full instructions as a real sub-session with this session\'s own tools (subject to ' +
        'the current mode\'s access/approval rules) and returns its final reply — the instructions ' +
        'themselves never enter this conversation.',
      promptSnippet: 'invoke_skill(skillId, task) - use a skill from the catalog for a specific task',
      parameters: Type.Object({
        skillId: Type.String({ description: 'The skill id from the catalog above.' }),
        task: Type.String({ description: 'What you want this skill\'s help with, in enough detail to act on.' }),
      }),
      async execute(_toolCallId, params) {
        const skill = skills.find((s) => s.id === params.skillId)
        if (!skill) {
          const known = skills.map((s) => s.id).join(', ')
          return { content: [{ type: 'text', text: `No skill "${params.skillId}" in the catalog. Known skill ids: ${known}` }], details: {} }
        }
        // Live mode — mirrors the outer tool_call hook's own resolution just above (re-read
        // fresh from the DB so a mid-run mode switch applies to the NEXT invoke_skill call too,
        // same plan-mode exception: plan's toolset is fixed at session-creation time, so a
        // mid-run switch to/from plan only takes effect on the skill's next invocation).
        const dbMode = (d.db.getConversation(convId)?.agentMode ?? mode) as CodeMode
        const liveMode: CodeMode = dbMode === 'plan' ? mode : dbMode
        try {
          const text = await runSkillSubSession(liveMode, skill, params.task)
          return { content: [{ type: 'text', text }], details: {} }
        } catch (e) {
          return { content: [{ type: 'text', text: `invoke_skill: failed (${e instanceof Error ? e.message : String(e)}) — try again.` }], details: {} }
        }
      },
    })

    // Delegate a focused, self-contained sub-task to an isolated sub-agent (delegate_task, ADR-259):
    // a real nested agentic sub-session (runDelegatedSubSession, above) that shares this session's
    // repo + tools + mode/approval boundary, runs the sub-task to completion, and returns ONLY its
    // final summary — the sub-agent's step-by-step work never enters this conversation, keeping the
    // parent's context focused. Depth-capped at 1 (the sub-agent gets no delegate_task/invoke_skill),
    // gate-serialized so it never starves foreground Chat, and time-bounded. See its own doc comment.
    pi.registerTool({
      name: 'delegate_task',
      label: 'Delegate task',
      description: 'Delegate a focused, self-contained sub-task to an isolated sub-agent that has ' +
        'your same repository access and tools (subject to the current mode), runs it to completion, ' +
        'and returns ONLY its final summary — the sub-agent\'s step-by-step work never enters this ' +
        'conversation, so your own context stays focused. Use it for a well-scoped chunk you can ' +
        'describe completely up front (e.g. "investigate how X works and report back", or "apply ' +
        'this specific refactor across these files"). The sub-agent does NOT see this conversation, ' +
        'so put everything it needs in the task; it cannot delegate further or invoke skills.',
      promptSnippet: 'delegate_task(task) - hand a focused, fully-described sub-task to an isolated sub-agent and get back its summary',
      parameters: Type.Object({
        task: Type.String({ description: 'The complete, self-contained sub-task, including every bit of context the sub-agent needs (it does not see this conversation or its history).' }),
      }),
      async execute(_toolCallId, params) {
        const valid = validateDelegateTask(params.task)
        if (!valid.ok) return { content: [{ type: 'text', text: valid.message }], details: {} }
        // Live mode — same fresh-from-DB resolution and plan-mode exception as invoke_skill above.
        const dbMode = (d.db.getConversation(convId)?.agentMode ?? mode) as CodeMode
        const liveMode: CodeMode = dbMode === 'plan' ? mode : dbMode
        try {
          const text = await runDelegatedSubSession(liveMode, valid.task)
          return { content: [{ type: 'text', text }], details: {} }
        } catch (e) {
          return { content: [{ type: 'text', text: `delegate_task: failed (${e instanceof Error ? e.message : String(e)}) — try again, or do the task yourself.` }], details: {} }
        }
      },
    })

    // Look back past a prior /compact without replaying the whole raw history inline
    // (lookback_history) — the pre-compaction messages are still sitting in the DB, unreferenced;
    // this answers a targeted question against them via an isolated sub-session (see
    // lookbackPreCompactionHistory's own doc comment) and returns ONLY the answer.
    pi.registerTool({
      name: 'lookback_history',
      label: 'Look back before compaction',
      description: 'If this session has been compacted (its earlier history was summarized to save ' +
        'context), ask a targeted question about what happened in that summarized-away part — e.g. ' +
        '"what did we decide about X" or "what was the exact error message before we compacted". ' +
        'Answers from the ORIGINAL messages, not just the summary, without loading them into your ' +
        'own context. Returns an error if this session has never been compacted (nothing to look ' +
        'back at) — check the compaction summary already in your context first.',
      promptSnippet: 'lookback_history(question) - ask a targeted question about this session\'s pre-compaction history',
      parameters: Type.Object({
        question: Type.String({ description: 'The specific question to answer from the pre-compaction history.' }),
      }),
      async execute(_toolCallId, params) {
        const q = (params.question ?? '').trim()
        if (!q) return { content: [{ type: 'text', text: 'lookback_history: `question` must be non-empty.' }], details: {} }
        try {
          const { answer } = await lookbackPreCompactionHistory({ d, convId, sessionId, repoRoot, question: q, signal })
          return { content: [{ type: 'text', text: answer }], details: {} }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          if (message === 'nothing_compacted') {
            return { content: [{ type: 'text', text: 'This session has not been compacted — there is no summarized-away history to look back at. Everything is already in your own context.' }], details: {} }
          }
          return { content: [{ type: 'text', text: `lookback_history: failed (${message}) — try again.` }], details: {} }
        }
      },
    })

    // Todo / step progress tracker (update_todos, ADR-255): the model maintains a visible checklist
    // of a multi-step task's steps so the UI shows live progress instead of an opaque tool-call
    // stream. Whole-list-replace each call (simplest for a model to get right). Emits an ephemeral
    // `todos` SSE frame via the same sink every other event uses; code-run-manager holds the latest
    // list in the run's live state so it survives a reconnect (like the queue), no DB column needed.
    // Registered on the top-level session ONLY (never on delegate_task/skill sub-sessions), so the
    // list is strictly the parent turn's plan — a delegated sub-agent's internal steps stay hidden.
    pi.registerTool({
      name: 'update_todos',
      label: 'Update todos',
      description: 'Maintain a visible checklist of the steps for a multi-step task so the user can ' +
        'see your plan and live progress. Call it when you START a task that has several distinct ' +
        'steps (send the full list, each step pending), and again whenever a step\'s state changes: ' +
        'mark a step in_progress when you begin it and completed as soon as it is done. ALWAYS send ' +
        'the ENTIRE current list each call — it REPLACES the previous one, it is not a diff. Skip it ' +
        'for trivial single-step requests; a one-item checklist is just noise.',
      promptSnippet: 'update_todos(todos) - show/refresh a checklist of steps for a multi-step task (send the whole list each call)',
      parameters: Type.Object({
        todos: Type.Array(
          Type.Object({
            content: Type.String({ description: 'The step as a short imperative phrase, e.g. "Add the /export route".' }),
            status: Type.Union(
              [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')],
              { description: 'pending, in_progress, or completed.' },
            ),
          }),
          { description: 'The COMPLETE current step list, in order — replaces the previous list entirely.' },
        ),
      }),
      async execute(_toolCallId, params) {
        const todos = normalizeTodos(params.todos)
        await sink({ event: 'todos', data: { todos } })
        return { content: [{ type: 'text', text: summarizeTodos(todos) }], details: {} }
      },
    })

    // Real web access (founder-reported gap, 2026-07-13): Code previously had NO way to look
    // anything up — only Chat had web_search/fetch_url. A local model that fails at something
    // (a real repro: Camera2 API) tends to silently substitute an easier, DIFFERENT feature
    // instead of persisting — persona.ts's guidance now tells it to search official docs after 2
    // failed attempts, which is meaningless without an actual tool to do that with. Both reuse
    // the EXACT SAME implementation chat's own tools use (ToolRegistry.executeTool) — same
    // provider config, same SSRF checks — not a second, divergent implementation. Neither is a
    // path-taking or mutating tool (not in PATH_TOOLS/MUTATING_TOOLS above), so they're never
    // containment-checked or ask-mode-gated, in every mode including plan — researching before
    // touching files is exactly what plan mode is for.
    if (d.tools) {
      const tools = d.tools
      pi.registerTool({
        name: 'web_search',
        label: 'Web search',
        description: 'Search the web for real-time information — official documentation, release ' +
          'notes, current library/package versions, and how other real projects solved the same ' +
          'problem. Use this whenever your own knowledge might be stale (a specific API, a library ' +
          'version, a platform SDK) or after failing to get something working twice — don\'t guess ' +
          'a third time, look it up, prioritizing official docs over forum answers.',
        promptSnippet: 'web_search(query) - search the web for docs, versions, and working examples',
        parameters: Type.Object({
          query: Type.String({ description: 'A precise, specific query — e.g. "Android Camera2 API official documentation" or "npm react latest version".' }),
        }),
        async execute(toolCallId, params) {
          const text = await tools.executeTool({ id: toolCallId, name: 'web_search', args: params })
          return { content: [{ type: 'text', text }], details: {} }
        },
      })
      pi.registerTool({
        name: 'fetch_url',
        label: 'Fetch URL',
        description: 'Fetch the text content of a URL — e.g. an official docs page or API reference ' +
          'found via web_search. Returns the page\'s main text, stripped of HTML.',
        promptSnippet: 'fetch_url(url) - fetch the text content of a URL',
        parameters: Type.Object({
          url: Type.String({ description: 'The URL to fetch (must start with http:// or https://).' }),
        }),
        async execute(toolCallId, params) {
          const text = await tools.executeTool({ id: toolCallId, name: 'fetch_url', args: params })
          return { content: [{ type: 'text', text }], details: {} }
        },
      })

      // run_code (founder decision, 2026-07-13: extend Chat's Customize-configured tools to
      // Code) — a sandboxed JS snippet runner with explicitly NO fs/network/process access
      // (builtin.ts's own RUN_CODE_TOOL description). Genuinely inert, so registered
      // unconditionally like web_search/fetch_url — no approval gate, every mode including plan.
      // MCP tools below get the opposite treatment (ask-mode gated, excluded from plan) because,
      // unlike this, they're arbitrary external providers with no such safety guarantee.
      pi.registerTool({
        name: 'run_code',
        label: 'Run code',
        description: 'Execute a JavaScript snippet in a sandbox with no network, file, or process access, ' +
          'and return the result. Useful for calculations, data transformation, and quick logic checks.',
        promptSnippet: 'run_code(code) - execute a sandboxed JS snippet and return the result',
        parameters: Type.Object({
          code: Type.String({ description: 'JavaScript code to execute. The last expression is the return value.' }),
        }),
        async execute(toolCallId, params) {
          const text = await tools.executeTool({ id: toolCallId, name: 'run_code', args: params })
          return { content: [{ type: 'text', text }], details: {} }
        },
      })

      // MCP tools (Customize → MCP Servers) — see mcpToolDefs' own comment above for how these
      // were fetched. Unlike web_search/fetch_url/run_code, these are arbitrary EXTERNAL tool
      // providers with no safety guarantee pi/Code can verify — a connected filesystem-style MCP
      // server, for instance, has no relationship to this session's repoRoot containment at all.
      // Treated as MUTATING for Code's own mode-gate purposes (mcpToolNames is checked alongside
      // MUTATING_TOOLS in the tool_call hook below): unconfined in auto, ask-mode-approved via
      // the SAME waitForToolApproval gate edit/write/bash already use (not Chat's own separate
      // tool-policy system — Code's mode model is the single source of truth for approval here),
      // and simply not registered at all in plan mode, mirroring how plan omits edit/write/bash.
      if (mode !== 'plan') {
        for (const def of mcpToolDefs) {
          const toolName = def.function.name
          pi.registerTool({
            name: toolName,
            label: def.function.name,
            description: def.function.description ?? '',
            parameters: Unsafe<Record<string, unknown>>((def.function.parameters ?? { type: 'object', properties: {} }) as TSchema),
            async execute(toolCallId, params) {
              const text = await tools.executeTool({ id: toolCallId, name: toolName, args: params })
              return { content: [{ type: 'text', text }], details: {} }
            },
          })
        }
      }
    }

    // LSP integration (founder-reported gap, 2026-07-13, item 3: "for a new code, it should 1st
    // analyse the coding language and install its lsp and always use lsp whenever making a code
    // change in a file"). Explicit tool for warming up a language server before a big task; NOT
    // required before editing — edit/write results below automatically start the right server and
    // append real diagnostics on their own. Not gated on `d.tools` (unlike web_search/fetch_url
    // above) since this doesn't depend on ToolRegistry at all — it spawns its own npx process.
    pi.registerTool({
      name: 'install_lsp',
      label: 'Install LSP',
      description: 'Ensure the language server for a language is installed (via npx, on demand — no ' +
        'global install) and running, so real compiler/type-checker diagnostics are available. Not ' +
        'required before editing (edits automatically start the right server and surface diagnostics), ' +
        `but useful to warm one up before a large multi-file task. Supported languages: ${SUPPORTED_LSP_LANGUAGES.join(', ')}.`,
      promptSnippet: 'install_lsp(language) - ensure a language server is installed and ready',
      parameters: Type.Object({
        language: Type.String({ description: `One of: ${SUPPORTED_LSP_LANGUAGES.join(', ')}.` }),
      }),
      async execute(_toolCallId, params) {
        const spec = lspSpecForLanguage(params.language)
        if (!spec) {
          return { content: [{ type: 'text', text: `No LSP available for "${params.language}" yet. Supported: ${SUPPORTED_LSP_LANGUAGES.join(', ')}.` }], details: {} }
        }
        const result = await getLspClient(spec).ensureStarted()
        const text = result.ok
          ? `${spec.language} language server is installed and running.`
          : `Failed to start the ${spec.language} language server: ${result.error}`
        return { content: [{ type: 'text', text }], details: {} }
      },
    })
  }

  // ── resource loader with the inline extension + real append system prompt ─────
  const resourceLoader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: 'turbollm-code', factory: extension }],
    // The FULL shared SkillStore, but only names+descriptions reach the prompt
    // (skillCatalogBlock, budget-capped) — full instructions for any ONE skill only ever load
    // inside invoke_skill's isolated subagent call, registered above. Previously this injected
    // every skill's FULL instructions unconditionally (measured live: 52 non-builtin skills
    // cost ~157K tokens of irrelevant instructions on a 200K window before a single real
    // message — the actual cause of "context fills up in 1-2 messages", not a compaction bug).
    // `noSkills: true` below is pi's OWN unrelated skill-discovery mechanism (kept off for
    // prompt hygiene) — this is TurboLLM's own Skills library.
    // agentsMd: <repoRoot>/<candidate> + <TurboLLM data dir>/<candidate>, like OpenCode — d.store.dir()
    // IS TurboLLM's own data dir (the same one SkillStore above reads from). Candidate lists read
    // fresh from config here (not passed in from further up) so a Settings change takes effect on
    // this session's NEXT turn without needing a new session — see persona.ts's own doc comment.
    appendSystemPrompt: buildAppendPrompt(mode, skills, {
      repoRoot,
      globalDir: d.store.dir(),
      projectCandidates: d.store.snapshot().code.agentsMdProjectCandidates,
      globalCandidates: d.store.snapshot().code.agentsMdGlobalCandidates,
    }, !!d.tools),
    // Keep the prompt lean and deterministic — no global skills/prompts/themes discovery.
    noSkills: true,
    // Disables pi's own native AGENTS.md/CLAUDE.md loader — see the skill sub-session's
    // identical construction above for the full double-injection writeup.
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  })
  await resourceLoader.reload()

  // Plan mode's real safety mechanism (plan §3c): mutating tools are simply not in the toolset,
  // so there is nothing for the tool_call hook to block. auto/ask use pi's default tool set
  // (read/bash/edit/write) — toolsForMode returns undefined so `tools` is omitted below.
  const tools = toolsForMode(mode)

  // Stop-button reliability (founder-reported gap, 2026-07-17): a customTool with the same name
  // as a built-in cleanly REPLACES it (confirmed in pi-coding-agent's own source,
  // agent-session.js's _refreshToolRegistry — built-ins populate the registry first, then
  // customTools Map.set() over them by name), and is filtered by the SAME tools/excludeTools
  // allowlist as built-ins — so passing this unconditionally is safe: plan mode's toolsForMode
  // allowlist already excludes 'bash', so this customTool simply never activates there, no mode
  // check needed here. See robust-bash.ts's own header for the full root-cause writeup (verified
  // live, repeated, timed testing): pi's own bash tool already wires abort correctly, but its
  // Windows kill (taskkill /F /T against a Git-Bash-rooted process tree) intermittently fails to
  // actually kill the spawned process — this swaps in a verified, escalating kill instead.
  const robustBash = createBashTool(repoRoot, { operations: createRobustBashOperations({ sessionLabel: sessionId }) })

  const { session } = await createAgentSession({
    cwd: repoRoot,
    agentDir,
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
    customTools: [robustBash],
    ...(tools ? { tools } : {}),
  })

  let aborted = false
  const onAbort = () => { aborted = true; void session.abort() }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  // ── relay streaming deltas/reasoning from the session event stream ────────────
  // Tool-call SSE is driven entirely by the extension hooks above; here we only relay the
  // model's text/thinking deltas so the two never double-emit.
  // Relay pi's event stream to SSE via the pure codeEventToFrame map (see its doc comment for the
  // full event→frame contract and rationale). Text/thinking deltas and compaction were surfaced
  // before; turn boundaries, auto-retries, and live tool-output streaming are the Phase 2 additions
  // (ADR-250). `turnCounter` is this run's own monotonic turn index, mutated across events.
  const turnCounter = { index: 0 }
  const unsubscribe = session.subscribe((ev: AgentSessionEvent) => {
    // First real model output means prefill is over — stop the /slots poller now, a cross-check in
    // case a slot's numbers never quite reach n_prompt_tokens (stale/rounding) before decode begins.
    if (ev.type === 'message_update') {
      stopPrefillPoll()
      if (roundStartedAt !== undefined && roundFirstTokenAt === undefined) {
        roundFirstTokenAt = Date.now()
        if (ttftMs === undefined) ttftMs = roundFirstTokenAt - turnStartedAt
      }
    } else if (ev.type === 'message_end' && ev.message.role === 'assistant' && roundStartedAt !== undefined) {
      // Round closes out — fold this round's prefill/gen split into the turn totals (see the
      // state declarations above for why this is summed across rounds, not just the last one).
      const roundEnded = Date.now()
      const firstTok = roundFirstTokenAt ?? roundEnded
      promptMsTotal += firstTok - roundStartedAt
      genMsTotal += roundEnded - firstTok
      roundStartedAt = undefined
      roundFirstTokenAt = undefined
    }
    const frame = codeEventToFrame(ev, turnCounter)
    if (frame) void sink(frame)
  })

  // Steering (Phase 1, ADR-246): hand the run manager a handle it can call to inject a message
  // into THIS live turn via pi's real session.steer(), delivered after the current assistant
  // turn's tool calls finish and before the next LLM call — redirecting the SAME turn rather than
  // queueing a fresh one. pi keeps the agentic loop alive until the steered message is drained
  // (agent-session.js's _runAgentPrompt loops while agent.hasQueuedMessages()), so the
  // `await session.prompt(task)` below still resolves only after the steered continuation settles
  // and the one accumulating assistant message captures it all. Guarded on isStreaming: if the
  // turn has already settled by the time a steer lands (a race — it just finished), return false
  // so the manager falls back to follow-up/queue instead of dropping it into a dead session.
  const steerHandle: SteerHandle = async (text) => {
    if (!session.isStreaming) return false
    await session.steer(text)
    return true
  }

  d.manager.generationStart()
  params.onSteerable?.(steerHandle)
  turnStartedAt = Date.now()
  try {
    // Not-streaming prompt: resolves after the whole agentic loop settles (mirrors pi's own
    // print mode), including any steered continuation folded in via steerHandle above.
    await session.prompt(task)
  } finally {
    params.onSteerable?.(null)
    stopPrefillPoll() // belt-and-suspenders: never leak the /slots timer past the turn (incl. abort)
    unsubscribe()
    releaseGate()
    d.manager.generationEnd()
    signal.removeEventListener('abort', onAbort)
  }

  const finalText = session.getLastAssistantText() ?? ''
  const stats = session.getSessionStats()
  // Prefer pi's live context-usage estimate; fall back to the aggregate token total.
  const contextUsed = stats.contextUsage?.tokens ?? stats.tokens.total ?? 0
  const contextMax = stats.contextUsage?.contextWindow ?? contextWindow
  const usage = foldTurnUsage(stats.tokens, { promptMsTotal, genMsTotal, ttftMs, totalMs: Date.now() - turnStartedAt })
  session.dispose()

  return { finalText, contextUsed, contextMax, aborted, ...usage }
}

export interface CompactCodeParams {
  d: Deps
  convId: string
  sessionId: string
  repoRoot: string
  /** Optional focus for the summary, mirrors pi's own `/compact [instructions]`. */
  customInstructions?: string
}

export interface CompactCodeResult {
  summary: string
  /** The DB message id everything at/before is now covered by `summary` — resolveEffectiveHistory
   *  cuts here on future turns instead of replaying the raw messages. */
  upToMessageId: string
  tokensBefore: number
}

/** Manual /compact — summarizes this session's history-so-far (including any EARLIER
 *  compaction's summary, since resolveEffectiveHistory seeds that first) into ONE new summary.
 *  Not incremental: a second /compact re-summarizes everything again rather than layering
 *  summaries on top of each other, which keeps seedPriorHistory's replay simple — at most one
 *  synthetic summary message, then raw messages after it.
 *
 *  Uses a dedicated, TOOL-LESS pi session purely to seed history and call pi's real
 *  session.compact() — no task is prompted, nothing executes, nothing can touch the filesystem
 *  or run a command regardless of the session's mode. */
export async function compactCodeSession(params: CompactCodeParams): Promise<CompactCodeResult> {
  const { d, convId, sessionId, repoRoot, customInstructions } = params

  // Never compact a cleared session (code-routes.ts's route already blocks this too, but the
  // invariant belongs here, not just at its one current caller): resolveEffectiveHistory
  // restricts a cleared session to only the post-clear messages, so compacting would summarize
  // ONLY those and persist a new cut point past the clear — a later /resume would then silently
  // and permanently lose everything before the clear, contradicting /resume's "restores exactly
  // as it was" contract.
  if (d.db.getAgentRun(sessionId)?.clearedUpToMessageId) throw new Error('session_cleared')

  const ms = d.manager.status()
  if (ms.state !== 'running' || !ms.model) throw new Error('model_not_loaded')
  const target = d.manager.target()
  if (!target) throw new Error('model_not_loaded')
  const engineKind = d.registry.active()?.kind ?? ''
  const modelId = engineModelAlias(engineKind) ?? ms.model.key
  const contextWindow = ms.model.ctx > 0 ? ms.model.ctx : 8192

  const { summaryText, messages: effectiveMessages } = resolveEffectiveHistory(d, convId, sessionId)
  if (effectiveMessages.length === 0) throw new Error('nothing_to_compact')
  const compactionSettings = compactionSettingsFor(contextWindow)
  compactionSettings.keepRecentTokens = keepRecentTokensFor(effectiveMessages, compactionSettings.keepRecentTokens)

  const authStorage = AuthStorage.inMemory()
  const modelRegistry = ModelRegistry.inMemory(authStorage)
  modelRegistry.registerProvider('local', {
    baseUrl: `${target}/v1`,
    apiKey: 'agent-key',
    authHeader: true,
    api: 'openai-completions',
    models: [{
      id: modelId,
      name: ms.model.name || 'Local Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen-chat-template' },
    }],
  })
  const model = modelRegistry.find('local', modelId)
  if (!model) throw new Error('Failed to register local model with pi.')

  const sessionManager = SessionManager.inMemory(repoRoot)
  if (summaryText) sessionManager.appendMessage({ role: 'user', content: summaryText, timestamp: Date.now() })
  const entryTrack: { piId: string; msgIndex: number }[] = []
  seedPriorHistory(sessionManager, effectiveMessages, modelId, (piId, msgIndex) => entryTrack.push({ piId, msgIndex }))
  if (entryTrack.length === 0) throw new Error('nothing_to_compact')

  // Same stale-ceiling strip as the main session's own before_provider_request hook — this
  // compaction session declares the identical maxTokens: 8192, and runs precisely when history
  // (hence prompt_tokens) is near the context limit, making the overflow this closes the most
  // likely to hit here of any Code code path.
  const compactExtension = (pi: ExtensionAPI): void => {
    pi.on('before_provider_request', async (event) => {
      const payload = { ...(event.payload as Record<string, unknown>) }
      delete payload.max_tokens
      delete payload.max_completion_tokens
      return payload
    })
  }
  const compactAgentDir = join(d.store.dir(), 'pi-agent')
  const compactResourceLoader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir: compactAgentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{ name: 'turbollm-compact', factory: compactExtension }],
    noSkills: true,
    // Disables pi's own native AGENTS.md/CLAUDE.md loader — see the skill sub-session's
    // identical construction above for the full double-injection writeup. Doubly relevant here:
    // this session's whole purpose is summarizing DB history, so pi's own uncapped
    // <project_context> injection would be pure noise on top of that.
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  })
  await compactResourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: repoRoot,
    agentDir: compactAgentDir,
    model,
    authStorage,
    modelRegistry,
    sessionManager,
    // Ctx-scaled settings (compactionSettingsFor), keepRecentTokens further guarded by
    // keepRecentTokensFor — pi's hosted-model-sized defaults could ask to keep more "recent"
    // tokens than this model's real context window even has room for, producing a compacted
    // result that still doesn't fit; the guard fixes a real bug in pi's own findCutPoint (see its
    // doc comment) that otherwise makes manual /compact report "nothing to compact" on a
    // heavy-tool-call-ending session, no matter how large the real conversation is.
    settingsManager: SettingsManager.inMemory({ compaction: compactionSettings }),
    resourceLoader: compactResourceLoader,
    tools: [], // pure summarization — no tool needs to run, and none should be able to.
  })
  let result: Awaited<ReturnType<typeof session.compact>>
  try {
    // pi's OWN compact() has an internal "already under budget" guard and throws its own
    // Error("Nothing to compact (session too small)") BEFORE ever returning a result — my
    // firstKeptEntryId analysis below never even runs in that case. Normalize both outcomes to
    // the same 'nothing_to_compact' signal the route already knows how to report cleanly.
    result = await session.compact(customInstructions)
  } catch (e) {
    session.dispose()
    if (e instanceof Error && /nothing to compact/i.test(e.message)) throw new Error('nothing_to_compact')
    throw e
  }
  session.dispose()

  // firstKeptEntryId is always a user/assistant message-boundary entry per pi's own cut-point
  // rules (never a tool result) — so the entry right before it in seed order is the last entry
  // of the PRIOR message, and that message's index is the correct new cut point.
  const keptIdx = entryTrack.findIndex((e) => e.piId === result.firstKeptEntryId)
  if (keptIdx <= 0) {
    // Not found (pi kept the synthetic summary itself) or the very first tracked entry is kept
    // — either way, everything new fits under keepRecentTokens; nothing further to summarize.
    throw new Error('nothing_to_compact')
  }
  const upToMessageId = effectiveMessages[entryTrack[keptIdx - 1].msgIndex].id

  d.db.updateAgentRun(sessionId, {
    compactionSummary: result.summary,
    compactionUpToMessageId: upToMessageId,
    compactionTokensBefore: result.tokensBefore,
  })

  return { summary: result.summary, upToMessageId, tokensBefore: result.tokensBefore }
}

export interface LookbackParams {
  d: Deps
  convId: string
  sessionId: string
  repoRoot: string
  question: string
  signal?: AbortSignal
}

export interface LookbackResult {
  answer: string
}

/** `delegate_task`'s sibling for the one thing it can't do: answer a question grounded in
 *  messages a PRIOR `/compact` already summarized away, which this session's own live context no
 *  longer carries raw. Today's `/compact` is non-incremental (see compactCodeSession's own doc
 *  comment) — a second `/compact` re-summarizes everything again, so "the pre-compaction range"
 *  here just means "every message up to and including the CURRENT compactionUpToMessageId
 *  cursor" — that already covers any number of stacked prior compactions, since compaction never
 *  deletes DB rows, only moves the cursor (resolveEffectiveHistory).
 *
 *  Same isolation principle as delegate_task/runSkillSubSession: a dedicated, TOOL-LESS pi
 *  session seeded with the raw pre-compaction messages, prompted with the model's own question,
 *  and only the final answer text returned — the raw history itself never re-enters the parent
 *  session's own context, so this doesn't defeat the point of having compacted in the first
 *  place. */
export async function lookbackPreCompactionHistory(params: LookbackParams): Promise<LookbackResult> {
  const { d, convId, sessionId, repoRoot, question, signal } = params
  const run = d.db.getAgentRun(sessionId)
  if (!run?.compactionUpToMessageId) throw new Error('nothing_compacted')

  const ms = d.manager.status()
  if (ms.state !== 'running' || !ms.model) throw new Error('model_not_loaded')
  const target = d.manager.target()
  if (!target) throw new Error('model_not_loaded')
  const engineKind = d.registry.active()?.kind ?? ''
  const modelId = engineModelAlias(engineKind) ?? ms.model.key
  const contextWindow = ms.model.ctx > 0 ? ms.model.ctx : 8192

  // Everything up to and including the cut, from the FULL (never-deactivated-by-compaction) DB
  // history — compaction only ever moves this cursor, it never deletes rows, so this is genuinely
  // the raw original text regardless of how many compactions have happened since.
  const all = d.db.getConversation(convId, true)?.messages ?? []
  const cutIdx = all.findIndex((m) => m.id === run.compactionUpToMessageId)
  const preCompaction = cutIdx === -1 ? all : all.slice(0, cutIdx + 1)
  if (preCompaction.length === 0) throw new Error('nothing_compacted')

  const authStorage = AuthStorage.inMemory()
  const modelRegistry = ModelRegistry.inMemory(authStorage)
  modelRegistry.registerProvider('local', {
    baseUrl: `${target}/v1`,
    apiKey: 'agent-key',
    authHeader: true,
    api: 'openai-completions',
    models: [{
      id: modelId,
      name: ms.model.name || 'Local Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen-chat-template' },
    }],
  })
  const model = modelRegistry.find('local', modelId)
  if (!model) throw new Error('Failed to register local model with pi.')

  const sessionManager = SessionManager.inMemory(repoRoot)
  const entryTrack: { piId: string; msgIndex: number }[] = []
  seedPriorHistory(sessionManager, preCompaction, modelId, (piId, msgIndex) => entryTrack.push({ piId, msgIndex }))
  if (entryTrack.length === 0) throw new Error('nothing_compacted')

  // Same stale-ceiling strip as compactCodeSession's own before_provider_request hook.
  const lookbackExtension = (pi: ExtensionAPI): void => {
    pi.on('before_provider_request', async (event) => {
      const payload = { ...(event.payload as Record<string, unknown>) }
      delete payload.max_tokens
      delete payload.max_completion_tokens
      return payload
    })
  }
  const lookbackAgentDir = join(d.store.dir(), 'pi-agent')
  const lookbackResourceLoader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir: lookbackAgentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{ name: 'turbollm-lookback', factory: lookbackExtension }],
    noSkills: true,
    // Disables pi's own native AGENTS.md/CLAUDE.md loader — see the skill sub-session's
    // identical construction above for the full double-injection writeup.
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  })
  await lookbackResourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: repoRoot,
    agentDir: lookbackAgentDir,
    model,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: lookbackResourceLoader,
    tools: [], // read-only Q&A over already-seeded history — no tool needs to run, none should.
  })

  const onAbort = () => { void session.abort() }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  // Reuses delegate_task's own bound — same "isolated, read-only sub-session" risk shape.
  const timer = setTimeout(() => void session.abort(), DELEGATE_SUBAGENT_TIMEOUT_MS)

  try {
    await session.prompt(
      'Answer the following question using ONLY the conversation history above, which is from ' +
      'earlier in this same coding session, before it was compacted/summarized away. Be concise ' +
      'and specific — quote or reference exactly what was said/decided if relevant. If the history ' +
      'does not actually answer the question, say so plainly rather than guessing.\n\n' +
      `Question: ${question}`,
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const answer = session.getLastAssistantText()?.trim() || '(no answer produced)'
  session.dispose()
  return { answer }
}

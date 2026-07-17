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
  const compactionIdx = run?.compactionUpToMessageId ? all.findIndex((m) => m.id === run.compactionUpToMessageId) : -1
  const clearedIdx = run?.clearedUpToMessageId ? all.findIndex((m) => m.id === run.clearedUpToMessageId) : -1
  // A RESOLVABLE clear that's at/after any compaction cut wins outright — a blank slate, no
  // summary carried forward. An unresolvable (stale/corrupt) clear marker falls through to the
  // compaction-only path below, same "degrade to replaying raw rather than silently dropping
  // everything" philosophy as an unresolvable compaction marker.
  if (clearedIdx !== -1 && clearedIdx >= compactionIdx) {
    return { summaryText: null, messages: all.slice(clearedIdx + 1) }
  }
  if (!run?.compactionUpToMessageId) return { summaryText: null, messages: all }
  // An unresolvable compaction marker (cut message deleted/corrupt) still surfaces its summary —
  // replaying every raw message alongside a redundant summary loses nothing, whereas resolving
  // it as "no compaction at all" would silently discard a real (if now unanchored) summary.
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
}

export interface RunCodeResult {
  /** Final assistant text (the plan, in plan mode; the summary, otherwise). */
  finalText: string
  /** Real context usage this run, for the context ring. */
  contextUsed: number
  contextMax: number
  aborted: boolean
}

// pi's built-in mutating tools that require approval in ASK mode. read/grep/find/ls are
// read-only and never gated. bash has no path argument, so containment can't confine it —
// the mode system is its only guard (ask = approval, plan = not in toolset, auto = unconfined).
export const MUTATING_TOOLS = new Set(['edit', 'write', 'bash'])
// Tools whose path argument must pass the containment check before executing (plan §3b).
// bash is deliberately absent — it takes `command`, not `path` (see risk flag 1).
export const PATH_TOOLS = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls'])

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

        if (PATH_TOOLS.has(toolName)) {
          const p = input.path
          const pathRequired = toolName === 'read' || toolName === 'edit' || toolName === 'write'
          if (p !== undefined && typeof p === 'string') {
            if (!isContainedFromRoot(p, repoRoot)) {
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
    pi.on('after_provider_response', () => { releaseGate() })

    pi.on('turn_start', () => { consecutiveToolFailures = 0; hasSearchedWebThisTurn = false })

    // The ENTIRE containment/approval boundary (plan risk flag 2). Runs before tool.execute().
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
      const toolName = event.toolName
      const toolCallId = event.toolCallId
      const input = event.input as Record<string, unknown>

      // Always surface the call as pending so the UI shows an inline step immediately.
      await sink({ event: 'tool_call', data: { id: toolCallId, name: toolName, args: input, status: 'pending' } })

      // 1. Containment (plan §3b) — BEFORE any mode logic, so it applies in every mode
      //    including auto. Only tools that take a `path` are checkable here.
      if (PATH_TOOLS.has(toolName)) {
        const p = input.path
        // grep/find/ls accept an optional path defaulting to cwd (contained by definition);
        // only reject when a path was actually supplied and falls outside the root.
        const pathRequired = toolName === 'read' || toolName === 'edit' || toolName === 'write'
        if (p !== undefined && typeof p === 'string') {
          // Resolve a RELATIVE path against the session repoRoot, NOT the daemon's own cwd —
          // pi's read/edit/write/ls tools emit repo-relative paths, and resolving those against
          // process.cwd() falsely rejected legitimate in-bounds calls in every mode.
          if (!isContainedFromRoot(p, repoRoot)) {
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
    // agentsMd: <repoRoot>/AGENTS.md + ~/.turbollm/agents.md, like OpenCode — d.store.dir() IS
    // TurboLLM's own data dir (the same one SkillStore above reads from).
    appendSystemPrompt: buildAppendPrompt(mode, skills, { repoRoot, globalDir: d.store.dir() }, !!d.tools),
    // Keep the prompt lean and deterministic — no global skills/prompts/themes discovery.
    noSkills: true,
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
  const unsubscribe = session.subscribe((ev: AgentSessionEvent) => {
    if (ev.type === 'message_update') {
      const ame = ev.assistantMessageEvent
      if (ame.type === 'text_delta') {
        void sink({ event: 'delta', data: { delta: ame.delta } })
      } else if (ame.type === 'thinking_delta') {
        void sink({ event: 'reasoning', data: { delta: ame.delta } })
      }
    } else if (ev.type === 'compaction_start') {
      // pi's own AUTO-compaction (distinct from the manual /compact route below, which only
      // ever calls session.compact() on demand) — a real first-class pi feature this session
      // registered no listener for until now, so it fired with zero UI feedback: the transcript
      // just went quiet while pi silently summarized history mid-turn. Forwarded so the
      // frontend can show a real "Compacting conversation…" state instead of a generic/blank gap.
      void sink({ event: 'compaction', data: { phase: 'start', reason: ev.reason } })
    } else if (ev.type === 'compaction_end') {
      void sink({ event: 'compaction', data: { phase: 'end', reason: ev.reason, aborted: ev.aborted, tokensBefore: ev.result?.tokensBefore } })
    }
  })

  d.manager.generationStart()
  try {
    // Not-streaming prompt: resolves after the whole agentic loop settles (mirrors pi's own
    // print mode). Steering/follow-up messages are a fast-follow.
    await session.prompt(task)
  } finally {
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
  session.dispose()

  return { finalText, contextUsed, contextMax, aborted }
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

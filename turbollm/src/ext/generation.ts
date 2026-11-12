// turbollm/src/ext/generation.ts
//
// The production generation body for the public API's send/stream route (spec 27 §5, §6, §8).
// `routes.runs.ts` only knows the injected `RunDeps.makeBody` seam; this file is the one place
// that wires it to a real engine call. Its loop is the chat's own: runGenerationCore
// (chat/generation-core.ts; ADR-112: one loop behind an event sink, never forked — scalability
// 5.6), the same loop the live chat and Chat Routines run, so an engine quirk is patched once for
// all three. generation.loop.test.ts drives it end to end against a loopback engine.
//
// What the public API needs of that loop, each through a port or a defaulted-off option:
//
//  - PERSISTENCE in the tenant's store. A public message lives in `d.chatStore` (the local store for
//    the 'local' tenant, a separate adapter store for any other); `d.db` — the LOCAL
//    ConversationStore — never holds it, so a write there would affect 0 rows and leave the public
//    message at status:'streaming' forever. The core never touches `d.db`: this file's persistence
//    port checkpoints into `d.chatStore` on its own cadence (progressCadence 'everyChange' +
//    shouldFlushCheckpoint), and the terminal write runs here, after the gate is released.
//  - NO WAITING ON APPROVALS. The approval policy is non-interactive with an empty
//    `agentAllowedTools`, so an 'ask'-policy tool resolves as an instant "Blocked" deny, never a
//    wait on an approval endpoint no external caller can reach (spec 27 §5.1: "public runs execute
//    allow-policy tools only; anything resolving to ask is treated as deny").
//  - THE TENANT'S SAMPLING CANNOT STEER THE REQUEST: mapSampling drops the control keys, and what
//    is left goes UNDER the request's own fields (GenerationTurn.engineSampling).
//  - THE PUBLIC WIRE: the run's events are the loop's deltas, reasoning and tool-call events, then
//    the engine's raw `usage`; the loop's own progress, notice, error and done events stay off it
//    (the run manager sends its own error and done frames). See PUBLIC_LOOP and publicSink.
//  - THIS MACHINE'S LEDGERS: the run holds the gate ('bg') and counts itself in-flight
//    (generationStart) here; the loop writes nothing more (`ledgers: false`: no live readout,
//    completion stats, bench result or request-log entry, as a public run never had).
import type { Deps } from '../deps.js'
import type { EmitSink } from '../chat/emit-sink.js'
import type { ChatStore } from '../chat/store/chat-store.js'
import type { Chat, ChatMessage, Scope } from '../chat/store/types.js'
import type { ChatUpstream } from '../chat/chat-upstream.js'
import type { RunDeps } from './routes.runs.js'
import { withCurrentDate } from '../chat/chat-compaction.js'
import { runGenerationCore, type GenerationOutcome, type LoopOptions, type ReplySnapshot } from '../chat/generation-core.js'
import { engineModelAlias } from '../engines/compat.js'
import { servingEngineKind } from '../engines/serving'

/** Mirrors chat-routes.ts's own MAX_TOOL_ITER / chat-runner.ts's identical constant — a
 *  ceiling, not a target. Ordinary chats finish in 1 round; this only bounds a runaway loop. */
const MAX_TOOL_ITER = 16

/** How a public run drives the shared loop: every option is what this API has always done.
 *  The 16-round ceiling, every round's calls run, then the run fails (`exceeded`); no BUG-001 extra
 *  pass; the run's own accounting only (`ledgers: false`, see the header); a stop lets the round's
 *  remaining calls run and ends the run before its next request; no prompt-progress request and no
 *  pending announcement of a call still streaming (neither is on the public wire); an error chunk
 *  in the stream read past; the stored reply exactly what was streamed. Tools are withheld on
 *  vLLM/SGLang, as in the live chat (no toolsOnEveryEngine). */
const PUBLIC_LOOP: LoopOptions = {
  toolRoundCeiling: MAX_TOOL_ITER,
  extraPass: false,
  ledgers: false,
  stopBetweenToolCalls: false,
  returnProgress: false,
  announceToolCalls: false,
  streamErrors: 'ignore',
  interruptedTail: 'asStreamed',
}
/** Per-page size when walking chat history (see `loadFullHistory`). This is NOT a cap on how
 *  much history is sent to the engine — `SqliteChatStore.listMessages` internally clamps any
 *  requested `limit` to 200 regardless (`clampLimit` in sqlite-chat-store.ts), so raising this
 *  number would do nothing; `loadFullHistory` pages past it instead. Overridable for tests. */
const DEFAULT_PAGE_SIZE = 200
/** Guards a misbehaving adapter (`hasMore` stuck `true` forever) from looping without bound —
 *  1000 pages at the max real page size is 200,000 messages, far beyond any realistic chat. */
const MAX_PAGES = 1000

interface WireMessage { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string; reasoning_content?: string }

/** Loads the ENTIRE message history for a chat, paging forward via `cursor` until
 *  `hasMore` is false — matching `runGeneration`'s own genuinely unbounded history source
 *  (`db.getConversation(convId, true).messages`, no limit at all).
 *
 *  CRITICAL FIX (post-review): a single `listMessages(scope, chatId, {limit: N})` call with no
 *  cursor is NOT "the first N messages of history" in the sense a caller might assume — it is
 *  the OLDEST page (`SqliteChatStore.listMessages` runs `WHERE seq > 0 ORDER BY seq ASC LIMIT
 *  $lim`). Once a chat has more total messages than one page, the just-persisted user message
 *  and assistant placeholder for THIS turn — the highest `seq` values — fall entirely outside
 *  that first page and silently vanish from what the engine sees, with the run still reporting
 *  status:'complete'. Raising the page size does not fix this either:
 *  `SqliteChatStore.listMessages` clamps any requested `limit` to 200 regardless
 *  (`clampLimit`) — pagination is the only correct fix. Exported so the pagination behavior
 *  itself can be exercised directly in a test without needing hundreds of real messages
 *  (see generation.test.ts, which overrides `pageSize` down to force multiple pages). */
export async function loadFullHistory(
  chatStore: ChatStore, scope: Scope, chatId: string, pageSize = DEFAULT_PAGE_SIZE,
): Promise<ChatMessage[]> {
  const all: ChatMessage[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const page = await chatStore.listMessages(scope, chatId, { cursor, limit: pageSize })
    all.push(...page.data)
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }
  return all
}

/** The minimal per-turn context a public-API generation needs, built from the PUBLIC `Chat` DTO
 *  the route already confirmed exists (`d.chatStore.getChat`) — never from `d.db.getConversation`
 *  (see the file header, PERSISTENCE). Intentionally thin: the public `Chat` type has no fields for the
 *  UI-only concepts chat-routes.ts's internal `Conversation` carries (agentId, skillIds,
 *  expertMode, readScope, toolOverrides, agentMode, force_web_search-style toolPolicy) — public
 *  chats simply don't have them, and public runs get no per-conversation override machinery
 *  (spec 27 §5.1), so there is nothing to synthesize for those fields. */
export interface GenerationCtx {
  chat: Chat
  engineMessages: WireMessage[]
}

/** Builds the wire message array: the chat's own system prompt (with the same live-date
 *  substitution real turns get, via chat-routes.ts's exported `withCurrentDate`), then its prior
 *  history in seq order, already including this turn's just-persisted user message (the route
 *  persists user-then-placeholder before starting the run, and the caller here filters out only
 *  the placeholder by id — see `createMakeBody`). Folds a prior assistant turn's `reasoning` back
 *  in as a `<think>` block exactly as chat-routes.ts's own resend logic does — `preserveThinking`
 *  is always on here, matching `ConversationStore.createConversation`'s own default for new chats
 *  (there is no per-chat toggle in the public API). For a LiteRT-LM engine (`engineKind`) it goes in the
 *  message's `reasoning_content` instead, as the chat sends it there (chat-compaction.ts buildEngineMessages):
 *  a bundle's template decides what of it the model sees, where the `<think>` text went into most of them verbatim,
 *  every past turn's reasoning in a 4096-token context. */
export function buildGenerationCtx(chat: Chat, engineHistory: ChatMessage[], engineKind = ''): GenerationCtx {
  const engineMessages: WireMessage[] = []
  if (chat.systemPrompt) engineMessages.push({ role: 'system', content: withCurrentDate(chat.systemPrompt) })
  for (const m of engineHistory) {
    const reasoning = m.role === 'assistant' && m.reasoning?.trim() ? m.reasoning : undefined
    if (reasoning && engineKind === 'litert-lm') {
      engineMessages.push({ role: m.role, content: m.content, reasoning_content: reasoning })
      continue
    }
    const content = reasoning ? `<think>\n${reasoning}\n</think>\n\n${m.content}` : m.content
    engineMessages.push({ role: m.role, content })
  }
  return { chat, engineMessages }
}

const SAMPLING_KEYS: Record<string, string> = {
  temp: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p',
  presencePenalty: 'presence_penalty', frequencyPenalty: 'frequency_penalty',
}

// A tenant's sampling goes UNDER the request's own fields (release-gate I7;
// GenerationTurn.engineSampling): `chat.sampling` is unvalidated integrator JSON, stored verbatim,
// and `mapSampling`'s own trailing loop copies through any key it doesn't recognize, so a tenant
// setting `sampling.model`/`.messages`/`.stream`/`.stream_options` must never be able to override
// what THIS route sends — e.g. `stream: false` would silently break the SSE read loop, and
// `messages: [...]` would hand the shared engine a prompt that skipped this route's own history
// assembly and context-window check entirely.
//
// Round-2 release-gate finding H2: that precedence (I7) only protects the fields the request
// actually sets (model/messages/stream/stream_options) — it does nothing for a control-plane key
// this trailing passthrough loop lets through that the ROUTE never happens to set. `tool_choice`
// is exactly that case: no route ever sets it explicitly, so there is no control field for a tenant's own
// `sampling.tool_choice` to lose to, and it reached the engine verbatim (live-reproduced: a
// tenant setting `tool_choice: 'required'` can COMPEL a tool call every turn, not just hope for
// one — those calls then execute under the LOCAL install's own tool policy, sharpening I10's
// already-accepted risk). `tools` has the same gap specifically on vLLM/SGLang, where the route
// deliberately withholds `reqBody.tools` (`toolsSupported` false) — a tenant's own `sampling.tools`
// reached the engine anyway on exactly the engines the route chose to suppress it on. Denylisted
// here, not left to the request's spread order, since spread order alone only protects fields the
// route actually sets — this protects a field even when the route sets nothing.
const RESERVED_ENGINE_KEYS = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice'])

/** The same camelCase → engine snake_case mapping the generation core applies to a chat's
 *  `conv.sampling`, applied here to the public `Chat.sampling` passthrough field, less every
 *  reserved key (RESERVED_ENGINE_KEYS, above). Exported so the denylist is directly testable. */
export function mapSampling(sampling: Record<string, unknown>, repeatPenaltyKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(SAMPLING_KEYS)) {
    if (camel in sampling) out[snake] = sampling[camel]
  }
  if ('repeatPenalty' in sampling) out[repeatPenaltyKey] = sampling.repeatPenalty
  for (const [k, v] of Object.entries(sampling)) {
    if (!(k in SAMPLING_KEYS) && k !== 'repeatPenalty' && k !== 'stop' && !RESERVED_ENGINE_KEYS.has(k)) out[k] = v
  }
  return out
}

/** Periodic mid-stream checkpoint thresholds (spec 27 §4.7, C2 fix): flush whichever comes
 *  first — roughly every ~500ms of wall-clock time since the last successful flush, or roughly
 *  every ~256 new characters of content+reasoning accumulated since the last flush. Exported so
 *  the decision itself is directly unit-testable without a live engine (see generation.test.ts). */
export const FLUSH_INTERVAL_MS = 500
export const FLUSH_MIN_CHARS = 256

/** Pure "should I checkpoint now?" decision — no I/O, no clock reads of its own. The caller
 *  supplies how much wall-clock time has elapsed and how many new characters have accumulated
 *  since the last flush. Returns false whenever there is nothing new to persist
 *  (`charsSinceLastFlush <= 0`) even if the interval has elapsed — flushing unchanged content
 *  would just be a wasted store write for zero durability benefit. */
export function shouldFlushCheckpoint(
  elapsedMsSinceLastFlush: number,
  charsSinceLastFlush: number,
  opts: { intervalMs?: number; minChars?: number } = {},
): boolean {
  if (charsSinceLastFlush <= 0) return false
  const intervalMs = opts.intervalMs ?? FLUSH_INTERVAL_MS
  const minChars = opts.minChars ?? FLUSH_MIN_CHARS
  return elapsedMsSinceLastFlush >= intervalMs || charsSinceLastFlush >= minChars
}

/** Pure "is this chunk's usage worth capturing" check, applied to each usage object the loop
 *  reports (GenerationPorts.onUsage; final-review Critical finding: this file's own loop once never
 *  captured it at all). The engine's final per-round SSE chunk — the one
 *  `stream_options: { include_usage: true }` on the outbound request asks for — carries a real
 *  `usage` object alongside an EMPTY `choices` array, which the loop reports before its
 *  `choices` gate. Returns the raw object unchanged — no field renaming, no derived fields —
 *  because that IS the real wire shape the engine sends. Exported so the decision is directly
 *  unit-testable without a live engine. */
export function extractChunkUsage(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const usage = chunk.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  return usage as Record<string, unknown>
}

/** Whether a captured usage object belongs in a `ChatMessage` patch — spread the result directly
 *  into a patch literal. Deliberately OMITS the `usage` key entirely (rather than sending
 *  `usage: {}` or a stale placeholder) until real usage data has actually arrived from the
 *  engine: `MessagePatch.usage` is optional specifically so "not present" and "present but
 *  empty" stay distinguishable, and `sqlite-chat-store.ts`'s `updateMessage` only touches the
 *  `stats` column when `patch.usage !== undefined` — sending `usage: {}` on every checkpoint
 *  before anything real has arrived would needlessly overwrite that column for no benefit.
 *  Exported for the same reason as `extractChunkUsage`. */
export function buildUsagePatch(usage: Record<string, unknown> | undefined): { usage?: Record<string, unknown> } {
  return usage !== undefined ? { usage } : {}
}

/** What a run hears of its loop. */
interface LoopHooks {
  /** The reply so far, at each change to it; `toolCall` when a tool call has just settled. */
  onProgress: (reply: ReplySnapshot, toolCall: boolean) => void
  /** The reply as the loop ends: what the terminal write stores. */
  onFinal: (reply: ReplySnapshot) => void
  onError: (message: string) => void
  onUsage: (usage: Record<string, unknown>) => void
}

/** This machine's engine as the run's upstream: the loaded model, under its engine's alias (engineModelAlias). A
 *  public run always generates on the local engine. Undefined when no model is loaded. */
function localUpstream(d: Deps): ChatUpstream | undefined {
  const ms = d.manager.status()
  const target = d.manager.target()
  if (ms.state !== 'running' || !ms.model || !target) return undefined
  const engineKind = servingEngineKind(d)
  return {
    modelField: engineModelAlias(engineKind, d.manager.currentOpts()?.modelPath) ?? ms.model.key,
    modelName: ms.model.name,
    ctxMax: ms.model.ctx,
    target,
    engineKind,
  }
}

/** The loop's events no public client reads: its prompt progress, and its own error and done (the run manager sends
 *  the run's error and done frames, run-manager.ts). */
const LOOP_ONLY_EVENTS = new Set(['progress', 'error', 'done'])

/** The run's event stream, from the loop's: a note the chat would show its user goes to the log (this API has no note
 *  event), the loop-only events stay off it, and the rest (deltas, reasoning, tool calls) goes through as it is. */
function publicSink(emit: EmitSink): EmitSink {
  return (ev) => {
    if (ev.event === 'notice') {
      console.log(`[ext] ${(ev.data as { message: string }).message}`)
      return
    }
    if (LOOP_ONLY_EVENTS.has(ev.event)) return
    return emit(ev)
  }
}

/** The error a run the loop finished reports, if it failed. */
function outcomeError(outcome: GenerationOutcome): string | undefined {
  const failure = outcome.failure
  // The engine's reason, as the chat gives it: it said only the status code.
  if (failure?.kind === 'http') return failure.reason ? `Engine returned ${failure.status}: ${failure.reason}` : `Engine returned ${failure.status}`
  if (failure?.kind === 'thrown') return failure.request ? `Engine request failed: ${failure.message}` : failure.message
  if (failure) return failure.message
  if (outcome.exceeded) return `Exceeded the ${MAX_TOOL_ITER}-round tool-call ceiling without finishing.`
  return undefined
}

/** Drives the engine for one turn on the shared loop, including any tool-call rounds, streaming deltas/reasoning out
 *  via `emit` as they arrive and reporting the reply and the final outcome via `hooks`. Never throws for an
 *  engine-side failure (the loop's own contract: swallow, report, finish) — `hooks.onError` is the sole failure
 *  signal, so the caller decides what a failure means for the run's terminal status. */
async function runGenerationLoop(d: Deps, ctx: GenerationCtx, emit: EmitSink, signal: AbortSignal, hooks: LoopHooks): Promise<void> {
  const upstream = localUpstream(d)
  if (!upstream) {
    hooks.onError('No model loaded.')
    return
  }
  // BUG-006 (generation-core.ts): vLLM/SGLang/mlx-vlm require the OpenAI-spec `repetition_penalty`
  // name, not llama.cpp's `repeat_penalty`. Same mapping, same reason; LiteRT-LM keeps llama.cpp's
  // name, whose window the Android app's server applies as llama.cpp does.
  const engineKind = upstream.engineKind
  const repeatPenaltyKey = (engineKind === 'vllm' || engineKind === 'sglang' || engineKind === 'mlx-vlm') ? 'repetition_penalty' : 'repeat_penalty'
  const sampling = ctx.chat.sampling ?? {}

  // The loop stops on its own controller, as a routine's run does (chat-runner.ts); the run's signal fires it.
  const ac = new AbortController()
  const abort = () => ac.abort()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  try {
    const outcome = await runGenerationCore(d, {
      convId: ctx.chat.id,
      // Public chats have no skills, agent tool list, persona tool policy or thinking toggle (spec 27 §5.1).
      conv: { id: ctx.chat.id, sampling: {} },
      engineMessages: ctx.engineMessages,
      upstream,
      ac,
      thinkingBudget: -1,
      reasoningEffort: undefined,
      engineSampling: { fields: mapSampling(sampling, repeatPenaltyKey), stop: Array.isArray(sampling.stop) ? sampling.stop as string[] : undefined },
      loop: PUBLIC_LOOP,
    }, {
      persistence: {
        progressCadence: 'everyChange',
        saveProgress: (reply, change) => hooks.onProgress(reply, change === 'toolCall'),
        restoreUnproduced: () => false,
        // The terminal write is the run's own, after the gate is released (createMakeBody): never under it.
        finalize: (reply) => { hooks.onFinal(reply) },
      },
      sink: publicSink(emit),
      // Public runs execute allow-policy tools only (spec 27 §5.1). `interactive: false` +
      // an empty `agentAllowedTools` means an 'ask'-policy tool (the default for anything not
      // explicitly configured — tool-policy.ts) resolves as an instant "Blocked" deny inside
      // executeToolCallWithApproval, never a wait on `waitForToolApproval` — there is no
      // interactive approval endpoint an external caller could ever reach.
      approval: {
        interactive: false,
        agentAllowedTools: [],
        isCodeAuthorized: false, // no HTTP request to authorize against here (§5.1) — fail closed
        // A tenant's run may not author, edit or fire a chat routine on an agent that lists one of
        // the owner's MCP tools, nor create such an agent, as a routine's own unattended run may
        // not (chat-runner.ts): the routine then runs that MCP tool with no approval. Without it a
        // tenant whose install had update_routine and run_routine_now on Allow rewrote the
        // prompt of the owner's MCP routine and fired it, running an MCP tool left on Ask (which
        // the tenant could not call itself) on the tenant's prompt, then on every later fire.
        // MCP tools themselves still run under their own policy.
        refuseMcpAgentsAndRoutines: true,
        convOverrides: () => ({}), // public chats carry no per-conversation override machinery (§5.1)
      },
      onUsage: (usage) => {
        const captured = extractChunkUsage({ usage })
        if (captured) hooks.onUsage(captured)
      },
    })
    const error = outcomeError(outcome)
    if (error) hooks.onError(error)
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Builds the real `RunDeps.makeBody` the send/stream route drives (routes.runs.ts). Persist-
 *  then-generate and the 404/409 checks already happened in the route before this is ever
 *  called — this only has to run the turn and land a terminal write, in this order:
 *    read chat + history (adapter I/O, no gate) → acquire gate('bg') → generationStart →
 *    engine loop (only "engine work" the gate should hold) → generationEnd → release gate →
 *    terminal chatStore.updateMessage (adapter I/O, after release, per the standing invariant
 *    that the gate never wraps adapter I/O).
 *  The terminal write always runs, on every exit path (success, engine failure, abort, or an
 *  early exception before the loop even starts) — so the assistant placeholder never sits stuck
 *  at status:'streaming' forever. */
export function createMakeBody(d: Deps): RunDeps['makeBody'] {
  return ({ chatId, messageId, scope }) => async ({ emit, signal }) => {
    /** The reply as the loop last reported it (LoopHooks): what every checkpoint and the terminal write store. */
    let reply: ReplySnapshot = { content: '', reasoning: '', toolCalls: [] }
    // undefined (not {}) until the engine's usage chunk actually arrives — see
    // buildUsagePatch's doc comment for why that distinction is load-bearing, not cosmetic.
    let finalUsage: Record<string, unknown> | undefined
    let errorMessage: string | undefined
    let release: (() => void) | null = null

    // Periodic mid-stream checkpoint (spec 27 §4.7, C2 fix): best-effort partial persistence so
    // a hard daemon crash (OOM, unhandled exception, kill) mid-generation loses at most
    // ~500ms/~256 chars of content, never everything generated so far for the turn — matching
    // §6.4's guarantee ("nothing generated is lost — only resumability"). This is additive: the
    // existing terminal `updateMessage` write below still runs on every exit path unchanged.
    //
    // Event-driven rather than a literal `setInterval`: content only ever changes where the loop
    // reports it (onProgress below: progressCadence 'everyChange'), so checking there (using a real
    // `Date.now()` elapsed-time comparison, not a token/event count) is exactly as timely as a
    // background timer would be — and there is no timer handle to leak or clean up on any exit
    // path (normal completion, an engine error, or an aborted signal all just stop the reports,
    // so the checks simply stop happening; nothing to clearInterval). The extracted
    // decision (`shouldFlushCheckpoint`) is directly unit-tested in generation.test.ts.
    //
    // Flushes are fire-and-forget from the hot loop (never awaited inline) so a slow adapter
    // write can't stall engine throughput while `d.gate` is held — but `flushInFlight` is
    // reconciled (awaited) once below, after the loop ends and the gate is released, so the
    // authoritative terminal write can never be raced and overwritten by a lagging partial
    // checkpoint that was still in flight when the loop returned.
    //
    // No `ifVersion` guard: the terminal write below has never carried one either (it
    // unconditionally overwrites `content`/`reasoning`/`toolCalls`/`status` regardless of the
    // message's current version), so an intermediate checkpoint adding a stricter guard than the
    // authoritative final write would be inconsistent for no real benefit — a guarded flush that
    // hit `version_conflict` would still need to fall back to *something* before the unguarded
    // terminal write ran anyway. Concurrent-edit-during-generation races on this message id are
    // a separate, already-tracked gap (final-review finding I3: no `run_active` 409 guard on
    // message mutation) — out of this fix's scope, and not made any worse by matching the
    // terminal write's existing behavior here.
    let lastFlushAt = Date.now()
    let lastFlushChars = 0
    let lastFlushToolCalls = 0
    let flushInFlight: Promise<void> | null = null

    const maybeFlush = (force = false) => {
      if (flushInFlight) return // a flush is already in progress; the next check picks up anything newer
      const charsSinceLastFlush = reply.content.length + reply.reasoning.length - lastFlushChars
      const toolCallsSinceLastFlush = reply.toolCalls.length - lastFlushToolCalls
      if (charsSinceLastFlush <= 0 && toolCallsSinceLastFlush <= 0) return // nothing new to persist
      if (!force && !shouldFlushCheckpoint(Date.now() - lastFlushAt, charsSinceLastFlush)) return

      lastFlushAt = Date.now()
      lastFlushChars = reply.content.length + reply.reasoning.length
      lastFlushToolCalls = reply.toolCalls.length
      flushInFlight = d.chatStore.updateMessage(scope, messageId, {
        content: reply.content,
        reasoning: reply.reasoning,
        toolCalls: reply.toolCalls,
        status: 'streaming',
        ...buildUsagePatch(finalUsage),
      }).then(
        () => {},
        () => {
          // Best-effort, same as the terminal write below: a failed intermediate checkpoint
          // (adapter hiccup, transient error) must never abort the generation — it just means
          // this one checkpoint didn't land; the next checkpoint or the terminal write tries
          // again with the fuller content.
        },
      ).finally(() => { flushInFlight = null })
    }

    try {
      const chat = await d.chatStore.getChat(scope, chatId)
      if (!chat) throw new Error(`Chat ${chatId} no longer exists.`)

      // Full history, not one capped page (see loadFullHistory's own doc comment for the bug
      // this fixes). The placeholder assistant message (this turn) is excluded by id —
      // everything else, including the just-persisted user turn, stays in seq order (mirrors
      // chat-routes.ts's own `allMsgs = conv.messages.filter(m => m.id !== assistantMsg.id)`).
      const fullHistory = await loadFullHistory(d.chatStore, scope, chatId)
      const engineHistory = fullHistory.filter((m) => m.id !== messageId)
      const ctx = buildGenerationCtx(chat, engineHistory, servingEngineKind(d))

      release = d.gate ? await d.gate.acquire('bg', { signal }) : null
      d.manager.generationStart()
      try {
        await runGenerationLoop(d, ctx, emit, signal, {
          onProgress: (r, toolCall) => { reply = r; maybeFlush(toolCall) },
          onFinal: (r) => { reply = r },
          onError: (m) => { errorMessage = m },
          onUsage: (u) => { finalUsage = u },
        })
      } finally {
        d.manager.generationEnd()
      }
    } catch (e) {
      if (!signal.aborted) errorMessage = errorMessage ?? (e as Error).message
    } finally {
      // Released BEFORE the terminal write below — the gate wraps engine work only, never
      // adapter I/O (standing invariant, spec 27 §8.2).
      release?.()
    }

    // Reconcile any still-in-flight periodic checkpoint before the terminal write below (see
    // the long comment above): this promise never rejects (errors are swallowed inside
    // `maybeFlush`), so this can't throw — it only guarantees ordering.
    if (flushInFlight) await flushInFlight

    // Emitted before the terminal write/return below so it always lands before run-manager.ts's
    // 'done' frame — that frame is only pushed to the buffer once this function's returned
    // promise settles (see PublicRunManager.start()'s `params.body(...)` await). Skipped
    // entirely (no event, no patch key below) if the engine never sent a usage chunk at all —
    // e.g. the run was aborted before the stream's final chunk arrived — rather than
    // emitting/persisting a fabricated zeroed placeholder.
    if (finalUsage !== undefined) await emit({ event: 'usage', data: finalUsage })

    const aborted = signal.aborted
    const status = aborted ? 'aborted' as const : errorMessage ? 'failed' as const : 'complete' as const
    await d.chatStore.updateMessage(scope, messageId, {
      content: reply.content,
      reasoning: reply.reasoning,
      toolCalls: reply.toolCalls,
      status,
      ...buildUsagePatch(finalUsage),
    }).catch(() => {
      // Best-effort: the run's own status (PublicRunManager) is authoritative for the caller
      // regardless of whether this write lands — a version conflict here (e.g. a concurrent
      // edit) must never mask the real outcome of the generation itself.
    })

    if (aborted) return { status: 'aborted' }
    if (errorMessage) throw new Error(errorMessage)
    return { status: 'complete' }
  }
}

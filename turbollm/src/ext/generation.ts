// turbollm/src/ext/generation.ts
//
// The production generation body for the public API's send/stream route (spec 27 §5, §6, §8).
// `routes.runs.ts` only knows the injected `RunDeps.makeBody` seam; this file is the one place
// that wires it to a real engine call. It is NOT independently unit-tested (there is no model to
// test against in this task) — its contract is exercised only through the interface routes.runs.ts
// depends on, per the route tests (which inject a fake `makeBody`). It must compile cleanly and
// match the design below.
//
// ── Why this does NOT call chat-routes.ts's runGeneration() ────────────────────────────────────
// The brief's own Step 4 sketch assumes `runGeneration` is an importable, reusable core. Three
// confirmed facts about the real function rule that out, not just as a style preference:
//
//  1. COMPILE BLOCKER: `runGeneration` and its `GenerationCtx` type are both unexported (private
//     to chat-routes.ts). There is nothing to import.
//  2. DATA LOSS for any real deployment: `runGeneration`'s terminal persistence
//     (`db.updateMessage(assistantMsg.id, ...)`, `db.touchConversation`, the `db.getMessage(...)!`
//     that builds its own 'done' payload) all write straight to `d.db` — the LOCAL
//     ConversationStore — with NO awareness of `d.chatStore` at all. `d.chatStore` only serves
//     'local' tenant chats from that same handle; every other tenant is served either by a
//     `not_supported` error (default config, no adapter — see chat/store/load-adapter.ts:
//     `kind:'sqlite'` resolves the adapter to `null`) or, in any real multi-tenant deployment, by
//     a genuinely separate adapter store. Either way `assistantMsg.id` (a public ChatMessage id)
//     was never written into `d.db`'s tables, so `db.updateMessage` silently affects 0 rows and
//     the public assistant message would never leave status:'streaming'. This is the exact same
//     shape of trap the task brief already flagged for `d.db.getConversation()` — just on the
//     WRITE side, and not something a synthetic `ctx` can route around, since it's hardcoded
//     inside runGeneration's own body.
//  3. HANG risk: runGeneration's one call to `executeToolCallWithApproval` hardcodes
//     `interactive: true` unconditionally — there is no ctx field that reaches it. Every tool
//     defaults to 'ask' policy unless explicitly configured (tools/tool-policy.ts's own doc
//     comment), so routing a public run through it would, by default, hang forever on the first
//     tool call waiting on `waitForToolApproval` (tools/approval-gate.ts has no timeout) — an
//     approval endpoint no external caller can ever reach.
//
// This is exactly the problem routines/chat-runner.ts already solved for a different detached
// caller (Chat Routines), and its own header comment says as much: "NOT a reuse of
// chat-routes.ts's runGeneration(): that function is hard-coupled to a live Hono SSE
// StreamHandle... and has no live client to stream to here." That file built its own loop
// instead of forcing a fit into the shared one; this file follows the same precedent, adding
// real SSE streaming (chat-runner.ts's own loop is deliberately non-streaming — "nobody is
// watching deltas live" — which does not hold for the public API's live SSE/JSON modes).
//
// Tool execution reuses `executeToolCallWithApproval` (tools/execute-with-approval.ts) directly
// — the exact function chat-runner.ts already reuses for the identical non-interactive-caller
// problem — with `interactive: false` and an empty `agentAllowedTools`. An 'ask'-policy tool
// resolves as an instant "Blocked" deny in that branch, never a wait (spec 27 §5.1: "public runs
// execute allow-policy tools only; anything resolving to ask is treated as deny").
import type { Deps } from '../deps.js'
import type { EmitSink } from '../chat/emit-sink.js'
import type { ChatStore } from '../chat/store/chat-store.js'
import type { Chat, ChatMessage, Scope } from '../chat/store/types.js'
import type { RunDeps } from './routes.runs.js'
import { withCurrentDate } from '../chat/chat-routes.js'
import { engineModelAlias } from '../engines/compat.js'
import { clampMaxTokens } from '../config/config.js'
import { executeToolCallWithApproval } from '../tools/execute-with-approval.js'
import { initParseState, feedChunk, flushState, type ParseState } from '../chat/parser.js'

/** Mirrors chat-routes.ts's own MAX_TOOL_ITER / chat-runner.ts's identical constant — a
 *  ceiling, not a target. Ordinary chats finish in 1 round; this only bounds a runaway loop. */
const MAX_TOOL_ITER = 16
/** Per-page size when walking chat history (see `loadFullHistory`). This is NOT a cap on how
 *  much history is sent to the engine — `SqliteChatStore.listMessages` internally clamps any
 *  requested `limit` to 200 regardless (`clampLimit` in sqlite-chat-store.ts), so raising this
 *  number would do nothing; `loadFullHistory` pages past it instead. Overridable for tests. */
const DEFAULT_PAGE_SIZE = 200
/** Guards a misbehaving adapter (`hasMore` stuck `true` forever) from looping without bound —
 *  1000 pages at the max real page size is 200,000 messages, far beyond any realistic chat. */
const MAX_PAGES = 1000

interface WireMessage { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }

interface ToolCallRecord { id: string; name: string; args: Record<string, unknown>; result?: string; error?: string }

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
 *  (see file header, point 2). Intentionally thin: the public `Chat` type has no fields for the
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
 *  (there is no per-chat toggle in the public API). */
export function buildGenerationCtx(chat: Chat, engineHistory: ChatMessage[]): GenerationCtx {
  const engineMessages: WireMessage[] = []
  if (chat.systemPrompt) engineMessages.push({ role: 'system', content: withCurrentDate(chat.systemPrompt) })
  for (const m of engineHistory) {
    const content = (m.role === 'assistant' && m.reasoning?.trim())
      ? `<think>\n${m.reasoning}\n</think>\n\n${m.content}`
      : m.content
    engineMessages.push({ role: m.role, content })
  }
  return { chat, engineMessages }
}

const SAMPLING_KEYS: Record<string, string> = {
  temp: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p',
  presencePenalty: 'presence_penalty', frequencyPenalty: 'frequency_penalty',
}

/** Same camelCase → engine snake_case mapping chat-routes.ts's runGeneration applies to
 *  `conv.sampling`, applied here to the public `Chat.sampling` passthrough field. */
function mapSampling(sampling: Record<string, unknown>, repeatPenaltyKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(SAMPLING_KEYS)) {
    if (camel in sampling) out[snake] = sampling[camel]
  }
  if ('repeatPenalty' in sampling) out[repeatPenaltyKey] = sampling.repeatPenalty
  for (const [k, v] of Object.entries(sampling)) {
    if (!(k in SAMPLING_KEYS) && k !== 'repeatPenalty' && k !== 'stop') out[k] = v
  }
  return out
}

/** Periodic mid-stream checkpoint thresholds (spec 27 §4.7, C2 fix): flush whichever comes
 *  first — roughly every ~500ms of wall-clock time since the last successful flush, or roughly
 *  every ~256 new characters of content+reasoning accumulated since the last flush. Exported so
 *  the decision itself is directly unit-testable without a live engine (see generation.test.ts;
 *  this file's own header comment explains why a full live-streaming test isn't feasible here). */
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

/** Pure "is this chunk's usage worth capturing" check, mirroring chat-routes.ts's own
 *  `if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage` (final-review Critical
 *  finding: that line's equivalent never existed in this file's loop at all). The engine's final
 *  per-round SSE chunk — the one `stream_options: { include_usage: true }` on the outbound
 *  request asks for — carries a real `usage` object alongside an EMPTY `choices` array, so this
 *  must be checked before/independent of the `if (!choices?.length) continue` gate below; that
 *  gate is exactly what silently discarded it before this fix. Returns the raw object unchanged
 *  — no field renaming, no derived fields — because that IS the real wire shape the engine
 *  sends, per chat-routes.ts's own identical, untransformed capture. Exported so the decision is
 *  directly unit-testable without a live engine. */
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

interface LoopHooks {
  onDelta: (text: string) => void
  onReasoning: (text: string) => void
  onError: (message: string) => void
  onToolCall: (tc: ToolCallRecord) => void
  onUsage: (usage: Record<string, unknown>) => void
}

/** Drives the engine for one turn, including any tool-call rounds, streaming deltas/reasoning
 *  out via `emit` as they arrive and reporting the final outcome via `hooks`. Never throws for an
 *  engine-side failure (mirrors runGeneration's own contract of "swallow, emit 'error',
 *  finish") — `hooks.onError` is the sole failure signal, so the caller decides what a failure
 *  means for the run's terminal status. Only a genuinely unexpected exception outside the
 *  fetch/stream handling would propagate. */
async function runGenerationLoop(d: Deps, ctx: GenerationCtx, emit: EmitSink, signal: AbortSignal, hooks: LoopHooks): Promise<void> {
  const ms = d.manager.status()
  const target = d.manager.target()
  if (ms.state !== 'running' || !ms.model || !target) {
    hooks.onError('No model loaded.')
    return
  }
  const loadedModel = ms.model

  const engineKind = d.registry.active()?.kind ?? ''
  // BUG-006 (chat-routes.ts): vLLM/SGLang/mlx-vlm require the OpenAI-spec `repetition_penalty`
  // name, not llama.cpp's `repeat_penalty`. Same mapping, same reason.
  const repeatPenaltyKey = (engineKind === 'vllm' || engineKind === 'sglang' || engineKind === 'mlx-vlm') ? 'repetition_penalty' : 'repeat_penalty'
  const sampling = ctx.chat.sampling ?? {}
  const samplingOverride = mapSampling(sampling, repeatPenaltyKey)
  const stopStrings = Array.isArray(sampling.stop) ? sampling.stop as string[] : undefined
  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0

  // vLLM is strict about a `tools` array defaulting tool_choice to "auto" unless launched with
  // --enable-auto-tool-choice (chat-routes.ts's own BUG note) — same engine-kind gate here.
  const toolDefs = d.tools ? await d.tools.buildToolDefinitions() : []
  const toolsSupported = engineKind !== 'vllm' && engineKind !== 'sglang' && toolDefs.length > 0

  const messages: WireMessage[] = ctx.engineMessages.map((m) => ({ role: m.role, content: m.content }))

  let iter = 0
  let finishedCleanly = false
  while (iter < MAX_TOOL_ITER) {
    iter++
    if (signal.aborted) return

    const reqBody: Record<string, unknown> = {
      model: engineModelAlias(engineKind, d.manager.currentOpts()?.modelPath) ?? loadedModel.key,
      messages, stream: true, stream_options: { include_usage: true },
      ...samplingOverride,
    }
    if (stopStrings?.length) reqBody.stop = stopStrings
    const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
    if (cappedMax != null) reqBody.max_tokens = cappedMax
    else delete reqBody.max_tokens
    if (toolsSupported) reqBody.tools = toolDefs

    let res: Response
    try {
      res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal,
        duplex: 'half',
      })
    } catch (e) {
      if (signal.aborted) return
      hooks.onError(`Engine request failed: ${(e as Error).message}`)
      return
    }
    if (!res.ok || !res.body) {
      hooks.onError(`Engine returned ${res.status}`)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let roundContent = ''
    let finishReason = ''
    const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()
    // Per-round parse state (reset each round, matching chat-routes.ts's own convention) for
    // stripping inline reasoning markup — `<think>...</think>` and the gpt-oss
    // `<|channel|>analysis...<|end|>` format — out of plain `content` and re-routing it into
    // `reasoning`. Models/engines that emit reasoning via the dedicated `reasoning_content`/
    // `reasoning` delta field (handled separately below) never touch this; this only matters
    // for engines that inline reasoning into `content` instead.
    let parseState: ParseState = initParseState()

    const cancelReader = () => void reader.cancel()
    if (signal.aborted) cancelReader()
    else signal.addEventListener('abort', cancelReader, { once: true })

    try {
      readLoop: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break readLoop

          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }

          // Must run BEFORE the `choices?.length` gate below — see extractChunkUsage's own
          // comment for why the usage chunk would otherwise be silently discarded there.
          const usage = extractChunkUsage(chunk)
          if (usage) hooks.onUsage(usage)

          const choices = chunk.choices as Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
            finish_reason?: string
          }> | undefined
          if (!choices?.length) continue

          if (choices[0].finish_reason) finishReason = choices[0].finish_reason
          const delta = choices[0].delta ?? {}

          if (delta.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              if (!pendingToolCalls.has(tc.index)) pendingToolCalls.set(tc.index, { id: '', name: '', argsBuffer: '' })
              const entry = pendingToolCalls.get(tc.index)!
              if (tc.id && !entry.id) entry.id = tc.id
              if (tc.function?.name && !entry.name) entry.name = tc.function.name
              if (tc.function?.arguments) entry.argsBuffer += tc.function.arguments
            }
            continue
          }

          const rc = delta.reasoning_content ?? delta.reasoning
          if (rc) {
            hooks.onReasoning(rc)
            await emit({ event: 'reasoning', data: { delta: rc } })
            continue
          }

          const rawContent = delta.content ?? ''
          if (rawContent) {
            const { state: nextState, events: parseEvents } = feedChunk(parseState, rawContent)
            parseState = nextState
            for (const ev of parseEvents) {
              if (ev.type === 'reasoning') {
                hooks.onReasoning(ev.text)
                await emit({ event: 'reasoning', data: { delta: ev.text } })
              } else {
                roundContent += ev.text
                hooks.onDelta(ev.text)
                await emit({ event: 'delta', data: { delta: ev.text } })
              }
            }
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', cancelReader)
    }

    // Flush any remaining lookahead buffer at end-of-stream (e.g. a partial `<think>` tag
    // that never got a chance to resolve because the round ended mid-buffer) — mirrors
    // chat-routes.ts's identical end-of-round flush.
    for (const ev of flushState(parseState)) {
      if (ev.type === 'reasoning') {
        hooks.onReasoning(ev.text)
        await emit({ event: 'reasoning', data: { delta: ev.text } })
      } else {
        roundContent += ev.text
        hooks.onDelta(ev.text)
        await emit({ event: 'delta', data: { delta: ev.text } })
      }
    }

    if (signal.aborted) return

    if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && d.tools) {
      const calls = [...pendingToolCalls.values()]
      messages.push({
        role: 'assistant',
        content: roundContent || null,
        tool_calls: calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argsBuffer } })),
      })

      for (const tc of calls) {
        let args: Record<string, unknown>
        try { args = JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown> } catch { args = {} }

        // Public runs execute allow-policy tools only (spec 27 §5.1). `interactive: false` +
        // an empty `agentAllowedTools` means an 'ask'-policy tool (the default for anything not
        // explicitly configured — tool-policy.ts) resolves as an instant "Blocked" deny inside
        // executeToolCallWithApproval, never a wait on `waitForToolApproval` — there is no
        // interactive approval endpoint an external caller could ever reach.
        const approved = await executeToolCallWithApproval({
          tools: d.tools,
          sink: emit,
          convId: ctx.chat.id,
          id: tc.id,
          name: tc.name,
          args,
          globalPolicies: d.store.snapshot().tools.toolPolicies ?? {},
          convOverrides: {}, // public chats carry no per-conversation override machinery (§5.1)
          autoAllowAll: d.store.snapshot().tools.autoAllowAll ?? false,
          signal,
          interactive: false,
          agentAllowedTools: [],
          isCodeAuthorized: false, // no HTTP request to authorize against here (§5.1) — fail closed
        })
        hooks.onToolCall({ id: tc.id, name: tc.name, args, result: approved.error ? undefined : approved.result, error: approved.error })
        messages.push({ role: 'tool', content: approved.result, tool_call_id: tc.id })
      }
      continue
    }

    finishedCleanly = true
    break
  }

  if (!finishedCleanly && !signal.aborted) {
    hooks.onError(`Exceeded the ${MAX_TOOL_ITER}-round tool-call ceiling without finishing.`)
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
    let finalContent = ''
    let finalReasoning = ''
    const toolCalls: ToolCallRecord[] = []
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
    // Event-driven rather than a literal `setInterval`: content only ever changes inside the
    // onDelta/onReasoning/onToolCall hooks below, so checking at those call sites (using a real
    // `Date.now()` elapsed-time comparison, not a token/event count) is exactly as timely as a
    // background timer would be — and there is no timer handle to leak or clean up on any exit
    // path (normal completion, an engine error, or an aborted signal all just stop calling the
    // hooks, so the checks simply stop happening; nothing to clearInterval). The extracted
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
      const charsSinceLastFlush = finalContent.length + finalReasoning.length - lastFlushChars
      const toolCallsSinceLastFlush = toolCalls.length - lastFlushToolCalls
      if (charsSinceLastFlush <= 0 && toolCallsSinceLastFlush <= 0) return // nothing new to persist
      if (!force && !shouldFlushCheckpoint(Date.now() - lastFlushAt, charsSinceLastFlush)) return

      lastFlushAt = Date.now()
      lastFlushChars = finalContent.length + finalReasoning.length
      lastFlushToolCalls = toolCalls.length
      flushInFlight = d.chatStore.updateMessage(scope, messageId, {
        content: finalContent,
        reasoning: finalReasoning,
        toolCalls,
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
      const ctx = buildGenerationCtx(chat, engineHistory)

      release = d.gate ? await d.gate.acquire('bg', { signal }) : null
      d.manager.generationStart()
      try {
        await runGenerationLoop(d, ctx, emit, signal, {
          onDelta: (t) => { finalContent += t; maybeFlush() },
          onReasoning: (t) => { finalReasoning += t; maybeFlush() },
          onError: (m) => { errorMessage = m },
          onToolCall: (tc) => { toolCalls.push(tc); maybeFlush(true) },
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
      content: finalContent,
      reasoning: finalReasoning,
      toolCalls,
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

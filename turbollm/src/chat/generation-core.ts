// turbollm/src/chat/generation-core.ts
//
// The ONE chat generation loop (scalability tier 5, item 5.6; ADR-112 rejected forking it): engine call(s), the
// agentic tool loop, reasoning and <think> parsing, the BUG-001 extra pass, the Research persona's confidence loop,
// and the turn's stats, behind three ports so every caller gets the same loop and every engine quirk is patched once:
//
//  - PERSISTENCE (GenerationPersistence): where the reply lands. The core never touches `d.db` (the conversation store is the adapter's, reached only through these ports, save_skill's
//    GenerationPorts.onSaveSkill included): the chat route's
//    adapter writes the turn's placeholder row in the local ConversationStore; a caller with another store (the
//    public API's chatStore) supplies its own port. ext/generation.ts's header (PERSISTENCE) is the bug that prevents.
//  - SINK (EmitSink, emit-sink.ts): where the events go, wrapped in resilientSink so a failing sink never costs output.
//  - APPROVAL POLICY (ApprovalPolicy): what an 'ask'-policy tool does — wait for a human (interactive: a live chat
//    turn) or be answered at once (a caller with nobody to ask, whose agentAllowedTools stand in for the approval) —
//    plus the caller's code authorization and MCP refusals, all passed through to executeToolCallWithApproval.
//
// Engine shaping lives here too, so no caller can skip it: the thread sampling under each engine's names (vLLM/SGLang/
// mlx-vlm's repetition_penalty), the Settings max-token cap (clampMaxTokens), thinking budget / reasoning effort /
// preserve_thinking fields, LiteRT-LM's tools, sampling and Research notes; callChatUpstream then shapes the finished
// body for the local engine (shapeForEngine) and the upstream carries the engine's model alias (resolveChatUpstream:
// engineModelAlias). The prompt itself (system prompt with withCurrentDate, history) is the caller's to build.
import type { Deps } from '../deps'
import { clampMaxTokens, getModelProfile } from '../config/config'
import { feedChunk, flushState, initParseState, type ParseState } from './parser'
import { needsExtraPass } from './think-utils'
import type { ReasoningEffort } from './reasoning-effort'
import type { EmitSink } from './emit-sink.js'
import type { EngineMessage } from './chat-compaction.js'
import type { ClaimVerdict, Conversation, MessageStats, ResearchMeta, ResearchSource, ToolCallRecord } from './db'
import { checkReply } from '../tools/research-referee.js'
import { executeToolCallWithApproval, newApprovalWaitBudget } from '../tools/execute-with-approval'
import { buildSaveSkillTool } from '../agents/agent-tools'
import { SkillStore } from '../agents/skills'
import { SKILL_AUTHORING_REFUSED } from '../agents/skill-jobs'
import { emitBenchResult } from '../telemetry/runtime/typed-emit'
import { buildBenchResultConfig } from '../telemetry/events/perf'
import { shouldEmitBenchResult, benchRateLimitKey, MIN_GEN_TOKENS_FOR_BENCH } from '../telemetry/runtime/bench-rate-limit'
import { resolveProfile, type LoadProfile } from '../models/profile'
import type { ModelInfo } from '../engines/manager'
import { litertLmPrefillStats } from '../engines/litert-lm'
import { engineErrorReason, engineErrorText, streamChunkError } from '../engines/engine-error'
import { engineWithholdsTools } from '../engines/compat'
import { LITERT_LM_RESEARCH_NOTE, litertLmIgnoredFieldsNote, litertLmSamplingNote, litertLmToolsFor } from '../engines/litert-lm-request'
import { getSysInfo } from '../sysinfo/sysinfo'
import { noteLocalActivity } from '../link/host-idle'
import { callChatUpstream, type ChatUpstream } from './chat-upstream'
import { servingEngine, servingEngineKind } from '../engines/serving'

/** Said once per turn when the in-app SDK engine is sent none of the turn's tools (ADR-447 point 7). */
const SDK_TOOLS_WITHHELD_NOTE = 'The in-app engine does not run tools, so the tools were not sent.'

/** The reply as it stands mid-turn: what a progress save writes. */
export interface ReplySnapshot {
  content: string
  reasoning: string
  toolCalls: ToolCallRecord[]
}

/** What changed in the reply, for a progress save at every change (GenerationPersistence.progressCadence). */
export type ReplyChange = 'text' | 'toolCall'

/** The reply as the turn ends: the one terminal write. */
export interface FinalReply extends ReplySnapshot {
  stats: Partial<MessageStats>
  researchMeta: ResearchMeta | undefined
}

/** Where the turn's reply lands. The core calls nothing else to persist, and never `d.db`. */
export interface GenerationPersistence {
  /** Saves the reply so far, every PARTIAL_SAVE_MS while it changes (and whenever trackProgressSave's caller asks), or
   *  at every change with `progressCadence` 'everyChange', told then what changed. Best-effort: a throw or rejection is
   *  swallowed, as the terminal write writes it all. */
  saveProgress(reply: ReplySnapshot, change?: ReplyChange): void | Promise<void>
  /** 'everyChange': saveProgress is called at each change to the reply as it happens (each streamed text or reasoning
   *  piece, each settled tool call), for a caller that keeps its own cadence (the public API checkpoints every ~500 ms
   *  or ~256 characters, and at once on a tool call); the PARTIAL_SAVE_MS timer does not run. Unset: the timer. */
  progressCadence?: 'everyChange'
  /** Hands the turn's progress save to whoever must be able to run it before the process goes (a daemon stop's
   *  flush, ChatTurns.addReplySave); returns its removal, called once as the turn ends. Optional. */
  trackProgressSave?(save: () => void): () => void
  /** The engine refused the turn before it produced anything: put back what this turn set aside, if anything. True
   *  when the turn's reply is gone with it, so there is nothing to finalize. Must not throw (a throw reads as false). */
  restoreUnproduced(): boolean
  /** Persists a tool round once all its calls have settled, before the next request (a routine's run appends one
   *  message per round). A round handed over is the caller's: the progress saves and the terminal write carry only
   *  what came after it. Optional: the live chat keeps the whole reply in its one row. */
  appendToolRound?(round: ToolRound): void | Promise<void>
  /** The one terminal write: persist the finished reply and return the message the 'done' event carries. */
  finalize(reply: FinalReply): unknown | Promise<unknown>
}

/** What an 'ask'-policy tool call does, and what the caller may do on the host. Passed through to
 *  executeToolCallWithApproval for every tool call; `refuseMcp` also leaves MCP tools out of what the model is offered,
 *  and `isCodeAuthorized` also gates the save_skill tool. */
export interface ApprovalPolicy {
  /** true: a human can answer (the call waits for its approval); false: an 'ask' is blocked at once unless listed in
   *  agentAllowedTools. */
  interactive: boolean
  agentAllowedTools?: string[]
  isCodeAuthorized: boolean
  refuseMcp?: boolean
  refuseMcpAgentsAndRoutines?: boolean
  /** The conversation's own tool overrides, read on every call. */
  convOverrides(): Record<string, 'allow' | 'deny'>
  /** Interactive only: how long the reply waits for its answers, read as each call reaches the gate. */
  approvalWaitMinutes?(): number
  /** Interactive only: told true as a call starts waiting for its answer and false as the wait ends. */
  onApprovalWait?(waiting: boolean): void
}

/** The conversation fields the loop reads. */
export type GenerationConversation = Pick<Conversation, 'id' | 'sampling'> &
  Partial<Pick<Conversation, 'skillIds' | 'allowedTools' | 'toolPolicy' | 'preserveThinking'>>

/** A message of the turn's history; a prior round's tool calls and results keep their pairing fields. */
export type GenerationMessage = EngineMessage & { tool_calls?: unknown; tool_call_id?: string }

/** How a caller with nobody watching runs the loop (a routine's run). Every field unset is the live chat's behavior. */
export interface LoopOptions {
  /** 'json': one non-streaming completion per round, its text taken as the engine gives it (no <think> parsing, no
   *  deltas, no progress). Unset: the streamed turn. */
  transport?: 'json'
  /** The most tool rounds the turn runs, each one's calls run; past it the turn ends `exceeded`. Unset: the live
   *  chat's MAX_TOOL_ITER + 1 requests, the last one's calls ignored. */
  toolRoundCeiling?: number
  /** false: no BUG-001 extra pass for an empty answer; the answer is what it is. */
  extraPass?: false
  /** false: the turn writes nothing into this machine's ledgers: the owner's activity (Turbo Link's wake gate), the
   *  engine's in-flight counter and live readout, its completion stats, the bench result or the request log. The
   *  caller keeps its own accounting (a routine's gate hold and Manager.hold, routines/execute.ts). */
  ledgers?: false
  /** true: the tools go to vLLM and SGLang too, which the live chat withholds there. */
  toolsOnEveryEngine?: true
  /** false: a stop does not keep a round's remaining calls from running; the turn still ends before its next request. */
  stopBetweenToolCalls?: false
  /** false: the streamed request does not ask for prompt progress (`return_progress`), as the public API's never has. */
  returnProgress?: false
  /** false: a tool call the model is still streaming is not announced as pending; the caller gets only the call's own
   *  events as it runs (the public API's event stream). */
  announceToolCalls?: false
  /** 'ignore': an error chunk inside a 200 stream is read past rather than failing the turn (the public API's run,
   *  which never read them). */
  streamErrors?: 'ignore'
  /** 'asStreamed': the reply is exactly what the sink was sent. A round its stop ends with a quiet end of the read
   *  streams what the parser still held back before the turn ends; a round a throw cuts short (a stop's AbortError,
   *  an engine that died) keeps none of it. Unset: what was held back is kept in the reply unsent (GitHub #177), which
   *  the live chat's refetch reads. */
  interruptedTail?: 'asStreamed'
}

/** One turn to generate. */
export interface GenerationTurn {
  convId: string
  conv: GenerationConversation
  engineMessages: GenerationMessage[]
  /** Where this turn generates — the local engine, or a linked host (chat-upstream.ts). `upstream.remote` is the
   *  single test for "another machine did the work", which every local ledger below branches on. */
  upstream: ChatUpstream
  ac: AbortController
  /** Reasoning token budget: -1 = unlimited, 0 = thinking off, N>0 = a sampler-enforced cap. */
  thinkingBudget: number
  reasoningEffort: ReasoningEffort | undefined
  loop?: LoopOptions
  /** The caller's sampling already in the engine's names, and its stop strings: the public API's (ext/generation.ts
   *  mapSampling, which drops every key that steers the request). Sent UNDER the request's own fields, so no key of
   *  it can replace the model, the messages or the stream fields. Unset: conv.sampling, mapped here and sent over
   *  them, as the live chat always has. */
  engineSampling?: { fields: Record<string, unknown>; stop: string[] | undefined }
}

/** A tool call of the round, before it runs. */
export interface PendingToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** A tool call that has its result: the result string as the model reads it, an error included. */
export interface SettledToolCall extends PendingToolCall {
  result: string
}

/** A round's text and the calls of it settled so far. */
export interface ToolRound {
  content: string
  calls: SettledToolCall[]
}

/** What the caller's beforeToolCall makes of a call: run it, answer it with `block` without running it, or end the
 *  turn where it stands with `stop` (nothing more runs and nothing is finalized; the outcome carries it). */
export type ToolCallVerdict<S> = 'run' | { block: string } | { stop: S }

export interface GenerationPorts<S = never> {
  persistence: GenerationPersistence
  sink: EmitSink
  approval: ApprovalPolicy
  /** Runs once the engine is done with the turn, however it ended, before the terminal write (the chat route frees
   *  the conversation's in-flight slot here). */
  onSettled?(): void
  /** The caller's say over each tool call before the approval policy's (a routine's loop breaker and its stall on a
   *  tool its agent does not list). `round` is the call's round so far. Unset: every call goes to the approval policy.
   *  Set, a round's calls reach it even with no tool registry (Deps.tools, absent in tests only), as a routine's stall
   *  does not depend on one; a call it lets run is then answered "Error: no tool registry available.". */
  beforeToolCall?(call: PendingToolCall, round: ToolRound): ToolCallVerdict<S>
  /** Told of every `usage` object the engine sends, as it sends it (the public API reports the last one raw). */
  onUsage?(usage: unknown): void
  /** Starts writing a skill from this conversation (the save_skill tool of the 'skill-creator' skill); returns the job's id,
   *  or null when there is nothing to save. Only the chat adapter supplies it, as it alone may read the conversation
   *  store: without it save_skill is not offered. */
  onSaveSkill?(): string | null
}

/** Why a turn the engine did not finish failed: the engine refused it (`http`, with its reason when it gave one) or
 *  reported an error (`engine`), or the request or its reading threw (`thrown`; `request` when the request itself
 *  threw, so the engine never answered). */
export type GenerationFailure =
  | { kind: 'http'; status: number; reason: string | undefined }
  | { kind: 'engine'; message: string }
  | { kind: 'thrown'; message: string; request?: true }

/** How the turn ended, for what its caller does next (a chat turn's title and memory). */
export interface GenerationOutcome<S = never> {
  /** The turn produced nothing and the persistence port put back what it set aside: nothing was finalized. */
  restored: boolean
  aborted: boolean
  content: string
  /** Set only when the engine failed the turn. */
  failure?: GenerationFailure
  /** Set only when beforeToolCall stopped the turn: its `stop`. */
  stopped?: S
  /** Set only when the turn ran out of LoopOptions.toolRoundCeiling rounds without an answer. */
  exceeded?: true
}

/**
 * Streams an assistant turn with optional agentic tool-calling loop. Posts to the
 * engine, relays delta/reasoning/progress/tool_call SSE events, parses inline <think>
 * tags, executes tool calls and loops (up to MAX_TOOL_ITER rounds), and persists the final
 * message + stats through the persistence port. Shared by every caller of the generation loop.
 */
export async function runGenerationCore<S = never>(d: Deps, turn: GenerationTurn, ports: GenerationPorts<S>): Promise<GenerationOutcome<S>> {
  const { persistence, approval } = ports
  const { convId, conv, upstream, ac, thinkingBudget, reasoningEffort } = turn
  const loop = turn.loop ?? {}
  const jsonTransport = loop.transport === 'json'
  const ledgers = loop.ledgers !== false
  // GitHub #177: never let a write to a torn-down stream unwind past the persistence write
  // below. See resilientSink's doc comment — this is the invariant, not the individual
  // try/catch at the two emit sites that happened to have one.
  const emit = resilientSink(ports.sink)
  // A remote turn ran on ANOTHER machine: nothing below may write its numbers into this
  // one's engine state. Same rule the gateway's own remote branch follows (I-4) — the
  // peer's engine card must not read "Generating…" for work its engine is not doing, and
  // `hostIdleState` reads sessionStats().activeRequests, so a false busy here would block a
  // third machine's legitimate wake.
  const localAccounting = ledgers && !upstream.remote

  // The engine serving THIS upstream: a routine's pool slot names its own, which is not the primary's. A remote
  // upstream names none and reads the primary's, as it always has (the host shapes for its own engine).
  const engineKind = upstream.engineKind ?? servingEngineKind(d)
  // The caller's own mapped sampling (GenerationTurn.engineSampling), or the conversation's, mapped here.
  let samplingOverride: Record<string, unknown> = {}
  let stopStrings: string[] | undefined
  if (turn.engineSampling) {
    samplingOverride = turn.engineSampling.fields
    stopStrings = turn.engineSampling.stop
  } else {
    // Map conversation sampling overrides (camelCase) to the engine's snake_case names.
    const convS = conv.sampling ?? {}
    // BUG-006: vLLM and SGLang reject `repeat_penalty` (the llama.cpp name) and require
    // `repetition_penalty` — the OpenAI-spec name. mlx-vlm's request schema (server/schemas.py)
    // only declares `repetition_penalty` too — `repeat_penalty` isn't rejected (the schema
    // allows extra fields) but is silently ignored, a no-op. Map per engine kind. LiteRT-LM keeps
    // `repeat_penalty`: the Repeat penalty is llama.cpp's, and the Android app's server applies that
    // name as llama.cpp does, over the last 64 tokens (`repetition_penalty` over the whole reply);
    // `serve` reads neither, which litertLmIgnoredFieldsNote says.
    const repeatPenaltyKey =
      (engineKind === 'vllm' || engineKind === 'sglang' || engineKind === 'mlx-vlm') ? 'repetition_penalty' : 'repeat_penalty'
    const SAMPLING_KEYS: Record<string, string> = {
      temp: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p',
      repeatPenalty: repeatPenaltyKey, presencePenalty: 'presence_penalty',
      frequencyPenalty: 'frequency_penalty',
    }
    for (const [camel, snake] of Object.entries(SAMPLING_KEYS)) {
      if (camel in convS) samplingOverride[snake] = convS[camel]
    }
    for (const [k, v] of Object.entries(convS)) {
      if (!(k in SAMPLING_KEYS) && k !== 'stop') samplingOverride[k] = v
    }
    stopStrings = convS.stop as string[] | undefined
  }

  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0
  const shaping: RequestShaping = {
    upstream, samplingOverride, stopStrings, maxLimit, thinkingBudget, reasoningEffort, preserveThinking: conv.preserveThinking, jsonTransport,
    samplingUnder: turn.engineSampling !== undefined, returnProgress: loop.returnProgress !== false,
  }
  /** LoopOptions.interruptedTail 'asStreamed': the reply is what the sink was sent. */
  const replyAsStreamed = loop.interruptedTail === 'asStreamed'

  // ── Agentic tool loop ──────────────────────────────────────────────────────
  // engineMessages is extended each round with tool results. Start from ctx copy
  // so the original array is never mutated (continue endpoint reuses it).
  // A prior round's tool calls and results keep their pairing (a resumed routine replays them).
  const iterMessages: GenerationMessage[] = turn.engineMessages.map((m) => ({
    role: m.role, content: m.content,
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }))

  // Skills enabled for this conversation (the shared SKILL.md library, picked via
  // Thread settings or the '/' picker): inject their instructions into the system
  // prompt. No-op for a plain chat with no skills enabled — byte-identical to today.
  const enabledSkillIds = new Set(conv.skillIds ?? [])
  if (enabledSkillIds.size > 0) {
    const enabledSkills = new SkillStore(d.store.dir()).list().filter((s) => enabledSkillIds.has(s.id))
    if (enabledSkills.length) {
      // Full instructions, formatting intact — a real skill's procedure can run to
      // several KB and a 300-char preview was silently dropping nearly all of it.
      // MAX_SKILL_INSTRUCTIONS_CHARS is a safety cap against a pathological file,
      // not an everyday limit (real skills should always fit under it whole).
      const MAX_SKILL_INSTRUCTIONS_CHARS = 20_000
      const skillSys = 'Skills enabled for this chat (apply the relevant ones):\n\n' +
        enabledSkills.map((s) => `## ${s.name}\n${s.description}\n\n${s.instructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS_CHARS)}`).join('\n\n---\n\n')
      const sysIdx = iterMessages.findIndex((m) => m.role === 'system')
      if (sysIdx >= 0) {
        const existing = typeof iterMessages[sysIdx].content === 'string' ? iterMessages[sysIdx].content : ''
        iterMessages[sysIdx] = { ...iterMessages[sysIdx], content: `${skillSys}\n\n${existing}`.trim() }
      } else {
        iterMessages.unshift({ role: 'system', content: skillSys })
      }
    }
  }

  // Search budget for a force_web_search turn. The Research persona plans 3–5 targeted
  // queries; at 3 the model got exactly ONE discretionary search (iterations 1–2 are
  // tool_choice-forced) and the confidence re-loop below had no room left to fire at all,
  // so the advertised strategy was not executable. 6 = 5 planned + at least one
  // confidence-driven refinement (ADR-230: quality over latency). SINGLE SOURCE OF TRUTH —
  // the instruction text the model is told and the guard the code enforces must never
  // disagree again, so both read this constant.
  const MAX_SEARCH_CALLS = 6
  // Bounds how many times a low-confidence answer may be folded back for refinement. The
  // re-loop does not force a tool call, so a model that keeps answering without searching
  // would otherwise never advance searchCallCount and would spin until MAX_TOOL_ITER.
  const MAX_CONFIDENCE_RETRIES = 2

  // F-021: inject confidence-loop instruction into Research persona system prompt.
  // Appends to the existing system message (or inserts one if absent).
  const CONFIDENCE_INSTRUCTION =
    `\n\nAfter reviewing the search results, include a confidence assessment on a line by itself before your final answer: \`[confidence: 0.XX]\` where XX is your confidence (0.0–1.0) that your answer is accurate and current. If your confidence is below 0.8, call web_search again with a more specific query first. Maximum ${MAX_SEARCH_CALLS} search calls per response.`
  if (conv.toolPolicy === 'force_web_search') {
    const sysIdx = iterMessages.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      const existing = typeof iterMessages[sysIdx].content === 'string' ? iterMessages[sysIdx].content : ''
      iterMessages[sysIdx] = { ...iterMessages[sysIdx], content: existing + CONFIDENCE_INSTRUCTION }
    } else {
      iterMessages.unshift({ role: 'system', content: CONFIDENCE_INSTRUCTION.trim() })
    }
  }

  // Outer ceiling on tool rounds. Worst case for a research turn that actually uses its
  // budget: 6 web_search rounds + up to 6 fetch_url/MCP rounds (the persona tells the model
  // to fetch_url any authoritative-looking result whose excerpt is thin) + 3 answer-
  // composition rounds (initial + MAX_CONFIDENCE_RETRIES refinements) = 15. 16 leaves one
  // round of headroom so a legitimate investigation is never truncated mid-flight. This is
  // a ceiling, not a target — ordinary chats still finish in 1–2 rounds and are unaffected.
  const MAX_TOOL_ITER = 16
  let toolIter = 0
  /** LoopOptions.toolRoundCeiling: the caller's own ceiling, every round of it run. */
  const roundCeiling = loop.toolRoundCeiling
  /** The loop stopped asking because it had its answer (or nothing more to do), not because it ran out of rounds. */
  let ended = false
  /** beforeToolCall's stop, once it ended the turn. */
  let stop: { value: S } | undefined
  let failure: GenerationFailure | undefined
  /** An engine request is in flight, not yet answered: a throw now is the request's own (GenerationFailure.request). */
  let requesting = false
  let exceeded = false
  /** The reply's wait for its tool-call approvals, shared by all its calls (ApprovalWaitBudget). */
  const approvalWait = newApprovalWaitBudget()
  /** Number of web_search tool calls made this turn (caps the confidence re-loop). */
  let searchCallCount = 0
  /** Confidence-driven refinement passes taken this turn (capped at MAX_CONFIDENCE_RETRIES). */
  let confidenceRetries = 0
  /** Accumulated ResearchResult[] from all web_search calls this turn (F-021). */
  const allResearchSources: ResearchSource[] = []
  /** Confidence score parsed from model output (F-021); undefined for non-research turns. */
  let parsedConfidence: number | undefined

  // Accumulated across all tool iterations for persistence
  let fullContent = ''
  let fullReasoning = ''
  const allToolCalls: ToolCallRecord[] = []

  // Stats from the final (non-tool) round
  const requestStart = Date.now()
  let ttftMs = 0
  let thinkStart = 0
  let thinkEnd = 0
  let finalUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } = {}
  let finalTimings: Record<string, number> = {}
  let aborted = false
  // Distinct from `aborted`: a thrown, non-AbortError exception mid-stream (e.g. the
  // engine process died) is neither a success nor a user-initiated cancellation.
  // `aborted` alone can't tell the two apart (both leave AbortError-only checks
  // false/true respectively), and first_chat needs the real three-way split.
  let engineFailed = false
  let liveOut = 0
  /** The live round's parser state, or null once its end-of-stream flush has already run.
   *  GitHub #177: the streaming parser legitimately withholds up to 29 characters as lookahead
   *  (it cannot know yet whether they are the start of a `<|channel|>analysis…` tag), and that
   *  tail is only released by `flushState` at end-of-stream. An abort or an engine death THROWS
   *  out of the round loop before that flush ever runs, so every short interrupted reply — the
   *  common case when a user hits Stop early — had its text dropped on the floor even though the
   *  model really did produce it. Held here so the finalizer below can drain it. */
  let pendingParse: ParseState | null = null
  /** GitHub #52 item 9: the authoritative prompt-token count only arrives at the END of a round
   *  (`usage.prompt_tokens` / `timings.prompt_n`), so a mid-stream abort leaves it at 0 — the UI
   *  renders "0+147 tokens" and `ctxUsed` understates context by the entire prompt even though
   *  those prompt tokens really are sitting in the KV cache. The engine streams `prompt_progress`
   *  chunks WHILE it ingests the prompt (`{ processed, total }`, surfaced to the client as the
   *  `progress` event), and that `total` IS the prompt size — the same number `prompt_tokens`
   *  would have reported. Remember the last one seen and use it as the fallback. This is a
   *  measured value from the engine, never an invented one: it stays 0 when the engine sends no
   *  progress at all (e.g. `return_progress` unsupported), which is exactly today's behavior. */
  let lastPromptTotal = 0

  /** The engine or a linked host can still refuse a turn after it started: an HTTP error (a 503 while a model
   *  loads, a host that unloaded it), a fetch that throws (a host asleep since its last probe, an engine that died), an
   *  error chunk in the stream. When the turn produced nothing (no text, reasoning or tool call, nothing still held back
   *  by the parser), the persistence port may put back what the turn set aside (a Regenerate's old reply, a Save &
   *  Resend's old question: GenerationPersistence.restoreUnproduced), before the error is sent, so the client's refetch
   *  on it already sees it back. Never throws: the catch below calls it, where nothing may. */
  let restored = false
  const restoreReplaced = (): boolean => {
    if (fullContent || fullReasoning || allToolCalls.length > 0 || pendingParse?.buf) return false
    try {
      return persistence.restoreUnproduced()
    } catch {
      return false // the turn ends as before, its empty reply shown
    }
  }

  // In-app chat is the owner using their own machine — the signal Turbo Link's wake
  // gate reads to refuse a peer's model swap (link/host-idle.ts). The gateway records
  // the terminal-agent paths; this is the only local path that never goes through it.
  // Still local activity even for a remote turn: the OWNER of this machine is at the
  // keyboard, which is exactly what the wake ledger records.
  if (ledgers) noteLocalActivity()
  if (localAccounting) d.manager.generationStart()
  // The reply's text so far (and its reasoning and finished tool calls) is saved into its placeholder every
  // PARTIAL_SAVE_MS while the turn runs, when it changed. It was written only at the end of the turn, so a daemon
  // or Android process killed mid-reply lost everything it had streamed, and the restart reconcile then marked an
  // empty reply stopped. The stats stay the placeholder's `{"aborted":false}` until the end-of-turn save below,
  // which is what tells that reconcile (db.ts abortUnfinishedReplies) the reply never finished.
  const saveProgress = (change?: ReplyChange) => {
    try {
      const saved = persistence.saveProgress({ content: fullContent, reasoning: fullReasoning, toolCalls: allToolCalls }, change)
      if (saved instanceof Promise) saved.catch(() => {})
    } catch { /* best-effort: the end-of-turn save writes it all */ }
  }
  let partial = { content: '', reasoning: '', toolCalls: 0 }
  const savePartial = () => {
    if (fullContent === partial.content && fullReasoning === partial.reasoning && allToolCalls.length === partial.toolCalls) return
    partial = { content: fullContent, reasoning: fullReasoning, toolCalls: allToolCalls.length }
    saveProgress()
  }
  // A caller with its own cadence (GenerationPersistence.progressCadence) is told of each change instead.
  const everyChange = persistence.progressCadence === 'everyChange'
  const replyChanged = (change: ReplyChange) => { if (everyChange) saveProgress(change) }
  const partialSaves = everyChange ? undefined : setInterval(savePartial, PARTIAL_SAVE_MS)
  partialSaves?.unref?.()
  const untrackPartialSave = persistence.trackProgressSave?.(savePartial)
  try {
    // Get tool definitions once (or empty for engines that don't support tools)
    // MCP server tools are left out (and refused below) for a caller that may not act on the host (the approval
    // policy's refuseMcp; for a chat turn, !isCodeAuthorized, the same isLocalRequest || real-key decision as adding
    // an MCP server).
    const baseToolDefs = d.tools ? await d.tools.buildToolDefinitions({ forGeneration: true, refuseMcp: approval.refuseMcp ?? false }) : []
    // 'skill-creator' grants save_skill — the one tool a skill can add beyond the base
    // registry (every other skill is instructions text only). No-op unless enabled.
    // save_skill writes to the shared skill library, as POST /api/v1/skills and the Save as skill
    // route do, and both refuse a caller isLocalOrAuthenticated fails. isCodeAuthorized is that
    // same decision for this turn's caller (isLocalRequest || a real key), so a turn without it
    // is not offered save_skill, and a call the model makes anyway is refused here, before the
    // skill author starts (the tool skips the approval gate, so this is the only check).
    const skillTools = enabledSkillIds.has('skill-creator') && ports.onSaveSkill
      ? buildSaveSkillTool(() => {
          if (!approval.isCodeAuthorized) return `Error: ${SKILL_AUTHORING_REFUSED}`
          // In-chat skill author: read THIS conversation in the background and write a
          // SKILL.md to the shared library.
          const tid = ports.onSaveSkill?.()
          return tid
            ? 'Started writing a skill from this conversation in the background. It will appear in the skill library shortly.'
            : 'There is nothing to turn into a skill yet.'
        })
      : undefined
    // Custom chat Agent tool allow-list (Customize → Agents), baked in at conversation
    // creation. Undefined (never set) = unrestricted — every untouched built-in persona's
    // conversations take this branch, so their tool list is byte-identical to before this
    // feature. An EXPLICIT empty array is different from unset, though — it means a
    // built-in deliberately fixed its tool list to none (e.g. the Blank persona: "raw model
    // output, no instructions injected" has to mean no tool-calling preamble too, not just
    // an empty system prompt — GitHub #52) — so it must actually filter down to zero tools,
    // not fall through to unrestricted the way a merely-absent list does.
    // Applied ONLY to the base (built-in + MCP) registry: skill-granted tools like
    // save_skill are never enumerated by /api/v1/tools (they only exist once their
    // skill is enabled), so they can never appear in the allow-list checklist — gating
    // them a second time here would silently strip save_skill from any agent that has
    // 'skill-creator' enabled. Enabling the skill IS the allow decision for its tools.
    const scopedBaseToolDefs = conv.allowedTools !== undefined
      ? baseToolDefs.filter((t) => conv.allowedTools!.includes(t.function.name))
      : baseToolDefs
    const toolDefs = skillTools && approval.isCodeAuthorized ? [...scopedBaseToolDefs, ...skillTools.defs] : scopedBaseToolDefs
    // This machine's LiteRT-LM engine and the model it serves (a Turbo Link host shapes for its own engine).
    const localLitert = engineKind === 'litert-lm' && !upstream.remote
    const litertModel = localLitert ? d.scanner?.get?.(upstream.libraryKey ?? d.manager.status?.().model?.key ?? '') : undefined
    /** A note for the user about this turn, once per turn: the chat shows it (ChatScreen's 'notice'). */
    const notes = new Set<string>()
    const noteOnce = async (message: string): Promise<void> => {
      if (notes.has(message)) return
      notes.add(message)
      await emit({ event: 'notice', data: { message } })
    }

    rounds: while (roundCeiling === undefined ? toolIter <= MAX_TOOL_ITER : toolIter < roundCeiling) {
      toolIter++
      // A stop between rounds ends the turn before its next request, whether or not the round's calls heeded it
      // (LoopOptions.stopBetweenToolCalls).
      ac.signal.throwIfAborted()

      const reqBody = buildEngineRequest(shaping, iterMessages)
      // Attach tools only to engines whose OpenAI server accepts a `tools` array as
      // passthrough. vLLM is strict: a `tools` array (which defaults tool_choice to
      // "auto") is REJECTED with HTTP 400 — "auto tool choice requires
      // --enable-auto-tool-choice and --tool-call-parser to be set" — unless the
      // server was launched with those flags (which we don't, and no built-in parser
      // matches Gemma's tool format). Sending tools there breaks ALL vLLM chat, so we
      // skip them. llama.cpp/forks accept them; mlx-lm ignores them harmlessly. mlx-vlm
      // also accepts them without erroring, but whether a tool call actually comes back
      // depends on the loaded model's chat template matching one of mlx-vlm's built-in
      // tool parsers (see the MLX-VLM catalog note) — not a crash risk, just a
      // per-architecture no-op some of the time.
      // A local LiteRT-LM model gets them when it calls tools and they fit (litertLmToolsFor), and the
      // user is told when it gets none. They were withheld from every LiteRT-LM model (PR #271, before
      // its servers took them), so the thread's tools, MCP and skill tools and the Research persona's
      // web_search never reached LFM2.5, Qwen3 or Gemma 4, whose templates show them to the model.
      // A temperature or top_p a LiteRT-LM model ignores (no sampler of its own: greedy without a top_k) is said.
      const samplingNote = localLitert ? litertLmSamplingNote(reqBody) : undefined
      if (samplingNote) await noteOnce(samplingNote)
      // So is a setting the server does not apply (Min P; on `serve`, stop strings and penalties). The request's own
      // sampling is the thread's (samplingOverride), so a Min P it sets is named as the thread's.
      const ignoredNote = localLitert ? litertLmIgnoredFieldsNote(reqBody, { fromThread: true }) : undefined
      if (ignoredNote) await noteOnce(ignoredNote)
      let roundTools = toolDefs
      if (localLitert && toolDefs.length > 0) {
        const pick = litertLmToolsFor(litertModel, toolDefs, iterMessages, upstream.ctxMax)
        roundTools = pick.tools
        if (pick.note) await noteOnce(pick.note)
      }
      // The in-app SDK engine refuses a request's tools (ADR-447 point 7), so a local turn there goes without them, on
      // every engine-facing path (chat, routine, public API), and the turn says so once. A turn to a Turbo Link host
      // keeps them: the host's engine runs them, whatever this machine's engine is (G-6).
      const localWithholdsTools = engineWithholdsTools(engineKind) && !upstream.remote
      if (localWithholdsTools && roundTools.length > 0) await noteOnce(SDK_TOOLS_WITHHELD_NOTE)
      const toolsSupported = (loop.toolsOnEveryEngine || (engineKind !== 'vllm' && engineKind !== 'sglang')) && !localWithholdsTools && roundTools.length > 0
      if (toolsSupported) reqBody.tools = roundTools
      // Force web_search on the first two iterations when the conversation has a
      // force_web_search policy (e.g. Research persona). This guarantees at least
      // two distinct searches before the model composes its answer. Iteration 3+
      // use "auto" so the model can continue searching or finish as it sees fit.
      // Not on LiteRT-LM: `serve` ignores tool_choice and the Android server refuses a forced call it
      // cannot honour, so its model chooses, and the user is told.
      if (
        toolsSupported &&
        conv.toolPolicy === 'force_web_search' &&
        toolIter <= 2 &&
        roundTools.some((t) => t.function.name === 'web_search')
      ) {
        if (localLitert) await noteOnce(LITERT_LM_RESEARCH_NOTE)
        else reqBody.tool_choice = { type: 'function', function: { name: 'web_search' } }
      }

      requesting = true
      const res = await callChatUpstream(upstream, reqBody, ac.signal, undefined, ledgers ? d : undefined)
      requesting = false

      if (!res.ok || !res.body) {
        // The engine's own reason, from its body or (LiteRT-LM) its status line, says far more than the status code.
        let reason = await engineErrorReason(res)
        if (reason) reason = engineErrorText(d, engineKind, reason)
        // Thrown, not returned: the catch below sends it as engine_error, puts back a Regenerate's
        // or a Save & Resend's old turn when this one produced nothing (restoreReplaced), and
        // otherwise falls through to the one save. A return here skipped that save, so a later tool
        // round refused this way (its request past n_ctx with round 1's tool result in it, a 503
        // after a model swap, a linked host's host_busy) lost round 1's text, reasoning and tool
        // calls, all already streamed, and left the reply empty.
        throw new EngineStreamError(reason ? `Engine returned ${res.status}: ${reason}` : `Engine returned ${res.status}`, { status: res.status, reason: reason || undefined })
      }

      // Per-round state
      let roundContent = ''
      let finishReason = ''
      // Accumulate streaming tool_calls by index (OpenAI format: fragmented across chunks)
      const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()

      if (jsonTransport) {
        // Reading the reply is still the request's: a body that is not JSON is the engine's, not the run's own.
        requesting = true
        const completion = await readCompletion(res)
        requesting = false
        if (completion.usage) {
          finalUsage = completion.usage
          ports.onUsage?.(completion.usage)
        }
        roundContent = completion.content
        fullContent += completion.content
        replyChanged('text')
        for (const [i, tc] of completion.toolCalls.entries()) pendingToolCalls.set(i, tc)
      } else {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''

        // `.catch()` is load-bearing (GitHub #177): on abort, the fetch layer ERRORS the body
        // stream first (undici rejects the pending read with AbortError), and cancelling an
        // already-errored stream returns a REJECTED promise. Bare `void reader.cancel()` left that
        // floating — an unhandled rejection, i.e. a daemon crash mid-generation, which loses the
        // turn's output the same way the unguarded emits did.
        const cancelReader = () => { void reader.cancel().catch(() => {}) }
        if (ac.signal.aborted) {
          cancelReader()
        } else {
          ac.signal.addEventListener('abort', cancelReader, { once: true })
        }

        let parseState = initParseState()
        pendingParse = parseState
        // Indices we've already told the UI about (so the long tool-arg generation that
        // follows the model's text shows an inline "running…" step instead of looking frozen).
        const announcedToolCalls = new Set<number>()

        roundLoop: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') break roundLoop

            let chunk: Record<string, unknown>
            try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
            const engineError = loop.streamErrors === 'ignore' ? undefined : streamChunkError(chunk)
            if (engineError) {
              // Nothing more is read from this stream: hang up so the engine stops, and drop the abort hook with it.
              ac.signal.removeEventListener('abort', cancelReader)
              cancelReader()
              throw new EngineStreamError(engineErrorText(d, engineKind, engineError))
            }

            // Prompt progress
            const pp = chunk.prompt_progress as { processed?: number; total?: number; tps?: number } | undefined
            if (pp && pp.total) {
              // #52 item 9: the only prompt-token number that exists before the round ends.
              lastPromptTotal = pp.total
              const pct = Math.round((pp.processed ?? 0) / pp.total * 100)
              if (localAccounting) d.manager.setLiveGen({ phase: 'prompt', pct, outputTokens: 0 })
              await emit({ event: 'progress', data: { phase: 'prompt', processed: pp.processed, total: pp.total, pct, tps: pp.tps ?? 0 } })
              continue
            }

            if (chunk.usage) {
              finalUsage = chunk.usage as typeof finalUsage
              ports.onUsage?.(chunk.usage)
            }
            if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings

            const choices = chunk.choices as Array<{
              delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
              finish_reason?: string
            }> | undefined
            if (!choices?.length) continue

            if (choices[0].finish_reason) finishReason = choices[0].finish_reason
            const delta = choices[0].delta ?? {}

            // Accumulate streaming tool_call fragments (OpenAI: id+name only in first chunk,
            // arguments fragment across all chunks for that index).
            if (delta.tool_calls?.length) {
              for (const tc of delta.tool_calls) {
                if (!pendingToolCalls.has(tc.index)) {
                  pendingToolCalls.set(tc.index, { id: '', name: '', argsBuffer: '' })
                }
                const entry = pendingToolCalls.get(tc.index)!
                if (tc.id && !entry.id) entry.id = tc.id
                if (tc.function?.name && !entry.name) entry.name = tc.function.name
                if (tc.function?.arguments) entry.argsBuffer += tc.function.arguments
                // The moment we know which tool this is, surface it as pending — the model
                // may stream a long argument body next, and silence there reads as a freeze.
                if (loop.announceToolCalls !== false && entry.id && entry.name && !announcedToolCalls.has(tc.index)) {
                  announcedToolCalls.add(tc.index)
                  await emit({ event: 'tool_call', data: { id: entry.id, name: entry.name, args: {}, status: 'pending' } })
                }
              }
              continue
            }

            // Reasoning content — llama-server uses `reasoning_content`, mlx-lm uses `reasoning`.
            const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
            if (rc) {
              if (!thinkStart) thinkStart = Date.now()
              thinkEnd = Date.now()
              fullReasoning += rc
              replyChanged('text')
              await emit({ event: 'reasoning', data: { delta: rc } })
              continue
            }

            const raw_content = delta.content ?? ''
            if (!raw_content) continue

            const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
            parseState = nextState
            pendingParse = parseState
            for (const ev of parseEvents) {
              if (ev.type === 'reasoning') {
                if (!thinkStart) thinkStart = Date.now()
                thinkEnd = Date.now()
                fullReasoning += ev.text
                replyChanged('text')
                await emit({ event: 'reasoning', data: { delta: ev.text } })
              } else {
                fullContent += ev.text
                roundContent += ev.text
                if (!ttftMs) ttftMs = Date.now() - requestStart
                liveOut++
                if (localAccounting) d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: liveOut })
                replyChanged('text')
                await emit({ event: 'delta', data: { delta: ev.text } })
              }
            }
          }
        }
        ac.signal.removeEventListener('abort', cancelReader)
        // A Stop does not always reach this loop as an AbortError: with the request log on (the default)
        // the turn reads one branch of a tee'd body (callChatUpstream), and cancelling it on abort ENDS the
        // pending read (done: true) instead; Node 18's fetch body (the Android app's runtime) does the same
        // with the log off. Read as the end of the round, a stopped reply was saved as finished (title,
        // memory and bench result included) and a tool call it was streaming still ran, one set to Allow
        // without asking. Thrown as the abort it is, before the flush below, so the catch and the drain
        // after it handle it as they handle an AbortError — or, for a reply kept as streamed
        // (LoopOptions.interruptedTail), right after the flush has streamed what the parser held back.
        if (!replyAsStreamed) ac.signal.throwIfAborted()

        // Flush lookahead buffer at end-of-stream. Clearing `pendingParse` first is what stops the
        // interrupted-turn drain after the try/catch from flushing this same buffer a SECOND time
        // (flushState is pure — it does not consume the buffer it reads).
        pendingParse = null
        for (const ev of flushState(parseState)) {
          if (ev.type === 'reasoning') {
            fullReasoning += ev.text
            replyChanged('text')
            await emit({ event: 'reasoning', data: { delta: ev.text } })
          } else {
            fullContent += ev.text
            roundContent += ev.text
            replyChanged('text')
            await emit({ event: 'delta', data: { delta: ev.text } })
          }
        }
        if (replyAsStreamed) ac.signal.throwIfAborted()
      }

      // ── Tool call execution ──────────────────────────────────────────────
      // A caller with a say over each call (beforeToolCall) gets every call, a registry or not (see there).
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && (d.tools || ports.beforeToolCall) && toolIter <= (roundCeiling ?? MAX_TOOL_ITER)) {
        const roundToolCalls = Array.from(pendingToolCalls.values())

        // Add the assistant message (with tool_calls) to iterMessages for the next round
        iterMessages.push({
          role: 'assistant',
          content: roundContent || null,
          tool_calls: roundToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsBuffer },
          })),
        })

        /** The round's calls settled so far, as the model reads their results. */
        const settled: SettledToolCall[] = []
        for (const tc of roundToolCalls) {
          // No call starts once the turn is stopped. A tool that does not honour the abort (fetch_url,
          // run_code, MCP) runs to its end when Stop comes during it, and the round's next call then
          // started after the Stop, a tool set to Allow included.
          if (loop.stopBetweenToolCalls !== false) ac.signal.throwIfAborted()
          let parsedArgs: Record<string, unknown>
          try { parsedArgs = JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown> }
          catch { parsedArgs = {} }

          // The caller's say comes first (GenerationPorts.beforeToolCall): a stop ends the turn here, a block
          // answers the call without running it.
          const verdict = ports.beforeToolCall?.({ id: tc.id, name: tc.name, args: parsedArgs }, { content: roundContent, calls: [...settled] }) ?? 'run'
          if (verdict !== 'run' && 'stop' in verdict) {
            stop = { value: verdict.stop }
            break rounds
          }
          const blocked = verdict === 'run' ? undefined : verdict.block

          // save_skill (from the 'skill-creator' skill) is pre-authorized by the user
          // having enabled that skill for this chat, so it bypasses the approval gate
          // and routes straight to its own executor. Everything else (normal chat
          // tools) still goes through the real approval gate below.
          const isSkillTool = skillTools?.names.has(tc.name) ?? false
          // The agent's allow-list (conv.allowedTools, scopedBaseToolDefs above) decides what may
          // RUN, not only what the model is offered: a model can name any tool, offered or not
          // (small models do hallucinate tool names), and the approval gate below ran such a call
          // whenever its policy allowed it, so an agent fixed to web_search still ran run_code or
          // an MCP tool. A base tool the list leaves out is answered as executeTool answers one
          // that does not exist. Skill tools are never on the list (see scopedBaseToolDefs).
          const unlisted = !isSkillTool && conv.allowedTools !== undefined && !conv.allowedTools.includes(tc.name)

          let result: string
          let callError: string | undefined

          if (blocked !== undefined) {
            result = blocked
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: 'done', result },
            })
          } else if (unlisted) {
            result = `Error: unknown tool "${tc.name}"`
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: 'done', result },
            })
          } else if (isSkillTool && skillTools) {
            // Emit pending event so the frontend can show "calling..."
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: 'pending' },
            })
            try {
              result = skillTools.execute({ id: tc.id, name: tc.name, args: parsedArgs })
            } catch (e) {
              callError = (e as Error).message
              result = `Error: ${callError}`
            }
            await emit({
              event: 'tool_call',
              data: { id: tc.id, name: tc.name, args: parsedArgs, status: callError ? 'error' : 'done', result },
            })
          } else if (!d.tools) {
            // Reached only with beforeToolCall: a call it lets run has nothing to run on.
            result = 'Error: no tool registry available.'
          } else {
            // The approval policy port decides what an 'ask'-policy tool does. Live foreground chat is interactive:
            // it prompts the user via 'tool_call'/'awaiting_approval' and waits for POST
            // .../tool-calls/:toolCallId/approve to resolve it. A caller with nobody to ask is not: the call is
            // answered at once as blocked, unless its agentAllowedTools stand in for the approval.
            const approved = await executeToolCallWithApproval({
              tools: d.tools,
              sink: (ev) => emit({ event: ev.event, data: ev.data }),
              convId,
              id: tc.id,
              name: tc.name,
              args: parsedArgs,
              globalPolicies: d.store.snapshot().tools.toolPolicies ?? {},
              // Read fresh on every call (ApprovalPolicy.convOverrides): a same-turn repeat call sees an "Allow for this chat" just made.
              convOverrides: approval.convOverrides(),
              autoAllowAll: d.store.snapshot().tools.autoAllowAll ?? false,
              signal: ac.signal,
              interactive: approval.interactive,
              agentAllowedTools: approval.agentAllowedTools,
              approvalWaitMinutes: approval.approvalWaitMinutes?.(),
              approvalBudget: approvalWait,
              onApprovalWait: approval.onApprovalWait,
              isCodeAuthorized: approval.isCodeAuthorized,
              refuseMcp: approval.refuseMcp,
              refuseMcpAgentsAndRoutines: approval.refuseMcpAgentsAndRoutines,
            })
            result = approved.result
            callError = approved.error
          }

          // F-021: track web_search calls and accumulate research sources.
          if (tc.name === 'web_search' && !callError && !unlisted && blocked === undefined) {
            searchCallCount++
            // The result string embeds the structured data; also ask the registry
            // for the raw ResearchResult[] via a direct research call on the same
            // args (zero extra network cost — the registry already called it).
            // We parse what we can from the result string as a fallback.
            try {
              // Re-parse sources from result text: each [N] block has Domain/Relevance line.
              // LOCKSTEP: this regex must track the exact line emitted by execWebSearch in
              // tools/builtin.ts — if they drift, every source silently vanishes from the UI
              // and from the persisted message. `Published`/`Retrieved` were appended after
              // `Freshness`, so both trailing groups are optional and this parses the pre-date
              // format too. m[7] = published label, m[8] = retrieval date, m[9] = passage.
              const sourceMatches = [...result.matchAll(/\[(\d+)\] (.+?)\nSource: (\S+)\nDomain: (\S+) \| Relevance: ([\d.]+) \| Freshness: (\w+)(?: \| Published: ([^|\n]*?))?(?: \| Retrieved: ([\d-]+))?\nKey passage: ([\s\S]+?)(?=\n\[|\s*$)/g)]
              for (const m of sourceMatches) {
                allResearchSources.push({
                  title: m[2].trim(),
                  url: m[3].trim(),
                  domain: m[4].trim(),
                  relevanceScore: parseFloat(m[5]),
                  freshnessSignal: (m[6].trim() as 'recent' | 'dated' | 'unknown'),
                  passage: m[9].trim(),
                })
              }
            } catch { /* parsing is best-effort */ }
          }

          allToolCalls.push({ id: tc.id, name: tc.name, args: parsedArgs, result: callError ? undefined : result, error: callError })
          replyChanged('toolCall')

          // Inject tool result into iterMessages
          iterMessages.push({ role: 'tool', content: result, tool_call_id: tc.id })
          settled.push({ id: tc.id, name: tc.name, args: parsedArgs, result })
        }

        if (persistence.appendToolRound) {
          await persistence.appendToolRound({ content: roundContent, calls: settled })
          // The round is the caller's now (GenerationPersistence.appendToolRound): the reply is what follows it.
          fullContent = ''
          fullReasoning = ''
          allToolCalls.length = 0
        }
        // Continue to next round
        continue
      }

      // ── F-021: Confidence loop (no tool calls — model gave final answer) ─────
      // For Research persona: parse [confidence: 0.XX] from accumulated content,
      // strip it from visible reply, and trigger another search pass if < 0.8
      // and search budget allows (max MAX_SEARCH_CALLS web_search calls per turn).
      if (conv.toolPolicy === 'force_web_search' && fullContent && d.tools) {
        const confMatch = fullContent.match(/\[confidence:\s*([\d.]+)\]/i)
        if (confMatch) {
          const conf = parseFloat(confMatch[1])
          parsedConfidence = conf
          // Strip confidence marker from visible content regardless
          fullContent = fullContent.replace(/\[confidence:\s*[\d.]+\]\s*/gi, '').trim()

          if (conf < 0.8 && searchCallCount < MAX_SEARCH_CALLS && confidenceRetries < MAX_CONFIDENCE_RETRIES) {
            confidenceRetries++
            console.log(`[chat] F-021: confidence ${conf} < 0.8 (searches: ${searchCallCount}/${MAX_SEARCH_CALLS}, retry ${confidenceRetries}/${MAX_CONFIDENCE_RETRIES}) — re-entering search loop`)
            const toolDefs2 = await d.tools.buildToolDefinitions()
            if (toolDefs2.some((t) => t.function.name === 'web_search')) {
              // Fold the low-confidence answer back and ask the model to refine
              iterMessages.push({ role: 'assistant', content: fullContent })
              iterMessages.push({
                role: 'user',
                content: `Your confidence is ${conf}. Please search again with a more specific query to improve accuracy, then provide a revised answer with an updated [confidence: X.XX] line.`,
              })
              fullContent = ''
              continue
            }
          }
        }
      }

      // No tool calls (or tools not available) — done
      ended = true
      break
    }
    exceeded = roundCeiling !== undefined && !ended && !stop

    // ── BUG-001: Qwen3 empty-reply guard ──────────────────────────────────────
    // Thinking models sometimes produce ONLY <think>…</think> tokens in their
    // final pass after tool results, leaving visible content empty. Detect this
    // and make one extra inference pass with tool_choice:'none' so the model is
    // forced to emit a text answer.
    console.log(`[chat] tool loop finished after ${toolIter} iteration(s); visible content length: ${fullContent.trim().length}`)
    if (!stop && loop.extraPass !== false && needsExtraPass(fullContent)) {
      console.log('[chat] BUG-001: final content is empty after stripping think blocks — making extra pass with tool_choice:none')
      iterMessages.push({ role: 'user', content: 'Please now write your final answer based on what you found.' })
      // Streamed whatever the turn's transport: this pass reads a stream.
      const reqBody = buildEngineRequest({ ...shaping, jsonTransport: false }, iterMessages, 'none')

      requesting = true
      const res = await callChatUpstream(upstream, reqBody, ac.signal, undefined, ledgers ? d : undefined)
      requesting = false

      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        // `.catch()` is load-bearing (GitHub #177) — see the identical guard in the main round
        // loop above: on abort the fetch layer errors the body stream first, and cancelling an
        // already-errored stream returns a REJECTED promise, which bare `void` left floating.
        const cancelReader = () => { void reader.cancel().catch(() => {}) }
        if (ac.signal.aborted) {
          cancelReader()
        } else {
          ac.signal.addEventListener('abort', cancelReader, { once: true })
        }

        let parseState = initParseState()
        pendingParse = parseState
        roundLoop: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') break roundLoop
            let chunk: Record<string, unknown>
            try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
            const engineError = loop.streamErrors === 'ignore' ? undefined : streamChunkError(chunk)
            if (engineError) {
              // Nothing more is read from this stream: hang up so the engine stops, and drop the abort hook with it.
              ac.signal.removeEventListener('abort', cancelReader)
              cancelReader()
              throw new EngineStreamError(engineErrorText(d, engineKind, engineError))
            }
            if (chunk.usage) {
              finalUsage = chunk.usage as typeof finalUsage
              ports.onUsage?.(chunk.usage)
            }
            if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings
            // #52 item 9: the extra pass re-sends the whole conversation, so ITS prompt is the
            // one occupying context when it is interrupted. Captured (not emitted — this pass
            // has never streamed progress to the client and this fix does not change that).
            const pp2 = chunk.prompt_progress as { total?: number } | undefined
            if (pp2?.total) lastPromptTotal = pp2.total
            const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> | undefined
            if (!choices?.length) continue
            const delta = choices[0].delta ?? {}
            const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
            if (rc) {
              fullReasoning += rc
              replyChanged('text')
              await emit({ event: 'reasoning', data: { delta: rc } })
              continue
            }
            const raw_content = delta.content ?? ''
            if (!raw_content) continue
            const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
            parseState = nextState
            pendingParse = parseState
            for (const ev of parseEvents) {
              if (ev.type === 'reasoning') {
                fullReasoning += ev.text
                replyChanged('text')
                await emit({ event: 'reasoning', data: { delta: ev.text } })
              } else {
                fullContent += ev.text
                if (!ttftMs) ttftMs = Date.now() - requestStart
                liveOut++
                if (localAccounting) d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: liveOut })
                replyChanged('text')
                await emit({ event: 'delta', data: { delta: ev.text } })
              }
            }
          }
        }
        ac.signal.removeEventListener('abort', cancelReader)
        if (!replyAsStreamed) ac.signal.throwIfAborted() // a quiet end on Stop, as in the round loop above
        pendingParse = null
        for (const ev of flushState(parseState)) {
          if (ev.type === 'reasoning') {
            fullReasoning += ev.text
            replyChanged('text')
            await emit({ event: 'reasoning', data: { delta: ev.text } })
          } else {
            fullContent += ev.text
            replyChanged('text')
            await emit({ event: 'delta', data: { delta: ev.text } })
          }
        }
        if (replyAsStreamed) ac.signal.throwIfAborted()
      }
    }
  } catch (e: unknown) {
    // Whatever was thrown once the turn was stopped is the Stop's doing (a linked host's leg cut off
    // under it, a body that errors otherwise than with an AbortError): not an engine failure.
    const isAbort = (e as Error)?.name === 'AbortError' || ac.signal.aborted
    aborted = isAbort
    if (!isAbort) {
      engineFailed = true
      failure = failureOf(e, requesting)
      restored = restoreReplaced() // a Stop (isAbort) keeps what it stopped
      // Belt and braces on top of resilientSink (GitHub #177): this emit is the one that used
      // to throw INSIDE the catch block, which no `finally` can contain — the rejection escaped
      // the whole function and skipped the `db.updateMessage` below, discarding everything the
      // model had already generated. Nothing after this point may be allowed to throw.
      try {
        const code = e instanceof EngineStreamError ? 'engine_error' : 'engine_stopped'
        await emit({ event: 'error', data: { code, message: (e as Error).message } })
      } catch { /* a failing sink — the message is still persisted below */ }
    }
  } finally {
    clearInterval(partialSaves)
    untrackPartialSave?.()
    if (localAccounting) d.manager.generationEnd()
    ports.onSettled?.()
  }
  // A Stop that came after the last read (while the round's last text was being sent on) is still a
  // Stop: the reply is saved and reported as stopped, and gets no title, memory or bench result.
  if (ac.signal.aborted && !engineFailed) aborted = true
  // beforeToolCall ended the turn where it stood: nothing to finalize, title or count.
  if (stop) return { restored: false, aborted, content: fullContent, stopped: stop.value }
  // The placeholder is gone and the old reply back (restoreReplaced): nothing to fill in, title or
  // count.
  if (restored) return { restored: true, aborted, content: fullContent, ...(failure ? { failure } : {}) }

  // GitHub #177: drain whatever the parser was still holding when the round was cut short (see
  // `pendingParse`). Non-null ONLY on the interrupted paths — a round that reached its own
  // end-of-stream flush nulls it first, so this can never double-count a normal turn. A reply kept as streamed
  // (LoopOptions.interruptedTail) keeps none of it: it was never sent.
  if (pendingParse && !replyAsStreamed) {
    for (const ev of flushState(pendingParse)) {
      if (ev.type === 'reasoning') {
        fullReasoning += ev.text
      } else {
        fullContent += ev.text
        // Counted like any other streamed delta so the #52 `liveOut` token fallback below
        // doesn't report "0 tokens" for a message that plainly has content.
        liveOut++
      }
    }
    pendingParse = null
  }

  const totalMs = Date.now() - requestStart
  const thinkMs = thinkStart && thinkEnd ? thinkEnd - thinkStart : 0
  const ctxMax = upstream.ctxMax

  // An aborted turn (Stop, deleting the chat, an engine kill switch) can be cut off
  // before the engine's final usage/timings chunk ever arrives, leaving completion_tokens at its
  // default 0 — even though real output WAS generated, IS persisted (fullContent below), and WILL
  // sit in context for the next turn. liveOut (incremented per streamed delta, above) is the one
  // number we still have in that case; fall back to it instead of silently reporting "0 tokens"
  // for a message that plainly has content (GitHub #52: "when you interrupt a model's response,
  // the token count remains as 0+0, yet the model still sees the message in context, and the
  // total token count remains unchanged").
  const genTokensFallback = finalUsage.completion_tokens || liveOut
  // The prompt half of the same problem (GitHub #52 item 9). `genTokens` has had its liveOut
  // fallback for a while; `promptTokens` had none, so an interrupted turn rendered "0+147
  // tokens" and ctxUsed was short by the ENTIRE prompt — the number the next turn's context
  // budget is judged against. lastPromptTotal is the engine's own streamed prompt size (see its
  // declaration); 0 when the engine never reported one, which reproduces the old behavior
  // rather than fabricating a count.
  const promptTokensFallback = finalUsage.prompt_tokens || lastPromptTotal

  const stats: Partial<MessageStats> = {
    ttftMs,
    totalMs,
    thinkMs,
    // Full context occupancy: cache-reused prompt tokens still sit in the KV cache / context
    // window (they're skipped only for recomputation), so they must stay counted here.
    // Not for a turn that failed before the engine reported its prompt's size: a send refused
    // on its first round (400 exceed_context_size_error, a 503 while a model loads) has no
    // measurement, and the 0 it wrote became the reading maybeAutoCompact judges the next turn
    // by, so a chat refused for its size was never compacted again. With no ctxUsed the gate
    // reads the last reply that has one (lastCtxUsage).
    ...(engineFailed && !promptTokensFallback ? {} : { ctxUsed: promptTokensFallback + genTokensFallback }),
    ctxMax,
    model: upstream.modelName,
    aborted,
  }
  const fullPrompt = finalUsage.prompt_tokens ?? 0
  const cachedExplicit = finalUsage.prompt_tokens_details?.cached_tokens
  if (finalTimings.prompt_n) {
    const processed = finalTimings.prompt_n
    stats.promptTokens = fullPrompt || processed
    stats.promptMs     = finalTimings.prompt_ms
    stats.promptTps    = finalTimings.prompt_per_second
    stats.genTokens    = finalTimings.predicted_n
    stats.genMs        = finalTimings.predicted_ms
    stats.tps          = finalTimings.predicted_per_second
    stats.cachedTokens = cachedExplicit ?? Math.max(0, (fullPrompt || processed) - processed)
  } else {
    // No final timings — the interrupted/failed case. `fullPrompt` is 0 here whenever the usage
    // chunk never landed, which is precisely when the streamed prompt total has to stand in.
    stats.promptTokens = promptTokensFallback
    stats.genTokens    = genTokensFallback
    stats.genMs        = totalMs - ttftMs
    stats.tps          = stats.genMs > 0 ? Math.round((stats.genTokens / stats.genMs) * 1000 * 10) / 10 : 0
    stats.cachedTokens = cachedExplicit ?? 0
    // LiteRT-LM sends token counts but no timings, so derive prefill from TTFT. Only for a single-round turn: with tool
    // calls, `ttftMs` spans earlier rounds too and would understate the speed. Only for the LOCAL engine: a Turbo Link
    // host's engine is not this machine's, and its own stats stand.
    if (localAccounting && engineKind === 'litert-lm' && allToolCalls.length === 0) {
      const pf = litertLmPrefillStats(finalUsage.prompt_tokens, ttftMs)
      if (pf) {
        stats.promptMs = pf.promptMs
        stats.promptTps = pf.promptTps
      }
    }
  }

  // F-022: run the heuristic referee on Research persona replies before persisting.
  // Pure string/regex — synchronous, < 5ms, no IO.
  let refereeVerdicts: ClaimVerdict[] | undefined
  if (conv.toolPolicy === 'force_web_search' && fullContent && allResearchSources.length > 0) {
    try {
      refereeVerdicts = checkReply(fullContent, allResearchSources)
    } catch { /* swallow — referee is best-effort */ }
  }

  // F-021: persist research metadata alongside the message.
  const researchMeta: ResearchMeta | undefined =
    conv.toolPolicy === 'force_web_search' && (parsedConfidence !== undefined || allResearchSources.length > 0 || refereeVerdicts !== undefined)
      ? {
          confidence: parsedConfidence,
          sources: allResearchSources.length > 0 ? allResearchSources : undefined,
          refereeVerdicts: refereeVerdicts && refereeVerdicts.length > 0 ? refereeVerdicts : undefined,
        }
      : undefined

  // The one terminal write. Awaited only after the local ledgers below, which ran after it before the port existed.
  const finalized = persistence.finalize({ content: fullContent, reasoning: fullReasoning, toolCalls: allToolCalls, stats, researchMeta })
  // Both are LOCAL measurements of LOCAL hardware. A remote turn's t/s describes the
  // HOST's GPU: reporting it as a bench_result for this machine's config would poison the
  // fleet-wide bench corpus, and folding it into this manager's session averages is the
  // very contamination I-4 closed on the gateway path.
  if (localAccounting) {
    const loaded = d.manager.status().model
    if (!aborted && !engineFailed && loaded) reportChatBenchResult(d, loaded, stats)
    try {
      d.manager.recordCompletion({
        inputTokens: stats.promptTokens,
        outputTokens: stats.genTokens,
        promptTps: stats.promptTps,
        genTps: stats.tps,
      })
    } catch { /* swallow — stats are best-effort */ }
  }

  const finalMsg = await finalized
  // A sink that can fail (not the turn's run, which never does) may reject here. Swallow it —
  // the assistant message is persisted above regardless, and an unhandled rejection here would
  // crash the daemon (and orphan the engine), which is the root of the reported "requests never
  // end / model stays loaded".
  try {
    await emit({ event: 'done', data: { message: finalMsg } })
  } catch { /* a failing sink — nothing to flush to */ }

  return { restored: false, aborted, content: fullContent, ...(failure ? { failure } : {}), ...(exceeded ? { exceeded: true } : {}) }
}

/** How often a reply's text so far is saved into its placeholder while its turn runs, when it changed since the
 *  last save (runGenerationCore's partial saves). Each save is one UPDATE of the row, about 1 ms on Android's sql.js with
 *  2,000 messages (Node 18.20.4), and on Android the export it then brings about a second later (sql-js-database.ts):
 *  about 11 ms for a 5 MB database and 47 ms for 24 MB on an idle disk here, a few hundred ms under heavy I/O. Every
 *  10 s that is under 1% of the time and a few MB written per 10 s of streaming, while a kill loses at most the last
 *  10 s of a reply. */
const PARTIAL_SAVE_MS = 10_000

/** The turn-constant inputs every engine request of a turn is shaped from. */
interface RequestShaping {
  upstream: ChatUpstream
  samplingOverride: Record<string, unknown>
  stopStrings: string[] | undefined
  maxLimit: number
  thinkingBudget: number
  reasoningEffort: ReasoningEffort | undefined
  preserveThinking: boolean | undefined
  /** LoopOptions.transport 'json': a non-streaming request. */
  jsonTransport: boolean
  /** GenerationTurn.engineSampling: the sampling goes under the request's own fields, not over them. */
  samplingUnder: boolean
  /** LoopOptions.returnProgress: a streamed request asks for prompt progress. */
  returnProgress: boolean
}

/** One engine request, streamed unless `jsonTransport`: the round's messages under the thread's sampling, the Settings
 *  max-token cap (clampMaxTokens: the cap, or no max_tokens at all when neither sets one), stop strings and the
 *  thinking fields. `toolChoice` goes before the thread's sampling, which can override it, as it always has; a caller's
 *  own mapped sampling (`samplingUnder`) goes under all of them instead. */
export function buildEngineRequest(shaping: RequestShaping, messages: unknown[], toolChoice?: string): Record<string, unknown> {
  const { upstream, samplingOverride, stopStrings, maxLimit, thinkingBudget, reasoningEffort } = shaping
  const streamFields = shaping.returnProgress
    ? { stream: true, stream_options: { include_usage: true }, return_progress: true }
    : { stream: true, stream_options: { include_usage: true } }
  const requestFields: Record<string, unknown> = {
    model: upstream.modelField,
    messages,
    ...(shaping.jsonTransport ? { stream: false } : streamFields),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  }
  const reqBody: Record<string, unknown> = shaping.samplingUnder
    ? { ...samplingOverride, ...requestFields }
    : { ...requestFields, ...samplingOverride }
  if (stopStrings?.length) reqBody.stop = stopStrings
  const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
  if (cappedMax != null) reqBody.max_tokens = cappedMax
  else delete reqBody.max_tokens
  // GitHub #52: thinkingBudget (this turn) and preserveThinking (past turns) are
  // independent and can both be relevant at once, so merge rather than overwrite.
  // thinking_budget_tokens (not the unrecognized `reasoning_budget`) is the field the
  // engine's sampler actually reads — see reasoning-budget.cpp in the TurboQuant fork.
  const templateKwargs: Record<string, unknown> = {}
  if (thinkingBudget === 0) {
    reqBody.thinking_budget_tokens = 0
    templateKwargs.enable_thinking = false
  } else if (thinkingBudget > 0) {
    reqBody.thinking_budget_tokens = thinkingBudget
  }
  if (shaping.preserveThinking) templateKwargs.preserve_thinking = true
  // Independent of thinkingBudget/enable_thinking above — only sent when the caller
  // passed a value that survived parseReasoningEffort (chat-routes.ts's body parsing),
  // so a client typo or an unsupported model can never make it into a request the
  // engine's chat template would raise_exception on. 'off' is this control's own way of
  // disabling thinking (see reasoning-effort.ts) — never forwarded as literal
  // reasoning_effort:"off"; it collapses onto the exact same fields thinkingBudget===0
  // above already sets.
  if (reasoningEffort === 'off') {
    reqBody.thinking_budget_tokens = 0
    templateKwargs.enable_thinking = false
  } else if (reasoningEffort) {
    templateKwargs.reasoning_effort = reasoningEffort
  }
  if (Object.keys(templateKwargs).length) reqBody.chat_template_kwargs = templateKwargs
  return reqBody
}

/**
 * `bench_result{source:'chat'}` (spec 23 §3.7, ADR-333, founder-directed
 * 2026-08-05): a real chat reply's own measured t/s, alongside the
 * synthetic autotune sweep bench_result already sent. llama.cpp's own
 * `predicted_per_second` is measured on EVERY generation already (`stats.tps`
 * above) — this only wires it to leave the machine, subject to the same
 * rate limit and short-run floor every real-run source shares
 * (`bench-rate-limit.ts`).
 *
 * Best-effort by contract (ADR-009): a lookup miss (model swapped mid-turn,
 * scanner not yet caught up) or any other failure here must never surface
 * to the user or affect the chat response already streamed.
 */
function reportChatBenchResult(d: Deps, ms: ModelInfo, stats: Partial<MessageStats>): void {
  try {
    if (!d.telemetry?.canSend('bench_result')) return
    if (stats.tps === undefined || stats.genTokens === undefined || stats.genTokens < MIN_GEN_TOKENS_FOR_BENCH) return

    const entry = d.scanner.get(ms.key)
    const engine = servingEngine(d)
    if (!entry || !engine) return

    const cfg = d.store.snapshot()
    const saved = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
    const profile = resolveProfile(entry, getSysInfo(), saved, undefined, cfg.modelDefaults)

    const key = benchRateLimitKey(entry.key, entry.quant, profile.ctx, profile.ngl, profile.nCpuMoe, profile.kvTypeK, 'chat')
    if (!shouldEmitBenchResult(d.store.dir(), key)) return

    const config = buildBenchResultConfig(entry, profile, engine.version, getSysInfo())
    emitBenchResult(
      d.telemetry,
      {
        source: 'chat',
        model: config.model,
        engine: config.engine,
        params: config.params,
        result: { tps: stats.tps, ttftMs: stats.ttftMs ?? 0, vramMb: null, outcome: 'ok' },
      },
      config.hw,
    )
  } catch {
    // Best-effort by contract (ADR-009).
  }
}

/** Wraps an emit sink so a failing sink can never cost us generated output (GitHub #177).
 *
 *  The turn routes' sink is now the turn's run (chat-runs.ts), whose push never throws: a viewer
 *  that goes away only closes its own subscription. This stays the seam's guard for a sink that
 *  can fail, as the live SSE stream it was written for did. Every `await emit(...)` in
 *  runGeneration wrote to that stream, and writing to a torn-down stream REJECTS. Any one of those
 *  rejections used to unwind the whole function —
 *  past the single `db.updateMessage(...)` that persists `fullContent` at the end — leaving the
 *  placeholder assistant row (inserted empty, `stats: { aborted: false }`, before the first
 *  token) permanently blank with `aborted: false`. That is exactly the reporter's third bucket:
 *  rows that are empty but not flagged aborted, with the model's real output thrown away.
 *  The done-path emit was individually guarded for this reason; the error-path emit was not, and
 *  neither were the ten emits inside the streaming loops.
 *
 *  So the guard belongs on the SEAM, not on individual call sites: the first failure latches the
 *  client as gone and every later emit becomes a no-op. A dead client degrades to "keep
 *  generating, keep persisting, stop writing to the socket" instead of unwinding. Abort semantics
 *  are untouched — Stop aborts via the AbortController, which is what sets `aborted: true`; this
 *  only stops write failures from being fatal. PURE-ish and exported so the latch behaviour is
 *  pinned by tests. */
export function resilientSink(sink: EmitSink): EmitSink & { clientGone: () => boolean } {
  let gone = false
  const wrapped = async (ev: { event: string; data: unknown }): Promise<void> => {
    if (gone) return
    try {
      await sink(ev)
    } catch {
      // The sink is gone. Nothing to flush to, ever again — and an unhandled rejection here
      // would crash the daemon.
      gone = true
    }
  }
  return Object.assign(wrapped, { clientGone: () => gone })
}

/** An error the engine reported INSIDE a 200 stream, as `data: {"error": ...}`. llama-server does this when a
 *  request fails after streaming began, and LiteRT-LM does it for every runtime failure (a prompt longer than the
 *  bundle's context, for one). Such a chunk has no `choices`, so the round loop skipped it and the turn ended as an
 *  empty message with no reason given. Also thrown for a non-OK response, so that one is handled (and the turn's
 *  earlier rounds saved) by the same catch; `refusal` then carries its status and reason. */
export class EngineStreamError extends Error {
  constructor(message: string, readonly refusal?: { status: number; reason: string | undefined }) {
    super(message)
  }
}

/** What the catch makes of a thrown failure (GenerationOutcome.failure); `requesting`: it came from the request itself. */
function failureOf(e: unknown, requesting: boolean): GenerationFailure {
  if (e instanceof EngineStreamError) return e.refusal ? { kind: 'http', ...e.refusal } : { kind: 'engine', message: e.message }
  return { kind: 'thrown', message: (e as Error)?.message ?? String(e), ...(requesting ? { request: true as const } : {}) }
}

interface CompletionReply {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

/** A non-streaming completion's one message (LoopOptions.transport 'json'): its text as the engine gives it, and its
 *  tool calls in the shape the streamed round collects them in. No message at all is the engine's failure. */
async function readCompletion(res: Response): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; argsBuffer: string }>; usage: CompletionReply['usage'] }> {
  const data = await res.json() as CompletionReply
  const message = data.choices?.[0]?.message
  if (!message) throw new EngineStreamError('Engine returned no message.')
  return {
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, argsBuffer: tc.function.arguments })),
    usage: data.usage,
  }
}

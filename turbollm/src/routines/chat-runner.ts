// turbollm/src/routines/chat-runner.ts
//
// Chat-flavor Routine execution — the "detached version of the existing chat generation path"
// spec 20 §5 asks for, tracing to the Scope-A detached-generation lineage that spec cites (spec
// 20 §5's last bullet). Its tool loop is the chat's own (chat/generation-core.ts's
// runGenerationCore; ADR-112: one loop, never forked — scalability 5.6), so an engine quirk or a
// tool fix lands here with the chat's. What a routine does differently is passed in, never
// re-implemented: the core's LoopOptions (UNATTENDED_LOOP below), a persistence port that appends
// one message per round, an approval policy with nobody to ask (`interactive:false` +
// `agentAllowedTools`, executeToolCallWithApproval's background seam, unused since the old
// background agent runner, generation.ts, was deleted per ADR-163), and a beforeToolCall hook
// for ToolLoopTracker/LOOP_BREAK_AFTER/LOOP_ABORT_AFTER (runaway-guard.ts) and the stall — the
// chat's tool loop has only a round-count ceiling with no same-call loop breaker, so an
// UNATTENDED run needs this wired explicitly (there is no human to notice a stuck loop).
//
// Requests stream:false (LoopOptions.transport 'json') — nobody is watching deltas live, so one
// non-streaming completion per round is simpler and exactly as sufficient as the chat's SSE
// delta parser, for an audience of nobody.
import type { Deps } from '../deps'
import type { CustomChatAgent } from '../config/config'
import type { Routine, RoutineRun } from './schema'
import type { Conversation, Message } from '../chat/db'
import { engineModelAlias } from '../engines/compat'
import { executeToolCallWithApproval } from '../tools/execute-with-approval'
import { ToolLoopTracker, LOOP_BREAK_AFTER, LOOP_ABORT_AFTER } from './runaway-guard'
import { stallRoutineRun, type PendingRoutineToolCall } from './approval'
import { servingEngineKind } from '../engines/serving'
import { runGenerationCore, type GenerationFailure, type GenerationMessage, type GenerationOutcome, type LoopOptions, type PendingToolCall, type ToolCallVerdict, type ToolRound } from '../chat/generation-core'
import type { ChatUpstream } from '../chat/chat-upstream'
import type { PinnedRoute } from './model-swap'

/** Mirrors chat-routes.ts's own MAX_TOOL_ITER (16) — same headroom reasoning: a handful of
 *  web_search/fetch_url/run_code rounds plus a final answer round. A ceiling, not a target. */
export const MAX_TOOL_ITER = 16

export type ChatRunOutcome =
  | { status: 'ok'; result: string }
  | { status: 'needs_approval' }
  | { status: 'errored'; error: string }

/** How a routine runs the chat's loop, unlike a live chat turn: one JSON completion per round (see the header); every
 *  one of MAX_TOOL_ITER rounds run, then an error rather than an extra pass, and an empty answer stays the result as
 *  it is; nothing in this machine's ledgers (the run's accounting is its gate hold and Manager.hold, execute.ts); the
 *  agent's tools offered on every engine, vLLM and SGLang included, as this runner always did; and a timeout that
 *  comes during a round's call lets the round's other calls finish, the round persisted, before the run ends. */
const UNATTENDED_LOOP: LoopOptions = {
  transport: 'json', toolRoundCeiling: MAX_TOOL_ITER, extraPass: false, ledgers: false, toolsOnEveryEngine: true, stopBetweenToolCalls: false,
}

const CANCELLED: ChatRunOutcome = { status: 'errored', error: 'Routine run timed out or was cancelled.' }

function buildInitialMessages(agent: CustomChatAgent, prompt: string): GenerationMessage[] {
  const messages: GenerationMessage[] = []
  if (agent.systemPrompt) messages.push({ role: 'system', content: agent.systemPrompt })
  messages.push({ role: 'user', content: prompt })
  return messages
}

function findAgent(d: Deps, routine: Routine): CustomChatAgent | undefined {
  return d.store.snapshot().customAgents.find((a) => a.id === routine.agentId)
}

/** Expands one persisted assistant Message that made tool calls into its wire form: the
 *  model's own `tool_calls` request, followed by one `tool`-role reply per call. Each COMPLETED
 *  round of `runChatRoundLoop` persists exactly one such Message (see there) — this is the
 *  inverse operation, needed so a resumed run replays earlier rounds' real tool activity
 *  instead of silently dropping it (fix for the "resume forgets round 1" finding: a run that
 *  searched in round 1 then stalled in round 2 must resume still knowing it searched). */
function toolCallsToWire(m: Message): GenerationMessage[] {
  const out: GenerationMessage[] = [{
    role: 'assistant', content: m.content || null,
    tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
  }]
  for (const tc of m.toolCalls) {
    out.push({ role: 'tool', content: tc.error ? `Error: ${tc.error}` : (tc.result ?? ''), tool_call_id: tc.id })
  }
  return out
}

/** Rebuilds the wire conversation for a resume from the conversation's OWN persisted history
 *  (`conv.messages`), rather than re-deriving the user prompt from the Routine (that duplicated
 *  the user turn — `runChatRoutine` already persisted it via `addMessage` before the loop ever
 *  started, so replaying both `routine.prompt` AND `conv.messages` sent the same user turn
 *  twice in a row, which strict-alternation chat templates reject outright). `conv.messages` is
 *  returned in seq order (getConversation/getMessages), so this alone reconstructs the entire
 *  prior conversation — including every completed round's real tool activity, once
 *  `runChatRoundLoop` is persisting those (see toolCallsToWire). */
function buildResumeMessages(agent: CustomChatAgent, conv: Conversation): GenerationMessage[] {
  const messages: GenerationMessage[] = []
  if (agent.systemPrompt) messages.push({ role: 'system', content: agent.systemPrompt })
  for (const m of conv.messages ?? []) {
    if (m.role === 'assistant' && m.toolCalls.length > 0) messages.push(...toolCallsToWire(m))
    else messages.push({ role: m.role, content: m.content })
  }
  return messages
}

/** Runs one Chat Routine fire to completion (or a stall/error), starting a FRESH conversation
 *  each time — a routine run is always a new task, never a continued thread (spec 20 §1's Chat
 *  Routine description). `signal` combines the caller's wall-clock deadline with cancellation.
 *  `route`: where withPinnedModel's swap loaded the routine's model, absent when no swap was needed
 *  (the model was already in the primary); see runChatRoundLoop. */
export async function runChatRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal, route?: PinnedRoute): Promise<ChatRunOutcome> {
  const agent = findAgent(d, routine)
  if (!agent) return { status: 'errored', error: `Chat agent "${routine.agentId}" no longer exists.` }

  const conv = d.db.createConversation({
    kind: 'agent', modelKey: routine.modelKey, systemPrompt: agent.systemPrompt,
    skillIds: agent.skillIds, allowedTools: agent.tools, agentId: agent.id,
  })
  // Set once, at creation — never touched again by a resume, which reuses this SAME conv.id.
  // Lets the run be opened and interacted with as a real conversation, not just read back as a
  // flattened `result` string.
  d.db.updateRoutineRun(run.id, { conversationId: conv.id })
  d.db.addMessage(conv.id, 'user', routine.prompt)

  return runChatRoundLoop(d, run, agent, conv.id, signal, buildInitialMessages(agent, routine.prompt), routine.modelKey, route)
}

/** Resume a stalled Chat Routine after an approve/deny decision. `pending` is the exact resume
 *  point stallRoutineRun() persisted — never re-derived from a (possibly since-edited) live
 *  Routine row, per spec 20 §6's "resumes with its original snapshot" rule. Since this runner
 *  owns its own tool loop end-to-end (no live pi/subprocess in the middle), resuming here is a
 *  literal continuation from the exact blocked point — no fresh-turn approximation needed. */
export async function resumeChatRoutine(
  d: Deps, routine: Routine, run: RoutineRun, pending: PendingRoutineToolCall, decision: 'allow' | 'deny', signal: AbortSignal, route?: PinnedRoute,
): Promise<ChatRunOutcome> {
  const agent = findAgent(d, routine)
  if (!agent) return { status: 'errored', error: `Chat agent "${routine.agentId}" no longer exists.` }
  if (decision === 'deny') return { status: 'errored', error: `Tool call "${pending.call.name}" denied by user.` }

  const conv = d.db.getConversation(pending.convId, true)
  if (!conv) return { status: 'errored', error: "The routine's conversation no longer exists." }

  // I2 fix: build history from conv.messages ALONE (it already contains the persisted user
  // prompt from runChatRoutine) — do not ALSO push routine.prompt via buildInitialMessages,
  // or the wire conversation gets two consecutive user turns in a row.
  const messages = buildResumeMessages(agent, conv)
  messages.push({
    role: 'assistant', content: pending.assistantContent || null,
    tool_calls: [...pending.precedingCalls, pending.call].map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
  })
  for (const c of pending.precedingCalls) messages.push({ role: 'tool', content: c.result, tool_call_id: c.id })

  // C1 fix: pending.call.name is, BY CONSTRUCTION, a tool NOT in agent.tools — that mismatch is
  // exactly why this run stalled in the first place. Passing plain `agent.tools` here would make
  // executeToolCallWithApproval's non-interactive branch re-block the very call a human just
  // approved (agentAllowedTools?.includes(name) fails), silently downgrading "approve" to the
  // same outcome as "deny" while still reporting {status:'ok'} once the model glosses over the
  // "Blocked: ..." tool result it was fed. Extend the allow-list with just this one call for
  // just this one already-approved execution — NOT for the rest of the resumed round loop below,
  // which still gates any OTHER not-yet-approved tool the model might request via the unmodified
  // agent.tools list.
  const approved = d.tools
    ? await executeToolCallWithApproval({
        tools: d.tools, sink: () => {}, convId: pending.convId, id: pending.call.id, name: pending.call.name, args: pending.call.args,
        globalPolicies: d.store.snapshot().tools.toolPolicies ?? {}, convOverrides: d.db.getToolOverrides(pending.convId),
        signal, interactive: false, agentAllowedTools: [...agent.tools, pending.call.name],
        // Deliberate `false` (Phase 4 / C1), not an oversight: see runChatRoundLoop's identical
        // call below. The human here approved ONE specific tool call, not a standing grant to
        // author code-flavor routines, and there is still no HTTP request to authorize against.
        isCodeAuthorized: false,
        // Same as runChatRoundLoop's call below: the approve route lets a caller who may not use
        // MCP tools approve a non-MCP call, such as an update_routine on the owner's MCP routine.
        refuseMcpAgentsAndRoutines: true,
      })
    : { result: 'Error: no tool registry available.' }
  messages.push({ role: 'tool', content: approved.result, tool_call_id: pending.call.id })

  // I1/I4 fix: this resumed round is now fully settled (every call it made — precedingCalls
  // plus the just-approved one — has a real result). Persist it the same way a normal completed
  // round does (see runChatRoundLoop), so the UI shows it and any LATER stall in this same
  // resumed run still has it when conv.messages is rebuilt again.
  const roundToolCalls: PendingRoutineToolCall['precedingCalls'] = [
    ...pending.precedingCalls,
    { id: pending.call.id, name: pending.call.name, args: pending.call.args, result: approved.result },
  ]
  d.db.addMessage(pending.convId, 'assistant', pending.assistantContent || '', { toolCalls: roundToolCalls })

  return runChatRoundLoop(d, run, agent, pending.convId, signal, messages, routine.modelKey, route)
}

/** Every turn goes to `route`, where the routine's swap loaded its model, shaped for the engine serving it there as the
 *  gateway shapes a request from its route. With keep-N 2 or more the swap loads the routine's model into a pool slot
 *  and leaves the user's in the primary. The turns went to the primary with the primary's model all the same, so the
 *  routine ran on the user's model and its run was recorded 'ok'; a routine pinned to a model already in a pool slot
 *  did so on every run. A route to the primary carries no engine and reads the primary's (its engine, model path and
 *  key). Without a route (no swap: the model was already in the primary) the turns go to the primary. A Turbo Link
 *  route is not followed: its requests need the link's token, which this runner does not send. `modelKey` is the
 *  routine's pinned model. */
function routineUpstream(d: Deps, modelKey: string, route?: PinnedRoute): ChatUpstream | undefined {
  const local = route && !route.remote ? route : undefined
  const ms = d.manager.status()
  const target = local ? local.target : d.manager.target?.() ?? null
  // The `model` fallback below: on a pool slot (its route carries the slot's engine) the routine's own key, since the
  // primary holds another model; on the primary, with or without a route to it, the primary's own key, as before.
  const servedKey = local?.engineKind ? modelKey : ms.state === 'running' ? ms.model?.key : undefined
  if (!target || !servedKey) return undefined

  const engineKind = local?.engineKind ?? servingEngineKind(d)
  const modelPath = local?.modelPath ?? d.manager.currentOpts()?.modelPath
  return {
    // `?? servedKey` is a should-never-happen fallback for mlx-vlm: the `!target || !servedKey`
    // guard above already implies a model path (on the primary servedKey needs a running engine,
    // so `currentOpts()` is set; a pool slot's route carries its own modelPath), so
    // engineModelAlias('mlx-vlm', ...) always resolves a real path here. If it were ever hit,
    // TurboLLM's internal display-name key would go out as the `model` field and mlx_vlm.server
    // would 400 with a clear "Failed to load model" error rather than silently misbehaving —
    // acceptable as a last-resort guard.
    modelField: engineModelAlias(engineKind, modelPath) ?? servedKey,
    modelName: servedKey,
    // What a LiteRT-LM round fits the agent's tools into: the routine's model's context, known on the primary only.
    ctxMax: local?.engineKind ? 0 : ms.model?.ctx ?? 0,
    target,
    engineKind,
    // The routine's model, for whether a LiteRT-LM one calls tools (litertLmToolsFor).
    libraryKey: servedKey,
  }
}

/** Runs the round loop on the chat's generation core (see the header) from `messages`, to an answer, a stall or an
 *  error. Every engine failure, a fetch that throws and a timeout mid-request among them, resolves to an errored
 *  outcome (I3: a genuinely stuck model spends its time INSIDE the request, which is what the Task-2 wall-clock
 *  deadline exists to catch), never a throw out of the run. */
async function runChatRoundLoop(d: Deps, run: RoutineRun, agent: CustomChatAgent, convId: string, signal: AbortSignal, messages: GenerationMessage[], modelKey: string, route?: PinnedRoute): Promise<ChatRunOutcome> {
  const upstream = routineUpstream(d, modelKey, route)
  if (!upstream) return { status: 'errored', error: 'No model loaded.' }

  const toolLoop = new ToolLoopTracker()
  const ac = new AbortController()
  const abort = () => ac.abort()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  try {
    const outcome = await runGenerationCore<ChatRunOutcome>(d, {
      convId,
      // No sampling, stop strings or skills: a routine's request carries the agent's tools and the Settings cap only.
      conv: { id: convId, sampling: {}, allowedTools: agent.tools },
      engineMessages: messages,
      upstream,
      ac,
      thinkingBudget: -1,
      reasoningEffort: undefined,
      loop: UNATTENDED_LOOP,
    }, {
      persistence: {
        saveProgress: () => {},
        restoreUnproduced: () => false,
        // I1/I4 fix: each round is persisted once it is fully settled — every call it made ran and has a real result
        // (a stall or abort ends the run before its round settles, so an incomplete/undecided round is never
        // persisted). Without this, only the user prompt and the final answer ever reached the DB: the conversation
        // view showed zero tool activity even when the run clearly did tool work, and a resume that rebuilds history
        // from conv.messages (buildResumeMessages) would have no memory of any round before the one that stalled.
        appendToolRound: (round) => { d.db.addMessage(convId, 'assistant', round.content, { toolCalls: round.calls }) },
        // The answer is appended once the run is known to have one (runOutcome).
        finalize: () => undefined,
      },
      // Nobody watches a routine's run: what the chat would show its user as a notice goes to the log.
      sink: (ev) => {
        if (ev.event === 'notice') console.log(`[routines] run ${run.id}: ${(ev.data as { message: string }).message}`)
      },
      approval: {
        interactive: false,
        agentAllowedTools: agent.tools,
        // Deliberate `false` (Phase 4 / C1), not an oversight — and load-bearing, so do not
        // "fix" it to true. A scheduled fire has NO inbound HTTP request, so there is nothing
        // to run routine-routes.ts's codeGateBlocks against; and an unattended routine running
        // on a timer must not be able to author FURTHER code-flavor routines (unsupervised
        // scheduled code execution begetting more of itself) with no human in the loop.
        // Chat-flavor create/update from a routine is unaffected — the flag only gates code.
        isCodeAuthorized: false,
        // The MCP counterpart, for the same reason: no request to check, and whoever made or
        // fired this routine may be a caller who may not use the owner's MCP tools (a keyless
        // Serve identity, Access JWT or open-LAN peer). Its agent can list update_routine and
        // run_routine_now without any MCP tool, so without this its run rewrote the prompt of
        // the owner's routine on an MCP agent and fired it, running that MCP tool unapproved.
        // create_agent with an MCP tool and those routine tools on a chat routine whose agent
        // lists one are refused; the MCP tools this agent lists itself still run.
        refuseMcpAgentsAndRoutines: true,
        convOverrides: () => d.db.getToolOverrides(convId),
      },
      beforeToolCall: (call, round) => routineToolVerdict(d, run, agent, convId, toolLoop, call, round),
    })
    return runOutcome(d, convId, outcome)
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** The routine's say over each tool call, in this order: a call repeated past LOOP_ABORT_AFTER ends the run; one to a
 *  tool the agent does not list stalls it durably for a human's decision (stallRoutineRun), with the round's text and
 *  its calls settled so far as the resume point; one repeated past LOOP_BREAK_AFTER is answered as blocked, not run. */
function routineToolVerdict(
  d: Deps, run: RoutineRun, agent: CustomChatAgent, convId: string, toolLoop: ToolLoopTracker, call: PendingToolCall, round: ToolRound,
): ToolCallVerdict<ChatRunOutcome> {
  const loopCount = toolLoop.record(call.name, call.args)
  if (loopCount > LOOP_ABORT_AFTER) {
    return { stop: { status: 'errored', error: `"${call.name}" was called with identical arguments ${loopCount} times in a row — stopped automatically to avoid an infinite loop.` } }
  }
  if (!agent.tools.includes(call.name)) {
    stallRoutineRun(d.db, run.id, { convId, assistantContent: round.content, precedingCalls: round.calls, call })
    return { stop: { status: 'needs_approval' } }
  }
  if (loopCount > LOOP_BREAK_AFTER) {
    return { block: `Blocked: "${call.name}" was called with identical arguments too many times in a row — not executed.` }
  }
  return 'run'
}

/** The run's outcome from the core's: a stop is the routine's own (a stall or the loop abort), then a timeout or
 *  cancellation, an engine failure, the round ceiling, and otherwise the answer, appended as the run's last message. */
function runOutcome(d: Deps, convId: string, outcome: GenerationOutcome<ChatRunOutcome>): ChatRunOutcome {
  if (outcome.stopped) return outcome.stopped
  if (outcome.aborted) return CANCELLED
  if (outcome.failure) return { status: 'errored', error: failureText(outcome.failure) }
  if (outcome.exceeded) return { status: 'errored', error: `Exceeded the ${MAX_TOOL_ITER}-round tool-call ceiling without finishing.` }
  d.db.addMessage(convId, 'assistant', outcome.content)
  return { status: 'ok', result: outcome.content }
}

/** The run's record of an engine failure. A refusal gives the engine's reason, as the chat gives it (the run recorded
 *  only the status code). */
function failureText(failure: GenerationFailure): string {
  if (failure.kind === 'http') return failure.reason ? `Engine returned ${failure.status}: ${failure.reason}` : `Engine returned ${failure.status}.`
  if (failure.kind === 'engine') return failure.message
  // Only the request (or reading its reply) failing is the engine's; any other throw is the run's own (its persistence,
  // a tool) and is reported as it is.
  return failure.request ? `Engine request failed: ${failure.message}` : failure.message
}


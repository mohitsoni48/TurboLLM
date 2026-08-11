// turbollm/src/routines/chat-runner.ts
//
// Chat-flavor Routine execution — the "detached version of the existing chat generation path"
// spec 20 §5 asks for, tracing to the Scope-A detached-generation lineage that spec cites (spec
// 20 §5's last bullet). NOT a reuse of chat-routes.ts's runGeneration(): that function is
// hard-coupled to a live Hono SSE StreamHandle (stream.writeSSE(...) throughout) and has no
// live client to stream to here — a routine's result is written to the DB/RoutineRun, never
// streamed. Reused directly instead: executeToolCallWithApproval (tools/execute-with-approval.ts),
// which already supports a non-interactive background caller via `interactive:false` +
// `agentAllowedTools` (confirmed dead code since the old background agent runner, generation.ts,
// was deleted per ADR-163 — this is that seam, finally used again); engineModelAlias/
// clampMaxTokens (request shaping, same as chat-routes.ts); and ToolLoopTracker/
// LOOP_BREAK_AFTER/LOOP_ABORT_AFTER (runaway-guard.ts) — chat-routes.ts's own tool loop has only
// a round-count ceiling (MAX_TOOL_ITER) with no same-call loop breaker, so an UNATTENDED run
// needs this wired explicitly (there is no human to notice a stuck loop).
//
// Requests stream:false — nobody is watching deltas live, so one non-streaming completion per
// round is simpler and exactly as sufficient as chat-routes.ts's own SSE delta parser, without
// reimplementing it for an audience of nobody.
import type { Deps } from '../deps'
import type { CustomChatAgent } from '../config/config'
import type { Routine, RoutineRun } from './schema'
import type { Conversation, Message } from '../chat/db'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { executeToolCallWithApproval } from '../tools/execute-with-approval'
import { ToolLoopTracker, LOOP_BREAK_AFTER, LOOP_ABORT_AFTER } from './runaway-guard'
import { stallRoutineRun, type PendingRoutineToolCall } from './approval'

/** Mirrors chat-routes.ts's own MAX_TOOL_ITER (16) — same headroom reasoning: a handful of
 *  web_search/fetch_url/run_code rounds plus a final answer round. A ceiling, not a target. */
export const MAX_TOOL_ITER = 16

export type ChatRunOutcome =
  | { status: 'ok'; result: string }
  | { status: 'needs_approval' }
  | { status: 'errored'; error: string }

interface WireMessage { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }
interface LoopState { messages: WireMessage[]; toolLoop: ToolLoopTracker; iter: number }

function buildInitialMessages(agent: CustomChatAgent, prompt: string): WireMessage[] {
  const messages: WireMessage[] = []
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
function toolCallsToWire(m: Message): WireMessage[] {
  const out: WireMessage[] = [{
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
function buildResumeMessages(agent: CustomChatAgent, conv: Conversation): WireMessage[] {
  const messages: WireMessage[] = []
  if (agent.systemPrompt) messages.push({ role: 'system', content: agent.systemPrompt })
  for (const m of conv.messages ?? []) {
    if (m.role === 'assistant' && m.toolCalls.length > 0) messages.push(...toolCallsToWire(m))
    else messages.push({ role: m.role, content: m.content })
  }
  return messages
}

/** Runs one Chat Routine fire to completion (or a stall/error), starting a FRESH conversation
 *  each time — a routine run is always a new task, never a continued thread (spec 20 §1's Chat
 *  Routine description). `signal` combines the caller's wall-clock deadline with cancellation. */
export async function runChatRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal): Promise<ChatRunOutcome> {
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

  return runChatRoundLoop(d, run, agent, conv.id, signal, { messages: buildInitialMessages(agent, routine.prompt), toolLoop: new ToolLoopTracker(), iter: 0 })
}

/** Resume a stalled Chat Routine after an approve/deny decision. `pending` is the exact resume
 *  point stallRoutineRun() persisted — never re-derived from a (possibly since-edited) live
 *  Routine row, per spec 20 §6's "resumes with its original snapshot" rule. Since this runner
 *  owns its own tool loop end-to-end (no live pi/subprocess in the middle), resuming here is a
 *  literal continuation from the exact blocked point — no fresh-turn approximation needed. */
export async function resumeChatRoutine(
  d: Deps, routine: Routine, run: RoutineRun, pending: PendingRoutineToolCall, decision: 'allow' | 'deny', signal: AbortSignal,
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

  return runChatRoundLoop(d, run, agent, pending.convId, signal, { messages, toolLoop: new ToolLoopTracker(), iter: 0 })
}

async function runChatRoundLoop(d: Deps, run: RoutineRun, agent: CustomChatAgent, convId: string, signal: AbortSignal, state: LoopState): Promise<ChatRunOutcome> {
  const ms = d.manager.status()
  const target = d.manager.target?.() ?? null
  if (ms.state !== 'running' || !ms.model || !target) return { status: 'errored', error: 'No model loaded.' }

  const engineKind = d.registry.active()?.kind ?? ''
  const baseToolDefs = d.tools ? (await d.tools.buildToolDefinitions()).filter((t) => agent.tools.includes(t.function.name)) : []
  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0

  while (state.iter < MAX_TOOL_ITER) {
    state.iter++
    if (signal.aborted) return { status: 'errored', error: 'Routine run timed out or was cancelled.' }

    // `?? ms.model.key` is a should-never-happen fallback for mlx-vlm: the `state !== 'running'`
    // guard above already implies `currentOpts()` is set, so engineModelAlias('mlx-vlm', ...)
    // always resolves a real path here. If it were ever hit, TurboLLM's internal display-name
    // key would go out as the `model` field and mlx_vlm.server would 400 with a clear "Failed to
    // load model" error rather than silently misbehaving — acceptable as a last-resort guard.
    const reqBody: Record<string, unknown> = { model: engineModelAlias(engineKind, d.manager.currentOpts()?.modelPath) ?? ms.model.key, messages: state.messages, stream: false }
    if (baseToolDefs.length) reqBody.tools = baseToolDefs
    const cappedMax = clampMaxTokens(undefined, maxLimit)
    if (cappedMax != null) reqBody.max_tokens = cappedMax

    // I3 fix: a genuinely stuck model spends its time INSIDE this fetch, not between rounds —
    // that's the realistic case the Task-2 wall-clock deadline exists to catch. Unwrapped, a
    // mid-request abort throws AbortError (not the intended errored outcome below) and a
    // connection failure throws an uncaught TypeError, so both must resolve through here instead
    // of escaping the loop.
    let message: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } | undefined
    try {
      const res = await fetch(`${target}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal })
      if (!res.ok) return { status: 'errored', error: `Engine returned ${res.status}.` }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }
      message = data.choices?.[0]?.message
    } catch (e) {
      if (signal.aborted) return { status: 'errored', error: 'Routine run timed out or was cancelled.' }
      return { status: 'errored', error: `Engine request failed: ${(e as Error).message}` }
    }
    if (!message) return { status: 'errored', error: 'Engine returned no message.' }

    const toolCalls = message.tool_calls ?? []
    if (toolCalls.length === 0) {
      const content = message.content ?? ''
      d.db.addMessage(convId, 'assistant', content)
      return { status: 'ok', result: content }
    }

    state.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
    const precedingCalls: PendingRoutineToolCall['precedingCalls'] = []

    for (const tc of toolCalls) {
      let args: Record<string, unknown>
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = {} }

      const loopCount = state.toolLoop.record(tc.function.name, args)
      if (loopCount > LOOP_ABORT_AFTER) {
        return { status: 'errored', error: `"${tc.function.name}" was called with identical arguments ${loopCount} times in a row — stopped automatically to avoid an infinite loop.` }
      }

      if (!agent.tools.includes(tc.function.name)) {
        stallRoutineRun(d.db, run.id, { convId, assistantContent: message.content ?? '', precedingCalls, call: { id: tc.id, name: tc.function.name, args } })
        return { status: 'needs_approval' }
      }

      if (loopCount > LOOP_BREAK_AFTER) {
        const blocked = `Blocked: "${tc.function.name}" was called with identical arguments too many times in a row — not executed.`
        precedingCalls.push({ id: tc.id, name: tc.function.name, args, result: blocked })
        state.messages.push({ role: 'tool', content: blocked, tool_call_id: tc.id })
        continue
      }

      const executed = d.tools
        ? await executeToolCallWithApproval({
            tools: d.tools, sink: () => {}, convId, id: tc.id, name: tc.function.name, args,
            globalPolicies: d.store.snapshot().tools.toolPolicies ?? {}, convOverrides: d.db.getToolOverrides(convId),
            signal, interactive: false, agentAllowedTools: agent.tools,
            // Deliberate `false` (Phase 4 / C1), not an oversight — and load-bearing, so do not
            // "fix" it to true. A scheduled fire has NO inbound HTTP request, so there is nothing
            // to run routine-routes.ts's codeGateBlocks against; and an unattended routine running
            // on a timer must not be able to author FURTHER code-flavor routines (unsupervised
            // scheduled code execution begetting more of itself) with no human in the loop.
            // Chat-flavor create/update from a routine is unaffected — the flag only gates code.
            isCodeAuthorized: false,
          })
        : { result: 'Error: no tool registry available.' }
      precedingCalls.push({ id: tc.id, name: tc.function.name, args, result: executed.result })
      state.messages.push({ role: 'tool', content: executed.result, tool_call_id: tc.id })
    }

    // I1/I4 fix: this round is fully settled — every call it made ran and has a real result
    // (a stall or abort above returns before reaching here, so an incomplete/undecided round is
    // never persisted). Without this, only the user prompt and the final answer ever reached the
    // DB: the conversation view showed zero tool activity even when the run clearly did tool
    // work, and a resume that rebuilds history from conv.messages (buildResumeMessages) would
    // have no memory of any round before the one that stalled.
    d.db.addMessage(convId, 'assistant', message.content ?? '', { toolCalls: precedingCalls })
  }
  return { status: 'errored', error: `Exceeded the ${MAX_TOOL_ITER}-round tool-call ceiling without finishing.` }
}

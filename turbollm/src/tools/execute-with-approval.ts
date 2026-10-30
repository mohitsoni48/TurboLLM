// Shared tool-call executor with the real approval gate (F-019 replacement).
// Both live foreground chat (chat-routes.ts) and the background agent runner
// (generation.ts) call this single implementation instead of maintaining their
// own inline per-tool-call blocks.
import { isMcpToolName, type ToolRegistry, type ToolCall } from './tool-registry'
import { type ToolPolicy, resolveToolPolicy } from './tool-policy'
import { waitForToolApproval } from './approval-gate'

/** The result a call gets when its approval wait (approvalWaitMinutes) ran out. */
export function approvalTimeoutResult(minutes: number): string {
  return `No answer within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}; the call was not run.`
}

export type ToolCallSink = (ev: { event: string; data: unknown }) => void | Promise<void>

/** A chat reply's wait for its approvals, shared by every Ask call of the reply: the wait is the reply's, not each
 *  call's. The reply's first call that waits sets `minutes` (approvalWaitMinutes as that call reaches its wait; 0 waits
 *  until answered). Only time spent waiting counts: each wait spends what it waited and an answer resets nothing, so an
 *  answered call leaves the rest for the next one. Once a wait has run out, `timedOut`: the reply's later Ask calls are
 *  answered at once with the timeout result, as no one is there to answer them. Per call, a model that asked again
 *  after a call nobody answered waited again each time (up to 16 rounds), holding the chat, its engine slot and, on
 *  Android, the loaded model for that many times the setting. */
export interface ApprovalWaitBudget {
  minutes?: number
  waitedMs: number
  timedOut: boolean
}

export function newApprovalWaitBudget(): ApprovalWaitBudget {
  return { waitedMs: 0, timedOut: false }
}

export async function executeToolCallWithApproval(params: {
  tools: ToolRegistry
  sink: ToolCallSink
  convId: string
  id: string
  name: string
  args: Record<string, unknown>
  globalPolicies: Record<string, ToolPolicy>
  convOverrides: Record<string, 'allow' | 'deny'>
  /** Settings → Tool permissions master toggle (default off) — silences a resolved
   *  'ask' only; an explicit 'deny' is still honored. See resolveToolPolicy. */
  autoAllowAll?: boolean
  signal: AbortSignal
  /** true for live foreground chat (can prompt a human); false for background agent runs
   *  (must never hang waiting for a human — 'ask'-policy tools are denied unless
   *  pre-approved via agentAllowedTools). */
  interactive: boolean
  /** Interactive only (a chat turn): how long the reply waits for its answers, in minutes, as
   *  Settings' chatApprovalWaitMinutes says when its first call reaches its wait (approvalBudget).
   *  Past it the call is not run and is answered like a deny, with its own text
   *  (approvalTimeoutResult). Unset or 0 waits until answered, as Code's ask mode does
   *  (code-session.ts waits on the gate itself). */
  approvalWaitMinutes?: number
  /** Interactive only: the reply's wait, shared by its calls (ApprovalWaitBudget). Without one,
   *  the call waits as a reply of one call would. */
  approvalBudget?: ApprovalWaitBudget
  /** Interactive only: told `true` as an 'ask' starts waiting for its answer and `false` as the
   *  wait ends, however it ends (before the call runs, if it was allowed). The chat turn marks
   *  itself parked meanwhile (chat-routes.ts parkedChatIds). */
  onApprovalWait?: (waiting: boolean) => void
  /** For background agent runs only: the tool names this agent was explicitly configured
   *  to use. A human already approved this list when setting up the agent, so it stands
   *  in for the interactive approval a background run can never get. */
  agentAllowedTools?: string[]
  /** Phase 4 / C1: whether the caller driving this tool loop has cleared the same bar `codeAuth`
   *  enforces (host-local OR a valid API key). Purely pass-through — this function makes no
   *  decision with it; `ToolRegistry.executeTool` forwards it to create_routine/update_routine/
   *  run_routine_now, the only tools that consult it, and only for code-flavor routines. OPTIONAL
   *  and defaulting to false so a caller that does not supply it fails closed, matching
   *  routine-tools.ts's own fail-closed philosophy. See each call site for how it computes (or
   *  deliberately omits) it. */
  isCodeAuthorized?: boolean
  /** Live chat: this turn's caller may not act on the host, so MCP server tools are refused
   *  (ToolRegistry.executeTool's `refuseMcp`). Unset elsewhere, which leaves them as before. */
  refuseMcp?: boolean
  /** A routine's unattended run and an External Chat API tenant's run: refuse create_agent with an
   *  MCP tool and the routine tools on a chat routine whose agent lists one, but run MCP tools
   *  themselves (ToolRegistry.executeTool's `refuseMcpAgentsAndRoutines`). */
  refuseMcpAgentsAndRoutines?: boolean
}): Promise<{ result: string; error?: string }> {
  const { tools, sink, convId, id, name, args, globalPolicies, convOverrides, signal, interactive, agentAllowedTools, autoAllowAll } = params

  // Refused before its policy is read: an 'ask' would put the approval to a caller whose own
  // approval could not run it (and the approve route refuses it to them), leaving the turn waiting.
  if (params.refuseMcp && isMcpToolName(name)) {
    const result = await tools.executeTool({ id, name, args }, params.isCodeAuthorized ?? false, { refuseMcp: true })
    await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
    return { result }
  }

  const policy = resolveToolPolicy(name, globalPolicies, convOverrides, autoAllowAll)

  if (policy === 'deny') {
    const result = 'Blocked: this tool is set to Deny in Tool Permissions settings.'
    await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
    return { result }
  }

  let cameFromApprovedAsk = false

  if (policy === 'ask') {
    if (!interactive) {
      if (agentAllowedTools?.includes(name)) {
        cameFromApprovedAsk = true
      } else {
        const result = "Blocked: this tool requires interactive approval, which is not available for background agent runs. Add it to this agent's allowed tools, or set it to Allow in Settings → Tools & safety → Tool permissions."
        await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
        return { result }
      }
    } else {
      const budget = params.approvalBudget ?? newApprovalWaitBudget()
      budget.minutes ??= params.approvalWaitMinutes ?? 0
      const waitMinutes = budget.minutes
      const leftMs = waitMinutes > 0 ? waitMinutes * 60_000 - budget.waitedMs : 0
      if (budget.timedOut || (waitMinutes > 0 && leftMs <= 0)) {
        // The reply's wait has run out: answered at once, as the call nobody answered was.
        budget.timedOut = true
        const result = approvalTimeoutResult(waitMinutes)
        await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
        return { result }
      }
      await sink({ event: 'tool_call', data: { id, name, args, status: 'awaiting_approval' } })
      const waitStarted = Date.now()
      params.onApprovalWait?.(true)
      let decision: 'allow' | 'deny' | 'timeout'
      try {
        decision = await waitForToolApproval(`${convId}:${id}`, signal, name, leftMs)
      } finally {
        budget.waitedMs += Date.now() - waitStarted
        params.onApprovalWait?.(false)
      }
      if (decision === 'timeout') {
        // Recorded like a deny (the model reads it as the call's result and the turn goes on),
        // in words that say no one answered: a Stop while waiting stays "Denied by user.".
        budget.timedOut = true
        const result = approvalTimeoutResult(waitMinutes)
        await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
        return { result }
      }
      if (decision === 'deny') {
        const result = 'Denied by user.'
        await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
        return { result }
      }
      cameFromApprovedAsk = true
    }
  }

  // policy === 'allow', or fell through from an approved 'ask'.
  if (!cameFromApprovedAsk) {
    await sink({ event: 'tool_call', data: { id, name, args, status: 'pending' } })
  }

  let result = ''
  let error: string | undefined
  try {
    const call: ToolCall = { id, name, args }
    result = await tools.executeTool(call, params.isCodeAuthorized ?? false, { refuseMcp: params.refuseMcp, refuseMcpAgentsAndRoutines: params.refuseMcpAgentsAndRoutines })
  } catch (e) {
    error = (e as Error).message
    result = `Error: ${error}`
  }

  await sink({ event: 'tool_call', data: { id, name, args, status: error ? 'error' : 'done', result } })
  return { result, error }
}

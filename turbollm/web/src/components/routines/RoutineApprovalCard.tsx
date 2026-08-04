import { useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { toast } from '../ui/sonner'
import { describeRoutineError } from '../../lib/routine-api'
import { useRoutineMutations } from '../../lib/routine-queries'
import type { RoutineRun } from '../../lib/routine-types'

/** The blocked call, extracted from `RoutineRun.pendingToolCall`.
 *
 *  DEVIATION FROM THE PLAN — the plan's parser read `{ name, args }` off the top level of the
 *  JSON. The real persisted shape (verified against `turbollm/src/routines/approval.ts`'s
 *  `PendingRoutineToolCall`, which `serializePendingToolCall` writes and `stallRoutineRun`
 *  stores verbatim) is:
 *
 *      { convId, assistantContent, precedingCalls[], call: { id, name, args }, sessionId? }
 *
 *  so the plan's parser would have found `name === undefined` on EVERY real stalled run and
 *  silently fallen through to its generic "a tool call needs your approval" message — i.e. the
 *  card's one job (naming the specific call being authorized, spec 20 §6) would have failed
 *  closed-but-useless on 100% of production data while its own unit test passed against a
 *  hand-written fixture of a shape the backend never emits.
 *
 *  Returns null (not a partial) unless a real call name is present: an approval prompt that
 *  cannot say WHAT it is approving must not pretend otherwise. */
interface PendingCall {
  name: string
  args: Record<string, unknown>
}

export function parsePendingRoutineToolCall(raw: string | undefined): PendingCall | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { call?: { name?: unknown; args?: unknown } } | null
    const call = v && typeof v === 'object' ? v.call : undefined
    if (!call || typeof call.name !== 'string' || !call.name.trim()) return null
    const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {}
    return { name: call.name, args }
  } catch {
    return null
  }
}

/** Args are model-authored and unbounded (a `write_file` call carries whole file contents), and
 *  this row sits inside a scrolling history list — same layout-blowout class the list screen's
 *  review flagged for unbounded `run.error`. Truncated for display only; the decision the buttons
 *  send is unaffected. */
const ARGS_DISPLAY_LIMIT = 240
function describeArgs(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return ''
  let text: string
  try {
    text = JSON.stringify(args)
  } catch {
    return '(arguments could not be displayed)'
  }
  return text.length > ARGS_DISPLAY_LIMIT ? `${text.slice(0, ARGS_DISPLAY_LIMIT)}…` : text
}

/** What the run IS now, for a card whose decision is already moot. Deliberately phrased from the
 *  run's own status rather than from this card's local action: by the time this renders, the run
 *  may have been resolved by a different tab, a different device, or the daemon itself — see the
 *  component comment. */
function settledLine(run: RoutineRun): string {
  const when = run.endedAt ? new Date(run.endedAt).toLocaleString() : new Date(run.startedAt).toLocaleString()
  if (run.status === 'ok') return `No longer awaiting approval — the run completed · ${when}`
  if (run.status === 'errored') return `No longer awaiting approval — the run ended with an error${run.error ? `: ${run.error}` : ''} · ${when}`
  if (run.status === 'skipped') return `No longer awaiting approval — the run was skipped${run.skipReason ? ` (${run.skipReason})` : ''} · ${when}`
  return `No longer awaiting approval — the run is continuing · ${when}`
}

/** A stalled run's blocked tool call, with Approve/Deny — spec 20 §6's stall/resume row, rendered
 *  inside RoutineEditPage's run-history list. Same visual/structural language as chat's
 *  `ToolApprovalBar.tsx` (warn-tinted inline banner, name + argument line, Deny/Approve pair),
 *  adapted from a floating composer banner to a history row, and from chat's live `LiveToolCall`
 *  object to the JSON string `RoutineRun.pendingToolCall` actually persists.
 *
 *  THE RUN PROP IS THE SOURCE OF TRUTH ABOUT WHETHER A DECISION IS STILL WANTED. This card holds
 *  no copy of the run and no boolean "I resolved this". Two consequences, both deliberate:
 *
 *  1. It goes inert on the run's ACTUAL current status, not on its own recollection of having
 *     clicked. `pendingToolCall` is persisted indefinitely, so this exact row re-renders (page
 *     reopened, poll tick, another device) long after the decision was taken — possibly by
 *     someone else entirely. `useRoutineRuns` polls every 10s, so a run resolved anywhere flows
 *     back here and the actionable card is replaced by {@link settledLine}. Rendering
 *     Approve/Deny against an already-resolved run would offer to authorize a tool call that has
 *     already run (or already been refused), and the backend would answer 409 'not_stalled'.
 *  2. Conversely, a submitted decision does NOT latch the card shut forever. Approving one call
 *     can stall the SAME run again on the NEXT one (chat-runner/code-runner both re-park), which
 *     leaves `status: 'needs_approval'` unchanged while `pendingToolCall` is replaced. The local
 *     "already submitted" note is therefore keyed to the exact serialized call it was made for,
 *     so a new blocked call is immediately actionable again instead of being swallowed by a stale
 *     flag.
 *
 *  DEVIATION FROM THE PLAN: the plan stored the mutation's reply as the resolved run
 *  (`onSuccess: (updated) => setResolvedRun(updated)`). `POST …/approve` and `…/deny` answer
 *  `{ ok: true }`, never a run (routine-api.ts's own DRIFT note, verified again in
 *  routine-routes.ts: the resumed continuation is still in flight when the response is written),
 *  so that would have typed a `{ ok: true }` as a `RoutineRun` and rendered a permanently
 *  status-less "Approved" row that no later poll could ever correct. */
export function RoutineApprovalCard({ routineId, run }: { routineId: string; run: RoutineRun }) {
  const mut = useRoutineMutations()
  /** Records a submitted decision ALONGSIDE the exact blocked call it applies to — see (2) above.
   *  Cleared on failure, so a 401/409 leaves a retryable card rather than a dead row. */
  const [submitted, setSubmitted] = useState<{ forCall: string; action: 'approve' | 'deny' } | null>(null)
  /** Synchronous re-entry guard: `isPending` only flips after a React state update, so two clicks
   *  inside one tick would both pass an isPending-only check and POST twice. */
  const inFlight = useRef(false)

  const pendingKey = run.pendingToolCall ?? ''
  const decision = submitted && submitted.forCall === pendingKey ? submitted.action : null

  // The run's real status wins over anything this card remembers doing.
  if (run.status !== 'needs_approval') {
    return <div className="rounded-md border border-border bg-panel px-3 py-2 text-[13px] break-words text-muted">{settledLine(run)}</div>
  }

  /** A run belonging to a different routine can never be approved through this routine's endpoint
   *  (routine-routes.ts answers 404 when `run.routineId !== :id`), so a mis-wired pairing gets an
   *  inert row rather than a button that always fails. */
  if (run.routineId !== routineId) {
    return <div className="rounded-md border border-border bg-panel px-3 py-2 text-[13px] text-muted">This run belongs to a different routine.</div>
  }

  if (decision) {
    return (
      <div className="rounded-md border border-border bg-panel px-3 py-2 text-[13px] text-muted">
        {decision === 'deny' ? 'Denied — waiting for this run to wind down.' : 'Approved — waiting for this run to resume.'}
      </div>
    )
  }

  const pending = parsePendingRoutineToolCall(run.pendingToolCall)
  const args = pending ? describeArgs(pending.args) : ''

  const respond = (action: 'approve' | 'deny') => {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitted({ forCall: pendingKey, action })
    const mutation = action === 'approve' ? mut.approve : mut.deny
    mutation.mutate(
      { routineId, runId: run.id },
      {
        // No onSuccess handler: `{ ok: true }` says nothing about the outcome. The runs query is
        // invalidated by the mutation definition and polls every 10s — that, not this card, is
        // what reports what actually happened.
        onError: (e) => {
          toast.error(describeRoutineError(e, 'Could not send your decision — please try again.'))
          setSubmitted(null)
        },
        onSettled: () => { inFlight.current = false },
      },
    )
  }

  const busy = mut.approve.isPending || mut.deny.isPending

  return (
    <div className="rounded-md border px-3 py-2.5 text-[13px]" style={{ borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {/* Unlike chat's banner this row sits in a list of otherwise-unremarkable history rows,
            so it carries the warn glyph as well as the warn tint. */}
        <HelpCircle size={13} style={{ color: 'var(--warn)' }} className="translate-y-[2px]" aria-hidden />
        <span className="font-medium text-ink">This run needs your approval:</span>
        {/* The RAW tool identifier, deliberately un-prettified — chat's ToolApprovalBar runs the
            name through `friendlyName` (underscores to spaces, MCP prefix stripped), which is the
            right call for a transient banner but the wrong one here: this string is what the
            routine's tool allow-list, the run history and the daemon logs all spell, and an
            authorization prompt that renames the thing being authorized cannot be cross-checked
            against any of them. */}
        <span className="font-mono text-[12px] text-ink">{pending ? pending.name : 'an unreadable tool call'}</span>
      </div>
      <p className="mt-0.5 break-all font-mono text-[12px] text-muted">
        {pending
          ? args || 'No arguments.'
          : 'A tool call outside this routine’s allow-list needs your approval, but its details could not be read.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => respond('deny')}>Deny</Button>
        <Button size="sm" disabled={busy} onClick={() => respond('approve')}>Approve</Button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { respondToolApproval } from '../../lib/chat-api'
import { ALWAYS_ASK_TOOLS, describeToolCall, friendlyName } from '../../lib/tool-explain'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { ApiError, track } from '../../lib/api'
import type { LiveToolCall } from '../../lib/chat-types'

type Decision = 'allow' | 'deny' | 'allow_chat' | 'always_allow'

/** Inline banner (not a modal) shown just above the composer while a tool call is
 *  waiting on interactive approval. Reuses the bordered/tinted-background banner
 *  visual language already used elsewhere in ChatScreen.tsx (e.g. the model-mismatch
 *  banner). Sits in normal document flow so the transcript remains readable. */
export function ToolApprovalBar({
  pending,
  convId,
  onResolved,
}: {
  pending: LiveToolCall
  convId: string
  onResolved: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  // Hidden the instant a button is clicked, rather than waiting ~1s for the SSE
  // round-trip to move the tool call off 'awaiting_approval' — that lag read as the
  // UI "blinking" / being unresponsive. Reappears only if the request itself failed,
  // so a genuine failure doesn't strand the user with no way to retry.
  const [dismissed, setDismissed] = useState(false)

  const respond = async (decision: Decision) => {
    if (submitting) return
    setDismissed(true)
    setSubmitting(true)
    try {
      await respondToolApproval(convId, pending.id, pending.name, decision)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not send your decision — please try again.')
      setDismissed(false)
    } finally {
      setSubmitting(false)
      onResolved()
    }
  }

  if (dismissed) return null
  // run_python (GitHub #52): the whole code, not a one-line summary, and Allow once only. Every run asks, so a standing
  // approval would be refused by the daemon anyway.
  const alwaysAsk = ALWAYS_ASK_TOOLS.has(pending.name)
  const code = alwaysAsk && typeof pending.args.code === 'string' ? pending.args.code : null

  return (
    <div className="mx-3 mb-3 rounded-md border border-[color:var(--warn)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-3 py-2.5 text-[13px] md:mx-8">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-ink">Tool call needs your approval:</span>
        <span className="font-mono text-[12px] text-ink">{friendlyName(pending.name)}</span>
      </div>
      <p className="mt-0.5 text-[12px] text-muted">{describeToolCall(pending.name, pending.args)}</p>
      {code !== null && (
        <>
          <pre className="mt-2 max-h-72 overflow-auto rounded border border-border bg-panel-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink whitespace-pre">{code}</pre>
          <p className="mt-1.5 text-[11px] text-faint">
            Runs in a sandbox with no network and no access to your files. Every run asks first.
          </p>
        </>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={submitting} onClick={() => { track('chat', 'deny_tool_call'); void respond('deny') }}>
          Deny
        </Button>
        <Button size="sm" disabled={submitting} onClick={() => { track('chat', 'allow_tool_call'); void respond('allow') }}>
          {alwaysAsk ? 'Allow once' : 'Allow'}
        </Button>
        {!alwaysAsk && (
          <>
            <Button size="sm" variant="outline" disabled={submitting} onClick={() => { track('chat', 'allow_tool_call_for_chat'); void respond('allow_chat') }}>
              Allow for this chat
            </Button>
            <Button size="sm" variant="outline" disabled={submitting} onClick={() => { track('chat', 'always_allow_tool_call'); void respond('always_allow') }}>
              Always Allow
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

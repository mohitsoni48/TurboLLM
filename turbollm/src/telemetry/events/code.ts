/** Code (coding-agent) feature volume (spec 23 §3.6, ADR-333). Read-only
 *  aggregation over `agent_runs`/`messages` for `conversations.kind='code'`
 *  (`ConversationStore.codeDailyStats`) — the same tables `codeStats()`
 *  already uses for the in-app "Coding activity" stats screen.
 *
 *  `toolApprovals`/`toolDenials`/`compactions`/`worktreeSessions` (spec 23
 *  §3.6's original sketch) are not included: no table records a per-call
 *  approval decision or a compaction event today, so populating them means
 *  new instrumentation inside `code-session.ts` itself — a larger, separate
 *  pass (TODO.md), not fabricated here. `sessions`/`turns`/`toolCalls` are
 *  fully backed by existing data and shipped now rather than waiting on the
 *  rest. */

import { defineEvent, f } from '../core/define'

export const codeDaily = defineEvent({
  name: 'code_daily',
  since: 2,
  consent: 'full',
  lifecycle: 'daily-rollup',
  description: "Yesterday's Code (coding-agent) feature volume for this machine — sessions, turns, and tool calls.",
  payload: {
    sessions: f.int(),
    turns: f.int(),
    toolCalls: f.int(),
  },
})

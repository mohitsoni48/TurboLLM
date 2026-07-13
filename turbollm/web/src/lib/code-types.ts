// Types for the Code launchpad's real backend surface (turbollm/src/code/code-routes.ts).

export type CodeMode = 'auto' | 'plan' | 'ask'

export type SessionStatus = 'merged' | 'review' | 'done' | 'aborted'

/** One row from GET /api/v1/code/sessions (sidebar list) or the `session` half of
 *  GET /api/v1/code/sessions/:id. */
export interface CodeSession {
  id: string
  convId: string
  title: string
  status: SessionStatus
  branch: string
  when: string
  add: number
  del: number
  mode?: string
  createdAt: string
  repoRoot: string
  error?: string
}

export interface CreateCodeSessionParams {
  repoRoot: string
  repoBranch?: string
  modelKey?: string
  mode: CodeMode
  task: string
  useWorktree?: boolean
  worktreeBranch?: string
  worktreeBase?: string
}

// SSE event payloads for GET /api/v1/code/sessions/:id/stream (code-routes.ts). Reuses
// chat's tool_call/reasoning/delta wire shape verbatim (same sink), but 'meta'/'done' carry
// different fields than chat's — a real, separate type, not a reuse of ChatSseEvent.
// 'queue' is Code-specific: the server-side message queue's current contents, so the client's
// "Queued" chips are driven by the daemon (and survive a disconnect) rather than browser memory.
export type CodeSseEvent =
  | { event: 'meta';      data: { userMessageId: string; assistantMessageId: string } }
  | { event: 'reasoning'; data: { delta: string } }
  | { event: 'delta';     data: { delta: string } }
  | { event: 'tool_call'; data: { id: string; name: string; args: Record<string, unknown>; status: 'pending' | 'done' | 'error' | 'awaiting_approval'; result?: string; diff?: string; patch?: string; firstChangedLine?: number } }
  | { event: 'queue';     data: { queued: string[] } }
  | { event: 'done';      data: { contextUsed: number; contextMax: number; aborted: boolean } }
  | { event: 'error';     data: { code: string; message: string } }

/** A streamed event tagged with its ring-buffer seq (from the SSE `id:` field), so the client
 *  can reconnect with ?fromSeq=<last seq>. Synthetic connect-time frames (meta/queue) carry no
 *  id and so leave `seq` undefined — they never advance the reconnect cursor. */
export type CodeStreamEvent = CodeSseEvent & { seq?: number }

// What would a primary-engine model load interrupt right now? (ADR-434 (i)(3): loading a Jev
// model asks for confirmation only when something is actively running, and names it — the same
// "active work, not an open window" rule as the daemon-restart gate.) One classifier,
// server-side, so the UI can never disagree with what the daemon is actually doing.
import type { Hono } from 'hono'
import type { Deps } from '../deps'
import { inFlightChatIds } from '../chat/chat-routes'

export interface ActiveWorkItem {
  kind: 'chat' | 'code' | 'routine'
  id: string
  label: string
}

export interface ActiveWork {
  items: ActiveWorkItem[]
  /** A generation an API client or a Code terminal agent is running through the gateway. It has
   *  no item of its own: the daemon knows a request is in flight, not whose it is. */
  engineGenerating: boolean
}

const UNTITLED = 'Untitled'

/** `chatIds` is a test seam only — every caller takes the default. */
export function activeWork(d: Deps, chatIds: () => string[] = inFlightChatIds): ActiveWork {
  return {
    items: [...chatItems(d, chatIds()), ...codeItems(d), ...routineItems(d)],
    engineGenerating: engineIsGenerating(d),
  }
}

export function registerActivityRoutes(app: Hono, d: Deps): void {
  app.get('/api/v1/activity', (c) => c.json(activeWork(d)))
}

function chatItems(d: Deps, convIds: string[]): ActiveWorkItem[] {
  return convIds.map((id) => ({ kind: 'chat', id, label: conversationTitle(d, id) }))
}

/** A Code session is identified by its agent-run id, so its title comes from the conversation
 *  that run belongs to. A routine-started session can be keyed by the conversation id itself
 *  (routines/code-runner.ts `pending.sessionId ?? pending.convId`), which is why the lookup
 *  falls back to the id as given. */
function codeItems(d: Deps): ActiveWorkItem[] {
  const sessionIds = d.codeRuns?.activeSessionIds() ?? []
  return sessionIds.map((id) => ({ kind: 'code', id, label: conversationTitle(d, d.db.getAgentRun(id)?.convId ?? id) }))
}

/** A routine has no name field: its prompt is what names it everywhere a user sees one (the
 *  conversation sidebar, run notifications), so that is its label here too. */
function routineItems(d: Deps): ActiveWorkItem[] {
  const routineIds = d.routineScheduler?.runningRoutineIds() ?? []
  return routineIds.map((id) => ({ kind: 'routine', id, label: d.db.getRoutine(id)?.prompt || UNTITLED }))
}

function conversationTitle(d: Deps, convId: string): string {
  return d.db.getConversation(convId)?.title || UNTITLED
}

function engineIsGenerating(d: Deps): boolean {
  return d.manager.status().state === 'running' && (d.manager.sessionStats()?.activeRequests ?? 0) > 0
}

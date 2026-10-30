// What would a primary-engine model load interrupt right now? (ADR-434 (i)(3): loading a Jev
// model asks for confirmation only when something is actively running, and names it — the same
// "active work, not an open window" rule as the daemon-restart gate.) One classifier,
// server-side, so the UI can never disagree with what the daemon is actually doing.
//
// The Android app's EngineService reads the same answer as "is the daemon busy?" (`items` and
// `engineGenerating` only): busy keeps the model loaded and the wake lock held after the app's
// window has gone. So every piece of work the daemon does on the engine is an item, and work that
// waits on a person (a chat parked on a tool-call approval) is listed apart, in `waiting`, which a
// load still interrupts.
import type { Hono } from 'hono'
import type { Deps } from '../deps'
import { mayAlsoRead } from '../auth'
import { afterReplyChatIds, inFlightChatIds, parkedChatIds, parkedEngineTurns } from '../chat/chat-routes'
import type { DownloadRecord } from '../downloads/downloads'
import { jevStatus } from './jev-status'
import { layaStatus } from './laya-status'
import { servingStatus, type ServingStatus } from './serving-status'

export interface ActiveWorkItem {
  /** `load`: a primary-engine model loading. `tune`: an auto-tune run (its own loads included).
   *  `skill`: a skill being written (in-chat save_skill, Save as skill, Learn from folder). */
  kind: 'chat' | 'code' | 'routine' | 'load' | 'tune' | 'skill'
  id: string
  label: string
}

export interface ActiveWork {
  /** Work in progress on the engine. */
  items: ActiveWorkItem[]
  /** Chats parked on a tool-call approval (kind `chat`): they wait on a person, not the engine, so
   *  they are not in `items`. A load, Stop or the approval wait (chatApprovalWaitMinutes) running
   *  out still ends them, so what asks what a load would interrupt reads `items` and `waiting`. */
  waiting: ActiveWorkItem[]
  /** A generation an API client or a Code terminal agent is running through the gateway. It has
   *  no item of its own: the daemon knows a request is in flight, not whose it is. */
  engineGenerating: boolean
}

/** Where the chats come from (chat-routes.ts). A test seam only — every caller takes the default. */
export interface ChatSources {
  /** Chats whose turn holds their in-flight slot (parked ones included). */
  inFlight: () => string[]
  /** Those of them parked on a tool-call approval. */
  parked: () => string[]
  /** Chats whose finished reply's auto-title or auto-memory call is still pending. */
  afterReply: () => string[]
  /** How many of the engine's in-progress generations are parked chat turns. */
  parkedGenerations: () => number
}

const CHAT_SOURCES: ChatSources = { inFlight: inFlightChatIds, parked: parkedChatIds, afterReply: afterReplyChatIds, parkedGenerations: parkedEngineTurns }

const UNTITLED = 'Untitled'

export function activeWork(d: Deps, sources: Partial<ChatSources> = {}): ActiveWork {
  const chats = { ...CHAT_SOURCES, ...sources }
  const parked = new Set(chats.parked())
  // A chat is listed once: running (a turn, or its title or memory call), else waiting.
  const running = [...new Set([...chats.inFlight().filter((id) => !parked.has(id)), ...chats.afterReply()])]
  const waiting = [...parked].filter((id) => !running.includes(id))
  return {
    items: [...chatItems(d, running), ...codeItems(d), ...routineItems(d), ...loadItems(d), ...tuneItems(d), ...skillItems(d)],
    waiting: chatItems(d, waiting),
    engineGenerating: engineIsGenerating(d, chats.parkedGenerations()),
  }
}

/** A download the Android app's poll counts as work (running or queued), with the fields its notification reads, as
 *  GET /api/v1/downloads gives them. */
export type LiveDownload = Pick<DownloadRecord, 'name' | 'status' | 'received' | 'total' | 'bytesPerSec'>

/** The fields of GET /api/v1/status the Android app's poll reads, in the same names and shapes: whether a model is
 *  held (the primary engine's state, `poolModels`, a Jev or Laya model) and its name, and the server features on. */
export interface PollStatus {
  engine: { state: string }
  model: { name: string } | null
  poolModels: number
  jev: { name: string } | null
  laya: { name: string } | null
  serving: ServingStatus
}

/** The activity, plus what the Android app's poll read from two more requests every 3 s (each with its own proof
 *  connection): `downloads`, the running and queued rows of GET /api/v1/downloads, and `status`, its fields of GET
 *  /api/v1/status. Each only for a caller that route would answer (mayAlsoRead: a remote-access token needs
 *  downloads:read and config:read for them); absent otherwise, as from a daemon before them, which a client reads as
 *  "ask that route". */
export function registerActivityRoutes(app: Hono, d: Deps): void {
  app.get('/api/v1/activity', (c) => c.json({
    ...activeWork(d),
    ...(mayAlsoRead(c, d, '/api/v1/downloads') ? { downloads: liveDownloads(d) } : {}),
    ...(mayAlsoRead(c, d, '/api/v1/status') ? { status: pollStatus(d) } : {}),
  }))
}

function liveDownloads(d: Deps): LiveDownload[] {
  return d.downloads.list()
    .filter((r) => r.status === 'downloading' || r.status === 'queued')
    .map(({ name, status, received, total, bytesPerSec }) => ({ name, status, received, total, bytesPerSec }))
}

function pollStatus(d: Deps): PollStatus {
  const ms = d.manager.status()
  const jev = jevStatus(d)
  const laya = layaStatus(d)
  return {
    engine: { state: ms.state },
    model: ms.model ? { name: ms.model.name } : null,
    poolModels: d.modelRouter.poolModelCount(),
    jev: jev ? { name: jev.name } : null,
    laya: laya ? { name: laya.name } : null,
    serving: servingStatus(d),
  }
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

/** A primary-engine load (a model loading or restarting, a gateway auto-swap, a routine's swap):
 *  the engine is busy though nothing generates yet. Not while auto-tune runs, whose candidate
 *  loads are its own item. */
function loadItems(d: Deps): ActiveWorkItem[] {
  const st = d.manager.status()
  if (st.state !== 'starting' || d.bench?.isRunning()) return []
  return [{ kind: 'load', id: st.model?.key ?? '', label: st.model?.name || st.model?.key || UNTITLED }]
}

/** An auto-tune run: it loads and benchmarks one candidate after another on the engine. */
function tuneItems(d: Deps): ActiveWorkItem[] {
  if (!d.bench?.isRunning()) return []
  const key = d.bench.status().modelKey ?? ''
  return [{ kind: 'tune', id: key, label: d.scanner?.get(key)?.name || key || UNTITLED }]
}

/** A skill being written (agents/skill-jobs.ts, agent-routes.ts's Learn from folder): it calls the
 *  engine directly, with no generationStart, so engineGenerating does not see it. Learn from folder's
 *  own label names the host folder (`Learning from <path>`), and this list reaches callers that may
 *  not see host paths (a remote-access token with models:load), so it is named generically here. */
function skillItems(d: Deps): ActiveWorkItem[] {
  return (d.agentTasks?.list() ?? [])
    .filter((t) => t.status === 'running' && t.kind.startsWith('skill_'))
    .map((t) => ({ kind: 'skill', id: t.id, label: t.kind === 'skill_from_folder' ? 'Learning skills from a folder' : t.label }))
}

function conversationTitle(d: Deps, convId: string): string {
  return d.db.getConversation(convId)?.title || UNTITLED
}

/** A local chat turn counts as a generation from its first request to its end, its approval waits
 *  included; `parked` of them wait on a person (they are in `waiting`), so they do not count here. */
function engineIsGenerating(d: Deps, parked: number): boolean {
  return d.manager.status().state === 'running' && (d.manager.sessionStats()?.activeRequests ?? 0) - parked > 0
}

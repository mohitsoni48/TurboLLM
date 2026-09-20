// Which Workspace the user gets (ADR-434 (b), (i)(1)): while a Jev model is loaded, Workspace
// is the Jev Playground and nothing else — Chat, Code and Routines are hidden, not killed.
//
// Pure on purpose. The gate that calls this runs on every /workspace* render, and the one
// failure mode that matters is a redirect loop, so the rules have to be testable without a
// router, a store or a poll.
import type { ModelEntry, Status } from './types'

export const JEV_PATH = '/workspace/jev'

/** 'unknown' is a real answer, not a missing one: a Turbo Link token scoped to `models:use`
 *  cannot read /status at all, and guessing "none" would bounce a deep link. */
export type JevPresence = 'unknown' | 'none' | 'loaded'

const CHAT_PATH = '/workspace/chat'

const WORK_PATHS = [CHAT_PATH, '/workspace/code', '/workspace/routines']

/** Status is the authority; the models list is the fallback for a client that cannot read it. */
export function jevPresence(status: Status | undefined, models: ModelEntry[] | undefined): JevPresence {
  if (status && 'jev' in status) return status.jev ? 'loaded' : 'none'
  if (models) return models.some((m) => m.jev && m.loaded) ? 'loaded' : 'none'
  return 'unknown'
}

/** The three sections a loaded Jev model takes over. Exact path or a sub-route of it —
 *  '/workspace/chatter' is a different section, not a chat. */
export function isWorkspaceWorkPath(pathname: string): boolean {
  return WORK_PATHS.some((p) => isAtOrUnder(pathname, p))
}

/** Where this Workspace URL really belongs, or null to leave it alone. `notice` asks the
 *  destination to explain itself — only the trip INTO the playground needs explaining. */
export function workspaceRedirect(
  pathname: string,
  presence: JevPresence,
): { to: string; notice: boolean } | null {
  if (presence === 'unknown') return null
  if (presence === 'loaded' && isWorkspaceWorkPath(pathname)) return { to: JEV_PATH, notice: true }
  if (presence === 'none' && isAtOrUnder(pathname, JEV_PATH)) return { to: CHAT_PATH, notice: false }
  return null
}

function isAtOrUnder(pathname: string, section: string): boolean {
  return pathname === section || pathname.startsWith(`${section}/`)
}

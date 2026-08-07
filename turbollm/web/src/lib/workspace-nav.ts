// Remembers which /workspace/* sub-route (a Chat conversation, a Code session, or Routines) the
// user last had open, so clicking/pressing the Workspace nav item from elsewhere in the app
// (Usage, Models, Engines, ...) returns to it — instead of always landing on a blank new chat.
//
// Founder-reported: "workspace -> code -> a particular chat -> usage -> back to workspace" landed
// on a NEW chat, not the Code session that was actually open. Root cause: Shell.tsx's NAV array
// hardcodes the Workspace entry's `to` as the literal string '/workspace', which App.tsx's own
// `<Route path="/workspace" element={<Navigate to="/workspace/chat" replace />} />` always
// resolves to plain Chat — there was never anywhere for "which sub-route" to be remembered.
//
// Session-scoped (sessionStorage, not localStorage) — this is "where was I in this browser
// session", not a durable cross-session preference like theme/fontSize (stores/ui.ts). A fresh
// browser session starts clean on Chat, same as today.

const KEY = 'tllm.workspace.lastPath'
const DEFAULT_PATH = '/workspace/chat'

/** The /workspace/* path to return to. Falls back to plain Chat when nothing's been recorded yet
 *  (fresh session) or storage is unavailable (private browsing). */
export function getLastWorkspacePath(): string {
  try {
    const v = sessionStorage.getItem(KEY)
    return v && v.startsWith('/workspace/') ? v : DEFAULT_PATH
  } catch {
    return DEFAULT_PATH
  }
}

/** Call on every route change (Shell.tsx). No-op for anything outside /workspace — leaving
 *  Workspace for another section must not overwrite what was remembered there. */
export function rememberWorkspacePath(pathname: string): void {
  if (!pathname.startsWith('/workspace/')) return
  try {
    sessionStorage.setItem(KEY, pathname)
  } catch {
    /* private browsing / storage disabled — the nav link just falls back to the default */
  }
}

/** Resolve a NAV entry's static `to` to its real navigation target — only the Workspace entry is
 *  dynamic; every other entry passes through unchanged. Centralized so the desktop rail, the
 *  Ctrl+1-9 shortcut, and the mobile nav bar (Shell.tsx, three separate render sites) can't drift. */
export function resolveNavTarget(to: string): string {
  return to === '/workspace' ? getLastWorkspacePath() : to
}

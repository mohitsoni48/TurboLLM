import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Truncate a long path in the middle, keeping the head and tail readable. */
export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value
  const keep = Math.floor((max - 1) / 2)
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`
}

/** Last path segment of a repo root, for a compact "which folder is this" chip —
 *  splits on both separators since repoRoot is a server-reported string, not something
 *  this platform's own path module can parse (a Windows daemon reports backslash paths
 *  even when read by browser JS on any OS). */
export function folderName(repoRoot: string): string {
  const parts = repoRoot.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? repoRoot
}

// ── Last-opened id per Workspace mode ──────────────────────────────────────────
//
// The Chat|Code pill in ConversationSidebar.tsx used to always link to the bare
// /workspace/chat or /workspace/code root, so switching modes and switching back lost
// whatever conversation/session was open. Screens call the write*() half on mount/id-change;
// the sidebar's mode pill calls the read*() half to build its link target. Same
// try/catch-wrapped localStorage convention as SidebarResizeHandle.tsx's width persistence.
const LAST_CHAT_CONV_KEY = 'tllm-last-chat-conv'
const LAST_CODE_SESSION_KEY = 'tllm-last-code-session'

export function readLastChatConvId(): string | null {
  try { return localStorage.getItem(LAST_CHAT_CONV_KEY) } catch { return null }
}
export function writeLastChatConvId(id: string): void {
  try { localStorage.setItem(LAST_CHAT_CONV_KEY, id) } catch { /* quota / disabled storage */ }
}
export function readLastCodeSessionId(): string | null {
  try { return localStorage.getItem(LAST_CODE_SESSION_KEY) } catch { return null }
}
export function writeLastCodeSessionId(id: string): void {
  try { localStorage.setItem(LAST_CODE_SESSION_KEY, id) } catch { /* quota / disabled storage */ }
}

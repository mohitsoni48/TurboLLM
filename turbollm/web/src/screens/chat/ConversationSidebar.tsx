import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AlarmClock, Archive, ArchiveRestore, ChevronDown, ChevronLeft, ChevronRight, Circle, Download, Folder as FolderIcon, FolderInput, FolderPlus, Loader2, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Plus, Search, SquareTerminal, Trash2 } from 'lucide-react'
import type { Conversation, Folder } from '../../lib/chat-types'
import { useConversationMutations, useConversations, useFolders } from '../../lib/chat-queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { toast } from '../../components/ui/sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { cn, folderName, readLastChatConvId, readLastCodeSessionId } from '../../lib/utils'
import { Skeleton } from '../../components/ui/skeleton'
import { useArchiveCodeSession, useCodeSessionRename, useCodeSessions, useDeleteCodeSession } from '../../lib/code-queries'
import { useCodeFeatureEnabled } from '../../lib/platform'
import type { CodeSession, CodeSessionFilter, SessionStatus } from '../../lib/code-types'
import { ApiError, track } from '../../lib/api'
import { useRoutinesWithLatestRun, type RoutineWithLatestRun } from '../../lib/routine-queries'
import { deriveRoutineDisplayStatus } from '../../lib/routine-status'
import { RoutineStatusBadge } from '../../components/routines/RoutineStatusBadge'
import { useSettings } from '../../lib/queries'

/** localStorage key for the client-only "confirm before deleting a conversation"
 *  preference (mirrors SettingsScreen). Default ON when unset. */
const CONFIRM_DELETE_KEY = 'tllm.confirmDeleteConversation'
const confirmDeleteEnabled = (): boolean => localStorage.getItem(CONFIRM_DELETE_KEY) !== 'false'

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000)  return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

// ── Code sessions list ───────────────────────────────────────────────────────
//
// Real agent-run sessions from GET /api/v1/code/sessions, surfaced here the same
// way chat conversations are: a search-filterable, click-to-open list with
// hover-revealed detail. Rendered flat, with no wrapping section header/folder —
// Code mode shows nothing else in the sidebar (see `isCodeMode` below), so a
// "Code sessions" label would just be restating what's already established by
// the mode itself, the same way the plain chat list has no "Chat" header.

const CODE_STATUS_DOT: Record<SessionStatus, string> = {
  merged: 'var(--ok)',
  review: 'var(--warn)',
  done: 'var(--info)',
  aborted: 'var(--faint)',
}
const CODE_STATUS_LABEL: Record<SessionStatus, string> = {
  merged: 'Merged',
  review: 'Needs review',
  done: 'Done',
  aborted: 'Aborted',
}

/** Skeleton row matching CodeSessionItem's exact layout (status dot + title + subtitle line) —
 *  spec 11 §8: never a bare spinner/text, show the shape of what's coming. */
function CodeSessionSkeletonRow() {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full" />
        <Skeleton className="h-3.5 w-[65%]" />
      </div>
      <Skeleton className="h-2.5 w-[85%]" />
    </div>
  )
}

function CodeSessionItem({
  session, active, onOpen, onRequestDelete,
}: {
  session: CodeSession
  active: boolean
  onOpen: () => void
  onRequestDelete: () => void
}) {
  // Rename: same double-click / Enter-to-commit UX as ConvItem below, through the
  // shared useCodeSessionRename hook (also used by CodeSessionScreen's header).
  const rename = useCodeSessionRename(session.id, session.title)
  const archiveMut = useArchiveCodeSession()
  const archived = !!session.archivedAt
  const toggleArchive = () => {
    track('code', 'archive_code_session')
    archiveMut.mutate(
      { id: session.id, archived: !archived },
      {
        onSuccess: () => toast.success(archived ? 'Session unarchived' : 'Session archived'),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : `Could not ${archived ? 'unarchive' : 'archive'} session.`),
      },
    )
  }
  const open = () => { track('code', 'open_code_session'); onOpen() }
  return (
    <div
      onClick={() => !rename.editing && open()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !rename.editing) open() }}
      className="group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 transition-colors"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {/* Live indicator (ADR-256) — overrides the static status dot whenever the daemon
            reports this run as actually active right now, including sessions running in the
            background (tab not open elsewhere). `session.running` comes from the polled sidebar
            list query (useCodeSessions, 5s interval) — no per-open-tab tracking needed. Without
            this, a background-running session's status collapses to the same amber "review" dot
            as a long-finished, unreviewed one (toSessionStatus in code-routes.ts), indistinguishable
            from actually generating. */}
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', session.running && 'tllm-pulse')}
          style={{ background: session.running ? 'var(--ok)' : CODE_STATUS_DOT[session.status] }}
          aria-hidden
        />
        {rename.editing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none"
            value={rename.draft}
            onChange={(e) => rename.setDraft(e.target.value)}
            onBlur={rename.commit}
            onKeyDown={(e) => { if (e.key === 'Enter') rename.commit(); if (e.key === 'Escape') rename.cancel() }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="min-w-0 truncate text-[13px] font-medium text-ink"
            style={{ color: active ? 'var(--accent)' : undefined }}
            onDoubleClick={(e) => { e.stopPropagation(); rename.start() }}
          >
            {session.title}
          </span>
        )}
      </div>
      <span className="truncate text-[11px] text-faint">
        {archived ? 'Archived · ' : ''}{session.running ? 'Running' : CODE_STATUS_LABEL[session.status]} · {folderName(session.repoRoot)}{session.branch ? ` · ${session.branch}` : ''} · {session.when}
      </span>
      {/* Hover reveal: diff stats + actions menu + open affordance — same interaction
          language as ConvItem's hover-revealed folder-move/rename buttons. */}
      {!rename.editing && (
        <div className="hover-actions absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {session.status !== 'aborted' && (session.add > 0 || session.del > 0) && (
            <span className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[10px] tabular-nums">
              <span style={{ color: 'var(--ok)' }}>+{session.add}</span>{' '}
              <span style={{ color: 'var(--err)' }}>&minus;{session.del}</span>
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-faint transition-colors hover:text-ink data-[state=open]:text-ink"
                title="Session actions"
                // Session-specific, not the generic "Session actions" the title tooltip uses —
                // this button repeats once per row, so a shared name would be ambiguous to a
                // screen reader across multiple sessions (final gate, spec 16 §9 item 4; also
                // caught colliding with CodeSessionScreen.tsx's own header button of the same
                // generic name when both are on screen at once).
                aria-label={`Actions for ${session.title}`}
              >
                <MoreHorizontal size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => { track('code', 'rename_code_session'); rename.start() }}>
                <Pencil size={13} /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleArchive}>
                {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                {archived ? 'Unarchive' : 'Archive'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onRequestDelete}>
                <Trash2 size={13} /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ChevronRight size={13} className="shrink-0 text-faint" />
        </div>
      )}
    </div>
  )
}

const CODE_FILTER_OPTIONS: { value: CodeSessionFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
]

function CodeSessionsList({ q, onRequestDelete }: { q: string; onRequestDelete: (session: CodeSession) => void }) {
  const navigate = useNavigate()
  const { sessionId: activeSessionId } = useParams<{ sessionId?: string }>()
  // Not persisted — resets to 'active' on remount, same as chat's open-folder state above.
  const [filter, setFilter] = useState<CodeSessionFilter>('active')
  const sessionsQ = useCodeSessions(filter)
  const sessions = sessionsQ.data?.sessions ?? []
  const filtered = q.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(q.trim().toLowerCase()))
    : sessions

  return (
    <>
      <div className="flex justify-center px-2 pb-2">
        <div className="flex overflow-hidden rounded-md border border-border text-[11px]" role="group" aria-label="Filter sessions">
          {CODE_FILTER_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { track('code', 'filter_code_sessions'); setFilter(o.value) }}
              className="px-2.5 py-1 font-medium transition-colors"
              style={{
                background: filter === o.value ? 'var(--accent)' : 'transparent',
                color: filter === o.value ? 'var(--on-accent)' : 'var(--muted)',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {sessionsQ.isLoading ? (
        <>
          <CodeSessionSkeletonRow />
          <CodeSessionSkeletonRow />
          <CodeSessionSkeletonRow />
        </>
      ) : filtered.length === 0 ? (
        <p className="px-3 py-4 text-[12px] text-faint">
          {q.trim() ? 'No results.' : filter === 'archived' ? 'No archived sessions.' : 'No code sessions yet.'}
        </p>
      ) : (
        filtered.map((s) => (
          <CodeSessionItem
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            onOpen={() => navigate(`/workspace/code/${s.id}`)}
            onRequestDelete={() => onRequestDelete(s)}
          />
        ))
      )}
    </>
  )
}

// ── Routines list ────────────────────────────────────────────────────────────
//
// Same "search-filterable, click-to-open list" pattern as the chat/code lists above — Routines
// is a real third Workspace mode now (spec 20 §2.1's own follow-up: it used to be a single link
// pinned above the Code session list, which read as bolted onto Code mode rather than a peer of
// it). Rendered flat, no section header, same reasoning as CodeSessionsList's own.

function lastRunSummary(item: RoutineWithLatestRun): string {
  const run = item.latestRun
  if (!run) return item.routine.status === 'pending_confirmation' ? 'Awaiting confirmation' : 'Never run yet'
  const when = new Date(run.startedAt).toLocaleString()
  if (run.status === 'ok') return `Ran successfully · ${when}`
  if (run.status === 'running') return `Running now · started ${when}`
  if (run.status === 'needs_approval') return `Stalled, needs approval · ${when}`
  if (run.status === 'skipped') return `Skipped${run.skipReason ? ` (${run.skipReason})` : ''} · ${when}`
  return `Errored${run.error ? `: ${run.error}` : ''} · ${when}`
}

function RoutineSidebarItem({ item, active, onOpen }: { item: RoutineWithLatestRun; active: boolean; onOpen: () => void }) {
  const { routine } = item
  const status = deriveRoutineDisplayStatus(routine, item.latestRun)
  const open = () => { track('routines', 'open_routine'); onOpen() }
  return (
    <div
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') open() }}
      className="flex cursor-pointer flex-col gap-1 rounded-md px-3 py-2 transition-colors"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink"
          style={{ color: active ? 'var(--accent)' : undefined }}
        >
          {routine.prompt}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <RoutineStatusBadge status={status} />
        <span className="min-w-0 truncate text-[11px] text-faint">{lastRunSummary(item)}</span>
      </div>
    </div>
  )
}

function RoutinesList({ q }: { q: string }) {
  const navigate = useNavigate()
  const { routineId: activeRoutineId } = useParams<{ routineId?: string }>()
  const { items, isLoading } = useRoutinesWithLatestRun()
  const filtered = q.trim()
    ? items.filter((it) => it.routine.prompt.toLowerCase().includes(q.trim().toLowerCase()))
    : items

  if (isLoading) {
    return (
      <>
        <CodeSessionSkeletonRow />
        <CodeSessionSkeletonRow />
      </>
    )
  }
  if (filtered.length === 0) {
    return <p className="px-3 py-4 text-[12px] text-faint">{q.trim() ? 'No results.' : 'No routines yet.'}</p>
  }
  return (
    <>
      {filtered.map((item) => (
        <RoutineSidebarItem
          key={item.routine.id}
          item={item}
          active={item.routine.id === activeRoutineId}
          onOpen={() => navigate(`/workspace/routines/${item.routine.id}`)}
        />
      ))}
    </>
  )
}

export function ConversationSidebar({
  activeId,
  onSelect,
  onNew,
  onImport,
  collapsed,
  onToggle,
  generating,
  generatingIds,
  recentlyCompletedIds,
  onDeleted,
}: {
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  /** Called when the user clicks "Import chat" — opens the file picker in the parent. */
  onImport?: () => void
  collapsed?: boolean
  onToggle?: () => void
  /** True when a generation is streaming in the active conversation. */
  generating?: boolean
  /** Ids of every conversation currently streaming a generation (including ones the
   *  user has navigated away from) — drives the spinning in-progress indicator. */
  generatingIds?: Set<string>
  /** Ids of conversations whose generation finished while the user was elsewhere —
   *  drives the "new result" dot until the user visits that conversation. */
  recentlyCompletedIds?: Set<string>
  /** Called after a conversation is deleted so the parent can clear its active
   *  reference when the deleted conversation was the open one. */
  onDeleted?: (id: string) => void
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // Only set while viewing an actual Code session (/workspace/code/:sessionId) — used to tell
  // whether a deleted session was the one currently open, so we can navigate away from it.
  const { sessionId: activeCodeSessionId } = useParams<{ sessionId?: string }>()
  // Workspace has three mutually-exclusive modes sharing this one sidebar column — Chat mode
  // shows chat folders/conversations, Code mode shows code sessions, Routines mode shows
  // routines, never more than one at once. Route is the single source of truth for which is
  // active. Routines lives at /workspace/routines/* (a peer path, not nested under
  // /workspace/code/*), so this is a plain three-way switch — no exclusion logic needed.
  const mode: 'chat' | 'code' | 'routines' = pathname.startsWith('/workspace/routines')
    ? 'routines'
    : pathname.startsWith('/workspace/code') ? 'code' : 'chat'
  const isCodeMode = mode === 'code'
  const isRoutinesMode = mode === 'routines'
  // Routines is experimental, off by default (Settings → Experimental) — the mode tab itself is
  // the "hidden" half of "hidden UI + can't be created from chat or code"; App.tsx's own gate on
  // the /workspace/routines* routes is what stops a stale link or typed URL from reaching
  // `isRoutinesMode` in the first place, so this file never needs to fall back out of it.
  const routinesEnabled = useSettings().query.data?.experimental?.routines ?? false
  // Code is cut from the Android release (platform.ts). Same shape as `routinesEnabled` right
  // above — the tab is omitted, and App.tsx's route gate is what keeps `isCodeMode` from being
  // reachable at all there, so nothing below needs an Android branch of its own. `=== true`
  // rather than a truthy check is load-bearing: the hook's third state is "sysinfo hasn't
  // answered yet", and rendering the tab through that window would flash Code onto the Android
  // app and then remove it. Costs desktop one beat before the tab appears; see the hook's
  // header for why that trade goes this way.
  const codeEnabled = useCodeFeatureEnabled() === true
  // Switching modes restores whatever conversation/session was last open in the OTHER
  // mode, instead of always resetting to that mode's list/launchpad root. Routines has no
  // such memory yet — it always lands on the list, same as a first-ever visit to Chat/Code
  // would if lastChatConvId/lastCodeSessionId were never set.
  const lastChatConvId = readLastChatConvId()
  const chatModeHref = lastChatConvId ? `/workspace/chat/${lastChatConvId}` : '/workspace/chat'
  const lastCodeSessionId = readLastCodeSessionId()
  const codeModeHref = lastCodeSessionId ? `/workspace/code/${lastCodeSessionId}` : '/workspace/code'
  const routinesModeHref = '/workspace/routines'
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  // Conversation queued for a confirmation dialog (null = dialog closed).
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  // Folder queued for a delete-confirmation dialog (null = dialog closed).
  const [pendingFolderDelete, setPendingFolderDelete] = useState<Folder | null>(null)
  // Code session queued for a delete-confirmation dialog (null = dialog closed). Always
  // confirmed (unlike chat's optional "confirm before delete" setting) — a Code session
  // carries repo/branch/worktree context that's more costly to lose than a chat.
  const [pendingCodeDelete, setPendingCodeDelete] = useState<CodeSession | null>(null)
  const deleteCodeMut = useDeleteCodeSession()
  const doDeleteCodeSession = (session: CodeSession) => {
    track('code', 'delete_code_session')
    const wasActive = session.id === activeCodeSessionId
    deleteCodeMut.mutate(session.id, {
      onSuccess: () => {
        toast.success('Session deleted')
        if (wasActive) navigate('/workspace/code')
      },
      onError: () => { toast.error('Could not delete session.') },
    })
  }
  // Which folder sections are open. Not persisted — resets on remount.
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  // True while the inline "new folder" name input is showing.
  const [addingFolder, setAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const mut = useConversationMutations()
  const convsQ = useConversations(debouncedQ || undefined)
  const convs = convsQ.data?.conversations ?? []
  const foldersQ = useFolders()
  const folders = foldersQ.data?.folders ?? []

  const searching = !!debouncedQ

  // Bucket conversations by folderId (only used when not searching). Conversations
  // whose folderId is null/undefined OR points at a folder that no longer exists fall
  // into the "ungrouped" bucket.
  const { byFolder, ungrouped } = useMemo(() => {
    const known = new Set(folders.map((f) => f.id))
    const byFolder = new Map<string, Conversation[]>()
    const ungrouped: Conversation[] = []
    for (const conv of convs) {
      const fid = conv.folderId
      if (fid && known.has(fid)) {
        const arr = byFolder.get(fid) ?? []
        arr.push(conv)
        byFolder.set(fid, arr)
      } else {
        ungrouped.push(conv)
      }
    }
    return { byFolder, ungrouped }
  }, [convs, folders])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200)
    return () => clearTimeout(t)
  }, [q])

  // Ctrl+K focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const toggleFolder = (id: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Actually delete a conversation. If it was the active one, tell the parent so
  // it can close/clear the now-dangling reference.
  const doDelete = (conv: Conversation) => {
    track('chat', 'delete_conversation')
    const wasActive = conv.id === activeId
    mut.remove.mutate(conv.id, {
      onSuccess: () => {
        toast.success('Conversation deleted')
        if (wasActive) onDeleted?.(conv.id)
      },
      onError: () => { toast.error('Could not delete conversation.') },
    })
  }

  const onDelete = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    // When confirmation is enabled, queue the dialog; otherwise delete immediately.
    if (confirmDeleteEnabled()) setPendingDelete(conv)
    else doDelete(conv)
  }

  const onMove = (conv: Conversation, folderId: string | null) => {
    mut.moveToFolder.mutate(
      { convId: conv.id, folderId },
      { onError: () => { toast.error('Could not move conversation.') } },
    )
  }

  const commitNewFolder = () => {
    const name = newFolderName.trim()
    setAddingFolder(false)
    setNewFolderName('')
    if (!name) return
    mut.createFolder.mutate(name, {
      onSuccess: (folder) => { setOpenFolders((prev) => new Set(prev).add(folder.id)) },
      onError: () => { toast.error('Could not create folder.') },
    })
  }

  const doDeleteFolder = (folder: Folder) => {
    track('chat', 'delete_folder')
    mut.deleteFolder.mutate(folder.id, {
      onSuccess: () => { toast.success('Folder deleted') },
      onError: () => { toast.error('Could not delete folder.') },
    })
  }

  // Warn that an in-flight generation will be lost only when deleting the active,
  // currently-generating conversation.
  const pendingIsActiveGenerating = !!pendingDelete && pendingDelete.id === activeId && !!generating

  // Data-driven mode switch — was two copy-pasted Chat/Code blocks (one per render form,
  // collapsed rail vs. expanded pill); adding Routines as a genuine third tab as a THIRD
  // copy-pasted block would have kept the exact "looks bolted on" problem this fixes, just with
  // one more repetition of it. `label` doubles as the accessible name AND the visible text.
  const modeTabs: { mode: 'chat' | 'code' | 'routines'; href: string; label: string; icon: typeof MessageSquare }[] = [
    { mode: 'chat', href: chatModeHref, label: 'Chat', icon: MessageSquare },
    // Omitted entirely on Android (feature cut there) — same treatment as Routines below.
    ...(codeEnabled ? [{ mode: 'code' as const, href: codeModeHref, label: 'Code', icon: SquareTerminal }] : []),
    // Omitted entirely (not just disabled) while the experimental flag is off — see
    // `routinesEnabled`'s own comment above.
    ...(routinesEnabled ? [{ mode: 'routines' as const, href: routinesModeHref, label: 'Routines', icon: AlarmClock }] : []),
  ]
  const newLabel = mode === 'code' ? 'New session' : mode === 'routines' ? 'New routine' : 'New chat (Ctrl+N)'
  const NewIcon = mode === 'chat' ? MessageSquarePlus : Plus
  // One shared action per mode rather than a single generic "new" — the founder wants
  // chat/code/routine creation volume distinguishable, not folded into one bucket.
  const newAction = mode === 'code' ? 'new_code_session' : mode === 'routines' ? 'new_routine' : 'new_chat'
  const trackNew = () => { track(mode, newAction); onNew() }
  const trackToggle = () => { track(mode, 'toggle_sidebar_collapsed'); onToggle?.() }
  const trackImport = () => { track('chat', 'import_chat'); onImport?.() }

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 border-r border-border bg-panel-2 py-3">
        {onToggle && (
          <Button size="icon" variant="ghost" onClick={trackToggle} title="Expand sidebar" className="h-7 w-7">
            <ChevronRight size={15} />
          </Button>
        )}
        {/* Mode switch (Chat|Code|Routines), collapsed-rail icon form — same active/inactive
            treatment as the app's own NavRail (Shell.tsx), since these read as nav-adjacent
            icons here rather than a horizontal pill. */}
        {modeTabs.map(({ mode: m, href, label, icon: Icon }) => (
          <Link
            key={m}
            to={href}
            title={label}
            aria-current={mode === m ? 'page' : undefined}
            className={cn(
              'grid h-7 w-7 place-items-center rounded-md transition-colors',
              mode === m ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-panel hover:text-ink',
            )}
          >
            <Icon size={15} />
          </Link>
        ))}
        <Button size="icon" variant="ghost" onClick={trackNew} title={newLabel} className="h-7 w-7">
          <NewIcon size={15} />
        </Button>
        {mode === 'chat' && onImport && (
          <Button size="icon" variant="ghost" onClick={trackImport} title="Import chat (.turbollm-chat.json or OpenAI JSON)" className="h-7 w-7">
            <Download size={15} />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-panel-2">
      {/* Mode switch (Chat|Code|Routines) — mirrors the pill in CodeHomeScreen's own header,
          kept in sync via the route (`mode` above). Lets the user flip modes from the sidebar
          itself, not just the main content header. This replaced the old single-purpose
          "Code · preview" footer link. */}
      {/* QA_BUGS.md BUG-06: on mobile this sidebar renders as a `position: fixed` full-height
          drawer (ChatScreen.tsx), not inside Shell's own column — Shell's top-inset padding
          (Shell.tsx) never reaches a fixed-position element, so this pill needs the same
          `env(safe-area-inset-top)` applied directly here, or the status bar clock renders
          through it. 0 on desktop (this sidebar sits in normal flow there, beside content that
          already starts below any inset) and 0 on any browser with no inset to report. */}
      <div className="px-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="flex overflow-hidden rounded-lg border border-border" role="group" aria-label="Workspace mode">
          {modeTabs.map(({ mode: m, href, label, icon: Icon }) =>
            mode === m ? (
              <span
                key={m}
                aria-current="page"
                className="flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] font-medium"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                <Icon size={13} /> {label}
              </span>
            ) : (
              <Link
                key={m}
                to={href}
                className="flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-panel hover:text-ink"
              >
                <Icon size={13} /> {label}
              </Link>
            ),
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        {onToggle && (
          <Button size="icon" variant="ghost" onClick={trackToggle} title="Collapse sidebar" className="h-7 w-7 shrink-0">
            <ChevronLeft size={15} />
          </Button>
        )}
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        {/* New folder / Import are chat-only actions — hidden in Code and Routines modes
            rather than left dangling above a list they don't act on. New (chat/session/routine)
            applies to all three modes — onNew is wired per-mode by whichever screen renders
            this sidebar. */}
        <Button
          size="icon"
          variant="ghost"
          onClick={trackNew}
          title={newLabel}
          className="h-7 w-7 shrink-0"
        >
          <NewIcon size={15} />
        </Button>
        {mode === 'chat' && (
          <Button size="icon" variant="ghost" onClick={() => { track('chat', 'new_folder'); setAddingFolder(true); setNewFolderName('') }} title="New folder" className="h-7 w-7 shrink-0">
            <FolderPlus size={15} />
          </Button>
        )}
        {mode === 'chat' && onImport && (
          <Button size="icon" variant="ghost" onClick={trackImport} title="Import chat (.turbollm-chat.json or OpenAI JSON)" className="h-7 w-7 shrink-0">
            <Download size={15} />
          </Button>
        )}
      </div>

      {/* Inline "new folder" name input — mirrors the conversation-rename inline UX. */}
      {mode === 'chat' && addingFolder && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <FolderIcon size={13} className="shrink-0 text-faint" />
          <input
            autoFocus
            className="w-full bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-faint"
            value={newFolderName}
            placeholder="Folder name…"
            onChange={(e) => setNewFolderName(e.target.value)}
            onBlur={commitNewFolder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNewFolder()
              if (e.key === 'Escape') { setAddingFolder(false); setNewFolderName('') }
            }}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {isRoutinesMode ? (
          // Routines mode: ONLY routines, flat (no section header, same reasoning as the code
          // list's own). No longer a link pinned above the Code session list (spec 20 §2.1's
          // follow-up) — Routines is a peer mode now, with its own list here.
          <RoutinesList q={debouncedQ} />
        ) : isCodeMode ? (
          // Code mode: ONLY code sessions, flat (no section header — see
          // CodeSessionsList above) — never co-displayed with chat history
          // (that was the bug this replaced: both histories showing at once).
          <CodeSessionsList q={debouncedQ} onRequestDelete={setPendingCodeDelete} />
        ) : (
          // Chat mode: ONLY chat folders/conversations — unchanged from how this
          // behaved before the Code section existed.
          <>
            {/* When searching, keep the flat, ungrouped list exactly as before. */}
            {searching ? (
              <>
                {convs.length === 0 && (
                  <p className="px-3 py-4 text-[12px] text-faint">No results.</p>
                )}
                {convs.map((conv) => (
                  <ConvItem
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeId}
                    folders={folders}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onMove={onMove}
                    generating={generatingIds?.has(conv.id)}
                    recentlyCompleted={recentlyCompletedIds?.has(conv.id)}
                  />
                ))}
              </>
            ) : (
              <>
                {convs.length === 0 && folders.length === 0 && (
                  <p className="px-3 py-4 text-[12px] text-faint">No conversations yet.</p>
                )}

                {/* One collapsible section per folder. */}
                {folders.map((folder) => (
                  <FolderSection
                    key={folder.id}
                    folder={folder}
                    items={byFolder.get(folder.id) ?? []}
                    open={openFolders.has(folder.id)}
                    onToggle={() => toggleFolder(folder.id)}
                    onRequestDelete={() => setPendingFolderDelete(folder)}
                    activeId={activeId}
                    folders={folders}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onMove={onMove}
                    generatingIds={generatingIds}
                    recentlyCompletedIds={recentlyCompletedIds}
                  />
                ))}

                {/* Explicit "Uncategorized" label so it reads as its own section rather than
                    blending into whichever folder happens to render above it — only shown
                    once folders exist at all (a flat list with no folders needs no label). */}
                {folders.length > 0 && ungrouped.length > 0 && (
                  <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                    Uncategorized
                  </div>
                )}
                {ungrouped.map((conv) => (
                  <ConvItem
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeId}
                    folders={folders}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onMove={onMove}
                    generating={generatingIds?.has(conv.id)}
                    recentlyCompleted={recentlyCompletedIds?.has(conv.id)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation (only shown when the "confirm before delete" setting is on). */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? (
                <>
                  <span className="font-medium text-ink">{pendingDelete.title || 'Untitled conversation'}</span>{' '}
                  will be permanently deleted. This can’t be undone.
                  {pendingIsActiveGenerating && (
                    <> A response is still generating in this conversation — it will be stopped and lost.</>
                  )}
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingDelete) doDelete(pendingDelete); setPendingDelete(null) }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Folder-delete confirmation. Folders can contain conversations, so always confirm. */}
      <AlertDialog open={!!pendingFolderDelete} onOpenChange={(open) => { if (!open) setPendingFolderDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingFolderDelete ? (
                <>
                  <span className="font-medium text-ink">{pendingFolderDelete.name}</span>{' '}
                  will be deleted. Conversations inside it won’t be deleted — they’ll move back to
                  Uncategorized.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingFolderDelete) doDeleteFolder(pendingFolderDelete); setPendingFolderDelete(null) }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Code session delete confirmation — always shown (no "skip confirm" setting, unlike
          chat's optional one): a session carries repo/branch/worktree context that's more
          costly to lose. Archiving is the reversible alternative, offered right in the menu. */}
      <AlertDialog open={!!pendingCodeDelete} onOpenChange={(open) => { if (!open) setPendingCodeDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCodeDelete ? (
                <>
                  <span className="font-medium text-ink">{pendingCodeDelete.title || 'Untitled session'}</span>{' '}
                  and its conversation will be permanently deleted. This can’t be undone — archive it instead
                  if you might want it back.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingCodeDelete) doDeleteCodeSession(pendingCodeDelete); setPendingCodeDelete(null) }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** A single collapsible folder section: header (chevron + name + count + actions
 *  dropdown) plus its member conversations. Rename is done inline, mirroring ConvItem's
 *  double-click / Enter-to-commit UX. Delete is confirmed by the parent via AlertDialog. */
function FolderSection({
  folder,
  items,
  open,
  onToggle,
  onRequestDelete,
  activeId,
  folders,
  onSelect,
  onDelete,
  onMove,
  generatingIds,
  recentlyCompletedIds,
}: {
  folder: Folder
  items: Conversation[]
  open: boolean
  onToggle: () => void
  onRequestDelete: () => void
  activeId: string | null
  folders: Folder[]
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
  onMove: (conv: Conversation, folderId: string | null) => void
  generatingIds?: Set<string>
  recentlyCompletedIds?: Set<string>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(folder.name)
  const mut = useConversationMutations()

  const commitRename = () => {
    setEditing(false)
    const name = draft.trim()
    if (!name || name === folder.name) { setDraft(folder.name); return }
    mut.renameFolder.mutate(
      { id: folder.id, name },
      { onError: () => { setDraft(folder.name); toast.error('Could not rename folder.') } },
    )
  }

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <div className="group/folder relative flex items-center rounded-md pr-1">
        {editing ? (
          <div className="flex flex-1 items-center gap-1.5 px-2 py-1.5">
            <FolderIcon size={13} className="shrink-0 text-faint" />
            <input
              autoFocus
              className="w-full bg-transparent text-[12px] font-semibold text-ink outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setDraft(folder.name); setEditing(false) } }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]">
            <ChevronDown size={13} className={`shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
            <FolderIcon size={13} className="shrink-0 text-faint" />
            <span className="truncate" onDoubleClick={(e) => { e.stopPropagation(); setDraft(folder.name); setEditing(true) }}>{folder.name}</span>
            <span className="ml-auto pl-1 text-[11px] font-normal text-faint">{items.length}</span>
          </CollapsibleTrigger>
        )}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-faint opacity-0 transition-opacity hover:text-ink group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                title="Folder actions"
              >
                <MoreHorizontal size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => { track('chat', 'rename_folder'); setDraft(folder.name); setEditing(true) }}>
                <Pencil size={13} /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={onRequestDelete}>
                <Trash2 size={13} /> Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <CollapsibleContent>
        {/* Left guide line brackets exactly which rows belong to this folder — a plain
            padding indent alone was too subtle to tell folder contents from the flat
            ungrouped list below. */}
        <div className="ml-3 border-l border-border pl-2">
          {items.length === 0 ? (
            <p className="px-3 py-1.5 text-[11px] text-faint">Empty folder</p>
          ) : (
            items.map((conv) => (
              <ConvItem
                key={conv.id}
                conv={conv}
                active={conv.id === activeId}
                folders={folders}
                onSelect={onSelect}
                onDelete={onDelete}
                onMove={onMove}
                generating={generatingIds?.has(conv.id)}
                recentlyCompleted={recentlyCompletedIds?.has(conv.id)}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ConvItem({
  conv,
  active,
  folders,
  onSelect,
  onDelete,
  onMove,
  generating,
  recentlyCompleted,
}: {
  conv: Conversation
  active: boolean
  folders: Folder[]
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
  onMove: (conv: Conversation, folderId: string | null) => void
  /** True while this conversation is streaming a generation (foreground or background). */
  generating?: boolean
  /** True when this conversation's generation finished while the user was elsewhere. */
  recentlyCompleted?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const mut = useConversationMutations()

  const commitRename = () => {
    setEditing(false)
    const title = draft.trim()
    if (!title || title === conv.title) { setDraft(conv.title); return }
    mut.update.mutate(
      { id: conv.id, title },
      { onError: () => { setDraft(conv.title); toast.error('Could not rename conversation.') } },
    )
  }

  const open = () => { track('chat', 'open_conversation'); onSelect(conv.id) }
  return (
    <div
      onClick={() => !editing && open()}
      className="group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 transition-colors"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
    >
      {editing ? (
        <input
          autoFocus
          className="w-full bg-transparent text-[13px] font-medium text-ink outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setDraft(conv.title); setEditing(false) } }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 truncate text-[13px] font-medium text-ink"
            style={{ color: active ? 'var(--accent)' : undefined }}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
          >
            {conv.title}
          </span>
          {generating && (
            <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} aria-label="Generating" />
          )}
          {!generating && recentlyCompleted && (
            <Circle size={7} className="shrink-0 fill-current text-accent" aria-label="New reply" />
          )}
        </div>
      )}
      <span className="text-[11px] text-faint">{relTime(conv.updatedAt)}</span>
      {!editing && (
        <div className="hover-actions absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-faint transition-colors hover:text-ink data-[state=open]:text-ink"
                title="Move to folder"
              >
                <FolderInput size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {folders.length === 0 && (
                <DropdownMenuItem disabled>No folders yet</DropdownMenuItem>
              )}
              {folders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  disabled={f.id === conv.folderId}
                  onSelect={() => { track('chat', 'move_conversation_to_folder'); onMove(conv, f.id) }}
                >
                  <FolderIcon size={13} /> {f.name}
                </DropdownMenuItem>
              ))}
              {conv.folderId && (
                <>
                  {folders.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => { track('chat', 'move_conversation_to_folder'); onMove(conv, null) }}>
                    Uncategorized
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); track('chat', 'rename_conversation'); setDraft(conv.title); setEditing(true) }}
            className="rounded p-1 text-faint transition-colors hover:text-ink"
            title="Rename conversation"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => onDelete(e, conv)}
            className="rounded p-1 text-faint transition-colors hover:text-err"
            title="Delete conversation"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

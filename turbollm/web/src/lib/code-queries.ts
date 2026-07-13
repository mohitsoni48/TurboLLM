import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  archiveCodeSession, clearCodeSession, deleteCodeSession, getCodeSession, listCodeSessions,
  resumeCodeSession, updateCodeSessionMode, updateCodeSessionTitle,
} from './code-api'
import type { CodeSessionFilter } from './code-types'
import { toast } from '../components/ui/sonner'

export const codeKeys = {
  list: (filter: CodeSessionFilter = 'active') => ['code-sessions', filter] as const,
  detail: (id: string | null) => ['code-session', id] as const,
}

/** Sidebar session list — polled gently; a code run can take a while, so there's no
 *  need for chat's faster cadence. Refetch is driven mostly by explicit invalidation
 *  from the session screen (on session create / turn completion). */
export function useCodeSessions(filter: CodeSessionFilter = 'active') {
  return useQuery({
    queryKey: codeKeys.list(filter),
    queryFn: () => listCodeSessions(filter),
    staleTime: 0,
    retry: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

/** Archive/unarchive — invalidates every filter's list (an archive moves a session between
 *  the active/archived buckets, and 'all' always needs a refetch either way). */
export function useArchiveCodeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; archived: boolean }) => archiveCodeSession(v.id, v.archived),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['code-sessions'] })
      void qc.invalidateQueries({ queryKey: codeKeys.detail(v.id) })
    },
  })
}

export function useDeleteCodeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCodeSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['code-sessions'] }),
  })
}

export function useClearCodeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => clearCodeSession(id),
    onSuccess: (_d, id) => void qc.invalidateQueries({ queryKey: codeKeys.detail(id) }),
  })
}

export function useResumeCodeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => resumeCodeSession(id),
    onSuccess: (_d, id) => void qc.invalidateQueries({ queryKey: codeKeys.detail(id) }),
  })
}

export function useCodeSession(id: string | null) {
  return useQuery({
    queryKey: codeKeys.detail(id),
    queryFn: () => getCodeSession(id!),
    enabled: !!id,
    retry: false,
    // Overrides the app's global refetchOnWindowFocus:false (main.tsx) for this one query:
    // without it, a session deleted/archived from another tab (or another device on the LAN)
    // stays stale here indefinitely — no poll, no invalidation reaches this tab's cache — until
    // some unrelated action happens to fail with a 404. Refetching on focus catches it as soon
    // as the user comes back to this tab, before they try to act on a session that's gone.
    refetchOnWindowFocus: true,
  })
}

/** Changes a session's mode at any stage (not just at creation) — see
 *  code-api.ts's updateCodeSessionMode for how this takes effect on the next run. */
export function useUpdateCodeSessionMode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; mode: string }) => updateCodeSessionMode(v.id, v.mode),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: codeKeys.detail(v.id) })
      void qc.invalidateQueries({ queryKey: ['code-sessions'] })
    },
  })
}

/** Renames a session's title — see code-api.ts's updateCodeSessionTitle. */
export function useUpdateCodeSessionTitle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; title: string }) => updateCodeSessionTitle(v.id, v.title),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: codeKeys.detail(v.id) })
      void qc.invalidateQueries({ queryKey: ['code-sessions'] })
    },
  })
}

/** Shared inline-rename state machine for a Code session's title — mirrors ConvItem's
 *  double-click / Enter-to-commit UX (ConversationSidebar.tsx). Used by BOTH the sidebar
 *  CodeSessionItem row and CodeSessionScreen's header, so the two surfaces commit through
 *  the exact same logic instead of duplicating it. `sessionId`/`currentTitle` may be
 *  undefined while the session is still loading — commit is a no-op until both are set. */
export function useCodeSessionRename(sessionId: string | undefined, currentTitle: string | undefined) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentTitle ?? '')
  const mut = useUpdateCodeSessionTitle()

  // Keep the draft in sync with the real title when not actively editing (e.g. after a
  // refetch), so a stale draft never lingers into the next edit.
  useEffect(() => { if (!editing) setDraft(currentTitle ?? '') }, [currentTitle, editing])

  const start = () => { setDraft(currentTitle ?? ''); setEditing(true) }
  const cancel = () => { setDraft(currentTitle ?? ''); setEditing(false) }
  const commit = () => {
    setEditing(false)
    const title = draft.trim()
    if (!sessionId || !title || title === currentTitle) { setDraft(currentTitle ?? ''); return }
    mut.mutate(
      { id: sessionId, title },
      { onError: () => { setDraft(currentTitle ?? ''); toast.error('Could not rename session.') } },
    )
  }

  return { editing, draft, setDraft, start, cancel, commit }
}

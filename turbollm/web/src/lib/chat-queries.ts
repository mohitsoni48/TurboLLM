import { useEffect } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import {
  compactConversation, createConversation, createFolder, deleteConversation, deleteFolder, deleteMemoryFact, deleteMessage, editMessage,
  getConversation, listConversations, listFolders, listMemoryFacts, moveConversationToFolder, regenerate, undoCompaction,
  renameFolder, stopGeneration, updateConversation,
} from './chat-api'
import type { ConversationPage } from './chat-api'
import type { Conversation, MemoryFact } from './chat-types'
import { FIRST_PAGE, flattenPages, nextCursorOf } from './paging'
import { pollWhileLive } from './live-events'

export const chatKeys = {
  list: (q?: string) => ['conversations', q ?? ''] as const,
  /** The list's first page alone, which the sidebar polls (useConversationListPoll). */
  listHead: (q?: string) => ['conversations', q ?? '', 'head'] as const,
  detail: (id: string | null) => ['conversation', id] as const,
  folders: ['folders'] as const,
}

export const memoryKeys = {
  list: ['memory-facts'] as const,
}

/** Auto-memory (Release 3) fact list — fetched regardless of the feature toggle so a user
 *  can review/clean up what's been saved even with extraction turned off. */
export function useMemoryFacts() {
  return useInfiniteQuery({
    queryKey: memoryKeys.list,
    queryFn: ({ pageParam }) => listMemoryFacts(pageParam),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: nextCursorOf,
    select: (data): { facts: MemoryFact[] } => ({
      facts: flattenPages<MemoryFact>({ ...data, pages: data.pages.map((p) => ({ items: p.facts })) }),
    }),
    staleTime: 0,
    retry: false,
  })
}

export function useMemoryFactMutations() {
  const qc = useQueryClient()
  return {
    remove: useMutation({
      mutationFn: (id: string) => deleteMemoryFact(id),
      onSuccess: () => void qc.invalidateQueries({ queryKey: memoryKeys.list }),
    }),
  }
}

/** The sidebar's list, a page at a time (`fetchNextPage` / `hasNextPage`); consumers still read one flat
 *  `data.conversations`. A refresh (a mutation's invalidation, or a change the poll below finds) refetches every page
 *  already loaded, in order, so pages the user scrolled to are neither dropped nor duplicated. A search is answered
 *  unpaged: its one page has no cursor. */
export function useConversations(q?: string) {
  const qc = useQueryClient()
  useConversationListPoll(q)
  return useInfiniteQuery({
    queryKey: chatKeys.list(q),
    // The first page through the poll's own query: one request when both want it at once, and the two always agree.
    queryFn: ({ pageParam }): Promise<ConversationPage> => (pageParam === FIRST_PAGE
      ? qc.fetchQuery({ queryKey: chatKeys.listHead(q), queryFn: () => listConversations(q, FIRST_PAGE), staleTime: 0 })
      : listConversations(q, pageParam)),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: nextCursorOf,
    select: (data): { conversations: Conversation[] } => ({
      conversations: flattenPages<Conversation>({ ...data, pages: data.pages.map((p) => ({ items: p.conversations })) }),
    }),
    staleTime: 0,
    retry: false,
  })
}

/** Same live-sync gap as useConversation below, for the sidebar's list instead of one open conversation: autoTitle
 *  (chat-routes.ts) runs ~1s+ AFTER the SSE stream's 'done' event has already closed, entirely out-of-band from the
 *  response the frontend is watching — nothing ever told the list the title changed, so the sidebar (and the
 *  still-"New chat" active conversation's header) was stuck showing the old title until a manual reload remounted it
 *  (GitHub: "the auto generated chat title doesn't update until i refresh"). Same 4s cadence as useConversation's own
 *  multi-device poll. It reads the first page only (the newest chats, where every change lands, since the list is
 *  most recently updated first), not every page the user scrolled to: when that page differs from the list's own,
 *  the list is refreshed. */
function useConversationListPoll(q?: string) {
  const qc = useQueryClient()
  const { data: head } = useQuery({
    queryKey: chatKeys.listHead(q),
    queryFn: () => listConversations(q, FIRST_PAGE),
    staleTime: 0,
    retry: false,
    refetchInterval: () => pollWhileLive(4000),
    refetchIntervalInBackground: false,
  })
  // `head` keeps its identity while the server's answer is unchanged (structural sharing), so this runs on a change.
  // Not while the list is fetching: its first page is this same answer.
  useEffect(() => {
    if (!head || qc.isFetching({ queryKey: chatKeys.list(q), exact: true }) > 0) return
    const shown = qc.getQueryData<InfiniteData<ConversationPage>>(chatKeys.list(q))?.pages[0]
    if (shown && JSON.stringify(shown.conversations) !== JSON.stringify(head.conversations)) {
      void qc.invalidateQueries({ queryKey: chatKeys.list(q), exact: true })
    }
  }, [head, q, qc])
}

export function useFolders() {
  return useQuery({
    queryKey: chatKeys.folders,
    queryFn: () => listFolders(),
    staleTime: 0,
    retry: false,
  })
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: chatKeys.detail(id),
    queryFn: () => getConversation(id!),
    enabled: !!id,
    retry: false,
    // Multi-device/multi-tab live sync (founder-reported gap, 2026-07-15): refetchOnWindowFocus is
    // off globally (main.tsx), so a second tab or device viewing the conversation would never
    // notice a new message, a title or a version switch made elsewhere short of a manual reload.
    // The poll catches those, and it is how such a page learns a reply is running
    // (`runningReplyId`): ChatScreen then attaches to the reply's own run, which fans out to every
    // viewer (GET .../stream, chat-runs.ts), and follows it live. Matches the cadence Code's own
    // session list already uses (code-queries.ts, refetchInterval: 5000).
    refetchInterval: () => pollWhileLive(4000),
    refetchIntervalInBackground: false,
  })
}

export function useConversationMutations() {
  const qc = useQueryClient()

  const invalidateList = () => void qc.invalidateQueries({ queryKey: ['conversations'] })
  const invalidateDetail = (id: string) => void qc.invalidateQueries({ queryKey: chatKeys.detail(id) })
  const invalidateFolders = () => void qc.invalidateQueries({ queryKey: chatKeys.folders })

  return {
    create: useMutation({
      mutationFn: (p?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'toolPolicy' | 'skillIds' | 'allowedTools' | 'sampling' | 'preserveThinking'>>) => createConversation(p),
      onSuccess: invalidateList,
    }),
update: useMutation({
      mutationFn: (v: { id: string } & Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'sampling' | 'skillIds' | 'preserveThinking'>>) => updateConversation(v.id, v),
      onSuccess: (_d, v) => { invalidateList(); invalidateDetail(v.id) },
    }),
    remove: useMutation({
      mutationFn: (id: string) => deleteConversation(id),
      onSuccess: invalidateList,
    }),
    stop: useMutation({
      mutationFn: ({ convId, messageId }: { convId: string; messageId?: string }) => stopGeneration(convId, messageId),
    }),
    editMsg: useMutation({
      mutationFn: (v: { convId: string; msgId: string; content: string }) => editMessage(v.convId, v.msgId, v.content),
      onSuccess: (_d, v) => invalidateDetail(v.convId),
    }),
    deleteMsg: useMutation({
      mutationFn: (v: { convId: string; msgId: string }) => deleteMessage(v.convId, v.msgId),
      onSuccess: (_d, v) => invalidateDetail(v.convId),
    }),
    regenerate: useMutation({
      mutationFn: (convId: string) => regenerate(convId),
      // Regenerate adds a new sibling to a variant group; without this the switcher's
      // cached list is stale until something else happens to remount it (it self-corrects
      // today only because the active message's id changes on refetch, which is load-bearing
      // but not obvious — invalidate explicitly instead of relying on that).
      onSuccess: (_d, convId) => { invalidateDetail(convId); void qc.invalidateQueries({ queryKey: ['message-variants'] }) },
    }),
    compact: useMutation({
      mutationFn: ({ convId, model }: { convId: string; model?: string }) => compactConversation(convId, model),
      onSuccess: (_d, { convId }) => invalidateDetail(convId),
    }),
    undoCompaction: useMutation({
      mutationFn: (convId: string) => undoCompaction(convId),
      onSuccess: (_d, convId) => invalidateDetail(convId),
    }),
    createFolder: useMutation({
      mutationFn: (name: string) => createFolder(name),
      onSuccess: () => { invalidateFolders(); invalidateList() },
    }),
    renameFolder: useMutation({
      mutationFn: (v: { id: string; name: string }) => renameFolder(v.id, v.name),
      onSuccess: () => { invalidateFolders(); invalidateList() },
    }),
    deleteFolder: useMutation({
      mutationFn: (id: string) => deleteFolder(id),
      // Deleting a folder unassigns its members, so the conversations list changes too.
      onSuccess: () => { invalidateFolders(); invalidateList() },
    }),
    moveToFolder: useMutation({
      mutationFn: (v: { convId: string; folderId: string | null }) => moveConversationToFolder(v.convId, v.folderId),
      onSuccess: (_d, v) => { invalidateFolders(); invalidateList(); invalidateDetail(v.convId) },
    }),
  }
}

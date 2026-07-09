import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createConversation, createFolder, deleteConversation, deleteFolder, deleteMemoryFact, deleteMessage, editMessage,
  getConversation, listConversations, listFolders, listMemoryFacts, moveConversationToFolder, regenerate,
  renameFolder, stopGeneration, updateConversation,
} from './chat-api'
import type { Conversation } from './chat-types'

export const chatKeys = {
  list: (q?: string) => ['conversations', q ?? ''] as const,
  detail: (id: string | null) => ['conversation', id] as const,
  folders: ['folders'] as const,
}

export const memoryKeys = {
  list: ['memory-facts'] as const,
}

/** Auto-memory (Release 3) fact list — fetched regardless of the feature toggle so a user
 *  can review/clean up what's been saved even with extraction turned off. */
export function useMemoryFacts() {
  return useQuery({
    queryKey: memoryKeys.list,
    queryFn: listMemoryFacts,
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

export function useConversations(q?: string) {
  return useQuery({
    queryKey: chatKeys.list(q),
    queryFn: () => listConversations(q),
    staleTime: 0,
    retry: false,
  })
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
      mutationFn: (convId: string) => stopGeneration(convId),
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

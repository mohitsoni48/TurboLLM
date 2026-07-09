import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createConversation, createFolder, deleteConversation, deleteFolder, deleteMessage, editMessage,
  getConversation, listConversations, listFolders, moveConversationToFolder, regenerate,
  renameFolder, stopGeneration, updateConversation,
} from './chat-api'
import type { Conversation } from './chat-types'

export const chatKeys = {
  list: (q?: string) => ['conversations', q ?? ''] as const,
  detail: (id: string | null) => ['conversation', id] as const,
  folders: ['folders'] as const,
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

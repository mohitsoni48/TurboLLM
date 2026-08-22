// The pluggable chat-store contract (spec 27 §4.2).
//
// 13 required methods. Optional capability groups are separate interfaces an adapter
// MAY also implement, declared via `capabilities` so callers can discover support at
// startup instead of at first failure.
import type {
  Chat, ChatInput, ChatMessage, ChatPatch, ListOpts, MessageInput, MessagePatch, Page, Scope,
} from './types.js'

/** The scope TurboLLM's own web UI operates under (spec 27 §3.1). */
export const LOCAL_SCOPE: Scope = { tenant: 'local', owner: 'default' }

export interface StoreCapabilities {
  /** Variants, tail freeze/restore, message-edit forks. */
  branching?: boolean
  /** Grouping chats into folders. */
  folders?: boolean
  /** Full-text `q` over chat TITLE — a typed column, never the opaque body (spec 27 §4.2). */
  search?: boolean
  /** Atomic multi-message append. */
  batch?: boolean
}

export type StoreErrorCode =
  | 'not_found'
  | 'version_conflict'
  | 'not_supported'
  | 'invalid_scope'
  | 'contract_violation'
  /** A caller-supplied pagination cursor could not be decoded — distinct from
   *  `contract_violation` (the ADAPTER returning malformed data): this is the CALLER's mistake,
   *  maps to a non-retryable 400 rather than reading as a storage incident. */
  | 'invalid_cursor'

/** The single error type every adapter throws, so the service layer can map store
 *  failures onto the public error catalogue (spec 27 §7.2) without sniffing messages. */
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

export interface ChatStore {
  readonly capabilities: StoreCapabilities

  createChat(s: Scope, input: ChatInput): Promise<Chat>
  getChat(s: Scope, id: string): Promise<Chat | null>
  listChats(s: Scope, opts: ListOpts): Promise<Page<Chat>>
  updateChat(s: Scope, id: string, patch: ChatPatch, ifVersion?: number): Promise<Chat | null>
  deleteChat(s: Scope, id: string): Promise<boolean>

  /** MUST allocate `seq` atomically per chat, and maintain the chat's messageCount /
   *  lastMessageAt / updatedAt in the same transaction (spec 27 §4.2). */
  addMessage(s: Scope, chatId: string, input: MessageInput): Promise<ChatMessage>
  getMessage(s: Scope, id: string): Promise<ChatMessage | null>
  listMessages(s: Scope, chatId: string, opts: ListOpts): Promise<Page<ChatMessage>>
  updateMessage(s: Scope, id: string, patch: MessagePatch, ifVersion?: number): Promise<ChatMessage | null>
  deleteMessage(s: Scope, id: string): Promise<boolean>
  getLastMessage(s: Scope, chatId: string): Promise<ChatMessage | null>

  health(): Promise<{ ok: boolean; detail?: string }>
  close(): Promise<void>
}

export interface Folder {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface FolderStore {
  listFolders(s: Scope): Promise<Folder[]>
  getFolder(s: Scope, id: string): Promise<Folder | null>
  createFolder(s: Scope, name: string): Promise<Folder>
  renameFolder(s: Scope, id: string, name: string): Promise<boolean>
  deleteFolder(s: Scope, id: string): Promise<boolean>
  moveChatToFolder(s: Scope, chatId: string, folderId: string | null): Promise<boolean>
}

export interface BranchingStore {
  getMessageVariants(s: Scope, messageId: string): Promise<ChatMessage[]>
  setActiveVariant(s: Scope, messageId: string): Promise<boolean>
  deactivateMessage(s: Scope, messageId: string): Promise<boolean>
  deactivateMessagesFrom(s: Scope, chatId: string, fromMessageId: string): Promise<number>
  reactivateMessagesFrom(s: Scope, chatId: string, fromMessageId: string): Promise<number>
  freezeTail(s: Scope, chatId: string, versionId: string): Promise<number>
  restoreTail(s: Scope, chatId: string, versionId: string): Promise<number>
}

export function hasFolders(s: ChatStore): s is ChatStore & FolderStore {
  return s.capabilities.folders === true
}

export function hasBranching(s: ChatStore): s is ChatStore & BranchingStore {
  return s.capabilities.branching === true
}

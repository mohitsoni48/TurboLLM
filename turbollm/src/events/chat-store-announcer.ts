// The chat store as an invalidation chokepoint (scalability review 4.14 / 5.10). Every conversation,
// routine, run, memory and Code-session change goes through ConversationStore's write methods,
// whether a route, a detached reply, the routine scheduler or a Code run made it, so announcing at
// those methods covers background changes a route-level hook would miss, without an emit in each
// caller. The public chat API writes through the same database by its SqliteChatStore
// (`store.chatStore`), whose chats the web sidebar lists too, so its writes are announced alike.
// Applied once, where the daemon builds its store (boot.ts).
//
// `conversations` names the sidebar's list rows (title, folder, order by updated_at), so only a
// write that changes a row announces it; a write to messages alone names its conversation.
import type { ConversationStore, PrunableRoutineRun } from '../chat/db'
import type { SqliteChatStore } from '../chat/store/sqlite-chat-store'
import { eventBus, type EventBus } from './bus'

/** The keys one write stands for, from its arguments and what it returned. */
type Announcement = (args: unknown[], result: unknown) => string[]
/** The keys one write stands for, read BEFORE it: a delete leaves nothing to look up after. */
type PriorAnnouncement = (store: ConversationStore, args: unknown[]) => string[]

const CONVERSATIONS = 'conversations'
const conversationKey = (convId: unknown): string => `conversation:${String(convId)}`
const routineRunsKey = (routineId: string): string => `routine-runs:${routineId}`
const listedConversation = (convId: unknown): string[] => [CONVERSATIONS, conversationKey(convId)]

/** A write that changes the conversation's list row, addressed by the argument at `index`. */
const rowByArg = (index: number): Announcement => (args) => listedConversation(args[index])
/** A write to the conversation's messages alone, addressed by the argument at `index`. */
const contentByArg = (index: number): Announcement => (args) => [conversationKey(args[index])]
const constant = (...keys: string[]): Announcement => () => keys
const createdConversation: Announcement = (_args, conv) => listedConversation((conv as { id: string }).id)
const routineRunKeys: Announcement = (_args, run) =>
  run ? [routineRunsKey((run as { routineId: string }).routineId)] : []
const updatedChatMessage: Announcement = (_args, msg) =>
  msg ? [conversationKey((msg as { chatId: string }).chatId)] : []

/** A message write, addressed by the message id at `index`, names that message's conversation. */
const messageConversation = (index: number): PriorAnnouncement => (store, args) => {
  const convId = store.getMessage(String(args[index]))?.convId
  return convId === undefined ? [] : [conversationKey(convId)]
}

/** Pruned runs take their conversations with them, and change their routine's run history. */
const prunedRoutineRuns: PriorAnnouncement = (store, [runs]) => {
  const routineIds = (runs as PrunableRoutineRun[]).map((run) => store.getRoutineRun(run.id)?.routineId)
  const distinct = new Set(routineIds.filter((id): id is string => id !== undefined))
  return [CONVERSATIONS, ...[...distinct].map(routineRunsKey)]
}

const CONVERSATION_STORE_WRITES: Writes<ConversationStore> = {
  createConversation: createdConversation,
  updateConversation: rowByArg(0),
  setConversationCompaction: rowByArg(0),
  clearConversationCompaction: rowByArg(0),
  touchConversation: rowByArg(0),
  deleteConversation: rowByArg(0),
  markConversationComplete: rowByArg(0),
  reopenConversation: rowByArg(0),
  setConversationReadScope: rowByArg(0),
  setConversationMode: rowByArg(0),
  moveConversationToFolder: rowByArg(0),
  addMessage: rowByArg(0),
  setToolOverride: contentByArg(0),
  freezeTail: contentByArg(0),
  deactivateMessagesFrom: contentByArg(0),
  reactivateMessagesFrom: contentByArg(0),
  deactivateMessagesUpTo: contentByArg(0),
  reactivateMessagesUpTo: contentByArg(0),
  abortUnfinishedReplies: constant(CONVERSATIONS),
  createFolder: constant(CONVERSATIONS),
  renameFolder: constant(CONVERSATIONS),
  deleteFolder: constant(CONVERSATIONS),
  addMemoryFact: constant('memory'),
  deleteMemoryFact: constant('memory'),
  createRoutine: constant('routines'),
  confirmRoutine: constant('routines'),
  updateRoutine: constant('routines'),
  deleteRoutine: constant('routines'),
  createRoutineRun: routineRunKeys,
  updateRoutineRun: routineRunKeys,
  createAgentRun: constant('code-sessions'),
  updateAgentRun: constant('code-sessions'),
  setAgentRunArchived: constant('code-sessions'),
  setClearedUpToMessageId: constant('code-sessions'),
  setRevertedFromMessageId: constant('code-sessions'),
  deleteCodeSession: constant('code-sessions'),
  setRunDisposition: constant('code-sessions'),
  setCodeSessionCtxUsed: constant('code-sessions'),
}

const CONVERSATION_STORE_PRIOR_WRITES: PriorWrites<ConversationStore> = {
  updateMessage: messageConversation(0),
  deleteMessage: messageConversation(0),
  deactivateMessage: messageConversation(0),
  restoreTail: messageConversation(0),
  setActiveVariant: messageConversation(1),
  deleteRoutineRuns: prunedRoutineRuns,
}

/** SqliteChatStore's methods take the caller's scope first, so what they address is the second argument. */
const CHAT_STORE_WRITES: Writes<SqliteChatStore> = {
  createChat: createdConversation,
  updateChat: rowByArg(1),
  deleteChat: rowByArg(1),
  addMessage: rowByArg(1),
  moveChatToFolder: rowByArg(1),
  updateMessage: updatedChatMessage,
  deactivateMessagesFrom: contentByArg(1),
  reactivateMessagesFrom: contentByArg(1),
  freezeTail: contentByArg(1),
  restoreTail: contentByArg(1),
  createFolder: constant(CONVERSATIONS),
  renameFolder: constant(CONVERSATIONS),
  deleteFolder: constant(CONVERSATIONS),
}

const CHAT_STORE_PRIOR_WRITES: PriorWrites<SqliteChatStore> = {
  deleteMessage: messageConversation(1),
  setActiveVariant: messageConversation(1),
  deactivateMessage: messageConversation(1),
}

/** Make `store`'s write methods, and its chat store's, announce what they changed on `bus`. Returns the same store. */
export function announceChatStoreChanges(store: ConversationStore, bus: EventBus = eventBus): ConversationStore {
  announceWrites(store, store, bus, CONVERSATION_STORE_WRITES, CONVERSATION_STORE_PRIOR_WRITES)
  announceWrites(store.chatStore, store, bus, CHAT_STORE_WRITES, CHAT_STORE_PRIOR_WRITES)
  return store
}

type AnyMethod = (...args: unknown[]) => unknown
type Writer = object
type Writes<T> = Partial<Record<keyof T, Announcement>>
type PriorWrites<T> = Partial<Record<keyof T, PriorAnnouncement>>

function announceWrites<T extends Writer>(
  writer: T, store: ConversationStore, bus: EventBus, writes: Writes<T>, priorWrites: PriorWrites<T>,
): void {
  for (const [method, announce] of Object.entries(writes) as Array<[string, Announcement]>) {
    announceAfterWrite(writer, method, bus, announce)
  }
  for (const [method, prior] of Object.entries(priorWrites) as Array<[string, PriorAnnouncement]>) {
    announceBeforeWrite(writer, method, bus, (args) => prior(store, args))
  }
}

function announceAfterWrite(writer: Writer, method: string, bus: EventBus, announce: Announcement): void {
  replaceMethod(writer, method, (original) => (...args) =>
    whenWritten(original(...args), (result) => {
      if (bus.subscriberCount() > 0) emitAll(bus, announce(args, result))
    }))
}

function announceBeforeWrite(writer: Writer, method: string, bus: EventBus, readKeys: (args: unknown[]) => string[]): void {
  replaceMethod(writer, method, (original) => (...args) => {
    const keys = bus.subscriberCount() > 0 ? readKeys(args) : []
    return whenWritten(original(...args), () => emitAll(bus, keys))
  })
}

function replaceMethod(writer: Writer, method: string, wrap: (original: AnyMethod) => AnyMethod): void {
  const methods = writer as Record<string, AnyMethod>
  methods[method] = wrap(methods[method].bind(writer))
}

/** Runs `announce` once the write is done: at once for a synchronous one, when its promise resolves for the chat
 *  store's async ones. Hands back what the write returned. */
function whenWritten(result: unknown, announce: (written: unknown) => void): unknown {
  if (!(result instanceof Promise)) {
    announce(result)
    return result
  }
  return result.then((written: unknown) => {
    announce(written)
    return written
  })
}

function emitAll(bus: EventBus, keys: readonly string[]): void {
  for (const key of keys) bus.emit(key)
}

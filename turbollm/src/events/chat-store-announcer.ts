// The chat store as an invalidation chokepoint (scalability review 4.14 / 5.10). Every conversation,
// routine, run, memory and Code-session change goes through ConversationStore's write methods,
// whether a route, a detached reply, the routine scheduler or a Code run made it, so announcing at
// those methods covers background changes a route-level hook would miss, without an emit in each
// caller. Applied once, where the daemon builds its store (boot.ts).
import type { ConversationStore } from '../chat/db'
import { eventBus, type EventBus } from './bus'

type WriteMethod = keyof ConversationStore
/** The keys one write stands for, from its arguments and what it returned. */
type Announcement = (args: unknown[], result: unknown) => string[]

const CONVERSATIONS = 'conversations'
const conversationKeys = (convId: unknown): string[] => [CONVERSATIONS, `conversation:${String(convId)}`]
const byFirstArg: Announcement = (args) => conversationKeys(args[0])
const constant = (...keys: string[]): Announcement => () => keys
const routineRunKeys: Announcement = (_args, run) =>
  run ? ['routines', `routine-runs:${(run as { routineId: string }).routineId}`] : ['routines']

const AFTER_WRITE: Partial<Record<WriteMethod, Announcement>> = {
  createConversation: (_args, conv) => conversationKeys((conv as { id: string }).id),
  updateConversation: byFirstArg,
  setConversationCompaction: byFirstArg,
  clearConversationCompaction: byFirstArg,
  setToolOverride: byFirstArg,
  touchConversation: byFirstArg,
  deleteConversation: byFirstArg,
  markConversationComplete: byFirstArg,
  reopenConversation: byFirstArg,
  setConversationReadScope: byFirstArg,
  setConversationMode: byFirstArg,
  moveConversationToFolder: byFirstArg,
  addMessage: byFirstArg,
  freezeTail: byFirstArg,
  deactivateMessagesFrom: byFirstArg,
  reactivateMessagesFrom: byFirstArg,
  deactivateMessagesUpTo: byFirstArg,
  reactivateMessagesUpTo: byFirstArg,
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
  deleteRoutineRuns: constant('routines'),
  createRoutineRun: routineRunKeys,
  updateRoutineRun: routineRunKeys,
  createAgentRun: constant('code-sessions'),
  updateAgentRun: constant('code-sessions'),
  setAgentRunArchived: constant('code-sessions'),
  setClearedUpToMessageId: constant('code-sessions'),
  setRevertedFromMessageId: constant('code-sessions'),
  deleteCodeSession: constant('code-sessions'),
  setRunDisposition: constant('code-sessions'),
}

/** Writes addressed by a message id, whose conversation is looked up BEFORE the write (a delete
 *  leaves nothing to look up after). The argument holding the message id is named per method. */
const BY_MESSAGE: Partial<Record<WriteMethod, number>> = {
  updateMessage: 0,
  deleteMessage: 0,
  deactivateMessage: 0,
  restoreTail: 0,
  setActiveVariant: 1,
}

/** Make `store`'s write methods announce what they changed on `bus`. Returns the same store. */
export function announceChatStoreChanges(store: ConversationStore, bus: EventBus = eventBus): ConversationStore {
  for (const [method, announce] of Object.entries(AFTER_WRITE)) {
    announceAfterWrite(store, method as WriteMethod, bus, announce)
  }
  for (const [method, idArg] of Object.entries(BY_MESSAGE)) {
    announceMessageWrite(store, method as WriteMethod, bus, idArg)
  }
  return store
}

type AnyMethod = (...args: unknown[]) => unknown

function replaceMethod(store: ConversationStore, method: WriteMethod, wrap: (original: AnyMethod) => AnyMethod): void {
  const methods = store as unknown as Record<string, AnyMethod>
  methods[method] = wrap(methods[method].bind(store))
}

function announceAfterWrite(store: ConversationStore, method: WriteMethod, bus: EventBus, announce: Announcement): void {
  replaceMethod(store, method, (original) => (...args) => {
    const result = original(...args)
    if (bus.subscriberCount() > 0) announce(args, result).forEach((key) => bus.emit(key))
    return result
  })
}

function announceMessageWrite(store: ConversationStore, method: WriteMethod, bus: EventBus, idArg: number): void {
  replaceMethod(store, method, (original) => (...args) => {
    const convId = bus.subscriberCount() > 0 ? store.getMessage(String(args[idArg]))?.convId : undefined
    const result = original(...args)
    if (convId !== undefined) conversationKeys(convId).forEach((key) => bus.emit(key))
    return result
  })
}

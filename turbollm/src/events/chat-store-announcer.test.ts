import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { LOCAL_SCOPE } from '../chat/store/chat-store'
import { EventBus } from './bus'
import { announceChatStoreChanges } from './chat-store-announcer'

function observed(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = new EventBus(10)
  const db = announceChatStoreChanges(new ConversationStore(IN_MEMORY_DATA_DIR), bus)
  t.after(() => db.close())
  const heard = new Set<string>()
  bus.subscribe((keys) => keys.forEach((k) => heard.add(k)))
  const drain = (): string[] => {
    t.mock.timers.tick(10)
    const keys = [...heard].sort()
    heard.clear()
    return keys
  }
  return { db, drain }
}

test('conversation writes announce the list and the conversation they touched', (t) => {
  const { db, drain } = observed(t)
  const conv = db.createConversation({ title: 'a' })
  assert.deepEqual(drain(), ['conversation:' + conv.id, 'conversations'])

  const msg = db.addMessage(conv.id, 'assistant', '')
  assert.deepEqual(drain(), ['conversation:' + conv.id, 'conversations'])

  db.updateMessage(msg.id, { content: 'done' })
  assert.deepEqual(drain(), ['conversation:' + conv.id], 'a message write names its conversation alone')

  db.deleteMessage(msg.id)
  assert.deepEqual(drain(), ['conversation:' + conv.id], 'looked up before the row is gone')
})

// The sidebar list shows conversation rows (title, folder, updated_at order); a write that changes only messages
// leaves every row as it was, and announcing the list for it refetched the sidebar on every streamed reply save.
test('message-only writes announce their conversation, not the list', (t) => {
  const { db, drain } = observed(t)
  const conv = db.createConversation({ title: 'a' })
  const first = db.addMessage(conv.id, 'user', 'hi')
  const reply = db.addMessage(conv.id, 'assistant', 'hello')
  drain()
  const only = ['conversation:' + conv.id]

  db.deactivateMessage(reply.id)
  assert.deepEqual(drain(), only)
  db.setActiveVariant(reply.id, reply.id)
  assert.deepEqual(drain(), only)
  db.freezeTail(conv.id, first.seq, first.id)
  assert.deepEqual(drain(), only)
  db.restoreTail(first.id)
  assert.deepEqual(drain(), only)
  db.deactivateMessagesFrom(conv.id, reply.id)
  assert.deepEqual(drain(), only)
  db.reactivateMessagesFrom(conv.id, reply.id)
  assert.deepEqual(drain(), only)
  db.deactivateMessagesUpTo(conv.id, first.id)
  assert.deepEqual(drain(), only)
  db.reactivateMessagesUpTo(conv.id, first.id)
  assert.deepEqual(drain(), only)
  db.setToolOverride(conv.id, 'web_search', 'allow')
  assert.deepEqual(drain(), only)
})

test('writes that change a list row still announce the list', (t) => {
  const { db, drain } = observed(t)
  const conv = db.createConversation({ title: 'a' })
  drain()
  const both = ['conversation:' + conv.id, 'conversations']

  db.updateConversation(conv.id, { title: 'b' })
  assert.deepEqual(drain(), both)
  db.touchConversation(conv.id)
  assert.deepEqual(drain(), both)
  db.setConversationCompaction(conv.id, { summary: 's', upToMessageId: 'm', tokensBefore: 1 })
  assert.deepEqual(drain(), both)
  db.deleteConversation(conv.id)
  assert.deepEqual(drain(), both)
})

test('reads announce nothing', (t) => {
  const { db, drain } = observed(t)
  const conv = db.createConversation()
  drain()
  db.getConversation(conv.id, true)
  db.listConversations()
  assert.deepEqual(drain(), [])
})

test('routine, run, memory and Code session writes announce their own families', (t) => {
  const { db, drain } = observed(t)
  const routine = db.createRoutine({
    flavor: 'chat', prompt: 'p', scheduleDisplay: 'daily', scheduleRule: { kind: 'daily', time: '09:00' } as never, modelKey: 'm',
  })
  assert.deepEqual(drain(), ['routines'])

  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: '{}' })
  assert.deepEqual(drain(), ['routine-runs:' + routine.id], 'a run changes its own routine runs, not the routine list')
  db.updateRoutineRun(run.id, { status: 'ok' })
  assert.deepEqual(drain(), ['routine-runs:' + routine.id])

  db.addMemoryFact({ factText: 'likes tea' })
  assert.deepEqual(drain(), ['memory'])

  const conv = db.createConversation({ kind: 'agent' })
  drain()
  db.createAgentRun({ convId: conv.id, title: 't', allowedTools: [] })
  assert.deepEqual(drain(), ['code-sessions'])

  db.setCodeSessionCtxUsed(conv.id, 1234)
  assert.deepEqual(drain(), ['code-sessions'], 'the context meter a Code session shows')
})

test('pruning routine runs announces the conversations it deleted and the runs of their routine', (t) => {
  const { db, drain } = observed(t)
  const routine = db.createRoutine({
    flavor: 'chat', prompt: 'p', scheduleDisplay: 'daily', scheduleRule: { kind: 'daily', time: '09:00' } as never, modelKey: 'm',
  })
  const conv = db.createConversation({ kind: 'agent' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: '{}' })
  db.updateRoutineRun(run.id, { status: 'ok', conversationId: conv.id, endedAt: new Date().toISOString() })
  drain()

  db.deleteRoutineRuns([{ id: run.id, startedAt: run.startedAt, conversationId: conv.id, codeSessionId: null }])
  assert.deepEqual(drain(), ['conversations', 'routine-runs:' + routine.id])
})

// The public chat API writes through the store's SqliteChatStore, not ConversationStore's methods, and its chats show
// in the web sidebar too (the list has no tenant filter): those writes announce the same keys.
test('writes through the chat store the public API uses announce like the app\'s own', async (t) => {
  const { db, drain } = observed(t)
  const chats = db.chatStore
  const chat = await chats.createChat(LOCAL_SCOPE, { title: 'ext' })
  const both = ['conversation:' + chat.id, 'conversations']
  assert.deepEqual(drain(), both)

  const msg = await chats.addMessage(LOCAL_SCOPE, chat.id, { role: 'user', content: 'hi' })
  assert.deepEqual(drain(), both)
  await chats.updateChat(LOCAL_SCOPE, chat.id, { title: 'renamed' })
  assert.deepEqual(drain(), both)

  await chats.updateMessage(LOCAL_SCOPE, msg.id, { content: 'edited' })
  assert.deepEqual(drain(), ['conversation:' + chat.id], 'a message write leaves the list rows as they were')
  await chats.deleteMessage(LOCAL_SCOPE, msg.id)
  assert.deepEqual(drain(), ['conversation:' + chat.id], 'looked up before the row is gone')

  await chats.deleteChat(LOCAL_SCOPE, chat.id)
  assert.deepEqual(drain(), both)
})

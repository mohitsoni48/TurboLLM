import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
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
  assert.deepEqual(drain(), ['conversation:' + conv.id, 'conversations'], 'a message write names its conversation')

  db.deleteMessage(msg.id)
  assert.deepEqual(drain(), ['conversation:' + conv.id, 'conversations'], 'looked up before the row is gone')
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
  assert.deepEqual(drain(), ['routine-runs:' + routine.id, 'routines'])
  db.updateRoutineRun(run.id, { status: 'ok' })
  assert.deepEqual(drain(), ['routine-runs:' + routine.id, 'routines'])

  db.addMemoryFact({ factText: 'likes tea' })
  assert.deepEqual(drain(), ['memory'])

  const conv = db.createConversation({ kind: 'agent' })
  drain()
  db.createAgentRun({ convId: conv.id, title: 't', allowedTools: [] })
  assert.deepEqual(drain(), ['code-sessions'])
})

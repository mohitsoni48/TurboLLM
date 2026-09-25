import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'

test('ConversationStore: an in-memory store keeps what it is given for as long as it is open', () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const conv = store.createConversation({ title: 'kept' })
  store.addMessage(conv.id, 'user', 'hello')

  assert.equal(store.getConversation(conv.id)?.title, 'kept')
  assert.deepEqual(store.getMessages(conv.id).map((m) => m.content), ['hello'])
  store.close()
})

test('ConversationStore: two in-memory stores are separate databases', () => {
  const first = new ConversationStore(IN_MEMORY_DATA_DIR)
  const second = new ConversationStore(IN_MEMORY_DATA_DIR)
  const conv = first.createConversation()

  assert.equal(second.getConversation(conv.id), null)
  first.close()
  second.close()
})

test('ConversationStore: an in-memory store writes no file', () => {
  const before = readdirSync(process.cwd()).sort()

  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  store.createConversation()
  store.close()

  assert.deepEqual(readdirSync(process.cwd()).sort(), before)
})

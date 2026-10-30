// A chat reply is saved once, when its turn ends. A turn that died with the daemon (a restart, a crash, Android killing
// the app) left its placeholder (empty, `{"aborted":false}`) for good: the chat showed "This message is empty." with
// nothing to say why. The startup reconcile (abortUnfinishedReplies, called first in registerChatRoutes) marks it
// stopped. One SQL class serves desktop's node:sqlite and Android's sql.js, so the method is checked on both.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { ConversationStore } from './db.js'
import { registerChatRoutes } from './chat-routes.js'
import { preloadSqlJs } from './store/sqlite-adapter.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

/** One chat with each kind of last reply, plus a Code session's placeholder. */
function seed(store: ConversationStore) {
  const chat = store.createConversation()
  store.addMessage(chat.id, 'user', 'q')
  const cutOff = store.addMessage(chat.id, 'assistant', '', { stats: { aborted: false } })
  const finished = store.addMessage(store.createConversation().id, 'assistant', 'an answer', { stats: { aborted: false, totalMs: 900 } })
  const stopped = store.addMessage(store.createConversation().id, 'assistant', 'half an', { stats: { aborted: true, totalMs: 300 } })
  const editedConv = store.createConversation()
  const edited = store.addMessage(editedConv.id, 'assistant', '', { stats: { aborted: false } })
  store.updateMessage(edited.id, { content: 'typed by hand', edited: true }) // as PUT /messages/:id writes it: stats stay
  const routineRun = store.addMessage(store.createConversation({ kind: 'agent' }).id, 'assistant', '', { stats: { aborted: false } })
  const code = store.addMessage(store.createConversation({ kind: 'code' }).id, 'assistant', '', { stats: { aborted: false } })
  return { chat, cutOff, finished, stopped, edited, routineRun, code }
}

function checkReconcile(store: ConversationStore) {
  const s = seed(store)
  assert.equal(store.abortUnfinishedReplies(), 2, 'the chat\'s placeholder and the routine run\'s')
  const stats = (id: string) => store.getMessage(id)!.stats
  assert.deepEqual(stats(s.cutOff.id), { aborted: true })
  assert.deepEqual(stats(s.routineRun.id), { aborted: true })
  assert.deepEqual(stats(s.finished.id), { aborted: false, totalMs: 900 }, 'a finished reply is left alone')
  assert.deepEqual(stats(s.stopped.id), { aborted: true, totalMs: 300 })
  assert.deepEqual(stats(s.edited.id), { aborted: false }, 'a placeholder edited by hand keeps its stats')
  assert.equal(store.getMessage(s.edited.id)!.content, 'typed by hand')
  assert.deepEqual(stats(s.code.id), { aborted: false }, 'a Code session is Code\'s own reconcile\'s')
  assert.equal(store.abortUnfinishedReplies(), 0, 'nothing left to mark')
}

/** A reply whose turn saved its text so far while it streamed (runGeneration's partial saves), then died with the
 *  daemon: its text, reasoning and finished tool calls are there, its stats still the placeholder's. */
function checkPartial(store: ConversationStore) {
  const conv = store.createConversation()
  store.addMessage(conv.id, 'user', 'write an essay')
  const partial = store.addMessage(conv.id, 'assistant', '', { stats: { aborted: false } })
  store.updateMessage(partial.id, { content: 'Paragraph one. Paragraph', reasoning: 'outline first', toolCalls: [{ id: 'call_1', name: 'web_search', args: { q: 'x' }, result: 'r' }] })
  const editedConv = store.createConversation()
  const edited = store.addMessage(editedConv.id, 'assistant', '', { stats: { aborted: false } })
  store.updateMessage(edited.id, { content: 'typed by hand', edited: true })

  assert.equal(store.abortUnfinishedReplies(), 1)
  const after = store.getMessage(partial.id)!
  assert.deepEqual(after.stats, { aborted: true }, 'stopped')
  assert.equal(after.content, 'Paragraph one. Paragraph', 'with the text it had saved')
  assert.equal(after.reasoning, 'outline first')
  assert.deepEqual(after.toolCalls.map((c) => c.id), ['call_1'])
  assert.deepEqual(store.getMessage(edited.id)!.stats, { aborted: false }, 'one edited by hand is not')
  assert.equal(store.getMessage(edited.id)!.content, 'typed by hand')
}

test('a reply partly saved while it streamed is marked stopped too, and keeps its text; one edited by hand is not', () => {
  const dir = tmpDir('tllm-unfinished-partial-')
  const store = new ConversationStore(dir)
  try {
    checkPartial(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same on Android\'s sql.js store', async (t) => {
  const actual = process.platform
  Object.defineProperty(process, 'platform', { value: 'android' })
  t.after(() => Object.defineProperty(process, 'platform', { value: actual }))
  await preloadSqlJs()
  const dir = tmpDir('tllm-unfinished-partial-sqljs-')
  const store = new ConversationStore(dir)
  try {
    checkPartial(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abortUnfinishedReplies marks a chat reply left as its turn\'s placeholder, and nothing else', () => {
  const dir = tmpDir('tllm-unfinished-')
  const store = new ConversationStore(dir)
  try {
    checkReconcile(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abortUnfinishedReplies does the same on Android\'s sql.js store', async (t) => {
  const actual = process.platform
  Object.defineProperty(process, 'platform', { value: 'android' })
  t.after(() => Object.defineProperty(process, 'platform', { value: actual }))
  await preloadSqlJs()
  const dir = tmpDir('tllm-unfinished-sqljs-')
  const store = new ConversationStore(dir)
  try {
    checkReconcile(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reply cut off by a daemon restart reads as stopped once the chat routes start', async () => {
  const dir = tmpDir('tllm-unfinished-routes-')
  const store = new ConversationStore(dir)
  const log = console.log
  console.log = () => {}
  try {
    const { chat, cutOff } = seed(store)
    const app = new Hono()
    registerChatRoutes(app, { db: store, store: { snapshot: () => ({}), dir: () => dir } } as unknown as Deps)
    const conv = await (await app.request(`/api/v1/conversations/${chat.id}`)).json() as { messages: Array<{ id: string; stats: { aborted: boolean } }> }
    assert.equal(conv.messages.find((m) => m.id === cutOff.id)!.stats.aborted, true)
  } finally {
    console.log = log
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

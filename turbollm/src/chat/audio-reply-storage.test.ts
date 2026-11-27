// What a spoken reply's clip does once it is stored on an assistant message: it is an ordinary attachment of the store
// that already keeps voice clips, so the janitor, the retention sweep, compaction and export treat it as they treat any
// message's, and nothing about it needs a store of its own.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { AttachmentJanitor } from './attachment-janitor'
import { attachmentRefId } from './attachments'
import { buildSnapshot } from './chat-export'
import { buildEngineMessages, pickCompactionCut, SPOKEN_REPLY_PLACEHOLDER } from './chat-compaction'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { RetentionSweeper } from './retention'
import { defaultConfig } from '../config/config'
import { tmpDir } from '../test-support/tmp'

const clip = (n: number) => `data:audio/wav;base64,${Buffer.from(`RIFF-reply-${n}`.padEnd(40, '.')).toString('base64')}`
const files = (dir: string) => (existsSync(join(dir, 'attachments')) ? readdirSync(join(dir, 'attachments')).sort() : [])
const age = (dir: string, ref: string) => {
  const old = new Date(Date.now() - 2 * 3600_000)
  utimesSync(join(dir, 'attachments', attachmentRefId(ref)!), old, old)
}

async function withStore(fn: (store: ConversationStore, dir: string) => Promise<void>): Promise<void> {
  const dir = tmpDir('tllm-audio-reply-storage-')
  const store = new ConversationStore(dir)
  try {
    await fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const janitor = (store: ConversationStore) => new AttachmentJanitor({ db: store, log: () => {}, graceMs: 3600_000 })

test('the janitor keeps a reply\'s clip while an assistant message names it, and collects it once nothing does', () => withStore(async (store, dir) => {
  const conv = store.createConversation()
  store.addMessage(conv.id, 'user', 'q')
  const [ref] = await store.attachments.save([clip(1)])
  const reply = store.addMessage(conv.id, 'assistant', 'Paris.', { attachments: [ref] })
  age(dir, ref)
  assert.equal((await janitor(store).run())?.deleted, 0)
  assert.deepEqual(files(dir), [attachmentRefId(ref)])

  store.deleteMessage(reply.id)
  assert.deepEqual(files(dir), [attachmentRefId(ref)], 'deleting the message leaves the file for the janitor')
  assert.equal((await janitor(store).run())?.deleted, 1)
  assert.deepEqual(files(dir), [])
}))

test('deleting the conversation leaves a reply\'s clip for the janitor too, and a clip another chat names stays', () => withStore(async (store, dir) => {
  const a = store.createConversation()
  const b = store.createConversation()
  const [mine, shared] = await store.attachments.save([clip(1), clip(2)])
  store.addMessage(a.id, 'assistant', '', { attachments: [mine, shared] })
  store.addMessage(b.id, 'assistant', 'x', { attachments: [shared] })
  for (const ref of [mine, shared]) age(dir, ref)
  store.deleteConversation(a.id)
  assert.equal(files(dir).length, 2, 'nothing deleted with the conversation')
  assert.equal((await janitor(store).run())?.deleted, 1)
  assert.deepEqual(files(dir), [attachmentRefId(shared)])
}))

test('the retention sweep removing a routine run\'s conversation leaves the clip of its assistant message for the janitor', () => withStore(async (store, dir) => {
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm' })
  const [ref] = await store.attachments.save([clip(3)])
  const runs: string[] = []
  for (let i = 0; i < 3; i++) {
    const run = store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
    const raw = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db
    const startedAt = Date.now() - (10 - i) * 86_400_000
    raw.prepare(`UPDATE routine_runs SET started_at = ?, ended_at = ?, status = 'ok' WHERE id = ?`).run(new Date(startedAt).toISOString(), new Date(startedAt + 500).toISOString(), run.id)
    const conv = store.createConversation({ kind: 'agent', modelKey: 'm' })
    const written = store.addMessage(conv.id, 'assistant', 'spoken', i === 0 ? { attachments: [ref] } : {})
    raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(startedAt + 100).toISOString(), written.id)
    store.updateRoutineRun(run.id, { conversationId: conv.id })
    runs.push(conv.id)
  }
  age(dir, ref)
  const sweeper = new RetentionSweeper({ db: store, settings: () => ({ enabled: true, apiUsageRawDays: 90, routineRunsKept: 2 }), log: () => {} })
  assert.equal((await sweeper.sweep())?.conversationsDeleted, 1)
  assert.equal(store.getConversation(runs[0]), null)
  assert.deepEqual(files(dir), [attachmentRefId(ref)], 'the sweep deletes rows, not files')
  assert.equal((await janitor(store).run())?.deleted, 1)
  assert.deepEqual(files(dir), [])
}))

// ── compaction and what a later text model is sent ──────────────────────────────────────────────────

const REPLY_REF = `attachment:${'ef'.repeat(32)}.wav`
let seq = 0
const msg = (role: 'user' | 'assistant', content: string, attachments: string[] = []) => ({
  id: `m${++seq}`, convId: 'c', seq, role, content, reasoning: '', attachments, textAttachments: [], toolCalls: [], stats: {},
  createdAt: '2026-09-09T00:00:00.000Z', variantGroup: null, isActive: true, branchOf: null, edited: false,
}) as never

test('compaction counts an assistant\'s clip as nothing, for a model that hears audio or not: the text stands in', () => {
  const build = (clips: string[]) => Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i} ${'x'.repeat(400)}`, i % 2 ? clips : []))
  for (const hearsAudio of [true, false]) {
    const plain = pickCompactionCut(build([]), 2000, undefined, false, hearsAudio)
    const spoken = pickCompactionCut(build([REPLY_REF, REPLY_REF]), 2000, undefined, false, hearsAudio)
    assert.ok(plain && spoken)
    assert.equal(spoken.toSummarize.length, plain.toSummarize.length)
    assert.equal(spoken.tokensBefore, plain.tokensBefore)
  }
})

test('a later text model is never sent an assistant\'s clip, and an empty spoken reply is [Spoken reply], not an empty turn', () => {
  const history = [msg('user', 'q'), msg('assistant', '', [REPLY_REF]), msg('user', 'and?'), msg('assistant', 'Berlin.', [REPLY_REF])]
  for (const hearsAudio of [true, false]) {
    const out = buildEngineMessages({ id: 'c', systemPrompt: '', modelKey: 'm', sampling: {}, expertMode: false, kind: 'chat', preserveThinking: false, title: 't', createdAt: '', updatedAt: '' } as never, history, undefined, { hearsAudio })
    assert.deepEqual(out.map((m) => m.content), ['q', SPOKEN_REPLY_PLACEHOLDER, 'and?', 'Berlin.'])
  }
})

test('export keeps a reply\'s text and carries no audio bytes, as it does for a voice message', () => {
  const conv = { id: 'c', title: 't', systemPrompt: '', modelKey: 'm', sampling: {}, expertMode: false, kind: 'chat', preserveThinking: false, createdAt: '', updatedAt: '', messages: [msg('user', '', [REPLY_REF]), msg('assistant', 'Paris.', [REPLY_REF]), msg('assistant', '', [clip(9)])] } as never
  const snapshot = buildSnapshot(conv, defaultConfig(), '1.0.0', '2026-09-09T00:00:00.000Z', 'export')
  assert.deepEqual(snapshot.messages.map((m) => m.content), ['', 'Paris.', ''])
  const json = JSON.stringify(snapshot)
  assert.ok(!json.includes('attachment:') && !json.includes('base64') && !json.includes('RIFF'))
})

test('an in-memory store keeps a reply\'s clip inline, as it does a voice message\'s: nothing on disk to outlive it', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const [kept] = await store.attachments.save([clip(5)])
  assert.equal(kept, clip(5))
  store.close()
})

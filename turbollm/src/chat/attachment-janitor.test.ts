// Scalability review 2.7: the background job that moves images already stored inline into files, and deletes files
// no message names any more. Runs on desktop's node:sqlite and Android's sql.js, so each check runs on both.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { AttachmentJanitor } from './attachment-janitor'
import { attachmentRefId } from './attachments'
import { ConversationStore } from './db'
import { preloadSqlJs } from './store/sqlite-adapter'
import { tmpDir } from '../test-support/tmp'

type Backend = 'node:sqlite' | 'sql.js'
const BACKENDS: Backend[] = ['node:sqlite', 'sql.js']

async function withFileStore(backend: Backend, fn: (store: ConversationStore, dir: string) => Promise<void>): Promise<void> {
  const actual = process.platform
  if (backend === 'sql.js') {
    Object.defineProperty(process, 'platform', { value: 'android' })
    await preloadSqlJs()
  }
  const dir = tmpDir('tllm-attach-janitor-')
  let store: ConversationStore | null = null
  try {
    store = new ConversationStore(dir)
    await fn(store, dir)
  } finally {
    store?.close()
    Object.defineProperty(process, 'platform', { value: actual })
    rmSync(dir, { recursive: true, force: true })
  }
}

const image = (n: number) => `data:image/png;base64,${Buffer.from(`png-bytes-${n}`.padEnd(30, '.')).toString('base64')}`
const files = (dir: string) => (existsSync(join(dir, 'attachments')) ? readdirSync(join(dir, 'attachments')).sort() : [])
const janitor = (store: ConversationStore, graceMs = 3600_000) =>
  new AttachmentJanitor({ db: store, log: () => {}, graceMs, scanWindow: 4 })

for (const backend of BACKENDS) {
  test(`backfill moves inline images into files a few rows at a time, and a second run finds nothing to do (${backend})`, () => withFileStore(backend, async (store, dir) => {
    const conv = store.createConversation()
    const rows = []
    for (let i = 0; i < 10; i++) {
      rows.push(store.addMessage(conv.id, 'user', `q${i}`, { attachments: i % 2 === 0 ? [image(i), image(i)] : [] }))
    }
    const keptInline = store.addMessage(conv.id, 'user', 'svg', { attachments: ['data:image/svg+xml;base64,PHN2Zy8+'] })

    const first = await janitor(store).run()
    assert.equal(first?.converted, 5)
    assert.ok(first!.batches >= 3, `scanned in windows, got ${first!.batches}`)
    for (const [i, row] of rows.entries()) {
      const stored = store.getMessage(row.id)!.attachments
      if (i % 2) assert.deepEqual(stored, [])
      else {
        assert.equal(stored.length, 2)
        assert.ok(stored.every((a) => attachmentRefId(a)), `row ${i} converted`)
        assert.equal(await store.attachments.inline(stored[0]), image(i), 'byte for byte')
      }
    }
    assert.deepEqual(store.getMessage(keptInline.id)!.attachments, ['data:image/svg+xml;base64,PHN2Zy8+'])
    assert.equal(files(dir).length, 5, 'one file per distinct image')

    assert.equal((await janitor(store).run())?.converted, 0)
    assert.equal(files(dir).length, 5)
  }))

  test(`backfill leaves External Chat API rows inline, as their client wrote them (${backend})`, () => withFileStore(backend, async (store, dir) => {
    const conv = store.createConversation()
    const own = store.addMessage(conv.id, 'user', 'mine', { attachments: [image(1)] })
    store.handle.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,attachments,stats,created_at,tenant,owner) VALUES ('ext-1',?,9,'user','theirs',?,'{}',?,'acme','bob')`)
      .run(conv.id, JSON.stringify([image(2)]), new Date().toISOString())

    assert.equal((await janitor(store).run())?.converted, 1)
    assert.ok(attachmentRefId(store.getMessage(own.id)!.attachments[0]))
    assert.equal(store.messageAttachmentsJson('ext-1'), JSON.stringify([image(2)]))
    assert.equal(files(dir).length, 1, 'no file written for the row left alone')
  }))

  test(`backfill after a crash between writing the file and updating the row converts the row and reuses the file (${backend})`, () => withFileStore(backend, async (store, dir) => {
    const conv = store.createConversation()
    const row = store.addMessage(conv.id, 'user', 'q', { attachments: [image(1)] })
    await store.attachments.save([image(1)]) // the crashed run's write; its row update never happened
    assert.equal((await janitor(store).run())?.converted, 1)
    assert.ok(attachmentRefId(store.getMessage(row.id)!.attachments[0]))
    assert.equal(files(dir).length, 1)
  }))

  test(`collection deletes files no row names once past the grace period, and keeps shared ones while any row names them (${backend})`, () => withFileStore(backend, async (store, dir) => {
    const a = store.createConversation()
    const b = store.createConversation()
    const [shared] = await store.attachments.save([image(1)])
    const [onlyA] = await store.attachments.save([image(2)])
    store.addMessage(a.id, 'user', 'q', { attachments: [shared, onlyA] })
    store.addMessage(b.id, 'user', 'q', { attachments: [shared] })
    const [orphan] = await store.attachments.save([image(3)])

    assert.equal((await janitor(store).run())?.deleted, 0, 'every unreferenced file is still inside the grace period')
    assert.equal(files(dir).length, 3)

    store.deleteConversation(a.id)
    const old = new Date(Date.now() - 2 * 3600_000)
    for (const ref of [shared, onlyA, orphan]) utimesSync(join(dir, 'attachments', attachmentRefId(ref)!), old, old)
    assert.equal((await janitor(store).run())?.deleted, 2)
    assert.deepEqual(files(dir), [attachmentRefId(shared)], 'still named by the other chat')
  }))

  test(`collection keeps a voice clip a row names by its .wav reference (${backend})`, () => withFileStore(backend, async (store, dir) => {
    const conv = store.createConversation()
    const [clip] = await store.attachments.save([`data:audio/wav;base64,${Buffer.from('RIFF-clip-bytes').toString('base64')}`])
    assert.match(clip, /\.wav$/)
    store.addMessage(conv.id, 'user', '', { attachments: [clip] })
    const old = new Date(Date.now() - 2 * 3600_000)
    utimesSync(join(dir, 'attachments', attachmentRefId(clip)!), old, old)
    assert.equal((await janitor(store).run())?.deleted, 0)
    assert.deepEqual(files(dir), [attachmentRefId(clip)])
  }))
}

test('an in-memory store has no files: the janitor does nothing', async () => {
  const store = new ConversationStore(':memory:')
  try {
    const conv = store.createConversation()
    store.addMessage(conv.id, 'user', 'q', { attachments: [image(1)] })
    assert.deepEqual(await janitor(store).run(), { converted: 0, deleted: 0, batches: 0 })
    assert.deepEqual(store.getMessages(conv.id)[0].attachments, [image(1)])
  } finally {
    store.close()
  }
})

test('two runs asked for at once share one', async () => {
  const store = new ConversationStore(':memory:')
  try {
    const j = janitor(store)
    assert.equal(j.run(), j.run())
  } finally {
    store.close()
  }
})

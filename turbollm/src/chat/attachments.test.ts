// Scalability review 2.7: chat images live in files under <dataDir>/attachments, named by their
// content hash, and messages.attachments keeps only a short `attachment:<id>` reference.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { AttachmentStore, attachmentRefId, audioAttachmentFormat, downloadFileName, isAttachmentRef, isAudioAttachment, isDownloadAttachmentRef, isImageAttachmentRef } from './attachments'
import { IN_MEMORY_DATA_DIR } from './db'
import { tmpDir } from '../test-support/tmp'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const PNG_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
const PNG_ID = `${createHash('sha256').update(PNG_BYTES).digest('hex')}.png`

function freshStore(): { store: AttachmentStore; dir: string } {
  const dir = tmpDir('tllm-attachments-')
  return { store: new AttachmentStore(dir), dir }
}

const backdate = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms)
  utimesSync(path, t, t)
}

test('save writes an image data URL to a content-addressed file and returns its reference', async () => {
  const { store, dir } = freshStore()
  const [ref] = await store.save([PNG_URL])
  assert.equal(ref, `attachment:${PNG_ID}`)
  assert.ok(isAttachmentRef(ref))
  assert.equal(attachmentRefId(ref), PNG_ID)
  assert.deepEqual(readFileSync(join(dir, 'attachments', PNG_ID)), PNG_BYTES)
  assert.deepEqual(readdirSync(join(dir, 'attachments')), [PNG_ID], 'no temp file left behind')
})

test('save dedupes identical images to one file', async () => {
  const { store, dir } = freshStore()
  const refs = await store.save([PNG_URL, PNG_URL])
  assert.equal(refs[0], refs[1])
  assert.deepEqual(readdirSync(join(dir, 'attachments')), [PNG_ID])
})

test('save keeps inline what it cannot give back byte for byte, or should not serve', async () => {
  const { store } = freshStore()
  const keep = [
    'data:image/svg+xml;base64,PHN2Zy8+', // script-capable, never served from our origin
    'data:image/jpg;base64,AAAA', // non-canonical mime: the engine must see the same string
    'data:image/png;base64,AAA', // non-canonical base64
    'data:image/png;name=x.png;base64,AAAA',
    'https://example.com/cat.png',
    `attachment:${PNG_ID}`,
  ]
  assert.deepEqual(await store.save(keep), keep)
})

test('an in-memory store keeps every image inline', async () => {
  const store = new AttachmentStore(IN_MEMORY_DATA_DIR)
  assert.deepEqual(await store.save([PNG_URL]), [PNG_URL])
})

test('inline turns a reference back into the exact data URL it was saved from; anything else passes through', async () => {
  const { store } = freshStore()
  const jpeg = `data:image/jpeg;base64,${Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64')}`
  const refs = await store.save([PNG_URL, jpeg])
  assert.equal(await store.inline(refs[0]), PNG_URL)
  assert.equal(await store.inline(refs[1]), jpeg)
  assert.equal(await store.inline(PNG_URL), PNG_URL)
  assert.equal(await store.inline(`attachment:${'0'.repeat(64)}.png`), null, 'a missing file')
})

test('resolveMedia swaps image references in engine messages for data URLs and drops a missing one', async () => {
  const { store } = freshStore()
  const [ref] = await store.save([PNG_URL])
  const messages = [
    { role: 'system', content: 'be brief' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: ref } },
        { type: 'image_url', image_url: { url: 'data:image/gif;base64,R0lG' } },
        { type: 'image_url', image_url: { url: `attachment:${'1'.repeat(64)}.png` } },
      ],
    },
  ]
  await store.resolveMedia(messages)
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'what is this' },
    { type: 'image_url', image_url: { url: PNG_URL } },
    { type: 'image_url', image_url: { url: 'data:image/gif;base64,R0lG' } },
  ])
  assert.equal(messages[0].content, 'be brief')
})

test('file accepts only a well-formed id, so no request can name a path outside the folder', async () => {
  const { store, dir } = freshStore()
  await store.save([PNG_URL])
  assert.deepEqual(store.file(PNG_ID), { path: join(dir, 'attachments', PNG_ID), mime: 'image/png' })
  for (const bad of ['../turbollm.db', `..\\${PNG_ID}`, PNG_ID.toUpperCase(), `${PNG_ID}/`, `x${PNG_ID}`, `${PNG_ID.slice(0, -4)}.svg`, '']) {
    assert.equal(store.file(bad), null, bad)
  }
})

test('collectGarbage deletes unreferenced files past the grace period and keeps the rest', async () => {
  const { store, dir } = freshStore()
  const gif = `data:image/gif;base64,${Buffer.from('GIF89a-one').toString('base64')}`
  const webp = `data:image/webp;base64,${Buffer.from('RIFF-two').toString('base64')}`
  const [kept, orphan, young] = await store.save([PNG_URL, gif, webp])
  const folder = join(dir, 'attachments')
  for (const ref of [kept, orphan]) backdate(join(folder, attachmentRefId(ref)!), 2 * 3600_000)
  const strayTemp = join(folder, `${PNG_ID}.abc.tmp`)
  writeFileSync(strayTemp, 'partial')
  backdate(strayTemp, 2 * 3600_000)

  const deleted = await store.collectGarbage(new Set([attachmentRefId(kept)!]), 3600_000)
  assert.equal(deleted, 2)
  assert.ok(existsSync(join(folder, attachmentRefId(kept)!)), 'referenced')
  assert.ok(!existsSync(join(folder, attachmentRefId(orphan)!)), 'unreferenced and old')
  assert.ok(existsSync(join(folder, attachmentRefId(young)!)), 'unreferenced but inside the grace period (an upload in flight)')
  assert.ok(!existsSync(strayTemp), 'a crashed write\'s temp file')
})

test('saving an image that already exists refreshes its age, so a collection running alongside keeps it', async () => {
  const { store, dir } = freshStore()
  await store.save([PNG_URL])
  const path = join(dir, 'attachments', PNG_ID)
  backdate(path, 2 * 3600_000)
  await store.save([PNG_URL])
  assert.equal(await store.collectGarbage(new Set(), 3600_000), 0)
  assert.ok(existsSync(path))
})

test('collectGarbage with no folder yet deletes nothing', async () => {
  const { store } = freshStore()
  assert.equal(await store.collectGarbage(new Set(), 0), 0)
})

test('an image that cannot be written stays inline rather than failing the send', async () => {
  const dir = tmpDir('tllm-attachments-blocked-')
  writeFileSync(join(dir, 'attachments'), 'a file where the folder should be')
  const store = new AttachmentStore(dir)
  assert.deepEqual(await store.save([PNG_URL]), [PNG_URL])
})

// A 44-byte RIFF/WAVE header and four 16-bit samples: small, but a real clip's shape.
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0x2c, 0, 0, 0]), Buffer.from('WAVEfmt ', 'ascii'),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]),
  Buffer.from('data', 'ascii'), Buffer.from([8, 0, 0, 0]), Buffer.from([0, 0, 0x10, 0, 0, 0, 0xf0, 0xff]),
])
const WAV_B64 = WAV_BYTES.toString('base64')
const WAV_URL = `data:audio/wav;base64,${WAV_B64}`
const WAV_ID = `${createHash('sha256').update(WAV_BYTES).digest('hex')}.wav`

test('save stores a WAV clip as <sha256>.wav and returns its reference', async () => {
  const { store, dir } = freshStore()
  const [ref] = await store.save([WAV_URL])
  assert.equal(ref, `attachment:${WAV_ID}`)
  assert.equal(attachmentRefId(ref), WAV_ID)
  assert.deepEqual(readFileSync(join(dir, 'attachments', WAV_ID)), WAV_BYTES)
})

test('save stores audio/mpeg as an .mp3 file', async () => {
  const { store, dir } = freshStore()
  const bytes = Buffer.from('ID3-not-really-an-mp3')
  const [ref] = await store.save([`data:audio/mpeg;base64,${bytes.toString('base64')}`])
  const id = `${createHash('sha256').update(bytes).digest('hex')}.mp3`
  assert.equal(ref, `attachment:${id}`)
  assert.deepEqual(readFileSync(join(dir, 'attachments', id)), bytes)
})

test('save keeps a clip in a format the engines do not decode inline', async () => {
  const { store, dir } = freshStore()
  const keep = [`data:audio/ogg;base64,${WAV_B64}`, `data:audio/webm;base64,${WAV_B64}`]
  assert.deepEqual(await store.save(keep), keep)
  assert.ok(!existsSync(join(dir, 'attachments')), 'nothing written')
})

test('audioAttachmentFormat and isAudioAttachment tell clips from images and garbage', async () => {
  const { store } = freshStore()
  const [wavRef, pngRef] = await store.save([WAV_URL, PNG_URL])
  assert.equal(audioAttachmentFormat(WAV_URL), 'wav')
  assert.equal(audioAttachmentFormat(wavRef), 'wav')
  assert.equal(audioAttachmentFormat(`data:audio/mpeg;base64,AAAA`), 'mp3')
  assert.equal(audioAttachmentFormat(`attachment:${'a'.repeat(64)}.mp3`), 'mp3')
  assert.ok(isAudioAttachment(wavRef))
  for (const other of [PNG_URL, pngRef, 'data:audio/ogg;base64,AAAA', 'attachment:nope.wav', 'https://example.com/a.wav', 'hello', '']) {
    assert.equal(audioAttachmentFormat(other), null, other)
    assert.equal(isAudioAttachment(other), false, other)
  }
})

test('file serves a clip as audio/wav', async () => {
  const { store, dir } = freshStore()
  await store.save([WAV_URL])
  assert.deepEqual(store.file(WAV_ID), { path: join(dir, 'attachments', WAV_ID), mime: 'audio/wav' })
})

test('resolveMedia turns a clip reference and an inline data URL into the bare base64 of the audio', async () => {
  const { store } = freshStore()
  const [ref] = await store.save([WAV_URL])
  const messages = [{
    role: 'user',
    content: [
      { type: 'input_audio', input_audio: { data: ref, format: 'wav' } },
      { type: 'input_audio', input_audio: { data: WAV_URL, format: 'wav' } },
    ],
  }]
  await store.resolveMedia(messages)
  const parts = messages[0].content as Array<{ input_audio: { data: string; format: string } }>
  assert.equal(parts.length, 2)
  for (const part of parts) {
    assert.equal(part.input_audio.data, WAV_B64, 'no data: prefix')
    assert.equal(part.input_audio.format, 'wav')
    assert.deepEqual(Buffer.from(part.input_audio.data, 'base64'), WAV_BYTES)
  }
})

test('resolveMedia leaves already-bare base64 audio alone', async () => {
  const { store } = freshStore()
  const messages = [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: WAV_B64, format: 'wav' } }] }]
  await store.resolveMedia(messages)
  assert.deepEqual(messages[0].content, [{ type: 'input_audio', input_audio: { data: WAV_B64, format: 'wav' } }])
})

test('resolveMedia drops a clip whose file is gone and still resolves images in the same message', async () => {
  const { store, dir } = freshStore()
  const [wavRef, pngRef] = await store.save([WAV_URL, PNG_URL])
  rmSync(join(dir, 'attachments', attachmentRefId(wavRef)!))
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'listen' },
      { type: 'input_audio', input_audio: { data: wavRef, format: 'wav' } },
      { type: 'image_url', image_url: { url: pngRef } },
    ],
  }]
  await store.resolveMedia(messages)
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'listen' },
    { type: 'image_url', image_url: { url: PNG_URL } },
  ])
})

test('collectGarbage reclaims an unreferenced clip and keeps a referenced one', async () => {
  const { store, dir } = freshStore()
  const other = Buffer.concat([WAV_BYTES, Buffer.from([1, 2])])
  const [kept, orphan] = await store.save([WAV_URL, `data:audio/wav;base64,${other.toString('base64')}`])
  const folder = join(dir, 'attachments')
  for (const ref of [kept, orphan]) backdate(join(folder, attachmentRefId(ref)!), 2 * 3600_000)
  assert.equal(await store.collectGarbage(new Set([attachmentRefId(kept)!]), 3600_000), 1)
  assert.ok(existsSync(join(folder, attachmentRefId(kept)!)))
  assert.ok(!existsSync(join(folder, attachmentRefId(orphan)!)))
})

test('isImageAttachmentRef is a stored image only: not a clip, an inline image, or a malformed or other stored file', () => {
  const hex = 'c'.repeat(64)
  for (const ext of ['png', 'jpg', 'gif', 'webp', 'bmp', 'avif']) assert.equal(isImageAttachmentRef(`attachment:${hex}.${ext}`), true, ext)
  for (const other of [`attachment:${hex}.wav`, `attachment:${hex}.mp3`, `attachment:${hex}.csv`, `attachment:${hex}`, 'attachment:../x.png', PNG_URL, ''])
    assert.equal(isImageAttachmentRef(other), false, other)
})

test('resolveMedia never sends a clip, another stored file or a malformed reference as an image (GitHub #52)', async () => {
  const { store } = freshStore()
  const [clip] = await store.save([`data:audio/wav;base64,${Buffer.from('RIFF0000WAVE').toString('base64')}`])
  assert.ok(isAudioAttachment(clip) && isAttachmentRef(clip))
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: clip } },
      { type: 'image_url', image_url: { url: `attachment:${'d'.repeat(64)}.csv` } },
      { type: 'image_url', image_url: { url: 'attachment:garbage' } },
    ],
  }]
  await store.resolveMedia(messages)
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'look' }])
})

// Files made for download (GitHub #52): CSV, JSON, text and Python from run_python, in through saveFile only.

const CSV_BYTES = Buffer.from('name,total\nada,3\n')
const CSV_ID = `${createHash('sha256').update(CSV_BYTES).digest('hex')}.csv`

test('save never stores a download type: a text/csv data URL a client sends stays inline', async () => {
  const { store, dir } = freshStore()
  const url = `data:text/csv;base64,${CSV_BYTES.toString('base64')}`
  assert.deepEqual(await store.save([url]), [url])
  assert.ok(!existsSync(join(dir, 'attachments', CSV_ID)))
})

test('saveFile stores a download content-addressed, and it is served, never inlined, and collected like any file', async () => {
  const { store, dir } = freshStore()
  const ref = await store.saveFile(CSV_BYTES, 'csv')
  assert.equal(ref, `attachment:${CSV_ID}`)
  assert.ok(isAttachmentRef(ref!) && isDownloadAttachmentRef(ref!) && !isImageAttachmentRef(ref!) && !isAudioAttachment(ref!))
  assert.deepEqual(readFileSync(join(dir, 'attachments', CSV_ID)), CSV_BYTES)
  assert.deepEqual(store.file(CSV_ID), { path: join(dir, 'attachments', CSV_ID), mime: 'text/csv; charset=utf-8' })
  assert.equal(await store.saveFile(CSV_BYTES, 'csv'), ref, 'the same bytes are the same file')
  assert.equal(await store.inline(ref!), null)
  for (const [ext, mime] of [['json', 'application/json; charset=utf-8'], ['txt', 'text/plain; charset=utf-8'], ['py', 'text/x-python; charset=utf-8']]) {
    const r = await store.saveFile(Buffer.from(`x-${ext}`), ext)
    assert.equal(store.file(attachmentRefId(r!)!)!.mime, mime, ext)
  }

  backdate(join(dir, 'attachments', CSV_ID), 2 * 3600_000)
  assert.equal(await store.collectGarbage(new Set([CSV_ID]), 3600_000), 0, 'kept while a row names it')
  assert.equal(await store.collectGarbage(new Set(), 3600_000), 1, 'collected once none does')
  assert.ok(!existsSync(join(dir, 'attachments', CSV_ID)))
})

test('saveFile takes only the download types, and the store names no page or picture it could serve as one', async () => {
  const { store } = freshStore()
  for (const ext of ['html', 'htm', 'svg', 'js', 'png', 'wav', 'CSV', '', '../csv']) assert.equal(await store.saveFile(CSV_BYTES, ext), null, ext)
  const hex = 'f'.repeat(64)
  for (const id of [`${hex}.html`, `${hex}.svg`, `${hex}.js`, `${hex}.CSV`]) assert.equal(store.file(id), null, id)
  assert.equal(await new AttachmentStore(IN_MEMORY_DATA_DIR).saveFile(CSV_BYTES, 'csv'), null, 'an in-memory database has no folder')
})

test('downloadFileName keeps the name without folders, control characters or quotes, always with the file\'s own extension', () => {
  const id = CSV_ID
  const cases: Array<[string, string]> = [
    ['cleaned.csv', 'cleaned.csv'],
    ['Cleaned.CSV', 'Cleaned.csv'],
    ['../../etc/passwd', 'passwd.csv'],
    ['..\\..\\Windows\\win.ini', 'win.ini.csv'],
    ['page.html', 'page.html.csv'],
    ['a\r\nX-Evil: 1.csv', 'a__X-Evil_ 1.csv'],
    ['say "hi".csv', 'say _hi_.csv'],
    ['données été.csv', 'données été.csv'],
    ['...', 'file.csv'],
    ['', 'file.csv'],
    ['.csv', 'file.csv'],
    [`${'x'.repeat(300)}.csv`, `${'x'.repeat(124)}.csv`],
  ]
  for (const [name, want] of cases) assert.equal(downloadFileName(name, id), want, JSON.stringify(name))
  assert.equal(downloadFileName('data.csv', `${'0'.repeat(64)}.json`), 'data.csv.json')
})

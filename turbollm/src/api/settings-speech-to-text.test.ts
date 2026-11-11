// Settings → Voice, the daemon's part (config.speechToText): the whisper model, spoken language, whisper-server path and
// GPU switch. Stored by PATCH /api/v1/settings field by field and served by GET; a config written before it, or hand-
// edited into nonsense, loads with the defaults.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore, type SpeechToText } from '../config/config'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

const DEFAULTS: SpeechToText = { model: '', language: 'auto', serverPath: '', gpu: false }

/** `remote` makes the caller a non-host one: an open LAN peer with no key (app.request() carries no TCP connection, so
 *  isLoopback fails closed to null, as in engines-zip-upload.test.ts). */
function mk(remote = false) {
  const store = ConfigStore.load(join(tmpDir('tllm-stt-settings-'), 'config.json'))
  if (remote) store.update((c) => { c.daemon.lanBind = true; c.daemon.requireApiKey = false })
  const app = new Hono()
  registerApi(app, { version: 'test', store, manager: { status: () => ({ state: 'stopped', model: null }) } } as unknown as Deps)
  const patch = (body: unknown) => app.request('/api/v1/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const get = async () => ((await (await app.request('/api/v1/settings')).json()) as { speechToText?: SpeechToText }).speechToText
  return { store, patch, get }
}

test('speechToText shows the default block in GET /api/v1/settings', async () => {
  const { get, store } = mk()
  assert.deepEqual(await get(), DEFAULTS)
  assert.deepEqual(store.snapshot().speechToText, DEFAULTS)
})

test('PATCH stores each speechToText field on its own, lower-cases the language, and leaves the others alone', async () => {
  const { patch, get, store } = mk()
  assert.equal((await patch({ speechToText: { model: 'small' } })).status, 200)
  assert.deepEqual(await get(), { ...DEFAULTS, model: 'small' })
  assert.equal((await patch({ speechToText: { language: 'DE' } })).status, 200)
  assert.deepEqual(await get(), { ...DEFAULTS, model: 'small', language: 'de' })
  assert.equal((await patch({ speechToText: { gpu: true } })).status, 200)
  const expected = { model: 'small', language: 'de', serverPath: '', gpu: true }
  assert.deepEqual(await get(), expected)
  assert.deepEqual(store.snapshot().speechToText, expected)
  assert.equal((await patch({ speechToText: { model: '', language: 'auto', gpu: false } })).status, 200)
  assert.deepEqual(store.snapshot().speechToText, DEFAULTS, 'empty and auto put the defaults back')
})

test('a custom ggml file name is accepted as a model', async () => {
  const { patch, store } = mk()
  assert.equal((await patch({ speechToText: { model: 'ggml-custom.bin' } })).status, 200)
  assert.equal(store.snapshot().speechToText.model, 'ggml-custom.bin')
})

test('PATCH refuses a model that is a path or unknown, a language whisper does not know, and a relative serverPath, storing nothing', async () => {
  const { patch, store } = mk()
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ model: '../../etc/passwd' }, 'speechToText.model'],
    [{ model: 'nope' }, 'speechToText.model'],
    [{ language: 'klingon' }, 'speechToText.language'],
    [{ serverPath: 'relative/whisper-server' }, 'speechToText.serverPath'],
  ]
  for (const [speechToText, field] of cases) {
    const before = store.snapshot().autoLoadOnStart
    const res = await patch({ speechToText, autoLoadOnStart: !before })
    assert.equal(res.status, 400, JSON.stringify(speechToText))
    const { error } = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(error.code, 'invalid_config_value')
    assert.ok(error.message.startsWith(`${field} must be`), error.message)
    assert.deepEqual(store.snapshot().speechToText, DEFAULTS, `${JSON.stringify(speechToText)}: unchanged`)
    assert.equal(store.snapshot().autoLoadOnStart, before, 'nothing else is written either')
  }
})

test('PATCH answers a speechToText value of the wrong JSON type with 400, never a 500', async () => {
  const { patch, store } = mk()
  const bodies: unknown[] = [
    { speechToText: { model: 5 } },
    { speechToText: { gpu: 'yes' } },
    { speechToText: { language: null } },
    { speechToText: { serverPath: 7 } },
  ]
  for (const body of bodies) {
    const res = await patch(body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_config_value', JSON.stringify(body))
    assert.deepEqual(store.snapshot().speechToText, DEFAULTS)
  }
})

test('an absolute whisper-server path, POSIX or Windows, is stored when the host sets it', async () => {
  for (const serverPath of ['/opt/x/whisper-server', 'C:\\x\\whisper-server.exe']) {
    const { patch, get, store } = mk()
    assert.equal((await patch({ speechToText: { serverPath } })).status, 200, serverPath)
    assert.equal(store.snapshot().speechToText.serverPath, serverPath)
    assert.equal((await get())?.serverPath, serverPath)
  }
})

test('a non-host caller cannot set the whisper-server path, since the daemon will run it, but can set the other fields', async () => {
  const { patch, store } = mk(true)
  for (const serverPath of ['/opt/x/whisper-server', 'C:\\x\\whisper-server.exe']) {
    const res = await patch({ speechToText: { serverPath } })
    assert.equal(res.status, 403, serverPath)
    const { error } = (await res.json()) as { error: { code: string; message: string; field?: string } }
    assert.equal(error.code, 'api_key_required')
    assert.equal(error.field, 'speechToText.serverPath')
    assert.equal(store.snapshot().speechToText.serverPath, '')
  }
  assert.equal((await patch({ speechToText: { model: 'base', language: 'fr', gpu: true } })).status, 200)
  assert.deepEqual(store.snapshot().speechToText, { model: 'base', language: 'fr', serverPath: '', gpu: true })
})

test('a config with a missing, null or garbage speechToText block loads with safe defaults', () => {
  const dir = tmpDir('tllm-stt-settings-')
  const cases: Array<[unknown, SpeechToText]> = [
    [undefined, DEFAULTS],
    [null, DEFAULTS],
    [{}, DEFAULTS],
    ['small', DEFAULTS],
    [{ language: 'xx', gpu: 'yes', model: 7 }, DEFAULTS],
    [{ model: 'small', language: 'de', serverPath: '/opt/w', gpu: true }, { model: 'small', language: 'de', serverPath: '/opt/w', gpu: true }],
  ]
  for (const [value, expected] of cases) {
    const path = join(dir, 'config.json')
    const raw = JSON.parse(JSON.stringify(ConfigStore.load(join(dir, 'seed.json')).snapshot())) as Record<string, unknown>
    if (value === undefined) delete raw.speechToText
    else raw.speechToText = value
    writeFileSync(path, JSON.stringify(raw))
    assert.deepEqual(ConfigStore.load(path).snapshot().speechToText, expected, JSON.stringify(value))
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChatStoreAdapter } from './load-adapter.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const ECHO = join(here, 'fixtures', 'echo-store.mjs')

test('kind sqlite loads no adapter', async () => {
  assert.equal(await loadChatStoreAdapter({ kind: 'sqlite' }, here), null)
})

test('a valid module adapter loads and receives its options', async () => {
  const store = await loadChatStoreAdapter(
    { kind: 'module', specifier: ECHO, options: { marker: 'passed-through' } }, here,
  )
  assert.ok(store)
  assert.equal((store as unknown as { marker: string }).marker, 'passed-through')
  assert.equal((await store!.health()).ok, true)
})

test('a loaded adapter actually round-trips a chat', async () => {
  const store = await loadChatStoreAdapter({ kind: 'module', specifier: ECHO }, here)
  const s = { tenant: 'acme', owner: 'u1' }
  const c = await store!.createChat(s, { title: 'Through the adapter' })
  assert.equal((await store!.getChat(s, c.id))?.title, 'Through the adapter')
})

test('a missing module fails loudly rather than falling back to sqlite', async () => {
  await assert.rejects(
    () => loadChatStoreAdapter({ kind: 'module', specifier: './does-not-exist.mjs' }, here),
    /chat-store adapter/i,
  )
})

test('a module with no default export is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-adapter-bad-'))
  const p = join(dir, 'no-default.mjs')
  writeFileSync(p, 'export const notDefault = 1\n')
  try {
    await assert.rejects(() => loadChatStoreAdapter({ kind: 'module', specifier: p }, dir), /default export/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a factory returning an object missing interface methods is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-adapter-partial-'))
  const p = join(dir, 'partial.mjs')
  writeFileSync(p, 'export default () => ({ capabilities: {}, async health() { return { ok: true } } })\n')
  try {
    await assert.rejects(() => loadChatStoreAdapter({ kind: 'module', specifier: p }, dir), /missing required method/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an adapter whose health check fails is rejected at load time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-adapter-sick-'))
  const p = join(dir, 'sick.mjs')
  const methods = [
    'createChat', 'getChat', 'listChats', 'updateChat', 'deleteChat', 'addMessage', 'getMessage',
    'listMessages', 'updateMessage', 'deleteMessage', 'getLastMessage', 'close',
  ].map((m) => `  async ${m}() { return null },`).join('\n')
  writeFileSync(p, `export default () => ({\n  capabilities: {},\n${methods}\n  async health() { return { ok: false, detail: 'db down' } },\n})\n`)
  try {
    await assert.rejects(() => loadChatStoreAdapter({ kind: 'module', specifier: p }, dir), /health check failed.*db down/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

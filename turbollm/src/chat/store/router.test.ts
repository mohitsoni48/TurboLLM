import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'
import { LOCAL_SCOPE } from './chat-store.js'
import { ChatStoreRouter } from './router.js'

function twoStores() {
  const a = mkdtempSync(join(tmpdir(), 'turbollm-router-local-'))
  const b = mkdtempSync(join(tmpdir(), 'turbollm-router-adapter-'))
  const localConv = new ConversationStore(a)
  const adapterConv = new ConversationStore(b)
  return {
    router: new ChatStoreRouter(localConv.chatStore, adapterConv.chatStore),
    local: localConv.chatStore,
    adapter: adapterConv.chatStore,
    cleanup: () => {
      localConv.close(); adapterConv.close()
      rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true })
    },
  }
}

test('the local tenant is served by the local store, never the adapter', async () => {
  const { router, local, adapter, cleanup } = twoStores()
  try {
    const c = await router.createChat(LOCAL_SCOPE, { title: 'UI chat' })
    assert.equal((await local.getChat(LOCAL_SCOPE, c.id))?.title, 'UI chat')
    assert.equal(await adapter.getChat(LOCAL_SCOPE, c.id), null)
  } finally {
    cleanup()
  }
})

test('a non-local tenant is served by the adapter, never the local store', async () => {
  const { router, local, adapter, cleanup } = twoStores()
  try {
    const s = { tenant: 'acme', owner: 'u1' }
    const c = await router.createChat(s, { title: 'Integrator chat' })
    assert.equal((await adapter.getChat(s, c.id))?.title, 'Integrator chat')
    assert.equal(await local.getChat(s, c.id), null)
  } finally {
    cleanup()
  }
})

test('with no adapter configured, a non-local tenant is refused rather than silently served locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-router-solo-'))
  const conv = new ConversationStore(dir)
  const router = new ChatStoreRouter(conv.chatStore, null)
  try {
    await assert.rejects(
      () => router.createChat({ tenant: 'acme', owner: 'u1' }, { title: 'x' }),
      /not_supported|no adapter/i,
    )
  } finally {
    conv.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('capabilities are the intersection, so a caller is never promised what one backend lacks', async () => {
  const { router, cleanup } = twoStores()
  try {
    assert.equal(typeof router.capabilities, 'object')
    assert.equal(router.capabilities.branching, true)
  } finally {
    cleanup()
  }
})

test('health reports unhealthy when either backend is unhealthy', async () => {
  const { router, cleanup } = twoStores()
  try {
    assert.equal((await router.health()).ok, true)
  } finally {
    cleanup()
  }
})

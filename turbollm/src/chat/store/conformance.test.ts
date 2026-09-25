// turbollm/src/chat/store/conformance.test.ts
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConversationStore } from '../db.js'
import { runConformanceSuite } from './conformance.js'
import { loadChatStoreAdapter } from './load-adapter.js'
import { tmpDir } from '../../test-support/tmp'

runConformanceSuite('SqliteChatStore', async () => {
  const dir = tmpDir('turbollm-conformance-')
  const conv = new ConversationStore(dir)
  return {
    store: conv.chatStore,
    cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) },
  }
})

const here = fileURLToPath(new URL('.', import.meta.url))

// Proves the conformance suite is a genuine backend-agnostic contract (spec 27 §13) by
// running it a second time against a non-SQLite, in-memory fixture loaded through the
// same adapter-loading path a real integrator's module would go through.
runConformanceSuite('EchoStore (in-memory fixture)', async () => {
  const store = await loadChatStoreAdapter(
    { kind: 'module', specifier: join(here, 'fixtures', 'echo-store.mjs') }, here,
  )
  if (!store) throw new Error('fixture adapter failed to load')
  return { store, cleanup: () => {} }
})

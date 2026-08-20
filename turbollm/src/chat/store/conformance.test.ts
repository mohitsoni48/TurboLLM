// turbollm/src/chat/store/conformance.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'
import { runConformanceSuite } from './conformance.js'

runConformanceSuite('SqliteChatStore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-conformance-'))
  const conv = new ConversationStore(dir)
  return {
    store: conv.chatStore,
    cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) },
  }
})

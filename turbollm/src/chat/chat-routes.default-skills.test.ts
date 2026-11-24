// Skills the user switched on for every new chat (config.defaultSkillIds) seed a conversation created
// without a skillIds of its own. A caller that names skillIds, even an empty list, gets exactly those.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ChatRuns } from './chat-runs.js'
import { ChatTurns } from './chat-turns.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

function harness(defaultSkillIds: string[]) {
  const dir = tmpDir('tllm-chat-default-skills-')
  const store = new ConversationStore(dir)
  const cfg = {
    defaultSkillIds,
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    chatTurns: new ChatTurns(), chatRuns: new ChatRuns(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
    manager: { status: () => ({ state: 'stopped' }), target: () => undefined, currentOpts: () => null },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  const create = async (body: unknown) => {
    const res = await app.request('/api/v1/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return (await res.json()) as { skillIds?: string[] }
  }
  return { create, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('a new chat with no skillIds of its own starts with the default skills', async () => {
  const h = harness(['skill-creator'])
  try {
    assert.deepEqual((await h.create({})).skillIds, ['skill-creator'])
  } finally { h.cleanup() }
})

test('a default skill that no longer exists in the library is left out', async () => {
  const h = harness(['skill-creator', 'deleted-long-ago'])
  try {
    assert.deepEqual((await h.create({})).skillIds, ['skill-creator'])
  } finally { h.cleanup() }
})

test('a default skill chat cannot run is left out', async () => {
  const h = harness(['skill-creator', 'filesystem'])
  try {
    assert.deepEqual((await h.create({})).skillIds, ['skill-creator'])
  } finally { h.cleanup() }
})

test('an explicit skillIds wins over the defaults, an empty list meaning none', async () => {
  const h = harness(['skill-creator'])
  try {
    assert.deepEqual((await h.create({ skillIds: [] })).skillIds, [])
  } finally { h.cleanup() }
})

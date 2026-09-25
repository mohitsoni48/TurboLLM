// N2 (Phase 5 final-review-fix re-review, ADR-422): POST .../tool-calls/:id/approve's
// `always_allow` decision persists a GLOBAL tool policy write to config.json — a configuration
// change, not a chat action — but this route sits entirely under `requiredCapability`'s
// `models:use` mapping (auth.ts), the product's own default and minimum remote-token scope.
// Without a check here, a bare chat-only token reaching the internet could permanently widen
// what tools run unattended on the host, for the OWNER's own future chats too. The write also
// happens BEFORE the pending-approval lookup (chat-routes.ts's own documented invariant), so
// this is reachable with a fabricated toolCallId against any real conversation — no genuine
// pending tool call is required.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import { hashKey } from '../auth.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

interface FakeConfig {
  tools: { toolPolicies: Record<string, string>; autoAllowAll: boolean }
  apiKeys: Array<{ id: string; name: string; hash: string; prefix: string; createdAt: string; lastUsedAt: string | null; grant?: unknown }>
}

function mkApp(): { app: Hono; store: ConversationStore; cfg: FakeConfig; cleanup: () => void } {
  const dir = tmpDir('tllm-chat-approve-')
  const store = new ConversationStore(dir)
  const cfg: FakeConfig = { tools: { toolPolicies: {}, autoAllowAll: false }, apiKeys: [] }
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: FakeConfig) => void) => fn(cfg) },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  return { app, store, cfg, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function approve(app: Hono, convId: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`/api/v1/conversations/${convId}/tool-calls/fake-tool-call-id/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ toolName: 'run_code', decision: 'always_allow' }),
  })
}

test('N2: a remote-kind (scoped) token cannot persist a global tool policy via always_allow', async () => {
  const h = mkApp()
  const raw = 'tllm-scopedtoolkeyscopedtoolkeyscopedto1'
  h.cfg.apiKeys.push({
    id: 'k1', name: 'remote', hash: hashKey(raw), prefix: raw.slice(0, 12),
    createdAt: '', lastUsedAt: null, grant: { kind: 'remote', capabilities: ['models:use'] },
  })
  try {
    const conv = h.store.createConversation()
    const res = await approve(h.app, conv.id, { 'X-TurboLLM-Auth': raw })
    assert.equal(res.status, 403, 'a remote-kind token must be refused before the config write, not merely after')
    assert.deepEqual(h.cfg.tools.toolPolicies, {}, 'no global policy may have been written')
  } finally {
    h.cleanup()
  }
})

test('N2: an ordinary (ungranted) key can still persist always_allow, unchanged', async () => {
  const h = mkApp()
  const raw = 'tllm-ordinarytoolkeyordinarytoolkeyord1'
  h.cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(raw), prefix: raw.slice(0, 12), createdAt: '', lastUsedAt: null })
  try {
    const conv = h.store.createConversation()
    const res = await approve(h.app, conv.id, { 'X-TurboLLM-Auth': raw })
    // 404 here means the write ran and only the (non-existent) pending approval lookup failed —
    // exactly the pre-existing behavior this test pins as unchanged for a real credential.
    assert.equal(res.status, 404)
    assert.deepEqual(h.cfg.tools.toolPolicies, { run_code: 'allow' }, 'the write must still happen for a real, ungranted key')
  } finally {
    h.cleanup()
  }
})

test('N2: a caller with no key at all (e.g. local dev) can still persist always_allow, unchanged', async () => {
  const h = mkApp()
  try {
    const conv = h.store.createConversation()
    const res = await approve(h.app, conv.id)
    assert.equal(res.status, 404)
    assert.deepEqual(h.cfg.tools.toolPolicies, { run_code: 'allow' })
  } finally {
    h.cleanup()
  }
})

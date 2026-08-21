// In-app chat against a Turbo Link host (ADR-376 phase 2, final-review C-1).
//
// The picker offered remote rows before this and chat could not serve them: the qualified
// id went to the LOCAL engine loader, and the send path required `d.manager` to be running
// and generated against `d.manager.target()`. `ModelLoadMenu.remote.test.tsx` pinned only
// what `onLoad` RECEIVES, which is exactly why the receiver's behaviour shipped broken —
// so these tests drive the composed path end to end and assert what the receiver DOES.
//
// The local engine is deliberately STOPPED in every remote case. If any of these pass with
// a running local manager but fail without one, chat is still secretly local.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'

const REMOTE = {
  linkId: 'lnk1',
  baseUrl: 'https://rig.trycloudflare.com',
  token: 'tllm-hostsecret',
  modelKey: 'qwen3-35b',
}

interface Ledger {
  generationStarts: number
  generationEnds: number
  liveGens: number
  completions: number
  gateAcquires: number
  /** Every model id handed to the ROUTER's auto-swap/load path. Must stay empty for a
   *  remote turn: resolving a link is a lookup, never a load. */
  loads: string[]
}

interface Captured { url: string; headers: Headers; body: string }

function mkApp(opts: { localRunning?: boolean } = {}): {
  app: Hono
  store: ConversationStore
  ledger: Ledger
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-chat-remote-'))
  const store = new ConversationStore(dir)
  const ledger: Ledger = {
    generationStarts: 0, generationEnds: 0, liveGens: 0, completions: 0, gateAcquires: 0, loads: [],
  }
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    db: store,
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    gate: { acquire: async () => { ledger.gateAcquires++; return () => {} } },
    remoteCatalog: {
      modelOn: (linkId: string, key: string) =>
        (linkId === REMOTE.linkId && key === REMOTE.modelKey
          ? { key, name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true }
          : undefined),
    },
    modelRouter: {
      route: async (m: string) => { ledger.loads.push(m); return { target: 'http://127.0.0.1:8081' } },
      resolveRemoteTarget: (id: string) =>
        (id === `rig/${REMOTE.modelKey}`
          ? { target: REMOTE.baseUrl, remote: REMOTE }
          : id === 'offline/model'
            ? { status: 503, message: "'offline' is not connected (unreachable). Reconnect it in Settings → Turbo Link." }
            : undefined),
    },
    manager: {
      status: () => (opts.localRunning
        ? { state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }
        : { state: 'stopped', model: null }),
      target: () => (opts.localRunning ? 'http://127.0.0.1:8081' : null),
      currentOpts: () => null,
      generationStart: () => { ledger.generationStarts++ },
      generationEnd: () => { ledger.generationEnds++ },
      setLiveGen: () => { ledger.liveGens++ },
      recordCompletion: () => { ledger.completions++ },
    },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  return { app, store, ledger, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** One complete non-streaming-shaped SSE reply, as llama.cpp's server sends it. */
function sseCompletion(): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from the rig' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 }, timings: { predicted_per_second: 42 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function captureFetch(respond: () => Response): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers ?? {}),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    return respond()
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

async function send(app: Hono, convId: string, model: string | undefined): Promise<{ status: number; text: string }> {
  const res = await app.request(`/api/v1/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hi', ...(model ? { model } : {}) }),
  })
  return { status: res.status, text: res.ok ? await res.text() : await res.text() }
}

test('a remote model actually generates in chat, with the local engine STOPPED', async () => {
  const h = mkApp()
  const f = captureFetch(sseCompletion)
  try {
    const conv = h.store.createConversation()
    const out = await send(h.app, conv.id, `rig/${REMOTE.modelKey}`)
    assert.equal(out.status, 200)
    // The host's tokens reached the client — not a 409 'Load a model first.'
    assert.match(out.text, /hello from the rig/)
  } finally {
    f.restore()
    h.cleanup()
  }

  assert.equal(f.calls.length, 1)
  const cap = f.calls[0]
  // Same façade URL and same token handling as the gateway — one proxy, not two.
  assert.equal(cap.url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(cap.headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
  // The host routes on its OWN plain key: a `rig/` prefix names no machine there.
  assert.equal((JSON.parse(cap.body) as { model: string }).model, REMOTE.modelKey)
})

test('picking a remote model never loads, swaps or touches the local engine', async () => {
  const h = mkApp({ localRunning: true })
  const f = captureFetch(sseCompletion)
  try {
    const conv = h.store.createConversation()
    await send(h.app, conv.id, `rig/${REMOTE.modelKey}`)
  } finally {
    f.restore()
    h.cleanup()
  }
  // The concrete failure C-1 described: the qualified id reaching a LOCAL loader, which
  // aborts every in-flight generation and then loads something else entirely.
  assert.deepEqual(h.ledger.loads, [])
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.ok(!f.calls[0].url.includes('127.0.0.1'))
})

test("a remote turn writes nothing into this machine's engine state", async () => {
  const h = mkApp({ localRunning: true })
  const f = captureFetch(sseCompletion)
  try {
    const conv = h.store.createConversation()
    await send(h.app, conv.id, `rig/${REMOTE.modelKey}`)
  } finally {
    f.restore()
    h.cleanup()
  }
  // I-4, on the chat path: the engine card must not read "Generating…" for another box's
  // work, and hostIdleState reads sessionStats().activeRequests.
  assert.equal(h.ledger.generationStarts, 0)
  assert.equal(h.ledger.generationEnds, 0)
  assert.equal(h.ledger.liveGens, 0)
  assert.equal(h.ledger.completions, 0)
  // I-3: no local engine slot is spent on work no local engine does.
  assert.equal(h.ledger.gateAcquires, 0)
})

test('the reply is labelled with the HOST\'s model and the HOST\'s context window', async () => {
  const h = mkApp({ localRunning: true })
  const f = captureFetch(sseCompletion)
  let stats: { model?: string; ctxMax?: number } | undefined
  try {
    const conv = h.store.createConversation()
    await send(h.app, conv.id, `rig/${REMOTE.modelKey}`)
    const last = h.store.getLastMessage(conv.id)!
    stats = last.stats as { model?: string; ctxMax?: number }
  } finally {
    f.restore()
    h.cleanup()
  }
  // Never 'Gemma 27B'/8192 — that is what this machine has loaded, on different weights.
  assert.equal(stats?.model, 'Qwen3 35B')
  assert.equal(stats?.ctxMax, 262144)
})

test('an OFFLINE machine is a typed 503 naming it — never a local model answering instead', async () => {
  const h = mkApp({ localRunning: true })
  const f = captureFetch(sseCompletion)
  let res: Response
  try {
    const conv = h.store.createConversation()
    res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', model: 'offline/model' }),
    })
  } finally {
    f.restore()
    h.cleanup()
  }
  assert.equal(res.status, 503)
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'remote_unavailable')
  assert.match(body.error.message, /offline/)
  // Design invariant 1: it must NOT have degraded to the loaded local model.
  assert.equal(f.calls.length, 0)
})

test('a local send is byte-for-byte the path it always was', async () => {
  const h = mkApp({ localRunning: true })
  const f = captureFetch(sseCompletion)
  try {
    const conv = h.store.createConversation()
    const out = await send(h.app, conv.id, undefined)
    assert.equal(out.status, 200)
  } finally {
    f.restore()
    h.cleanup()
  }
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8081/v1/chat/completions')
  assert.equal(f.calls[0].headers.get('X-TurboLLM-Auth'), null)
  assert.equal((JSON.parse(f.calls[0].body) as { model: string }).model, 'gemma-27b')
  assert.equal(h.ledger.generationStarts, 1)
  assert.equal(h.ledger.generationEnds, 1)
  assert.equal(h.ledger.completions, 1)
})

test('a local model key containing a slash still resolves LOCALLY', async () => {
  // `unsloth/Qwen3-GGUF` looks qualified and is not. The remote decision is
  // ModelRouter.resolveRemoteTarget — "does this name a machine I link to" — never a
  // `includes('/')` test, which is what would break this.
  const h = mkApp({ localRunning: true })
  const f = captureFetch(sseCompletion)
  try {
    const conv = h.store.createConversation()
    const out = await send(h.app, conv.id, 'unsloth/Qwen3-GGUF')
    assert.equal(out.status, 200)
  } finally {
    f.restore()
    h.cleanup()
  }
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8081/v1/chat/completions')
  assert.equal(f.calls[0].headers.get('X-TurboLLM-Auth'), null)
})

test('/continue routes to the host too — both send paths, not just the first', async () => {
  const h = mkApp()
  const f = captureFetch(sseCompletion)
  try {
    const conv = h.store.createConversation()
    h.store.addMessage(conv.id, 'user', 'hi')
    const res = await h.app.request(`/api/v1/conversations/${conv.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `rig/${REMOTE.modelKey}` }),
    })
    assert.equal(res.status, 200)
    await res.text()
  } finally {
    f.restore()
    h.cleanup()
  }
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(f.calls[0].headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
})

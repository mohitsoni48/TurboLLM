// Gateway-level coverage for Turbo Link peer-side proxying (ADR-376, phase 2 task 4).
//
// `link-proxy.test.ts` proves the HELPER works. This file proves the GATEWAY actually calls
// it: that a route result carrying `remote` leaves for the host's façade URL with the LINK
// token (never the caller's own credential), that the qualified id is unqualified before it
// travels, and that an inbound client abort reaches the upstream request. Verifying one layer
// in isolation is precisely how this path would ship broken.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'

const REMOTE = { linkId: 'lnk1', baseUrl: 'https://rig.trycloudflare.com', token: 'tllm-hostsecret', modelKey: 'Qwen3' }

function fakeDeps(): Deps {
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: REMOTE.baseUrl, remote: REMOTE }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'stopped', model: null }),
      target: () => null,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
      setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'mlx-lm' }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

interface Captured { url: string; headers: Headers; body: string; signal: AbortSignal | undefined | null }

/** Swap in a fetch that records the outbound request. `respond` decides what comes back;
 *  a never-resolving promise models a host that is still generating. */
function captureFetch(respond: (cap: Captured) => Promise<Response>): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const cap: Captured = {
      url: String(input),
      headers: new Headers(init?.headers ?? {}),
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal,
    }
    calls.push(cap)
    return respond(cap)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function jsonCompletion(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

test('/v1/chat/completions on a remote route reaches the façade with the link token', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => jsonCompletion())
  try {
    await app.request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-TurboLLM-Auth': 'callers-own-key',
        'x-api-key': 'anthropic-style-key',
        Authorization: 'Bearer someone-elses',
      },
      body: JSON.stringify({ model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(f.calls.length, 1)
  const cap = f.calls[0]
  assert.equal(cap.url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  // Invariant 7, at the gateway rather than in the helper's own unit test.
  assert.equal(cap.headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
  assert.equal(cap.headers.get('x-api-key'), null)
  assert.equal(cap.headers.get('authorization'), null)
  // The host routes on ITS own plain key — a qualified id would find no such machine there.
  assert.equal((JSON.parse(cap.body) as { model: string }).model, 'Qwen3')
})

test('/v1/messages on a remote route reaches the façade with the link token', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const f = captureFetch(async () => jsonCompletion())
  try {
    await app.request('http://local.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'anthropic-style-key' },
      body: JSON.stringify({ model: 'Rig/Qwen3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    })
  } finally {
    f.restore()
  }
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(f.calls[0].headers.get('X-TurboLLM-Auth'), 'tllm-hostsecret')
  assert.equal(f.calls[0].headers.get('x-api-key'), null)
  assert.equal((JSON.parse(f.calls[0].body) as { model: string }).model, 'Qwen3')
})

// ── Invariant 6, at the gateway: the host must not keep generating into a dead socket.
test('aborting the inbound request aborts the upstream request to the host', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  let upstreamAborted = false
  let sawRequest: (() => void) | null = null
  const seen = new Promise<void>((r) => { sawRequest = r })
  const f = captureFetch((cap) => new Promise<Response>((_res, rej) => {
    cap.signal?.addEventListener('abort', () => { upstreamAborted = true; rej(new Error('aborted')) })
    sawRequest?.()
  }))
  const ac = new AbortController()
  try {
    const p = Promise.resolve(app.request(new Request('http://local.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Rig/Qwen3', messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    }))).catch(() => undefined)
    await seen
    ac.abort()
    await p
  } finally {
    f.restore()
  }
  // Pinned so this stays a test of the REMOTE branch: the local branch has always passed
  // ac.signal, so without this the assertion below could pass while the link path leaked.
  assert.equal(f.calls[0].url, 'https://rig.trycloudflare.com/api/link/v1/chat/completions')
  assert.equal(upstreamAborted, true)
})

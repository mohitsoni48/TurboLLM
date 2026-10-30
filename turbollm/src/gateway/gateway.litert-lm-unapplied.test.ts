// An API client's request fields that `litert-lm serve` does not apply (min_p, stop, stop_sequences and the penalties:
// it reads none of them) went nowhere through the gateway, and nothing said so; the chat names them in a note. The
// response now names them in X-Unapplied-Parameters, the header the Android app's server names min_p in (it applies
// stop strings and the penalties itself, so nothing is added for it where its header is relayed; /v1/messages, which
// writes its own reply, names its min_p itself). llama.cpp is unchanged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { rememberLitertLmModel } from '../engines/litert-lm-request'

const ENGINE = 'http://engine.invalid'
const MODEL_PATH = '/models/Qwen3-0.6B.litertlm'
const KEY = 'qwen3 0.6b|?|3000'
const ENTRY = { key: KEY, name: 'Qwen3 0.6B', format: 'litertlm', path: MODEL_PATH } as unknown as ModelEntry

function deps(kind: string): Deps {
  const byKeyOrName = (id: string) => (id === KEY || id === ENTRY.name ? ENTRY : undefined)
  return {
    scanner: { list: () => ({ models: [ENTRY], scanning: false, lastScanAt: '' }) },
    modelRouter: {
      route: async () => ({ target: ENGINE }),
      targetEntry: byKeyOrName,
      resolveRemoteTarget: () => undefined,
      resolveLocal: byKeyOrName,
      routeTo: async () => ({ target: ENGINE }),
    },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: true } }) },
    manager: {
      status: () => ({ state: 'running', model: { key: KEY, name: ENTRY.name } }),
      target: () => ENGINE,
      currentOpts: () => ({ modelPath: MODEL_PATH }),
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

/** The X-Unapplied-Parameters the client gets for `body`, the model on `serve` (or the Android app's server, which
 *  answers with `serverHeader` as its own X-Unapplied-Parameters when given). */
async function unapplied(kind: string, native: boolean, path: '/v1/chat/completions' | '/v1/messages', body: Record<string, unknown>, saved: Record<string, number | string[]> = {}, serverHeader?: string): Promise<string | null> {
  rememberLitertLmModel(MODEL_PATH, { sampling: saved, native })
  const app = new Hono()
  registerGateway(app, deps(kind))
  const realFetch = globalThis.fetch
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(serverHeader ? { 'x-unapplied-parameters': serverHeader } : {}) }
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers })) as typeof fetch
  try {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: KEY, messages: [{ role: 'user', content: 'hi' }], ...(path === '/v1/messages' ? { max_tokens: 4000 } : {}), ...body }),
    })
    assert.equal(res.status, 200)
    await res.text()
    return res.headers.get('x-unapplied-parameters')
  } finally {
    globalThis.fetch = realFetch
  }
}

test('what `serve` does not apply is named in X-Unapplied-Parameters: an API client\'s own and the model\'s saved', async () => {
  assert.equal(await unapplied('litert-lm', false, '/v1/chat/completions', { min_p: 0.05, stop: ['###'], presence_penalty: 0.5, frequency_penalty: 0.2 }),
    'min_p, stop, presence_penalty, frequency_penalty')
  assert.equal(await unapplied('litert-lm', false, '/v1/chat/completions', {}, { repeat_penalty: 1.2 }), 'repeat_penalty')
  assert.equal(await unapplied('litert-lm', false, '/v1/chat/completions', {}, { min_p: 0.2 }), 'min_p')
  assert.equal(await unapplied('litert-lm', false, '/v1/messages', { stop_sequences: ['END'] }), 'stop_sequences')
  // Neutral values are no request for anything, and a request with none of them gets no header.
  assert.equal(await unapplied('litert-lm', false, '/v1/chat/completions', { presence_penalty: 0, frequency_penalty: 0, min_p: 0, stop: [] }), null)
  assert.equal(await unapplied('litert-lm', false, '/v1/chat/completions', { temperature: 0.7 }), null)
  // The Android app's server applies stop strings and the penalties, and names min_p itself; llama.cpp applies them all.
  assert.equal(await unapplied('litert-lm', true, '/v1/chat/completions', { stop: ['###'], presence_penalty: 0.5 }), null)
  assert.equal(await unapplied('llama-server', false, '/v1/chat/completions', { min_p: 0.05, stop: ['###'] }), null)
})

test('on /v1/messages a Min P is named for the Android app\'s server too, whose own header that reply never carries', async () => {
  // /v1/chat/completions relays the server's X-Unapplied-Parameters; /v1/messages writes an Anthropic reply of its own,
  // so a Min P saved on the model was dropped there with no word, where `serve` got it named.
  assert.equal(await unapplied('litert-lm', true, '/v1/messages', {}, { min_p: 0.2 }, 'min_p'), 'min_p')
  assert.equal(await unapplied('litert-lm', true, '/v1/chat/completions', {}, { min_p: 0.2 }, 'min_p'), 'min_p', 'relayed, not named twice')
  // The rest that server applies; nothing set, nothing named.
  assert.equal(await unapplied('litert-lm', true, '/v1/messages', { stop_sequences: ['END'] }), null)
  assert.equal(await unapplied('litert-lm', true, '/v1/messages', {}), null)
})

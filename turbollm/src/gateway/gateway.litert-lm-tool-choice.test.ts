// tool_choice "none" to a LiteRT-LM engine: neither of its servers read tool_choice, so the model was still shown every
// tool and could call them. The gateway's loop breaker answers a terminal agent's sixth identical call with exactly
// that "none", to make the model answer in text, and on LiteRT-LM the agent looped on. "none" now sends no tools.
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

async function engineBody(kind: string, path: '/v1/chat/completions' | '/v1/messages', body: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const app = new Hono()
  registerGateway(app, deps(kind))
  const bodies: Array<Record<string, unknown>> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: KEY, messages: [{ role: 'user', content: 'hi' }], ...(path === '/v1/messages' ? { max_tokens: 4000 } : {}), ...body }),
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(bodies.length, 1)
  return bodies[0]
}

const TOOLS = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]
const HISTORY = [
  { role: 'user', content: 'read a.txt' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'hello' },
]

test('tool_choice "none" sends a LiteRT-LM engine no tools; its history\'s calls stay; llama.cpp is as before', async () => {
  const b = await engineBody('litert-lm', '/v1/chat/completions', { messages: HISTORY, tools: TOOLS, tool_choice: 'none' })
  assert.equal('tools' in b, false)
  const sent = b.messages as Array<{ role: string; tool_calls?: unknown[] }>
  assert.ok(sent.some((m) => m.role === 'assistant' && m.tool_calls?.length) && sent.some((m) => m.role === 'tool'), 'the earlier call and its result are still sent')
  assert.deepEqual((await engineBody('litert-lm', '/v1/chat/completions', { messages: HISTORY, tools: TOOLS, tool_choice: 'auto' })).tools, TOOLS)
  assert.deepEqual((await engineBody('litert-lm', '/v1/chat/completions', { messages: HISTORY, tools: TOOLS })).tools, TOOLS)
  assert.deepEqual((await engineBody('llama-server', '/v1/chat/completions', { messages: HISTORY, tools: TOOLS, tool_choice: 'none' })).tools, TOOLS)
})

/** A request through the gateway, on `serve` or the Android app's server: its answer, and the bodies the engine got. */
async function ask(native: boolean, path: '/v1/chat/completions' | '/v1/messages', body: Record<string, unknown>) {
  rememberLitertLmModel(MODEL_PATH, { sampling: {}, native })
  const app = new Hono()
  registerGateway(app, deps('litert-lm'))
  const bodies: Array<Record<string, unknown>> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: KEY, messages: [{ role: 'user', content: 'hi' }], ...(path === '/v1/messages' ? { max_tokens: 4000 } : {}), ...body }),
    })
    return { status: res.status, json: await res.json() as Record<string, any>, bodies }
  } finally {
    globalThis.fetch = realFetch
  }
}

const ANTHROPIC_TOOLS = [{ name: 'read', input_schema: { type: 'object' } }]

test('a forced tool call is a 400 on `serve`, which ignored it, as the Android app\'s server answers it; both protocols', async () => {
  const req = await ask(false, '/v1/chat/completions', { tools: TOOLS, tool_choice: 'required' })
  assert.equal(req.status, 400)
  assert.equal(req.json.error.param, 'tool_choice')
  assert.match(req.json.error.message, /^Invalid tool_choice: this server cannot make the model call a tool \("required"\)/)
  assert.equal(req.bodies.length, 0, 'the engine is not asked')
  const named = await ask(false, '/v1/chat/completions', { tools: TOOLS, tool_choice: { type: 'function', function: { name: 'read' } } })
  assert.equal(named.status, 400)
  const anyTool = await ask(false, '/v1/messages', { tools: ANTHROPIC_TOOLS, tool_choice: { type: 'any' } })
  assert.equal(anyTool.status, 400)
  assert.equal(anyTool.json.type, 'error')
  assert.equal(anyTool.json.error.type, 'invalid_request_error')
  assert.equal(anyTool.bodies.length, 0)
  // The Android app's server answers it itself: forwarded.
  const app = await ask(true, '/v1/chat/completions', { tools: TOOLS, tool_choice: 'required' })
  assert.equal(app.status, 200)
  assert.equal(app.bodies[0].tool_choice, 'required')
  // auto is the model's choice, and an Anthropic client's none is none (no tools), not a forced call.
  assert.equal((await ask(false, '/v1/chat/completions', { tools: TOOLS, tool_choice: 'auto' })).status, 200)
  const none = await ask(false, '/v1/messages', { tools: ANTHROPIC_TOOLS, tool_choice: { type: 'none' } })
  assert.equal(none.status, 200)
  assert.equal(none.bodies[0].tool_choice, 'none')
  assert.equal('tools' in none.bodies[0], false)
})

// Thinking through the gateway to a LiteRT-LM engine. An OpenAI client's own reasoning_effort, every value of which
// LiteRT-LM takes, was always deleted and rewritten through Qwen3.8's aliases ('high' → 'xhigh', 'none' → enable_thinking
// false) into chat_template_kwargs, which `serve` never reads, nor did the Android app's server until it took
// chat_template_kwargs too: opencode's or an SDK's choice, 'none' included, never reached a .litertlm. Claude Code's
// thinking setting reached it only in llama.cpp's shape, and its default {type:'adaptive'} got a half-of-max_tokens
// budget. The same requests to llama.cpp are unchanged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { sessionAuth } from '../code/session-auth'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'

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

test('an OpenAI client\'s reasoning_effort reaches a LiteRT-LM engine as it is, none and high included', async () => {
  for (const v of ['none', 'minimal', 'high', 'xhigh']) {
    const b = await engineBody('litert-lm', '/v1/chat/completions', { reasoning_effort: v })
    assert.equal(b.reasoning_effort, v, v)
    assert.equal((b.chat_template_kwargs as Record<string, unknown> | undefined)?.reasoning_effort, undefined, `${v}: not rewritten into chat_template_kwargs`)
  }
})

test('the same reasoning_effort to llama.cpp is still translated into chat_template_kwargs', async () => {
  const b = await engineBody('llama-server', '/v1/chat/completions', { reasoning_effort: 'high' })
  assert.equal(b.reasoning_effort, undefined)
  assert.equal((b.chat_template_kwargs as Record<string, unknown>).reasoning_effort, 'xhigh')
})

test('Claude Code\'s thinking reaches a LiteRT-LM engine: disabled is none, an explicit budget is on', async () => {
  assert.equal((await engineBody('litert-lm', '/v1/messages', { thinking: { type: 'disabled' } })).reasoning_effort, 'none')
  const on = await engineBody('litert-lm', '/v1/messages', { thinking: { type: 'enabled', budget_tokens: 1000 } })
  assert.equal(on.reasoning_effort, 'medium')
  assert.equal(on.thinking_budget_tokens, 1000)
  const onNoBudget = await engineBody('litert-lm', '/v1/messages', { thinking: { type: 'enabled' } })
  assert.equal(onNoBudget.reasoning_effort, 'medium')
  assert.equal('thinking_budget_tokens' in onNoBudget, false, 'no half-of-max_tokens cap the client did not ask for')
})

test('Claude Code\'s adaptive thinking leaves it to the model: nothing is sent, no budget either', async () => {
  const b = await engineBody('litert-lm', '/v1/messages', { thinking: { type: 'adaptive' } })
  assert.equal('reasoning_effort' in b, false)
  assert.equal('thinking_budget_tokens' in b, false)
  // llama.cpp keeps its half-of-max_tokens budget for adaptive.
  assert.equal((await engineBody('llama-server', '/v1/messages', { thinking: { type: 'adaptive' } })).thinking_budget_tokens, 2000)
})

test('a Code session\'s own override reaches a LiteRT-LM engine as reasoning_effort, and its Off wins', async () => {
  const level = sessionAuth.mint('sess-litert-level')
  sessionAuth.setReasoningEffort('sess-litert-level', 'low')
  assert.equal((await engineBody('litert-lm', '/v1/chat/completions', { reasoning_effort: 'high' }, level)).reasoning_effort, 'low')
  // A level does not turn a client's off back on.
  assert.equal((await engineBody('litert-lm', '/v1/chat/completions', { reasoning_effort: 'none' }, level)).reasoning_effort, 'none')
  const off = sessionAuth.mint('sess-litert-off')
  sessionAuth.setThinkingBudget('sess-litert-off', 0)
  assert.equal((await engineBody('litert-lm', '/v1/chat/completions', { reasoning_effort: 'high' }, off)).reasoning_effort, 'none')
  const budget = sessionAuth.mint('sess-litert-budget')
  sessionAuth.setThinkingBudget('sess-litert-budget', 1024)
  assert.equal((await engineBody('litert-lm', '/v1/chat/completions', { reasoning_effort: 'none' }, budget)).reasoning_effort, 'medium', 'the slider\'s budget wins over the client\'s off, as for llama.cpp')
  const viaMessages = sessionAuth.mint('sess-litert-msgs')
  sessionAuth.setReasoningEffort('sess-litert-msgs', 'xhigh')
  assert.equal((await engineBody('litert-lm', '/v1/messages', {}, viaMessages)).reasoning_effort, 'xhigh')
  // A session with no override set sends nothing.
  const none = sessionAuth.mint('sess-litert-none')
  assert.equal('reasoning_effort' in (await engineBody('litert-lm', '/v1/chat/completions', {}, none)), false)
})

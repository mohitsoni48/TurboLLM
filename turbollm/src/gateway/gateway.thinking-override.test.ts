// Regression coverage for ADR-284's server-side thinking-budget override: a terminal-agent
// session (pi/claude/opencode) has no per-turn send call of our own to attach the composer's
// ThinkingBudgetSlider to — the gateway instead injects/overrides the outbound request's
// thinking field itself, keyed by the session-scoped token the CLI presents (session-auth.ts),
// regardless of what the CLI itself sent. Verifies both gateway entry points: /v1/messages
// (Anthropic protocol → req.thinking) and /v1/chat/completions (OpenAI protocol passthrough →
// thinking_budget_tokens directly).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { sessionAuth } from '../code/session-auth'
import type { Deps } from '../deps'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

function fakeDeps(): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: 'http://engine.invalid.local:1' }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: () => {} },
  } as unknown as Deps
}

/** Captures the single outbound fetch call's body without needing a real/valid engine —
 *  the handler's response after that point is irrelevant to what this test checks. */
function captureOutboundFetch(): { calls: Array<{ url: string; body: Record<string, unknown> | null }>; restore: () => void } {
  const original = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let body: Record<string, unknown> | null = null
    try { body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null } catch { body = null }
    calls.push({ url: String(url), body })
    return new Response(null, { status: 500 })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('/v1/messages: a session with a thinking-budget override gets it injected regardless of what the CLI sent', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-override-anthropic')
  sessionAuth.setThinkingBudget('sess-override-anthropic', 4000)

  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'qwen3-8b|Q4|123', max_tokens: 32000, stream: false, messages: [],
        thinking: { type: 'enabled', budget_tokens: 999 }, // what Claude Code itself sent
      }),
    })
  } finally { capture.restore() }

  assert.equal(capture.calls.length, 1)
  assert.equal(capture.calls[0].body?.thinking_budget_tokens, 4000, 'override must win over the CLI-supplied 999')
})

test('/v1/messages: budget 0 disables thinking entirely, overriding an enabled request', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-override-off')
  sessionAuth.setThinkingBudget('sess-override-off', 0)

  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'qwen3-8b|Q4|123', max_tokens: 32000, stream: false, messages: [],
        thinking: { type: 'enabled', budget_tokens: 999 },
      }),
    })
  } finally { capture.restore() }

  assert.equal(capture.calls[0].body?.thinking_budget_tokens, undefined, 'no thinking budget forwarded when the override is 0 (off)')
})

test('/v1/messages: no override set for the session — the request passes through unmodified', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-no-override')
  // No setThinkingBudget call — unlimited/no override is the default.

  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'qwen3-8b|Q4|123', max_tokens: 32000, stream: false, messages: [],
        thinking: { type: 'enabled', budget_tokens: 777 },
      }),
    })
  } finally { capture.restore() }

  assert.equal(capture.calls[0].body?.thinking_budget_tokens, 777, "the CLI's own value must pass through untouched")
})

test('/v1/messages: an unrecognized token (manual `turbollm launch claude`, shared static token) is unaffected', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer turbollm-local' },
      body: JSON.stringify({
        model: 'qwen3-8b|Q4|123', max_tokens: 32000, stream: false, messages: [],
        thinking: { type: 'enabled', budget_tokens: 555 },
      }),
    })
  } finally { capture.restore() }

  assert.equal(capture.calls[0].body?.thinking_budget_tokens, 555)
})

test('/v1/chat/completions: OpenAI-protocol passthrough (pi/opencode) gets thinking_budget_tokens injected directly', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-override-openai')
  sessionAuth.setThinkingBudget('sess-override-openai', 6000)

  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false, thinking_budget_tokens: 111 }),
    })
  } finally { capture.restore() }

  assert.equal(capture.calls[0].body?.thinking_budget_tokens, 6000)
})

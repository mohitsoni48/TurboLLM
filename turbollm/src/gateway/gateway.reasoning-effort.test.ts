// Regression coverage for GitHub #213: a plain OpenAI-protocol client (opencode via
// `@ai-sdk/openai-compatible`, LiteLLM, or any script hitting /v1/chat/completions directly,
// with no TurboLLM Code-session token at all) sends the OpenAI-standard top-level
// `reasoning_effort` field. Before this fix that field passed straight through to the engine
// untouched, so whether it did anything depended entirely on the vendored llama.cpp build's
// own (version-dependent) support for it — on an older build every variant silently rendered
// identically. gateway.ts now translates it itself, through the same validated parser
// reasoning-effort.ts's own doc comment requires every caller to use.
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

async function postChatAs(app: Hono, token: string, body: Record<string, unknown>) {
  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: false, ...body }),
    })
  } finally { capture.restore() }
  return capture.calls[0]?.body
}

function postChat(app: Hono, body: Record<string, unknown>) {
  return postChatAs(app, 'turbollm-local', body)
}

test('a client-supplied reasoning_effort is translated into chat_template_kwargs, not forwarded raw', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'low' })

  assert.equal(outbound?.reasoning_effort, undefined, 'the raw top-level key must not reach the engine')
  assert.deepEqual((outbound?.chat_template_kwargs as Record<string, unknown>)?.reasoning_effort, 'low')
})

test("the OpenAI-standard 'high' is aliased to Qwen3.8's 'xhigh' rather than forwarded raw (would raise_exception)", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'high' })

  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown>)?.reasoning_effort, 'xhigh')
})

test("reasoning_effort: 'off' collapses onto enable_thinking/thinking_budget_tokens, same as the Code-session override", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'off' })

  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown>)?.enable_thinking, false)
  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown> | undefined)?.reasoning_effort, undefined)
})

test('an unsupported reasoning_effort value is dropped rather than forwarded to the engine', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'ultra-mega' })

  assert.equal(outbound?.reasoning_effort, undefined)
  assert.equal(outbound?.chat_template_kwargs, undefined)
})

test('no reasoning_effort field at all is a no-op — the request is otherwise unmodified', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, {})

  assert.equal(outbound?.reasoning_effort, undefined)
  assert.equal(outbound?.chat_template_kwargs, undefined)
  assert.equal(outbound?.thinking_budget_tokens, undefined)
})

test('a caller-supplied chat_template_kwargs is preserved alongside the translated reasoning_effort', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'medium', chat_template_kwargs: { some_other_flag: true } })

  const kwargs = outbound?.chat_template_kwargs as Record<string, unknown>
  assert.equal(kwargs.reasoning_effort, 'medium')
  assert.equal(kwargs.some_other_flag, true)
})

// A Code-session client (launched via TurboLLM's own `turbollm launch`) carries a
// session-scoped token AND may send its own top-level `reasoning_effort` on the same turn.
// The persisted session override must win cleanly — not just be added alongside whatever the
// client-value translation already wrote to chat_template_kwargs/thinking_budget_tokens.
test("a Code-session override to a real effort clears a client-sent 'off' cleanly (no stale enable_thinking/thinking_budget_tokens)", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-conflict-a')
  sessionAuth.setReasoningEffort('sess-conflict-a', 'low')

  const outbound = await postChatAs(app, token, { reasoning_effort: 'off' })

  const kwargs = outbound?.chat_template_kwargs as Record<string, unknown> | undefined
  assert.equal(kwargs?.reasoning_effort, 'low', "the session's override must win")
  assert.equal(kwargs?.enable_thinking, undefined, "no stale enable_thinking:false left over from the client's 'off'")
  assert.equal(outbound?.thinking_budget_tokens, undefined, "no stale thinking_budget_tokens:0 left over from the client's 'off'")
})

test("a Code-session override to 'off' clears a client-sent real effort cleanly (no stale reasoning_effort)", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-conflict-b')
  sessionAuth.setReasoningEffort('sess-conflict-b', 'off')

  const outbound = await postChatAs(app, token, { reasoning_effort: 'medium' })

  const kwargs = outbound?.chat_template_kwargs as Record<string, unknown> | undefined
  assert.equal(kwargs?.enable_thinking, false, "the session's 'off' override must win")
  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.equal(kwargs?.reasoning_effort, undefined, "no stale reasoning_effort:'medium' left over from the client's value")
})

test('a Code session with no reasoning-effort override set still gets the client value translated', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-no-effort-override')
  // No setReasoningEffort call — the client's own value should flow through untouched.

  const outbound = await postChatAs(app, token, { reasoning_effort: 'low' })

  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown>)?.reasoning_effort, 'low')
})

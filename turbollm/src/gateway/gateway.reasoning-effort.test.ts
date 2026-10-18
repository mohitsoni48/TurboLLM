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

function fakeDeps(engineKind = 'llama.cpp'): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target: 'http://engine.invalid.local:1' }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => ({ kind: engineKind }) },
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
// Except over the client's off: a session's level says how hard to think, not whether, and the web sets one for every
// terminal session it opens (its default xhigh until the user picks another), so a client's reasoning_effort 'off', or
// opencode's no-reasoning 'none', used to reach the engine as that level.
test("a client's reasoning_effort 'off' stays off in a Code session whose effort is set to a level", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-conflict-a')
  sessionAuth.setReasoningEffort('sess-conflict-a', 'low')

  const outbound = await postChatAs(app, token, { reasoning_effort: 'off' })

  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false }, "no reasoning_effort:'low' beside the client's 'off'")
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

// Thinking off on /v1/chat/completions (the thinking slider's Off, or a client's own chat_template_kwargs
// enable_thinking false) beside an effort level: the level's write cleared every key the pair can set before adding
// reasoning_effort, enable_thinking false among them. The web sets an effort for every terminal session it opens, so the
// slider's Off kept only thinking_budget_tokens 0, which vLLM, SGLang, MLX and llama.cpp builds without that sampler
// field ignore: the model went on thinking. Checked on the body each engine kind is sent.
const OFF_ENGINE_KINDS = ['llama-server', 'vllm', 'sglang', 'mlx']

test("/v1/chat/completions: the thinking slider's Off stays off beside a Code session's effort level, on every engine kind", async () => {
  for (const kind of OFF_ENGINE_KINDS) {
    const app = new Hono()
    registerGateway(app, fakeDeps(kind))
    const token = sessionAuth.mint(`sess-slider-off-chat-${kind}`)
    sessionAuth.setThinkingBudget(`sess-slider-off-chat-${kind}`, 0)
    // What CodeSessionScreen's open-time sync sets for a terminal session whose effort the user never picked.
    sessionAuth.setReasoningEffort(`sess-slider-off-chat-${kind}`, 'xhigh')

    const outbound = await postChatAs(app, token, {})

    assert.equal(outbound?.thinking_budget_tokens, 0, kind)
    assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false }, kind)
  }
})

test("/v1/chat/completions: a client's enable_thinking false stays off beside a Code session's effort level, on every engine kind", async () => {
  for (const kind of OFF_ENGINE_KINDS) {
    const app = new Hono()
    registerGateway(app, fakeDeps(kind))
    const token = sessionAuth.mint(`sess-client-off-chat-${kind}`)
    sessionAuth.setReasoningEffort(`sess-client-off-chat-${kind}`, 'low')

    const outbound = await postChatAs(app, token, { chat_template_kwargs: { enable_thinking: false, some_other_flag: true } })

    assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false, some_other_flag: true }, kind)
  }
})

test("/v1/chat/completions: a client's reasoning_effort 'none' stays off in a terminal the web opened at its default effort, on every engine kind", async () => {
  for (const kind of OFF_ENGINE_KINDS) {
    const app = new Hono()
    registerGateway(app, fakeDeps(kind))
    const token = sessionAuth.mint(`sess-client-none-chat-${kind}`)
    // What CodeSessionScreen's open-time sync sets for a terminal session whose effort the user never picked.
    sessionAuth.setReasoningEffort(`sess-client-none-chat-${kind}`, 'xhigh')

    const outbound = await postChatAs(app, token, { reasoning_effort: 'none' })

    assert.equal(outbound?.reasoning_effort, undefined, kind)
    assert.equal(outbound?.thinking_budget_tokens, 0, kind)
    assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false }, kind)
  }
})

// The thinking slider's budget (ADR-284) wins over what the client sent about thinking, on both routes: /v1/messages
// replaces a thinking {type:'disabled'} with it. /v1/chat/completions kept a client's enable_thinking false beside it,
// which turned thinking off under the budget the user set and, kept as an off flag, stopped the session's level too;
// a client's reasoning_effort 'none' (or 'off') sent budget 0 and enable_thinking false in place of the budget.
test("/v1/chat/completions: the thinking slider's budget wins over a client's enable_thinking false, as on /v1/messages", async () => {
  for (const effort of ['xhigh', undefined] as const) {
    const app = new Hono()
    registerGateway(app, fakeDeps())
    const id = `sess-slider-budget-client-off-${effort ?? 'none'}`
    const token = sessionAuth.mint(id)
    sessionAuth.setThinkingBudget(id, 4096)
    if (effort) sessionAuth.setReasoningEffort(id, effort)

    const chat = await postChatAs(app, token, { chat_template_kwargs: { enable_thinking: false } })
    const messages = await postMessagesAs(app, token, { thinking: { type: 'disabled' } })

    for (const [route, outbound] of [['/v1/chat/completions', chat], ['/v1/messages', messages]] as const) {
      assert.equal(outbound?.thinking_budget_tokens, 4096, `${route}, effort ${effort}`)
      assert.deepEqual(outbound?.chat_template_kwargs, effort ? { reasoning_effort: effort } : undefined, `${route}, effort ${effort}`)
    }
  }
})

test("/v1/chat/completions: the thinking slider's budget wins over a client's reasoning_effort 'none' or 'off'", async () => {
  for (const effort of ['xhigh', undefined] as const) {
    for (const clientOff of ['none', 'off']) {
      const app = new Hono()
      registerGateway(app, fakeDeps())
      const id = `sess-slider-budget-client-${clientOff}-${effort ?? 'unset'}`
      const token = sessionAuth.mint(id)
      sessionAuth.setThinkingBudget(id, 4096)
      if (effort) sessionAuth.setReasoningEffort(id, effort)

      const outbound = await postChatAs(app, token, { reasoning_effort: clientOff })

      assert.equal(outbound?.reasoning_effort, undefined, `${clientOff}, effort ${effort}`)
      assert.equal(outbound?.thinking_budget_tokens, 4096, `${clientOff}, effort ${effort}`)
      assert.deepEqual(outbound?.chat_template_kwargs, effort ? { reasoning_effort: effort } : undefined, `${clientOff}, effort ${effort}`)
    }
  }
})

test("/v1/chat/completions: a client's own enable_thinking false wins over its own reasoning_effort level", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: false } })

  assert.equal(outbound?.reasoning_effort, undefined, 'the raw top-level key must not reach the engine')
  assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false })
})

// On /v1/messages Claude Code says "off" as thinking {type:'disabled'}. A session's effort is a level, not an on
// switch: it used to replace that 'disabled' with thinking on the default budget, and the web sets an effort for every
// terminal session it opens (its default xhigh until the user picks another), so Claude Code's off never reached the
// engine from one. The off now stays off, and no level is sent beside it.
async function postMessagesAs(app: Hono, token: string, body: Record<string, unknown>) {
  const capture = captureOutboundFetch()
  try {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 32000, stream: false, messages: [], ...body }),
    })
  } finally { capture.restore() }
  return capture.calls[0]?.body
}

test("/v1/messages: a client's thinking 'disabled' stays off in a terminal the web opened at its default effort", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-disabled-default-effort')
  // What CodeSessionScreen's open-time sync sets for a terminal session whose effort the user never picked.
  sessionAuth.setReasoningEffort('sess-disabled-default-effort', 'xhigh')

  const outbound = await postMessagesAs(app, token, { thinking: { type: 'disabled' } })

  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false })
})

test("/v1/messages: a client's thinking 'disabled' stays off in a Code session whose effort is set to a level", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-conflict-messages')
  sessionAuth.setReasoningEffort('sess-conflict-messages', 'low')

  const outbound = await postMessagesAs(app, token, { thinking: { type: 'disabled' } })

  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false })
})

test("/v1/messages: a Code session's effort level still applies when the client thinks", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-effort-adaptive')
  sessionAuth.setReasoningEffort('sess-effort-adaptive', 'low')

  // Claude Code's own request shape (see anthropic.ts): adaptive, no budget.
  const outbound = await postMessagesAs(app, token, { thinking: { type: 'adaptive', display: 'omitted' } })

  assert.equal(outbound?.thinking_budget_tokens, 16000, 'the default budget of a thinking request with none (half of max_tokens)')
  assert.deepEqual(outbound?.chat_template_kwargs, { reasoning_effort: 'low' })
})

test("/v1/messages: the thinking slider's Off stays off beside a Code session's effort level, which is not sent", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-slider-off-effort')
  sessionAuth.setThinkingBudget('sess-slider-off-effort', 0)
  sessionAuth.setReasoningEffort('sess-slider-off-effort', 'xhigh')

  const outbound = await postMessagesAs(app, token, { thinking: { type: 'adaptive', display: 'omitted' } })

  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false })
})

test("/v1/messages: a client's thinking 'disabled' still turns thinking off in a Code session with no effort override", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-disabled-no-effort')

  const outbound = await postMessagesAs(app, token, { thinking: { type: 'disabled' } })

  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.deepEqual(outbound?.chat_template_kwargs, { enable_thinking: false })
})

test('a Code session with no reasoning-effort override set still gets the client value translated', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const token = sessionAuth.mint('sess-no-effort-override')
  // No setReasoningEffort call — the client's own value should flow through untouched.

  const outbound = await postChatAs(app, token, { reasoning_effort: 'low' })

  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown>)?.reasoning_effort, 'low')
})

test('a prototype-chain key never reaches the engine as a non-string reasoning_effort', async () => {
  // ALIASES[value] on a plain object would resolve '__proto__' to Object.prototype itself,
  // which then lands in chat_template_kwargs.reasoning_effort as a JSON object — exactly the
  // raise_exception-triggering shape this whole feature exists to keep away from the engine.
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: '__proto__' })

  assert.equal(outbound?.reasoning_effort, undefined)
  assert.equal(outbound?.chat_template_kwargs, undefined)
})

test('a non-string reasoning_effort (e.g. an explicit null from an SDK wrapper) is still deleted, not forwarded raw', async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())

  const nullBody = await postChat(app, { reasoning_effort: null })
  assert.equal(nullBody && 'reasoning_effort' in nullBody, false)

  const numberBody = await postChat(app, { reasoning_effort: 5 })
  assert.equal(numberBody && 'reasoning_effort' in numberBody, false)
})

// GitHub #213 follow-up (reported against v1.12.6, which already carried the #215 fix above).
// opencode sends the OpenAI-standard `"none"` for its no-reasoning variant. That value was in
// neither VALID nor ALIASES, so parseReasoningEffort returned undefined — and because the raw
// top-level key is ALWAYS deleted, the parameter vanished completely on the way to the engine
// rather than turning thinking off. The reporter saw exactly that: the field present when the
// same client talked to LM Studio (which forwards it verbatim), absent through TurboLLM.
test("GitHub #213: OpenAI's 'none' turns thinking off rather than vanishing en route to the engine", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'none' })

  assert.equal(outbound?.reasoning_effort, undefined, 'the raw top-level key must not reach the engine')
  assert.equal(outbound?.thinking_budget_tokens, 0)
  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown>)?.enable_thinking, false)
  assert.equal(
    (outbound?.chat_template_kwargs as Record<string, unknown> | undefined)?.reasoning_effort,
    undefined,
    "'none' is not a template value — it must collapse onto enable_thinking, never be sent literally",
  )
})

test("GitHub #213: OpenAI's 'minimal' maps to the lowest real thinking level rather than vanishing", async () => {
  const app = new Hono()
  registerGateway(app, fakeDeps())
  const outbound = await postChat(app, { reasoning_effort: 'minimal' })

  assert.equal(outbound?.reasoning_effort, undefined)
  assert.equal((outbound?.chat_template_kwargs as Record<string, unknown>)?.reasoning_effort, 'low')
})

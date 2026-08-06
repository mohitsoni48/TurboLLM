// BUG-001 regression tests: Qwen3 / thinking models returning only <think>...</think>
// tokens after the tool-calling loop, leaving visible content empty.
//
// The fix: after the tool loop exits, strip <think> blocks from the accumulated
// content. If the visible content is empty/whitespace, make one extra inference
// pass with tool_choice:'none' and use that result as the final reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { stripThinkingBlocks, needsExtraPass } from './think-utils.js'
import { recentTitleTurns, chatCodeAuthorization } from './chat-routes.js'
import type { Deps } from '../deps.js'

// ── stripThinkingBlocks ───────────────────────────────────────────────────────

test('stripThinkingBlocks: removes a single <think> block', () => {
  const input = '<think>some chain of thought</think>The actual answer.'
  assert.equal(stripThinkingBlocks(input), 'The actual answer.')
})

test('stripThinkingBlocks: removes multiple <think> blocks', () => {
  const input = '<think>step 1</think>middle<think>step 2</think>end'
  assert.equal(stripThinkingBlocks(input), 'middleend')
})

test('stripThinkingBlocks: case-insensitive tag match', () => {
  const input = '<THINK>hidden</THINK>visible'
  assert.equal(stripThinkingBlocks(input), 'visible')
})

test('stripThinkingBlocks: multiline think block is removed', () => {
  const input = '<think>\nline one\nline two\n</think>\nFinal answer.'
  assert.equal(stripThinkingBlocks(input).trim(), 'Final answer.')
})

test('stripThinkingBlocks: no think block returns input unchanged', () => {
  const input = 'Plain response with no thinking.'
  assert.equal(stripThinkingBlocks(input), input)
})

test('stripThinkingBlocks: only think block yields empty string after trim', () => {
  const input = '<think>only reasoning, no visible content</think>'
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

test('stripThinkingBlocks: whitespace-only after stripping yields empty after trim', () => {
  const input = '<think>reasoning</think>   \n  '
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

// ── needsExtraPass ───────────────────────────────────────────────────────────

test('needsExtraPass: returns true when content is only a <think> block', () => {
  assert.equal(needsExtraPass('<think>deep thoughts</think>'), true)
})

test('needsExtraPass: returns true when content is whitespace only', () => {
  assert.equal(needsExtraPass('   \n\t  '), true)
})

test('needsExtraPass: returns true when content is empty string', () => {
  assert.equal(needsExtraPass(''), true)
})

test('needsExtraPass: returns false when visible content exists after stripping', () => {
  assert.equal(needsExtraPass('<think>reasoning</think>Here is my answer.'), false)
})

test('needsExtraPass: returns false for plain text with no thinking tokens', () => {
  assert.equal(needsExtraPass('The capital of France is Paris.'), false)
})

test('needsExtraPass: returns false when think block is followed by non-whitespace', () => {
  assert.equal(needsExtraPass('<think>step</think>\n\nActual answer here.'), false)
})

// ── recentTitleTurns ──────────────────────────────────────────────────────────
// GitHub: "the AI generated chat title is broken. It gets title based on memory and not based
// on msg I send." For a brand-new conversation (exactly when auto-title fires), engineMessages
// is just [system, user] — a plain slice(-2) grabbed the memory-stuffed system prompt right
// alongside the real first message.

test('recentTitleTurns: excludes the injected system prompt for a brand-new conversation', () => {
  const engineMessages = [
    { role: 'system', content: 'You are TurboLLM...\n\nWhat you know about the user from past conversations:\n- Likes cats\n- Works in finance' },
    { role: 'user', content: 'How do I center a div in CSS?' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].content, 'How do I center a div in CSS?')
})

test('recentTitleTurns: still takes the last N when there IS real history (no system message present)', () => {
  const engineMessages = [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second turn' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.deepEqual(turns.map((t) => t.content), ['first reply', 'second turn'])
})

test('recentTitleTurns: a system message is excluded even when mixed in with real history', () => {
  const engineMessages = [
    { role: 'system', content: 'hidden capability + memory block' },
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first reply' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.ok(turns.every((t) => t.role !== 'system'))
  assert.deepEqual(turns.map((t) => t.content), ['first turn', 'first reply'])
})

test('recentTitleTurns: empty input yields empty output, no throw', () => {
  assert.deepEqual(recentTitleTurns([]), [])
})

// ── Phase 4 / C1: the trust decision chat's routine tools are threaded from ──────────────────
// chat-routes.ts computes `isCodeAuthorized` as `!codeGateBlocks(c, d)` at BOTH generation entry
// points (/messages and /continue) and hands it to runGeneration → executeToolCallWithApproval →
// ToolRegistry.executeTool → the routine executors' code-flavor gate. The SSE loop is far too
// heavy to drive here, but the invariant that whole chain rests on is a pure per-request decision
// and is directly testable: for the exact deployment the threat model names — LAN-exposed daemon
// with the API key requirement OFF, keyless caller, non-loopback address — `chatCodeAuthorization`
// must be FALSE. If it is ever true there, gating the executors buys nothing. Same fake `Deps`
// shape routine-routes.test.ts's own I2 run-now tests use, driven through a real Hono Context (the
// decision reads getConnInfo, which no hand-rolled Context object can honestly supply).
//
// I1: these drive `chatCodeAuthorization` EXPORTED FROM chat-routes.ts — the exact function both
// generation entry points call — not a re-derivation of `!codeGateBlocks(c, d)` against the import
// from routine-routes.ts. That distinction is the whole fix: a reviewer previously restored the
// full CRITICAL with a green suite by aliasing chat-routes.ts's `codeGateBlocks` import and
// shadowing the name locally with `() => false`. Re-deriving the expression here measured the real
// function while production measured the shadow; driving the real exported one cannot.

/** Runs chat-routes.ts's own `chatCodeAuthorization` over a one-route app, so the assertion runs
 *  against a REAL Hono Context rather than a stand-in. */
function gateProbe(daemon: { lanBind: boolean; requireApiKey: boolean }, apiKeys: unknown[] = []) {
  const app = new Hono()
  const d = {
    store: {
      snapshot: () => ({ daemon, apiKeys }),
      update: (fn: (cfg: { apiKeys: unknown[] }) => void) => fn({ apiKeys }),
    },
  } as unknown as Deps
  app.get('/probe', (c) => c.json({ isCodeAuthorized: chatCodeAuthorization(c, d) }))
  return app
}

/** A real remote peer address, the way @hono/node-server's getConnInfo reads it. */
const LAN_PEER = { incoming: { socket: { remoteAddress: '192.168.1.50', remotePort: 54321, remoteFamily: 'IPv4' } } }
const LOOPBACK_PEER = { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 54321, remoteFamily: 'IPv4' } } }

async function probe(app: Hono, env: unknown, headers: Record<string, string> = {}): Promise<boolean> {
  const res = await app.request('/probe', { headers }, env)
  return (await res.json() as { isCodeAuthorized: boolean }).isCodeAuthorized
}

test('C1 invariant: a keyless non-loopback caller on an open LAN (lanBind, no requireApiKey) is NOT code-authorized', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, LAN_PEER), false,
    'this is the exact configuration lanAuth waves through — the routine tools\' gate is the only thing left')
})

test('C1 invariant: an undetermined remote address on an open LAN fails closed too', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, undefined), false)
})

test('C1 invariant: a wrong/garbage API key does not buy code authorization', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, LAN_PEER, { 'X-TurboLLM-Auth': 'tllm-not-a-real-key' }), false)
})

// Polarity control: the expression must not be false for EVERYONE (which would also "pass" the
// tests above while breaking every legitimate host user).
test('C1 invariant: the host itself IS code-authorized (loopback on a LAN-exposed daemon)', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, LOOPBACK_PEER), true)
})

test('C1 invariant: a loopback-only bind is code-authorized regardless of address resolution', async () => {
  const app = gateProbe({ lanBind: false, requireApiKey: false })
  assert.equal(await probe(app, undefined), true)
})

// The tests above pin what chatCodeAuthorization DECIDES; they cannot pin that both SSE handlers
// still ASK it — the two producers live inside the /messages and /continue handlers, which need a
// live engine, a stream and a full conversation to drive. That gap is real and was demonstrated
// twice: a reviewer replaced chat-routes.ts:280 with `const isCodeAuthorized = true` and the whole
// suite stayed green. This is a structural assertion over the source text rather than a
// behavioural one — deliberately, as the cheapest thing that actually fails on that exact edit.
//
// I1: it is a SUPPLEMENT now, not the primary defence. It pins only that both entry points call
// the named function rather than re-inlining the expression; what that function RESOLVES TO is
// pinned behaviourally by the five tests above, which drive the real export. The previous version
// of this test was the only thing standing behind the decision, and it pinned the spelling of the
// two producers while asserting nothing about what `codeGateBlocks` resolved to inside the module
// — so an import-alias-plus-local-shadow refactor passed it with both producer lines untouched.
test('C1 invariant: both chat generation entry points DERIVE isCodeAuthorized, never hardcode it', () => {
  const src = readFileSync(new URL('./chat-routes.ts', import.meta.url), 'utf8')
  const producers = src.match(/const isCodeAuthorized = .*/g) ?? []
  assert.equal(producers.length, 2, 'expected exactly two producers (POST /messages and POST /continue)')
  for (const line of producers) {
    assert.equal(line, 'const isCodeAuthorized = chatCodeAuthorization(c, d)',
      'a chat generation entry point must call the exported, behaviourally-pinned decision function — never inline the expression, which puts it back out of the tests\' reach')
  }
  assert.doesNotMatch(src, /isCodeAuthorized\s*[:=]\s*true/, 'no chat path may assert code authorization by literal')
  assert.match(src, /isCodeAuthorized: ctx\.isCodeAuthorized/, 'the tool loop must forward the per-request value, not recompute or fake one')
})

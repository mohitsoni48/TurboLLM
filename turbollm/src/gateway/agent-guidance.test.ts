// Regression coverage for the agent behaviour scaffolding the terminal-agent CLI never had.
//
// All five founder-built behaviours (loop detection, tool-loop breaking, search-on-failure,
// research-first, version+docs-before-a-dependency) lived inside the in-process pi agent
// (code/code-session.ts) and so applied to exactly one of TurboLLM's two coding agents. The
// Claude CLI reaches TurboLLM only over HTTP, so the gateway rebuilds them from request history.
// These tests pin the reconstruction against the SAME thresholds pi uses — that equivalence is
// the whole point, and a drift between the two agents is what this file exists to catch.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOOP_ABORT_AFTER, LOOP_BREAK_AFTER } from '../code/agent-loop-rules'
import type { AnthropicRequest } from './anthropic'
import {
  analyzeTurn,
  applyAgentGuidance,
  blindDependencyAdd,
  routineGuidance,
  standingGuidance,
  trailingIdenticalCalls,
  trailingToolFailures,
  webToolNames,
} from './agent-guidance'

/** An assistant turn that calls one tool. */
function call(name: string, input: unknown): AnthropicRequest['messages'][number] {
  return { role: 'assistant', content: [{ type: 'tool_use', id: `t${Math.random()}`, name, input }] }
}
/** The user turn carrying that tool's result. */
function toolResult(content: string, isError = false): AnthropicRequest['messages'][number] {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't', content, ...(isError ? { is_error: true } : {}) }],
  } as AnthropicRequest['messages'][number]
}

const CLAUDE_TOOLS = [
  { name: 'WebSearch', input_schema: { type: 'object' } },
  { name: 'WebFetch', input_schema: { type: 'object' } },
  { name: 'Bash', input_schema: { type: 'object' } },
]

function req(messages: AnthropicRequest['messages'], tools = CLAUDE_TOOLS): AnthropicRequest {
  return { max_tokens: 1024, messages, tools }
}

// ── 1 + 2: loop detection and breaking ───────────────────────────────────────

test('trailingIdenticalCalls: counts only the CONSECUTIVE run of identical calls', () => {
  const n = trailingIdenticalCalls([
    call('Read', { file_path: '/a' }),
    call('Read', { file_path: '/b' }), // different args reset the run
    call('Read', { file_path: '/b' }),
    call('Read', { file_path: '/b' }),
  ])
  assert.deepEqual(n, { name: 'Read', count: 3 })
})

test('trailingIdenticalCalls: argument key ORDER does not break the match', () => {
  // Mirrors toolCallSignature's stable ordering — a model re-emitting the same call with keys
  // shuffled is still the same call, and was still a loop.
  const n = trailingIdenticalCalls([
    call('Grep', { pattern: 'x', path: '/p' }),
    call('Grep', { path: '/p', pattern: 'x' }),
  ])
  assert.equal(n?.count, 2)
})

test('trailingIdenticalCalls: a different final call breaks the run', () => {
  const n = trailingIdenticalCalls([call('Read', { f: 1 }), call('Read', { f: 1 }), call('Bash', { command: 'ls' })])
  assert.deepEqual(n, { name: 'Bash', count: 1 })
})

test('analyzeTurn: nudges at pi\'s LOOP_BREAK_AFTER, and not one call earlier', () => {
  const below = analyzeTurn(req(Array.from({ length: LOOP_BREAK_AFTER - 1 }, () => call('Read', { f: 1 }))))
  assert.equal(below.nudges.length, 0, 'legitimate repetition must be left alone')

  const at = analyzeTurn(req(Array.from({ length: LOOP_BREAK_AFTER }, () => call('Read', { f: 1 }))))
  assert.equal(at.nudges.length, 1)
  assert.match(at.nudges[0], /identical arguments/)
  assert.equal(at.forceTextOnly, false, 'the first stage leaves other tools available, like pi does')
})

test('analyzeTurn: escalates to a HARD tool-call block at LOOP_ABORT_AFTER', () => {
  // pi refuses to execute the call; the gateway is not in an external CLI's execution path, so
  // the equivalent is denying tool calls for the reply — the model cannot emit the call again.
  const g = analyzeTurn(req(Array.from({ length: LOOP_ABORT_AFTER }, () => call('Read', { f: 1 }))))
  assert.equal(g.forceTextOnly, true)
  assert.match(g.nudges[0], /Tool calls are DISABLED/)
})

// ── 3: search the web when things keep failing ───────────────────────────────

test('trailingToolFailures: counts the trailing run of is_error results across messages', () => {
  assert.equal(trailingToolFailures([toolResult('ok'), toolResult('boom', true), toolResult('boom', true)]), 2)
  assert.equal(trailingToolFailures([toolResult('boom', true), toolResult('ok')]), 0, 'a success resets the run')
})

test('analyzeTurn: two failures in a row triggers the search-and-retry nudge at pi\'s threshold', () => {
  const one = analyzeTurn(req([call('Bash', { command: 'a' }), toolResult('boom', true)]))
  assert.equal(one.nudges.length, 0, 'a single failure is normal and must not nag')

  const two = analyzeTurn(
    req([call('Bash', { command: 'a' }), toolResult('boom', true), call('Bash', { command: 'b' }), toolResult('boom', true)]),
  )
  assert.equal(two.nudges.length, 1)
  assert.match(two.nudges[0], /WebSearch/)
  assert.match(two.nudges[0], /Do NOT substitute an easier or different feature/)
})

// ── 5: versions and docs before a new dependency ─────────────────────────────

test('blindDependencyAdd: flags an install that had no web search before it', () => {
  const cmd = blindDependencyAdd([call('Bash', { command: 'npm install hono' })])
  assert.equal(cmd, 'npm install hono')
})

test('blindDependencyAdd: a search shortly before the install clears it', () => {
  const cmd = blindDependencyAdd([
    call('WebSearch', { query: 'hono latest version' }),
    call('Bash', { command: 'npm install hono' }),
  ])
  assert.equal(cmd, null)
})

test('blindDependencyAdd: installing from an existing manifest is not a new dependency', () => {
  // Same precision rule as pi's isDependencyAddCommand: a bare `npm install` restores what the
  // manifest already pins and involves no decision to vet.
  assert.equal(blindDependencyAdd([call('Bash', { command: 'npm install' })]), null)
  assert.equal(blindDependencyAdd([call('Bash', { command: 'pip install -r requirements.txt' })]), null)
})

test('blindDependencyAdd: recognises pi\'s `cmd` argument name too, not just Claude Code\'s `command`', () => {
  assert.equal(blindDependencyAdd([call('bash', { cmd: 'cargo add serde' })]), 'cargo add serde')
})

test('analyzeTurn: the blind-install nudge names the package manager command it saw', () => {
  const g = analyzeTurn(req([call('Bash', { command: 'npm install hono' })]))
  const nudge = g.nudges.find((n) => n.includes('npm install hono'))
  assert.ok(nudge, 'the nudge should quote the offending command')
  assert.match(nudge, /LATEST version/)
})

// ── 4: standing guidance, adapted to the client's real tool names ────────────

test('webToolNames: resolves Claude Code\'s names and TurboLLM\'s own', () => {
  assert.deepEqual(webToolNames(CLAUDE_TOOLS), { search: 'WebSearch', fetch: 'WebFetch' })
  assert.deepEqual(
    webToolNames([{ name: 'web_search', input_schema: {} }, { name: 'fetch_url', input_schema: {} }]),
    { search: 'web_search', fetch: 'fetch_url' },
  )
})

test('standingGuidance: names the tools THIS client actually has', () => {
  const claude = standingGuidance(CLAUDE_TOOLS).join('\n')
  assert.match(claude, /call WebSearch/)
  assert.match(claude, /use WebFetch to read/)
  assert.ok(!claude.includes('web_search'), 'must not name a tool this client does not have')
})

test('standingGuidance: stamps TODAY so the model cannot date a query from training data', () => {
  // Observed live: told to verify a freshly-installed package, the model searched
  // "zod npm latest version 2024" — a year it remembered, which would have "confirmed" a stale
  // version. builtin.ts fixes this for the in-app agent inside the tool DESCRIPTION; the CLI owns
  // its own tool schema, so the gateway states it as a standing rule instead.
  const g = standingGuidance(CLAUDE_TOOLS, '2026-08-01').join('\n')
  assert.match(g, /TODAY IS 2026-08-01/)
  assert.match(g, /if a query needs a year, it is 2026/)
})

test('standingGuidance: says nothing when the client declared no web tools', () => {
  // Telling a model to call a tool it does not have is worse than saying nothing — the same rule
  // persona.ts's hasWebTools gate already follows for the in-app agent.
  assert.deepEqual(standingGuidance([{ name: 'Read', input_schema: {} }]), [])
})

// ── application to the outbound request ──────────────────────────────────────

test('applyAgentGuidance: standing rules go on the SYSTEM prompt, nudges go at the TAIL', () => {
  // Placement is deliberate and load-bearing: the standing rules are identical every turn, so
  // they sit in the prefix the engine can reuse; a nudge changes turn to turn, so putting it in
  // the prefix would invalidate the whole cached prompt every time one fired.
  const r = req([call('Read', { f: 1 }), call('Read', { f: 1 }), call('Read', { f: 1 }), toolResult('again')])
  r.system = 'You are Claude Code.'
  applyAgentGuidance(r)

  assert.match(r.system as string, /STRICT RULE/)
  const last = r.messages[r.messages.length - 1]
  const tail = (last.content as Array<{ type: string; text?: string }>).at(-1)
  assert.equal(tail?.type, 'text')
  assert.match(tail?.text ?? '', /identical arguments/)
})

test('applyAgentGuidance: appends a system BLOCK when the client sent structured system content', () => {
  // Claude Code sends `system` as an array of blocks with cache_control markers; appending a new
  // block preserves them, where flattening to a string would destroy them.
  const r = req([])
  r.system = [{ type: 'text', text: 'base prompt' }]
  applyAgentGuidance(r)
  assert.ok(Array.isArray(r.system))
  assert.equal((r.system as Array<{ text?: string }>)[0].text, 'base prompt')
  assert.match((r.system as Array<{ text?: string }>)[1].text ?? '', /STRICT RULE/)
})

test('applyAgentGuidance: never injects into a trailing ASSISTANT message', () => {
  // A request ending on an assistant message is a prefill; injecting a user turn there would
  // corrupt it. The nudge is skipped and lands on the next turn instead.
  const r = req(Array.from({ length: LOOP_BREAK_AFTER }, () => call('Read', { f: 1 })))
  const before = JSON.stringify(r.messages)
  const g = applyAgentGuidance(r)
  assert.ok(g.nudges.length > 0, 'the loop is still detected')
  assert.equal(JSON.stringify(r.messages), before, 'but the messages are left untouched')
})

test('applyAgentGuidance: a clean conversation gets rules but no nudges', () => {
  const r = req([call('Read', { f: 1 }), toolResult('fine')])
  const g = applyAgentGuidance(r)
  assert.deepEqual(g.nudges, [])
  assert.equal(g.forceTextOnly, false)
  assert.equal(g.system.length, 3)
})

// ── routine creation hint (Phase 4) ──────────────────────────────────────────

test('routineGuidance: null when no base URL is known (never emits a broken curl target)', () => {
  assert.equal(routineGuidance(undefined), null)
})

test('routineGuidance: names the real base URL and both the create and confirm endpoints', () => {
  const g = routineGuidance('http://127.0.0.1:6996')
  assert.match(g ?? '', /curl -X POST http:\/\/127\.0\.0\.1:6996\/api\/v1\/routines/)
  assert.match(g ?? '', /confirm/)
})

test('standingGuidance: includes the routine hint when a base URL is supplied, even with NO web tools', () => {
  // Independent of rules 4/5's `if (!search) return []` gate — a routine hint has nothing to do
  // with web search, so it must not disappear just because the client declared no search tool.
  const g = standingGuidance([{ name: 'Read', input_schema: {} }], undefined, 'http://127.0.0.1:6996')
  assert.equal(g.length, 1)
  assert.match(g[0], /curl -X POST http:\/\/127\.0\.0\.1:6996\/api\/v1\/routines/)
})

test('standingGuidance: still says nothing at all when NEITHER web tools NOR a base URL are known', () => {
  // Exact pre-existing behavior preserved — the old test right above this one already asserts
  // standingGuidance(tools) with no baseUrl stays [] when there's no search tool either.
  assert.deepEqual(standingGuidance([{ name: 'Read', input_schema: {} }]), [])
})

test('applyAgentGuidance: threads a supplied base URL into the routine hint on the system prompt', () => {
  const r = req([call('Read', { f: 1 }), toolResult('fine')])
  applyAgentGuidance(r, 'http://127.0.0.1:6996')
  assert.match(r.system as string, /curl -X POST http:\/\/127\.0\.0\.1:6996\/api\/v1\/routines/)
})

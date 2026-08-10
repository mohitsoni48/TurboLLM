// Coding-activity attribution for terminal-agent Code sessions. A session run through the
// embedded Claude CLI applies its edits inside its own subprocess and never reports back, so
// nothing ever wrote to the two tables the "Coding activity" dashboard reads (codeStats(): a
// code conversation's `messages.tool_calls`, and `agent_runs.status`). Result: real work moved
// none of the Tasks shipped / Files touched / Diff shipped tiles.
//
// The gateway is the one component that can see those edits — it is the HTTP intermediary the CLI
// asks for every token, and it already resolves which session a request belongs to from the
// session-scoped bearer token (session-auth.ts). These tests pin what it records, on both the
// streaming and non-streaming /v1/messages branches, and — critically — that a request with no
// resolved Code session (independent CLI usage, plain chat, the shared static token) still
// touches none of it.
//
// Attribution takes TWO requests, and most tests below therefore drive two. The gateway sees a
// tool call the moment the ENGINE emits it, which is before the CLI has run it and before the
// user has been asked to permit it — so a call is only stashed as pending there. The request
// AFTER it replays the conversation carrying that call's `tool_result`, and only that confirms
// (or, with `is_error`, retires) it. Crediting on sight instead counted files that were never
// modified and diffs that were declined or that failed and were then retried 2-4 times, which is
// exactly the two tiles this feature exists to populate.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { sessionAuth } from '../code/session-auth'
import type { Deps } from '../deps'
import type { ToolCallRecord } from '../chat/db'

const LIBRARY = [{ key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' }]

type DbSpy = {
  getAgentRunIds: string[]
  messages: { convId: string; toolCalls: ToolCallRecord[] }[]
  runUpdates: { id: string; patch: { status?: string; endedAt?: string } }[]
}

/** Deps stub whose `db` records exactly the three calls this feature makes. `run` null models a
 *  token that resolves to a session whose run row is gone. */
function fakeDeps(run: { id: string; convId: string } | null = { id: 'sess-1', convId: 'conv-1' }): { deps: Deps; spy: DbSpy } {
  const spy: DbSpy = { getAgentRunIds: [], messages: [], runUpdates: [] }
  const deps = {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: 'http://engine.invalid.local:1' }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
      setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: {
      recordApiUsage: () => {},
      getAgentRun: (id: string) => { spy.getAgentRunIds.push(id); return run },
      addMessage: (convId: string, _role: string, _content: string, extra?: { toolCalls?: ToolCallRecord[] }) => {
        spy.messages.push({ convId, toolCalls: extra?.toolCalls ?? [] })
      },
      updateAgentRun: (id: string, patch: { status?: string; endedAt?: string }) => { spy.runUpdates.push({ id, patch }) },
    },
  } as unknown as Deps
  return { deps, spy }
}

/** Point the engine fetch at a canned OpenAI-shaped SSE stream, in the same one-chunk-per-line
 *  shape llama.cpp emits (a tool call's arguments split across deltas). */
function stubStreamingEngine(lines: string[]): () => void {
  const original = globalThis.fetch
  const enc = new TextEncoder()
  globalThis.fetch = (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** An engine that delivers `lines` and then DIES — the stream errors instead of closing, which
 *  is what a crashed/OOM-killed llama-server, an evicted model, or a severed connection looks
 *  like from here. Throwing from `pull` (rather than `controller.error()`, which resets the
 *  queue) means the already-enqueued lines are still consumed first, so the failure lands
 *  mid-turn with a fully-formed tool call already seen. */
function stubDyingStreamingEngine(lines: string[]): () => void {
  const original = globalThis.fetch
  const enc = new TextEncoder()
  globalThis.fetch = (async () => {
    let i = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < lines.length) { controller.enqueue(enc.encode(lines[i++] + '\n')); return }
          throw new Error('engine stopped mid-stream')
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Point the engine fetch at a canned non-streaming OpenAI completion. */
function stubJsonEngine(body: Record<string, unknown>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Returns the raw response body so a test can assert the CLI still got a complete answer. */
async function postMessages(app: Hono, token: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 4096, messages: [], ...body }),
  })
  return await res.text() // drains too: the SSE branch's recording happens as the stream is consumed
}

const NO_TOOL_STREAM = [
  'data: {"choices":[{"delta":{"content":"Done."}}]}',
  'data: {"choices":[{"finish_reason":"stop"}]}',
  'data: [DONE]',
]

/** The CLI's NEXT request. An Anthropic-protocol client resends the whole conversation every
 *  turn, so this is where the previous turn's `tool_result` blocks arrive — the only place the
 *  daemon ever learns whether an edit it watched the engine ask for actually landed. */
async function postToolResults(
  app: Hono,
  token: string,
  results: Array<{ id: string; isError?: boolean }>,
  engineLines: string[] = NO_TOOL_STREAM,
): Promise<string> {
  const restore = stubStreamingEngine(engineLines)
  try {
    return await postMessages(app, token, {
      stream: true,
      messages: [
        { role: 'user', content: 'edit that file' },
        {
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.isError ? 'String to replace not found in file.' : 'The file has been updated.',
            ...(r.isError ? { is_error: true } : {}),
          })),
        },
      ],
    })
  } finally { restore() }
}

const EDIT_STREAM = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_01","function":{"name":"Edit","arguments":"{\\"file_path\\":\\"/repo/src/a.ts\\","}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"old_string\\":\\"let x = 1\\\\n\\",\\"new_string\\":\\"const x = 2\\\\nconst y = 3\\\\n\\"}"}}]}}]}',
  'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20}}',
  'data: [DONE]',
]

test('an Edit tool call is credited only once its tool_result confirms the CLI applied it', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-1')

  const restore = stubStreamingEngine(EDIT_STREAM)
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  // The turn the engine ASKED for the edit on proves nothing: at this instant the CLI has not run
  // it, and the user has not been asked to permit it.
  assert.equal(spy.messages.length, 0, 'an unconfirmed edit must not be credited')

  await postToolResults(app, token, [{ id: 'toolu_01' }])

  assert.deepEqual([...new Set(spy.getAgentRunIds)], ['sess-1'], 'the run is only ever looked up by the session the token resolves to')
  assert.equal(spy.messages.length, 1)
  assert.equal(spy.messages[0].convId, 'conv-1', 'the record lands on the run\'s own conversation — what codeStats() joins on')
  const [record] = spy.messages[0].toolCalls
  assert.equal(record.id, 'toolu_01')
  assert.equal(record.name, 'edit', 'lower-cased to the name codeStats() matches, not Claude Code\'s PascalCase')
  assert.equal(record.args.path, '/repo/src/a.ts', 'codeStats() reads args.path for filesTouched')
  // A real unified diff, so countDiffLines() sees one removed and two added lines.
  assert.ok(record.diff, 'an edit must carry a diff — it is the only thing feeding "Diff shipped"')
  const changed = record.diff!.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
  assert.deepEqual(changed, ['-let x = 1', '+const x = 2', '+const y = 3'])
})

// The failure this whole pending/confirm split exists for. An `Edit` whose `old_string` isn't
// found or isn't unique is the single most common local-model tool failure, and a decline at a
// permission prompt comes back the same shape — both as `is_error: true`. Crediting either one
// inflates "Files touched" with a file that was never modified and "Diff shipped" with a change
// that never happened (then again on each retry).
test('a tool_result marked is_error retires the record without crediting anything', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-err')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_fail","function":{"name":"Edit","arguments":"{\\"file_path\\":\\"/repo/nope.ts\\",\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  await postToolResults(app, token, [{ id: 'toolu_fail', isError: true }])
  assert.equal(spy.messages.length, 0, 'a failed or declined edit is never credited')

  // Retired, not merely skipped: replaying the same history (which every later turn does) must
  // not resurrect it either.
  await postToolResults(app, token, [{ id: 'toolu_fail' }])
  assert.equal(spy.messages.length, 0, 'a retired record can never be revived by a later replay')

  // The run is still marked shipped throughout — that claim is about the session having done real
  // work, which the turns themselves prove regardless of how any one call turned out.
  assert.ok(spy.runUpdates.length >= 1)
  assert.deepEqual([...new Set(spy.runUpdates.map((u) => u.patch.status))], ['done'])
})

// Every request replays the ENTIRE conversation, so a confirmed call's tool_result keeps arriving
// for the rest of the session. Counting it each time would multiply both tiles by the number of
// remaining turns.
test('a confirmed tool_result replayed on later turns is counted exactly once', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-replay')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_once","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/repo/once.ts\\",\\"content\\":\\"hi\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  await postToolResults(app, token, [{ id: 'toolu_once' }])
  await postToolResults(app, token, [{ id: 'toolu_once' }])
  await postToolResults(app, token, [{ id: 'toolu_once' }])

  assert.equal(spy.messages.length, 1, 'the same call must land in messages.tool_calls exactly once')
  assert.equal(spy.messages[0].toolCalls[0].id, 'toolu_once')
})

test('a Write tool call is recorded with no diff — it counts toward files touched only', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-write')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_w","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/repo/new.ts\\",\\"content\\":\\"hello\\\\n\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }
  await postToolResults(app, token, [{ id: 'toolu_w' }])

  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'write')
  assert.equal(record.args.path, '/repo/new.ts')
  assert.equal(record.diff, undefined, 'codeStats() only counts diff lines for edits, never writes')
})

test('a MultiEdit is credited for files touched but carries no fabricated diff', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-multi')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_m","function":{"name":"MultiEdit","arguments":"{\\"file_path\\":\\"/repo/multi.ts\\",\\"edits\\":[{\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}]}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }
  await postToolResults(app, token, [{ id: 'toolu_m' }])

  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'edit', 'recorded as an edit so the file still counts toward filesTouched')
  assert.equal(record.args.path, '/repo/multi.ts')
  assert.equal(record.diff, undefined, 'fragment pairs cannot be reconstructed into an honest diff — omit rather than invent')
})

// See MAX_DIFF_INPUT_CHARS: createPatch is synchronous Myers on Node's single thread, so a
// whole-block rewrite (well within a 32k-token response budget) blocks the entire daemon for
// hundreds of milliseconds. The record is still made — only the diff is given up.
test('an oversized Edit still counts toward files touched but skips the daemon-blocking diff', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-big')

  const big = 'x'.repeat(40 * 1024) // 40 KB each side: 80 KB combined, past the 64 KB ceiling
  const restore = stubJsonEngine({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: '',
        tool_calls: [{
          id: 'toolu_big',
          type: 'function',
          function: { name: 'Edit', arguments: JSON.stringify({ file_path: '/repo/big.ts', old_string: big, new_string: `${big}y` }) },
        }],
      },
    }],
  })
  try { await postMessages(app, token, { stream: false }) } finally { restore() }
  await postToolResults(app, token, [{ id: 'toolu_big' }])

  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'edit')
  assert.equal(record.args.path, '/repo/big.ts', 'filesTouched credit survives — that is the whole point of still recording it')
  assert.equal(record.diff, undefined, 'the diff is skipped rather than blocking the event loop on it')
})

// A malformed call must be DROPPED, not coerced: `String(undefined)` would put the literal
// "undefined" into args.path, which codeStats() would then count as a real file touched.
test('a file-touching tool call with no usable file_path is dropped, never coerced to "undefined"', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-nopath')

  const restore = stubStreamingEngine([
    // First: no file_path at all. Second: a non-string one (a model that emitted a number).
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_nopath","function":{"name":"Edit","arguments":"{\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"toolu_numpath","function":{"name":"Write","arguments":"{\\"file_path\\":42,\\"content\\":\\"hi\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }
  await postToolResults(app, token, [{ id: 'toolu_nopath' }, { id: 'toolu_numpath' }])

  assert.equal(spy.messages.length, 0, 'neither call was ever stashed, so a confirming result finds nothing to credit')
  // The turn itself still counted — only the unusable records were dropped.
  assert.deepEqual([...new Set(spy.runUpdates.map((u) => u.patch.status))], ['done'])
})

// The optimistic marking (see observeCodeSessionTurn): leaving the terminal tab does not quit
// the CLI (ADR-298), so waiting for a completion signal leaves nearly every real session stuck at
// 'queued' — and reconcileOnStartup then relabels it 'interrupted' on the next daemon restart.
test('any observed turn marks the run done, even one that touched no files at all', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-1')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_b","function":{"name":"Bash","arguments":"{\\"command\\":\\"npm test\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{"content":"Tests pass."}}]}',
    'data: {"choices":[{"finish_reason":"stop"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  assert.equal(spy.messages.length, 0, 'Bash touches no file — nothing to record into messages.tool_calls')
  assert.equal(spy.runUpdates.length, 1)
  assert.equal(spy.runUpdates[0].id, 'sess-1')
  assert.equal(spy.runUpdates[0].patch.status, 'done')
  assert.ok(spy.runUpdates[0].patch.endedAt, 'endedAt is stamped alongside the status')
})

test('a text-only reply with no tool calls at all still marks the run done', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-1')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"content":"Here is what I found."}}]}',
    'data: {"choices":[{"finish_reason":"stop"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  assert.equal(spy.messages.length, 0)
  assert.deepEqual(spy.runUpdates.map((u) => u.patch.status), ['done'])
})

// The backward-compatibility case that matters most. resolveCodeSession returns null for the
// shared static token, a manual `turbollm launch`, or any other client — none of them is a Code
// session and none may have anything written on its behalf.
test('a request with no resolved Code session touches none of getAgentRun/addMessage/updateAgentRun', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)

  const restore = stubStreamingEngine(EDIT_STREAM)
  try { await postMessages(app, 'turbollm-local', { stream: true }) } finally { restore() }

  assert.deepEqual(spy.getAgentRunIds, [], 'the run lookup itself must not happen')
  assert.equal(spy.messages.length, 0)
  assert.equal(spy.runUpdates.length, 0)
})

test('a token resolving to a session whose run row is gone records nothing and does not throw', async () => {
  const { deps, spy } = fakeDeps(null)
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-missing')

  const restore = stubStreamingEngine(EDIT_STREAM)
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  assert.deepEqual(spy.getAgentRunIds, ['sess-missing'])
  assert.equal(spy.messages.length, 0)
  assert.equal(spy.runUpdates.length, 0)
})

// The non-streaming branch has no per-delta reassembly to do, but must not be the one shape of
// terminal-agent turn that silently records nothing.
test('a NON-streaming turn records the same edit record and the same optimistic done marking', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-ns')

  const restore = stubJsonEngine({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: '',
        tool_calls: [{
          id: 'toolu_ns',
          type: 'function',
          function: { name: 'Edit', arguments: JSON.stringify({ file_path: '/repo/ns.ts', old_string: 'old\n', new_string: 'new\n' }) },
        }],
      },
    }],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  })
  try { await postMessages(app, token, { stream: false }) } finally { restore() }
  await postToolResults(app, token, [{ id: 'toolu_ns' }])

  assert.equal(spy.messages.length, 1)
  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'edit')
  assert.equal(record.args.path, '/repo/ns.ts')
  assert.ok(record.diff?.includes('-old'))
  assert.ok(record.diff?.includes('+new'))
  assert.deepEqual([...new Set(spy.runUpdates.map((u) => u.patch.status))], ['done'])
})

// streamToAnthropic only fires onToolCalls inside `if (!failed)`. That guard is what stops a
// half-received turn — the engine crashed, the model was evicted, the connection was cut — from
// being observed as though it had completed: the client never got the rest of that tool call, so
// its CLI never ran it, and nothing about it may reach the database.
test('a stream that dies mid-turn records nothing at all, and leaves nothing to confirm later', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-dead')

  const restore = stubDyingStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_dead","function":{"name":"Edit","arguments":"{\\"file_path\\":\\"/repo/dead.ts\\",\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}"}}]}}]}',
  ])
  let body: string
  try { body = await postMessages(app, token, { stream: true }) } finally { restore() }

  assert.ok(body.includes('"type":"error"'), 'the client is told the engine stopped')
  assert.deepEqual(spy.getAgentRunIds, [], 'a failed turn is never observed — not even to mark the run done')
  assert.equal(spy.messages.length, 0)
  assert.equal(spy.runUpdates.length, 0)

  // Nothing was stashed either, so even a (fabricated) later confirmation credits nothing.
  await postToolResults(app, token, [{ id: 'toolu_dead' }])
  assert.equal(spy.messages.length, 0, 'a call from a failed stream can never be credited retroactively')
})

// Attribution is a side observation of a request whose actual job is to answer the CLI. Every DB
// call it makes is inside a swallow, so a locked/failing database costs the tiles, never the turn.
test('a DB failure during attribution still returns the CLI a complete non-streaming message', async () => {
  const { deps } = fakeDeps()
  ;(deps.db as unknown as { getAgentRun: () => never }).getAgentRun = () => { throw new Error('database is locked') }
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-dbfail')

  const restore = stubJsonEngine({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'Editing that now.',
        tool_calls: [{
          id: 'toolu_dbfail',
          type: 'function',
          function: { name: 'Edit', arguments: JSON.stringify({ file_path: '/repo/x.ts', old_string: 'a', new_string: 'b' }) },
        }],
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  })
  let body: string
  try { body = await postMessages(app, token, { stream: false }) } finally { restore() }

  const msg = JSON.parse(body) as { type: string; content: Array<{ type: string; name?: string }>; stop_reason: string; usage: { output_tokens: number } }
  assert.equal(msg.type, 'message')
  assert.deepEqual(msg.content.map((b) => b.type), ['text', 'tool_use'], 'the engine\'s real answer reaches the client untouched')
  assert.equal(msg.content[1].name, 'Edit')
  assert.equal(msg.stop_reason, 'tool_use')
  assert.equal(msg.usage.output_tokens, 5)
})

test('a DB failure while committing a confirmed call still returns a complete SSE stream', async () => {
  const { deps } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-dbfail2')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_c","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/repo/c.ts\\",\\"content\\":\\"hi\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  // Fails on the NEXT request, i.e. exactly while the confirm path tries to commit the record.
  ;(deps.db as unknown as { addMessage: () => never }).addMessage = () => { throw new Error('database is locked') }
  const body = await postToolResults(app, token, [{ id: 'toolu_c' }])

  assert.ok(body.includes('event: message_start'), 'the stream still opens')
  assert.ok(body.includes('Done.'), 'the engine\'s text still reaches the client')
  assert.ok(body.includes('event: message_stop'), 'and it still terminates cleanly')
})

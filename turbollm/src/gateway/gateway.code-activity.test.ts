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

/** Point the engine fetch at a canned non-streaming OpenAI completion. */
function stubJsonEngine(body: Record<string, unknown>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function postMessages(app: Hono, token: string, body: Record<string, unknown>): Promise<void> {
  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'qwen3-8b|Q4|123', max_tokens: 4096, messages: [], ...body }),
  })
  await res.text() // drain: the SSE branch's recording happens as the stream is consumed
}

const EDIT_STREAM = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_01","function":{"name":"Edit","arguments":"{\\"file_path\\":\\"/repo/src/a.ts\\","}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"old_string\\":\\"let x = 1\\\\n\\",\\"new_string\\":\\"const x = 2\\\\nconst y = 3\\\\n\\"}"}}]}}]}',
  'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20}}',
  'data: [DONE]',
]

test('an Edit tool call from a session-scoped CLI is recorded as an edit record with a real unified diff', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-1')

  const restore = stubStreamingEngine(EDIT_STREAM)
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  assert.deepEqual(spy.getAgentRunIds, ['sess-1'], 'the run is looked up by the session the token resolves to')
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

test('a Write tool call is recorded with no diff — it counts toward files touched only', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-1')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_w","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/repo/new.ts\\",\\"content\\":\\"hello\\\\n\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'write')
  assert.equal(record.args.path, '/repo/new.ts')
  assert.equal(record.diff, undefined, 'codeStats() only counts diff lines for edits, never writes')
})

test('a MultiEdit is credited for files touched but carries no fabricated diff', async () => {
  const { deps, spy } = fakeDeps()
  const app = new Hono()
  registerGateway(app, deps)
  const token = sessionAuth.mint('sess-1')

  const restore = stubStreamingEngine([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_m","function":{"name":"MultiEdit","arguments":"{\\"file_path\\":\\"/repo/multi.ts\\",\\"edits\\":[{\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}]}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  try { await postMessages(app, token, { stream: true }) } finally { restore() }

  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'edit', 'recorded as an edit so the file still counts toward filesTouched')
  assert.equal(record.args.path, '/repo/multi.ts')
  assert.equal(record.diff, undefined, 'fragment pairs cannot be reconstructed into an honest diff — omit rather than invent')
})

// The optimistic marking (see recordCodeSessionToolCalls): leaving the terminal tab does not quit
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
  const token = sessionAuth.mint('sess-1')

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

  assert.equal(spy.messages.length, 1)
  const [record] = spy.messages[0].toolCalls
  assert.equal(record.name, 'edit')
  assert.equal(record.args.path, '/repo/ns.ts')
  assert.ok(record.diff?.includes('-old'))
  assert.ok(record.diff?.includes('+new'))
  assert.deepEqual(spy.runUpdates.map((u) => u.patch.status), ['done'])
})

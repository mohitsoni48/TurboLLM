// run_python through the real chat routes (GitHub #52): who is offered it, that every run asks with Allow once only,
// and that the images a run hands back are named on the reply's own row (which keeps the attachment janitor off them).
// The engine is a fetch double and the sandbox a stand-in manager; the real Deno is the escape suite's job.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ChatRuns } from './chat-runs.js'
import { ChatTurns } from './chat-turns.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { ToolRegistry } from '../tools/tool-registry'
import type { SandboxFile } from '../sandbox/sandbox-process'
import { tmpDir } from '../test-support/tmp'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/** Round 1 asks for run_python; later rounds answer in text. Records each request's tool names. */
function scriptedEngine(t: TestContext) {
  const original = globalThis.fetch
  const offered: string[][] = []
  const sse = (...chunks: unknown[]) => new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    init?.signal?.throwIfAborted()
    const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ function: { name: string } }> }
    offered.push((body.tools ?? []).map((x) => x.function.name))
    if (offered.length === 1) {
      return sse(
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_python', arguments: '{"code":"print(1+1)"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      )
    }
    return sse({ choices: [{ index: 0, delta: { content: 'Here is your chart.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return { offered }
}

function routes(t: TestContext, o: { sandboxOn: boolean }) {
  const dir = tmpDir('tllm-chat-run-python-')
  const store = new ConversationStore(dir)
  const runs: Array<{ convId: string; code: string; files: SandboxFile[] }> = []
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { lanBind: false, autoGenerateTitles: false, experimental: { memory: false, sandbox: o.sandboxOn }, autoMemoryEnabled: false },
    tools: { toolPolicies: { run_python: 'allow' }, autoAllowAll: true, chatApprovalWaitMinutes: 0 },
    apiKeys: [],
  }
  const d = {
    chatTurns: new ChatTurns(), chatRuns: new ChatRuns(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }),
      sessionStats: () => ({ activeRequests: 0 }),
      target: () => 'http://engine.invalid',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    tools: new ToolRegistry({ toolPolicies: {} } as never),
    sandboxRuntime: { view: () => ({ installed: { deno: '2.9.6', pyodide: '0.29.5' } }) },
    sandbox: {
      has: () => runs.length > 0,
      run: async (convId: string, code: string, files: SandboxFile[]) => {
        runs.push({ convId, code, files })
        return { ok: true, stdout: '2\n', stderr: '', files: [{ name: 'chart.png', bytes: PNG }], skipped: [] }
      },
    },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  t.after(() => { store.close() })
  return { app, store, runs }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const settle = async () => { for (let i = 0; i < 2000; i++) await new Promise((r) => setImmediate(r)) }

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 20_000; i++) {
    const v = read()
    if (v !== undefined) return v
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const reply = (store: ConversationStore, convId: string) => store.getMessages(convId).filter((m) => m.role === 'assistant').at(-1)

test('run_python: offered with the sandbox on, asks even with Allow and Auto-allow set, runs once allowed, and the chart lands on the reply row', async (t) => {
  const engine = scriptedEngine(t)
  const h = routes(t, { sandboxOn: true })
  const conv = h.store.createConversation()
  const sent = h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({
    content: 'chart this', textAttachments: ['sales.csv'], docContext: '[Attached: sales.csv]\nmonth,sales\nJan,3',
  }))
  void Promise.resolve(sent).then((r) => r.body?.cancel())
  await waitFor(() => (engine.offered.length ? true : undefined), 'the first request')
  assert.ok(engine.offered[0].includes('run_python'), 'offered to the model')
  await settle()
  assert.equal(h.runs.length, 0, 'nothing runs before it is allowed')

  // No standing approval for it, by either name the route checks.
  for (const decision of ['allow_chat', 'always_allow']) {
    const res = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_python', decision }))
    assert.equal(res.status, 400, decision)
  }
  assert.deepEqual(h.store.getToolOverrides(conv.id), {}, 'no chat override saved')

  const ok = await h.app.request(`/api/v1/conversations/${conv.id}/tool-calls/call_1/approve`, json({ toolName: 'run_python', decision: 'allow' }))
  assert.equal(ok.status, 200)
  await waitFor(() => (reply(h.store, conv.id)?.content === 'Here is your chart.' ? true : undefined), 'the reply')
  await settle()

  assert.equal(h.runs.length, 1)
  assert.equal(h.runs[0].code, 'print(1+1)')
  assert.deepEqual(h.runs[0].files.map((f) => [f.name, f.bytes.toString()]), [['sales.csv', 'month,sales\nJan,3']], 'the turn\'s document went in')
  const r = reply(h.store, conv.id)!
  const files = r.toolCalls[0].files ?? []
  assert.equal(files.length, 1)
  assert.match(files[0], /^attachment:[0-9a-f]{64}\.png$/)
  assert.deepEqual(r.attachments, files, 'the reply row names the chart, so the janitor keeps it')
  assert.match(r.toolCalls[0].result ?? '', /Shown to the user in the chat: chart\.png/)
})

test('run_python: not offered with the sandbox off, and a call made anyway is refused without running', async (t) => {
  const engine = scriptedEngine(t)
  const h = routes(t, { sandboxOn: false })
  const conv = h.store.createConversation()
  const sent = h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'run something' }))
  void Promise.resolve(sent).then((r) => r.body?.cancel())
  await waitFor(() => (reply(h.store, conv.id)?.content === 'Here is your chart.' ? true : undefined), 'the reply')
  assert.equal(engine.offered[0].includes('run_python'), false)
  assert.equal(h.runs.length, 0)
  assert.match(reply(h.store, conv.id)!.toolCalls[0].result ?? '', /only available in a chat on this computer/)
})

test('run_python: the tool catalog lists it only while the sandbox is on', async (t) => {
  for (const sandboxOn of [true, false]) {
    const h = routes(t, { sandboxOn })
    const res = await h.app.request('/api/v1/tools')
    const names = ((await res.json()) as { tools: Array<{ name: string }> }).tools.map((x) => x.name)
    assert.equal(names.includes('run_python'), sandboxOn)
  }
})

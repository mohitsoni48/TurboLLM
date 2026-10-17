// runCodeSession end to end against a stub OpenAI-compatible engine (no model, no port beyond a
// loopback ephemeral one): the real pi session, hooks and registered tools, with the provider
// scripted request by request. Covers what code-session.test.ts's pure tests can't reach — Stop
// handling across pi's run lifecycle, plan mode's real toolset, and what history the model gets.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { runCodeSession, type CodeSseSink } from './code-session'
import { resolveToolApproval } from '../tools/approval-gate'
import type { CodeMode } from './persona'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

type Body = { messages: unknown[]; tools?: { function: { name: string } }[] }
type Reply = (res: ServerResponse, req: IncomingMessage, body: Body) => void

function sse(res: ServerResponse, chunks: object[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test-model', ...c })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
const text = (t: string): Reply => (res) => sse(res, [
  { choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
])
const toolCall = (name: string, args: Record<string, unknown>): Reply => (res) => sse(res, [
  { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
])

/** A loopback engine that answers each chat-completions request with the next scripted reply
 *  (and 404s everything else, e.g. the /slots prefill poll). `bodies` records what was sent. */
async function stubEngine(script: Reply[]) {
  const bodies: Body[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as Body
      bodies.push(body)
      const reply = script.shift()
      if (reply) reply(res, req, body)
      else text('(unscripted)')(res, req, body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  return { base, bodies, close }
}

function harness(base: string, mode: CodeMode, extraDeps: Record<string, unknown> = {}) {
  const dataDir = tmpDir('tllm-code-run-')
  const repoRoot = tmpDir('tllm-code-run-repo-')
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const conv = store.createConversation({ kind: 'code' })
  store.setConversationMode(conv.id, mode)
  const run = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot })
  const d = {
    db: store,
    store: { dir: () => dataDir, snapshot: () => ({ code: { agentsMdProjectCandidates: [], agentsMdGlobalCandidates: [] }, daemon: { experimental: { routines: false } } }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'test-model', name: 'Test', ctx: 8192 } }),
      target: () => base,
      currentOpts: () => undefined,
      generationStart: () => {},
      generationEnd: () => {},
    },
    registry: { active: () => undefined },
    scanner: { get: () => undefined },
    ...extraDeps,
  } as unknown as Deps
  const frames: { event: string; data: Record<string, unknown> }[] = []
  const sink: CodeSseSink = (ev) => { frames.push(ev as { event: string; data: Record<string, unknown> }) }
  /** Store the user message + placeholder the way code-run-manager.ts does, then run the turn. */
  const turn = (task: string, signal: AbortSignal) => {
    const u = store.addMessage(conv.id, 'user', task)
    const a = store.addMessage(conv.id, 'assistant', '', { stats: { aborted: false } })
    return runCodeSession({ d, convId: conv.id, sessionId: run.id, repoRoot, mode, thinkingBudget: -1, reasoningEffort: undefined, task, excludeFromHistory: [u.id, a.id], signal, sink })
  }
  return { store, convId: conv.id, repoRoot, frames, turn }
}

const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function.name)
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])

test('a Stop that lands before pi has a run (during turn setup) still stops the turn: the model is never called', { timeout: 30_000 }, async () => {
  const engine = await stubEngine([text('should never be asked')])
  try {
    const h = harness(engine.base, 'auto')
    const ac = new AbortController()
    ac.abort() // Stop / "Send now" while the turn was still setting up
    const result = await h.turn('do the thing', ac.signal)
    assert.equal(result.aborted, true)
    assert.equal(engine.bodies.length, 0, 'no provider request after the stop')
  } finally { await engine.close() }
})

test('Stop while invoke_skill is running aborts the skill\'s sub-agent and lets the turn settle', { timeout: 30_000 }, async () => {
  let skillRequestClosed!: () => void
  const closed = new Promise<void>((r) => { skillRequestClosed = r })
  let skillRequestArrived!: () => void
  const arrived = new Promise<void>((r) => { skillRequestArrived = r })
  const engine = await stubEngine([
    toolCall('invoke_skill', { skillId: 'filesystem', task: 'look around' }),
    // The skill's own first request: never answered — a long-running skill.
    (res, req) => { res.on('close', () => skillRequestClosed()); req.on('close', () => skillRequestClosed()); skillRequestArrived() },
  ])
  try {
    const h = harness(engine.base, 'auto')
    const ac = new AbortController()
    const settled = h.turn('use the skill', ac.signal)
    assert.notEqual(await within(arrived, 10_000), 'timeout', 'the skill sub-agent started')
    ac.abort()
    assert.notEqual(await within(closed, 5_000), 'timeout', 'Stop aborted the skill\'s in-flight request')
    const result = await within(settled, 5_000)
    assert.notEqual(result, 'timeout', 'the turn settled after the Stop')
    assert.equal((result as Awaited<typeof settled>).aborted, true)
  } finally { await engine.close() }
})

test('plan mode offers the read-only TurboLLM tools to the model, and none that change anything', { timeout: 30_000 }, async () => {
  const engine = await stubEngine([text('the plan')])
  try {
    const h = harness(engine.base, 'plan')
    await h.turn('plan it', new AbortController().signal)
    const names = toolNames(engine.bodies[0])
    for (const t of ['read', 'grep', 'find', 'ls', 'invoke_skill', 'delegate_task', 'lookback_history']) assert.ok(names.includes(t), `${t} offered`)
    for (const t of ['bash', 'edit', 'write', 'update_todos', 'install_lsp']) assert.ok(!names.includes(t), `${t} not offered`)
  } finally { await engine.close() }
})

test('plan mode offers web_search but not fetch_url, even with the web tools registered', { timeout: 30_000 }, async () => {
  const engine = await stubEngine([text('the plan')])
  try {
    // A ToolRegistry stand-in: runCodeSession registers web_search/fetch_url only when d.tools is set.
    const tools = { buildToolDefinitions: async () => [], executeTool: async () => 'unused' }
    const h = harness(engine.base, 'plan', { tools })
    await h.turn('plan it', new AbortController().signal)
    const names = toolNames(engine.bodies[0])
    assert.ok(names.includes('web_search'), 'web_search offered')
    assert.ok(!names.includes('fetch_url'), 'fetch_url not offered in plan mode')
  } finally { await engine.close() }
})

test('a plan run\'s skill gets read-only tools, even after a live switch to auto', { timeout: 30_000 }, async () => {
  let store!: ConversationStore
  let convId!: string
  const engine = await stubEngine([
    (res, req, body) => { store.setConversationMode(convId, 'auto'); toolCall('invoke_skill', { skillId: 'filesystem', task: 'look around' })(res, req, body) },
    text('skill done'),
    text('the plan'),
  ])
  try {
    const h = harness(engine.base, 'plan')
    store = h.store
    convId = h.convId
    await h.turn('plan it', new AbortController().signal)
    const skillBody = engine.bodies[1]
    assert.ok(JSON.stringify(skillBody.messages).includes('You can read files and explore directories'), 'second request is the skill sub-agent\'s')
    const names = toolNames(skillBody)
    assert.ok(names.includes('read'))
    for (const t of ['bash', 'edit', 'write']) assert.ok(!names.includes(t), `${t} not given to a plan run's skill`)
  } finally { await engine.close() }
})

test('the next turn\'s model context carries the delegate_task summary, not the sub-agent\'s own tool calls', { timeout: 30_000 }, async () => {
  const engine = await stubEngine([text('ok')])
  try {
    const h = harness(engine.base, 'auto')
    h.store.addMessage(h.convId, 'user', 'investigate X')
    h.store.addMessage(h.convId, 'assistant', 'found it', {
      toolCalls: [
        { id: 'sub-1', name: 'read', args: { path: 'big.ts' }, result: 'SUBAGENT_FILE_BODY', subagent: true },
        { id: 'own-1', name: 'delegate_task', args: { task: 'look' }, result: 'DELEGATE_SUMMARY' },
      ],
    })
    await h.turn('next step', new AbortController().signal)
    const sent = JSON.stringify(engine.bodies[0].messages)
    assert.ok(sent.includes('found it') && sent.includes('DELEGATE_SUMMARY'), 'the parent\'s own history is replayed')
    assert.ok(!sent.includes('SUBAGENT_FILE_BODY'), 'the sub-agent\'s reads are not')
    assert.equal(sent.split('next step').length - 1, 1, 'the current task is sent once, not also replayed as history')
  } finally { await engine.close() }
})

test('the skill sub-agent\'s tool frames are tagged `subagent`; the parent\'s own are not', { timeout: 30_000 }, async () => {
  const engine = await stubEngine([
    toolCall('invoke_skill', { skillId: 'filesystem', task: 'look around' }),
    toolCall('read', { path: 'missing.txt' }),
    text('skill done'),
    text('all done'),
  ])
  try {
    const h = harness(engine.base, 'auto')
    await h.turn('use the skill', new AbortController().signal)
    // Every frame of each call (pending → done/error), so the run manager records the right flag.
    const calls = h.frames.filter((f) => f.event === 'tool_call')
    assert.ok(calls.some((f) => f.data.name === 'read'), 'the skill made its call')
    for (const f of calls) assert.equal(f.data.subagent === true, f.data.name === 'read', `${f.data.name} ${f.data.status}`)
  } finally { await engine.close() }
})

// ── an edit/write outside the repo is blocked before it runs, in each tool_call hook ───────────

/** Runs an auto-mode turn, where no approval wait follows the containment check, so that check is
 *  all that keeps the call off the disk. The script makes a `write` of a new file and an `edit`
 *  of an existing one, both named by absolute paths in a folder outside the repo. Returns what
 *  changed out there, and each call's final frame. */
async function writeAndEditOutside(script: (write: Reply, edit: Reply) => Reply[]) {
  const outside = tmpDir('tllm-code-run-outside-')
  writeFileSync(join(outside, 'kept.txt'), 'before\n')
  const write = toolCall('write', { path: join(outside, 'new.txt'), content: 'written\n' })
  const edit = toolCall('edit', { path: join(outside, 'kept.txt'), edits: [{ oldText: 'before', newText: 'after' }] })
  const engine = await stubEngine(script(write, edit))
  try {
    const h = harness(engine.base, 'auto')
    assert.notEqual(await within(h.turn('change the files', new AbortController().signal), 20_000), 'timeout', 'the turn settled')
    const last = (name: string) => h.frames.filter((x) => x.event === 'tool_call' && x.data.name === name).at(-1)
    return {
      written: existsSync(join(outside, 'new.txt')),
      edited: readFileSync(join(outside, 'kept.txt'), 'utf8') !== 'before\n',
      frames: [last('write'), last('edit')],
    }
  } finally { await engine.close() }
}

function assertBlocked(r: Awaited<ReturnType<typeof writeAndEditOutside>>, subagent: boolean) {
  assert.equal(r.written, false, 'no file created outside the repo')
  assert.equal(r.edited, false, 'the file outside the repo is unchanged')
  for (const f of r.frames) {
    assert.equal(f?.data.status, 'error', `${f?.data.name} refused`)
    assert.match(String(f?.data.result), /outside the allowed repo root/)
    assert.equal(f?.data.subagent === true, subagent, `${f?.data.name} was made by the hook under test`)
  }
}

test('an edit or write outside the repo is blocked by the session\'s own tool_call hook', { timeout: 30_000 }, async () => {
  assertBlocked(await writeAndEditOutside((write, edit) => [write, edit, text('done')]), false)
})

test('an edit or write outside the repo is blocked in a skill\'s sub-session', { timeout: 30_000 }, async () => {
  assertBlocked(await writeAndEditOutside((write, edit) => [
    toolCall('invoke_skill', { skillId: 'filesystem', task: 'change the files' }), write, edit, text('skill done'), text('all done'),
  ]), true)
})

test('an edit or write outside the repo is blocked in a delegate_task sub-agent', { timeout: 30_000 }, async () => {
  assertBlocked(await writeAndEditOutside((write, edit) => [
    toolCall('delegate_task', { task: 'Change the files.' }), write, edit, text('sub-agent done'), text('all done'),
  ]), true)
})

// ── ask mode: write containment is checked again once the approval wait ends ──────────────────

/** Runs an ask-mode turn whose engine script makes a `write` to sub/a.txt (inside the repo when it
 *  is asked for), and while that call awaits approval replaces the folder `sub` with a link to a
 *  folder outside the repo, then approves. Returns whether the write landed outside, and the
 *  call's final frame. */
async function approveAfterSwap(script: (write: Reply) => Reply[]) {
  const write = toolCall('write', { path: 'sub/a.txt', content: 'approved write\n' })
  const engine = await stubEngine(script(write))
  try {
    const h = harness(engine.base, 'ask')
    const outside = tmpDir('tllm-code-run-outside-')
    mkdirSync(join(h.repoRoot, 'sub'))
    const settled = h.turn('write it', new AbortController().signal)
    const awaiting = async () => {
      for (;;) {
        const f = h.frames.find((x) => x.event === 'tool_call' && x.data.name === 'write' && x.data.status === 'awaiting_approval')
        if (f) return f
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    const f = await within(awaiting(), 10_000)
    if (f === 'timeout') assert.fail('the write is awaiting approval')
    rmSync(join(h.repoRoot, 'sub'), { recursive: true })
    // 'junction' so this also runs on Windows without admin rights; ignored elsewhere.
    symlinkSync(outside, join(h.repoRoot, 'sub'), 'junction')
    assert.ok(resolveToolApproval(`${h.convId}:${String(f.data.id)}`, 'allow'))
    assert.notEqual(await within(settled, 10_000), 'timeout', 'the turn settled')
    const last = h.frames.filter((x) => x.event === 'tool_call' && x.data.name === 'write').at(-1)
    return { landedOutside: existsSync(join(outside, 'a.txt')), last }
  } finally { await engine.close() }
}

test('ask mode: an approved write is refused when its folder became a link out of the repo during the wait', { timeout: 30_000 }, async () => {
  const { landedOutside, last } = await approveAfterSwap((write) => [write, text('done')])
  assert.equal(landedOutside, false, 'nothing written outside the repo')
  assert.equal(last?.data.status, 'error')
  assert.match(String(last?.data.result), /outside the allowed repo root/)
})

test('ask mode: the same re-check holds for a skill\'s write and for a delegate_task sub-agent\'s', { timeout: 30_000 }, async () => {
  const skill = await approveAfterSwap((write) => [
    toolCall('invoke_skill', { skillId: 'filesystem', task: 'write it' }), write, text('skill done'), text('all done'),
  ])
  assert.equal(skill.landedOutside, false, 'skill: nothing written outside the repo')
  assert.match(String(skill.last?.data.result), /outside the allowed repo root/)
  const delegated = await approveAfterSwap((write) => [
    toolCall('delegate_task', { task: 'Write the text "approved write" to sub/a.txt in this repository.' }), write, text('sub-agent done'), text('all done'),
  ])
  assert.equal(delegated.landedOutside, false, 'delegate_task: nothing written outside the repo')
  assert.match(String(delegated.last?.data.result), /outside the allowed repo root/)
})

// A manual /compact runs to the end in the daemon whatever happens to the page that asked for it
// (POST /compact awaits compactCodeSession, which takes no signal). Until this was tracked, only
// that page's own state knew it was running: a page reopened (or another tab) mid-compaction
// showed nothing, and a new turn, a /clear, a /resume, a /revert or a second /compact sent
// meanwhile was accepted against the very history being summarized. These drive the real routes
// and the real compactCodeSession (pi's own compaction) against a loopback stand-in engine that
// holds the summary request until the test lets it answer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function sseText(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const delta of [{ role: 'assistant', content: text }, {}]) {
    const finish = 'content' in delta ? null : 'stop'
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

/** A loopback engine whose chat-completions requests wait until `answer` is called: the summary
 *  call of a compaction stays in flight for as long as the test needs. Once answered, any later
 *  request (pi may summarize in more than one call) is answered the same way at once. 404 for
 *  anything else. */
async function holdingEngine() {
  const held: ServerResponse[] = []
  let reply: ((res: ServerResponse) => void) | null = null
  let arrived!: () => void
  const firstRequest = new Promise<void>((r) => { arrived = r })
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    req.resume()
    req.on('end', () => {
      if (reply) reply(res)
      else held.push(res)
      arrived()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    firstRequest,
    answer: (how: (res: ServerResponse) => void) => {
      reply = how
      for (const res of held.splice(0)) how(res)
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

function makeApp(base: string) {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const dataDir = tmpDir('tllm-code-compacting-')
  /** The engine's generation count as the routes move it (Manager.generationStart/End). */
  const generations = { held: 0 }
  const repoRoot = tmpDir('tllm-code-compacting-repo-')
  const d = {
    db,
    version: 'test',
    store: {
      dir: () => dataDir,
      snapshot: () => ({ code: { defaultAgent: 'turbollm', agentsMdProjectCandidates: [], agentsMdGlobalCandidates: [] }, daemon: { experimental: { routines: false } } }),
    },
    manager: {
      status: () => ({ state: 'running', model: { key: 'test-model', name: 'Test', ctx: 8192 } }),
      target: () => base,
      currentOpts: () => undefined,
      generationStart: () => { generations.held++ },
      generationEnd: () => { generations.held-- },
    },
    registry: { active: () => undefined },
    scanner: { get: () => undefined },
    modelRouter: { resolveRemoteTarget: () => undefined },
  } as unknown as Deps
  const started: string[] = []
  const runs = {
    reconcileOnStartup() {},
    // A turn started here stays running for the rest of the test.
    isActive: () => started.length > 0,
    queued: () => [],
    todos: () => [],
    enqueue: (_id: string, p: { task: string }) => { started.push(p.task); return { queued: false } },
    steer: async (_id: string, p: { task: string }) => { started.push(p.task); return { steered: false, queued: false } },
  } as unknown as CodeRunManager
  const app = new Hono()
  registerCodeRoutes(app, d, runs)

  // A session with enough history for pi to find something to summarize: ten exchanges of about
  // 4,000 characters each against an 8k-token context.
  const conv = db.createConversation({ kind: 'code' })
  db.setConversationMode(conv.id, 'auto')
  const run = db.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot })
  for (let i = 0; i < 10; i++) {
    db.addMessage(conv.id, 'user', `Step ${i}: ${'explain the parser in detail. '.repeat(140)}`)
    db.addMessage(conv.id, 'assistant', `Answer ${i}: ${'the parser reads tokens one at a time. '.repeat(100)}`)
  }
  return { app, db, convId: conv.id, sessionId: run.id, started, generations }
}

const post = (app: Hono, path: string, body: unknown = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const within = <T>(p: T | Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])

async function sessionDetail(app: Hono, sessionId: string) {
  const res = await app.request(`/api/v1/code/sessions/${sessionId}`)
  assert.equal(res.status, 200)
  return (await res.json()) as { compacting: boolean; conversation: { messages: unknown[] } }
}

test('while /compact runs, the session says so, and a turn, /clear, /resume, /revert and a second /compact are refused until it settles', { timeout: 60_000 }, async () => {
  const engine = await holdingEngine()
  try {
    const { app, db, convId, sessionId, started } = makeApp(engine.base)
    const s = `/api/v1/code/sessions/${sessionId}`
    assert.equal((await sessionDetail(app, sessionId)).compacting, false)

    const compaction = post(app, `${s}/compact`)
    assert.notEqual(await within(engine.firstRequest, 30_000), 'timeout', 'the summary call reached the engine')

    const during = await sessionDetail(app, sessionId)
    assert.equal(during.compacting, true, 'a page opened now learns that a compaction is running')
    const messagesBefore = db.getConversation(convId, true)!.messages!
    // A revert to the fourth step would hide the messages the compaction is summarizing, and the
    // cut it stores when it settles would then point at a hidden message.
    const revertTo = messagesBefore[6].id

    for (const [path, body] of [['/messages', { content: 'next step' }], ['/messages', { content: 'redirect', kind: 'steer' }], ['/clear', {}], ['/resume', {}], ['/revert', { messageId: revertTo }], ['/compact', {}]] as const) {
      const res = await post(app, `${s}${path}`, body)
      assert.equal(res.status, 409, `${path} ${JSON.stringify(body)}: ${await res.clone().text()}`)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'compaction_in_progress', path)
    }
    assert.deepEqual(started, [], 'no turn was started or queued')
    assert.equal(db.getConversation(convId, true)!.messages!.length, messagesBefore.length, 'no message was stored or hidden')
    assert.equal(db.getAgentRun(sessionId)!.clearedUpToMessageId ?? null, null, 'nothing was cleared')
    assert.equal(db.getAgentRun(sessionId)!.revertedFromMessageId ?? null, null, 'nothing was reverted')

    engine.answer((res) => sseText(res, 'The user and the assistant went through the parser step by step.'))
    const done = await within(compaction, 30_000)
    assert.notEqual(done, 'timeout', 'the compaction finished')
    const res = done as Response
    assert.equal(res.status, 200, await res.clone().text())
    assert.ok(db.getAgentRun(sessionId)!.compactionSummary, 'the summary was stored')
    const cut = db.getAgentRun(sessionId)!.compactionUpToMessageId
    assert.ok(db.getConversation(convId, true)!.messages!.some((m) => m.id === cut), 'its cut is a message still shown')

    assert.equal((await sessionDetail(app, sessionId)).compacting, false, 'cleared once the compaction settled')
    const next = await post(app, `${s}/messages`, { content: 'next step' })
    assert.equal(next.status, 202, await next.text())
    assert.equal(started.length, 1, 'a turn is accepted again')
  } finally { await engine.close() }
})

test('a /compact that fails also stops reporting the session as compacting', { timeout: 60_000 }, async () => {
  const engine = await holdingEngine()
  try {
    const { app, sessionId } = makeApp(engine.base)
    const s = `/api/v1/code/sessions/${sessionId}`
    const compaction = post(app, `${s}/compact`)
    assert.notEqual(await within(engine.firstRequest, 30_000), 'timeout', 'the summary call reached the engine')
    assert.equal((await sessionDetail(app, sessionId)).compacting, true)

    engine.answer((res) => { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'engine fell over' } })) })
    const done = await within(compaction, 30_000)
    assert.notEqual(done, 'timeout', 'the compaction settled')
    assert.notEqual((done as Response).status, 200)

    assert.equal((await sessionDetail(app, sessionId)).compacting, false)
    const clear = await post(app, `${s}/clear`)
    assert.equal(clear.status, 200, await clear.text())
  } finally { await engine.close() }
})

test('a turn taken while /compact still reads its body holds that /compact back', { timeout: 60_000 }, async () => {
  const engine = await holdingEngine()
  try {
    const { app, sessionId, started } = makeApp(engine.base)
    const s = `/api/v1/code/sessions/${sessionId}`
    // A body that arrives only when the test sends it: /compact has passed its first run_active
    // check and claimed nothing yet while it waits, and the turn below is handled meanwhile.
    let reading!: () => void
    const bodyRead = new Promise<void>((r) => { reading = r })
    let sendBody!: () => void
    const bodySent = new Promise<void>((r) => { sendBody = r })
    const slowBody = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        reading()
        await bodySent
        ctrl.enqueue(new TextEncoder().encode('{}'))
        ctrl.close()
      },
    }, { highWaterMark: 0 })
    const compaction = app.request(`${s}/compact`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: slowBody, duplex: 'half',
    } as RequestInit)
    assert.notEqual(await within(bodyRead, 10_000), 'timeout', '/compact is reading its body')

    const turn = await post(app, `${s}/messages`, { content: 'next step' })
    assert.equal(turn.status, 202, await turn.text())
    assert.equal(started.length, 1)
    sendBody()
    const first = await within(Promise.race([compaction, engine.firstRequest.then(() => 'summarizing' as const)]), 30_000)
    assert.notEqual(first, 'summarizing', 'no compaction ran beside the turn')
    assert.notEqual(first, 'timeout')
    const res = first as Response
    assert.equal(res.status, 409, await res.clone().text())
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'run_active')
    assert.equal((await sessionDetail(app, sessionId)).compacting, false)
  } finally { await engine.close() }
})

// The summary call goes straight to the engine, and nothing held the engine's generation count meanwhile: the idle
// watchdog could unload the model under a running /compact, and /api/v1/activity's engineGenerating said idle.
test('a local /compact holds the engine\'s generation count while its summary call runs, and lets go once it settles', { timeout: 60_000 }, async () => {
  const engine = await holdingEngine()
  try {
    const { app, sessionId, generations } = makeApp(engine.base)
    const s = `/api/v1/code/sessions/${sessionId}`
    assert.equal(generations.held, 0)
    const compaction = post(app, `${s}/compact`)
    assert.notEqual(await within(engine.firstRequest, 30_000), 'timeout', 'the summary call reached the engine')
    assert.equal(generations.held, 1, 'held while the summary call runs')

    engine.answer((res) => sseText(res, 'The user and the assistant went through the parser step by step.'))
    const done = await within(compaction, 30_000)
    assert.notEqual(done, 'timeout', 'the compaction finished')
    assert.equal((done as Response).status, 200)
    assert.equal(generations.held, 0, 'let go once it settled')

    // A refused one (nothing new to compact) holds nothing either.
    await post(app, `${s}/compact`)
    assert.equal(generations.held, 0)
  } finally { await engine.close() }
})

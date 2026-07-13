// End-to-end proof of Task 5's actual mechanism: a Code run's lifecycle is owned by the DAEMON
// (CodeRunManager), not by the HTTP request, so it survives a client disconnect and a
// reconnecting client replays the buffered history then continues live to completion — with the
// real on-disk file change still landing. Also proves the server-side message queue survives a
// disconnect and fires in order.
//
// This drives the REAL CodeRunManager (real ring buffer, real subscribe, real DB persistence)
// with an injected runner in place of the pi-SDK's runCodeSession — the pi/model path is
// unchanged by this task, so substituting the runner isolates exactly what Task 5 changed:
// WHO owns and re-streams the run. It needs no loaded model, so it's deterministic and CI-safe.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { CodeRunManager, type BufferedEvent, type CodeSessionRunner } from './code-run-manager'
import type { Deps } from '../deps'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A minimal Deps with a real in-memory-ish ConversationStore + a stub engine manager reporting
 *  a loaded model (all the CodeRunManager's turn executor reads). Everything else is unused. */
function makeDeps(): { d: Deps; store: ConversationStore; dir: string } {
  const dir = tmp('tllm-code-mgr-')
  const store = new ConversationStore(dir)
  const d = {
    db: store,
    manager: { status: () => ({ state: 'running', model: { key: 'test-model' } }) },
    // autoGenerateTitles: false — this test verifies reconnect/queue mechanics, not auto-title
    // (which pump() now also fires post-run, see code-run-manager.ts); off keeps it a no-op
    // here instead of also needing a fetch mock for the title-generation completions call.
    store: { dir: () => dir, snapshot: () => ({ daemon: { autoGenerateTitles: false } }) },
  } as unknown as Deps
  return { d, store, dir }
}

/** Create a code session (conversation kind:'code' + agent_run) and return its ids. */
function makeSession(store: ConversationStore, repoRoot: string, task: string) {
  const conv = store.createConversation({ kind: 'code' })
  store.setConversationMode(conv.id, 'auto')
  const run = store.createAgentRun({ convId: conv.id, title: task.slice(0, 40), allowedTools: [], repoRoot })
  const userMsg = store.addMessage(conv.id, 'user', task)
  return { sessionId: run.id, convId: conv.id, userMsgId: userMsg.id }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A paced fake runner: emits a couple of tool calls with real gaps (so a client can disconnect
 *  mid-run), then WRITES A REAL FILE under repoRoot (the on-disk change that must still land),
 *  and returns a normal result. Honors the abort signal like the real runCodeSession does. */
function pacedRunner(marker: string): CodeSessionRunner {
  return (async (params) => {
    const { repoRoot, task, signal, sink } = params
    const outFile = join(repoRoot, `${marker}.txt`)
    const steps = ['read', 'edit']
    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) return { finalText: '', contextUsed: 0, contextMax: 0, aborted: true }
      const id = `${marker}-${i}`
      sink({ event: 'tool_call', data: { id, name: steps[i], args: { path: `${marker}.txt` }, status: 'pending' } })
      await delay(40)
      if (signal.aborted) return { finalText: '', contextUsed: 0, contextMax: 0, aborted: true }
      sink({ event: 'tool_call', data: { id, name: steps[i], args: { path: `${marker}.txt` }, status: 'done', result: 'ok' } })
      sink({ event: 'delta', data: { delta: `did ${steps[i]} ` } })
    }
    // Final abort check right before the durable side effect: a stop() during the run must
    // leave NO file behind (mirrors real tools not running once the run is cancelled).
    if (signal.aborted) return { finalText: '', contextUsed: 0, contextMax: 0, aborted: true }
    // The real, durable side effect — must survive the disconnect/reconnect dance.
    writeFileSync(outFile, `task=${task}\n`)
    return { finalText: `Completed ${marker}.`, contextUsed: 123, contextMax: 8192, aborted: false }
  }) as CodeSessionRunner
}

/** Iterate a subscription, pushing events until `stop(ev)` returns true or the stream ends.
 *  Returns the collected events and whether the stream ended on its own. */
async function collect(
  sub: AsyncIterable<BufferedEvent> & { close(): void },
  stop: (ev: BufferedEvent, all: BufferedEvent[]) => boolean,
): Promise<{ events: BufferedEvent[]; ended: boolean }> {
  const events: BufferedEvent[] = []
  for await (const ev of sub) {
    events.push(ev)
    if (stop(ev, events)) return { events, ended: false }
  }
  return { events, ended: true }
}

// ── disconnect mid-run → run keeps going → reconnect replays + finishes → file lands ──

test('run is daemon-owned: a client disconnect does NOT stop it; a reconnect replays + completes', async () => {
  const { d, store, dir } = makeDeps()
  const mgr = new CodeRunManager(d, { runner: pacedRunner('alpha') })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'do alpha')

  // Start the run (daemon-owned; returns immediately).
  const { queued } = mgr.enqueue(sessionId, { convId, repoRoot, task: 'do alpha', userMsgId })
  assert.equal(queued, false, 'first turn on an idle session starts, not queues')

  // Connect and read until the FIRST tool call, then DISCONNECT (close the subscription) —
  // exactly what a browser navigating away does, WITHOUT calling stop.
  const sub1 = mgr.subscribe(sessionId, 0)
  const first = await collect(sub1, (ev) => ev.event === 'tool_call')
  sub1.close()
  assert.ok(first.events.some((e) => e.event === 'meta'), 'got the meta frame before the first tool call')
  assert.ok(first.events.some((e) => e.event === 'tool_call'), 'saw at least one tool call before disconnecting')

  // The run must STILL be executing server-side — the disconnect didn't touch it.
  assert.equal(mgr.isActive(sessionId), true, 'run kept running after the client disconnected')
  assert.equal(existsSync(join(repoRoot, 'alpha.txt')), false, 'file not written yet (run mid-flight)')
  assert.equal(store.getAgentRun(sessionId)?.status, 'running', 'DB still shows the run as running')

  // RECONNECT: a fresh subscribe from seq 0 must replay the buffered history (incl. the tool
  // call emitted before the disconnect) and then live-tail to completion.
  const sub2 = mgr.subscribe(sessionId, 0)
  const all = await collect(sub2, () => false) // read to natural end (session goes idle)
  assert.equal(all.ended, true, 'reconnected stream ended when the session went idle')

  const kinds = all.events.map((e) => e.event)
  assert.ok(kinds.includes('meta'), 'reconnect replayed the meta frame')
  assert.ok(all.events.filter((e) => e.event === 'tool_call').length >= 2, 'reconnect replayed the buffered tool calls + live ones')
  assert.ok(kinds.includes('done'), 'reconnect saw the terminal done frame')

  // The real on-disk change landed, and the turn is persisted.
  assert.equal(existsSync(join(repoRoot, 'alpha.txt')), true, 'the run finished and wrote its file')
  assert.match(readFileSync(join(repoRoot, 'alpha.txt'), 'utf8'), /task=do alpha/)
  assert.equal(store.getAgentRun(sessionId)?.status, 'done', 'DB shows the run done')
  const assistant = store.getConversation(convId, true)?.messages?.findLast((m) => m.role === 'assistant')
  assert.ok(assistant && assistant.content.includes('did edit'), 'assistant turn persisted with accumulated content')
  assert.ok(dir.length > 0)
})

// ── reconnecting to an ALREADY-finished run ends cleanly (falls back to DB) ────────────

test('reconnect after the run already finished ends immediately without replaying a stale turn', async () => {
  const { d, store } = makeDeps()
  const mgr = new CodeRunManager(d, { runner: pacedRunner('beta') })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'do beta')

  mgr.enqueue(sessionId, { convId, repoRoot, task: 'do beta', userMsgId })
  // Watch to completion.
  const s1 = mgr.subscribe(sessionId, 0)
  const done = await collect(s1, () => false)
  assert.ok(done.events.some((e) => e.event === 'done'))
  assert.equal(mgr.isActive(sessionId), false, 'session idle after completion')

  // A late reconnect (within the retain window) must NOT re-stream the finished turn — it
  // replays nothing and ends, so the client just shows the DB transcript.
  const s2 = mgr.subscribe(sessionId, 0)
  const late = await collect(s2, () => false)
  assert.equal(late.ended, true)
  assert.equal(late.events.filter((e) => e.event === 'done').length, 0, 'no stale terminal frame re-emitted')
  assert.equal(late.events.filter((e) => e.event === 'tool_call').length, 0, 'no stale tool calls re-emitted')
})

// ── server-side queue survives a disconnect and fires in order ─────────────────────────

test('a queued follow-up survives a mid-run disconnect and runs in order server-side', async () => {
  const { d, store } = makeDeps()
  // Distinct markers per task so we can verify BOTH turns landed, in order.
  const runner: CodeSessionRunner = (params) => {
    const marker = params.task === 'first' ? 'q1' : 'q2'
    return pacedRunner(marker)(params)
  }
  const mgr = new CodeRunManager(d, { runner })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')

  // Turn 1 starts.
  const r1 = mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  assert.equal(r1.queued, false)

  // Connect, read to the first tool call, then queue a SECOND turn while turn 1 is active.
  const sub1 = mgr.subscribe(sessionId, 0)
  await collect(sub1, (ev) => ev.event === 'tool_call')
  const u2 = store.addMessage(convId, 'user', 'second')
  const r2 = mgr.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  assert.equal(r2.queued, true, 'the follow-up queued behind the active turn')
  assert.deepEqual(mgr.queued(sessionId), ['second'], 'server-side queue holds the follow-up')

  // DISCONNECT mid-run. The queue is server-side, so it must survive.
  sub1.close()
  assert.deepEqual(mgr.queued(sessionId), ['second'], 'queue survived the client disconnect')

  // Reconnect and watch everything to the end.
  const sub2 = mgr.subscribe(sessionId, 0)
  const all = await collect(sub2, () => false)
  assert.equal(all.ended, true)

  // BOTH turns ran, in order, and both files landed.
  assert.equal(existsSync(join(repoRoot, 'q1.txt')), true, 'first turn landed its file')
  assert.equal(existsSync(join(repoRoot, 'q2.txt')), true, 'queued follow-up ran and landed its file')
  // Two turns → two meta frames and two done frames across the session's live span (the reconnect
  // replays from the CURRENTLY active turn's meta, so we assert on the DB for the full history).
  const msgs = store.getConversation(convId, true)?.messages ?? []
  const assistants = msgs.filter((m) => m.role === 'assistant')
  assert.equal(assistants.length, 2, 'both turns persisted an assistant reply')
  assert.equal(mgr.queued(sessionId).length, 0, 'queue drained')
  assert.equal(mgr.isActive(sessionId), false, 'session idle after both turns')
})

// ── stop() aborts the active run AND clears the queue ─────────────────────────────────

test('stop() aborts the active run and drops everything queued behind it', async () => {
  const { d, store } = makeDeps()
  const mgr = new CodeRunManager(d, { runner: pacedRunner('gamma') })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'do gamma')

  mgr.enqueue(sessionId, { convId, repoRoot, task: 'do gamma', userMsgId })
  const u2 = store.addMessage(convId, 'user', 'queued one')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'queued one', userMsgId: u2.id })
  assert.deepEqual(mgr.queued(sessionId), ['queued one'])

  const sub1 = mgr.subscribe(sessionId, 0)
  await collect(sub1, (ev) => ev.event === 'tool_call') // early return closes sub1 (a disconnect)

  const stopped = mgr.stop(sessionId)
  assert.equal(stopped, true)
  assert.deepEqual(mgr.queued(sessionId), [], 'queue cleared by stop')

  // Reconnect and drain to the end; the active turn ends aborted/interrupted, the queued one
  // never runs. (Draining on a FRESH subscription — reusing sub1 would be a no-op, since the
  // early return above already closed it, exactly as a real client disconnect would.)
  const rest = await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.equal(rest.ended, true)
  assert.equal(existsSync(join(repoRoot, 'gamma.txt')), false, 'aborted run wrote no file')
  assert.equal(mgr.isActive(sessionId), false)
  assert.equal(store.getAgentRun(sessionId)?.status, 'interrupted', 'aborted run recorded as interrupted')
})

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
  assert.deepEqual(mgr.queued(sessionId), [{ userMsgId: u2.id, task: 'second', kind: 'followUp' }], 'server-side queue holds the follow-up (tagged followUp by default)')

  // DISCONNECT mid-run. The queue is server-side, so it must survive.
  sub1.close()
  assert.deepEqual(mgr.queued(sessionId), [{ userMsgId: u2.id, task: 'second', kind: 'followUp' }], 'queue survived the client disconnect')

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

// ── sendNow() promotes one queued turn without dropping the rest ───────────────────────

test('sendNow() stops the active turn and promotes the target queued turn, keeping the rest queued', async () => {
  const { d, store } = makeDeps()
  const runner: CodeSessionRunner = (params) => {
    const marker = params.task === 'first' ? 'r1' : params.task === 'second' ? 'r2' : 'r3'
    return pacedRunner(marker)(params)
  }
  const mgr = new CodeRunManager(d, { runner })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')

  // Turn 1 active; queue turns 2 and 3 behind it, in that order.
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  const sub1 = mgr.subscribe(sessionId, 0)
  await collect(sub1, (ev) => ev.event === 'tool_call')
  const u2 = store.addMessage(convId, 'user', 'second')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  const u3 = store.addMessage(convId, 'user', 'third')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'third', userMsgId: u3.id })
  assert.deepEqual(mgr.queued(sessionId).map((t) => t.task), ['second', 'third'], 'FIFO order before sendNow')

  // "Send now" on the THIRD turn — must stop turn 1 AND move turn 3 to the FRONT, without
  // dropping turn 2 (a naive stop()-then-requeue would either drop turn 2 or run turn 2 first).
  const ok = mgr.sendNow(sessionId, u3.id)
  assert.equal(ok, true)
  assert.deepEqual(mgr.queued(sessionId).map((t) => t.task), ['third', 'second'], 'target promoted to front, the rest survives')

  sub1.close()
  const all = await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.equal(all.ended, true)

  // Turn 1 aborted (no file). Turn 3 ran BEFORE turn 2 (promoted), and turn 2 still ran after.
  assert.equal(existsSync(join(repoRoot, 'r1.txt')), false, 'turn 1 was stopped before finishing')
  assert.equal(existsSync(join(repoRoot, 'r2.txt')), true, 'turn 2 (demoted) still ran eventually')
  assert.equal(existsSync(join(repoRoot, 'r3.txt')), true, 'turn 3 (promoted) ran')
  assert.equal(mgr.queued(sessionId).length, 0, 'queue drained')
  assert.equal(mgr.isActive(sessionId), false)
})

test('sendNow() on an unknown/already-run userMsgId is a harmless no-op', async () => {
  const { d, store } = makeDeps()
  const mgr = new CodeRunManager(d, { runner: pacedRunner('delta') })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'do delta')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'do delta', userMsgId })

  assert.equal(mgr.sendNow(sessionId, 'not-a-real-id'), false, 'unknown userMsgId returns false')
  assert.equal(mgr.sendNow('not-a-real-session', userMsgId), false, 'unknown session returns false')
  assert.equal(mgr.isActive(sessionId), true, 'the real active turn was untouched by either no-op call')

  await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.equal(existsSync(join(repoRoot, 'delta.txt')), true, 'the active turn completed normally')
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
  assert.deepEqual(mgr.queued(sessionId), [{ userMsgId: u2.id, task: 'queued one', kind: 'followUp' }])

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

// ── an aborted turn's context-usage stats never regress below the last confirmed value ─

test('an aborted turn does not report ctxUsed lower than the last completed turn (context cannot shrink)', async () => {
  const { d, store } = makeDeps()
  const repoRoot = tmp('tllm-code-repo-')
  // Turn 1: a runner that completes normally with a real, healthy contextUsed.
  const goodRunner: CodeSessionRunner = (async () => ({ finalText: 'ok', contextUsed: 5000, contextMax: 131072, aborted: false })) as CodeSessionRunner
  const mgr1 = new CodeRunManager(d, { runner: goodRunner })
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')
  mgr1.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await collect(mgr1.subscribe(sessionId, 0), () => false)
  assert.equal(store.getConversation(convId, true)?.messages?.findLast((m) => m.role === 'assistant')?.stats.ctxUsed, 5000)

  // Turn 2: simulates the real live bug (2026-07-13) — an aborted turn's OWN contextUsed
  // estimate came back much lower than reality (pi's estimator caught mid-assembly), resolving
  // normally (not throwing) with { aborted: true, contextUsed: 800 }.
  const flakyAbortRunner: CodeSessionRunner = (async () => ({ finalText: '', contextUsed: 800, contextMax: 131072, aborted: true })) as CodeSessionRunner
  const mgr2 = new CodeRunManager(d, { runner: flakyAbortRunner })
  const u2 = store.addMessage(convId, 'user', 'second')
  mgr2.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  await collect(mgr2.subscribe(sessionId, 0), () => false)

  const last = store.getConversation(convId, true)?.messages?.findLast((m) => m.role === 'assistant')
  assert.equal(last?.stats.aborted, true)
  assert.equal(last?.stats.ctxUsed, 5000, 'floored at the last confirmed value, not the unreliable lower one')
  assert.equal(last?.stats.ctxMax, 131072)
})

test('an aborted turn that reports a HIGHER ctxUsed than before is trusted as-is', async () => {
  const { d, store } = makeDeps()
  const repoRoot = tmp('tllm-code-repo-')
  const goodRunner: CodeSessionRunner = (async () => ({ finalText: 'ok', contextUsed: 5000, contextMax: 131072, aborted: false })) as CodeSessionRunner
  const mgr1 = new CodeRunManager(d, { runner: goodRunner })
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')
  mgr1.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await collect(mgr1.subscribe(sessionId, 0), () => false)

  // A genuinely larger number (e.g. the turn streamed a lot of tool output before being
  // stopped) is real growth, not the bug — must NOT be clamped down to the prior value.
  const higherAbortRunner: CodeSessionRunner = (async () => ({ finalText: '', contextUsed: 9000, contextMax: 131072, aborted: true })) as CodeSessionRunner
  const mgr2 = new CodeRunManager(d, { runner: higherAbortRunner })
  const u2 = store.addMessage(convId, 'user', 'second')
  mgr2.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  await collect(mgr2.subscribe(sessionId, 0), () => false)

  const last = store.getConversation(convId, true)?.messages?.findLast((m) => m.role === 'assistant')
  assert.equal(last?.stats.ctxUsed, 9000, 'a real higher value is trusted, not clamped')
})

// ── a manual rename survives a later successful turn (founder-reported gap, 2026-07-14) ─

test('a manual session rename is not reverted by a later successful turn\'s auto-title mirror', async () => {
  const { d, store } = makeDeps()
  const repoRoot = tmp('tllm-code-repo-')
  const okRunner: CodeSessionRunner = (async () => ({ finalText: 'ok', contextUsed: 100, contextMax: 8192, aborted: false })) as CodeSessionRunner
  const mgr = new CodeRunManager(d, { runner: okRunner })
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')

  // Simulate an already-generated conversation title (bypasses needing to mock the real
  // title-generation completions call — autoTitleFromConversation's own guard short-circuits
  // once conv.title isn't 'New chat', exactly as it would after a real generation).
  store.updateConversation(convId, { title: 'Auto Generated Title' })

  // Turn 1: the mirror fires for the first time — agent_runs.title picks up the generated name.
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.equal(store.getAgentRun(sessionId)?.title, 'Auto Generated Title')
  assert.equal(store.getAgentRun(sessionId)?.titleAutoSynced, true, 'mirror marks itself synced after the first successful turn')

  // The user renames the session (PATCH .../title route, mirrored here directly).
  store.updateAgentRun(sessionId, { title: 'My Custom Name' })

  // Turn 2: a second successful turn must NOT re-mirror conversations.title over the rename.
  const u2 = store.addMessage(convId, 'user', 'second')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.equal(store.getAgentRun(sessionId)?.title, 'My Custom Name', 'manual rename survives a later completed turn')
})

test('a runner that THROWS AbortError also floors ctxUsed at the last confirmed value', async () => {
  const { d, store } = makeDeps()
  const repoRoot = tmp('tllm-code-repo-')
  const goodRunner: CodeSessionRunner = (async () => ({ finalText: 'ok', contextUsed: 3000, contextMax: 8192, aborted: false })) as CodeSessionRunner
  const mgr1 = new CodeRunManager(d, { runner: goodRunner })
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')
  mgr1.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await collect(mgr1.subscribe(sessionId, 0), () => false)

  // Simulates the ORIGINAL bug's exact trigger: runCodeSession throws an AbortError (e.g. from
  // an aborted gate.acquire()) before ever computing its own contextUsed.
  const throwingRunner: CodeSessionRunner = (async () => {
    const err = new Error('gate_acquire_aborted')
    err.name = 'AbortError'
    throw err
  }) as CodeSessionRunner
  const mgr2 = new CodeRunManager(d, { runner: throwingRunner })
  const u2 = store.addMessage(convId, 'user', 'second')
  mgr2.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  await collect(mgr2.subscribe(sessionId, 0), () => false)

  const last = store.getConversation(convId, true)?.messages?.findLast((m) => m.role === 'assistant')
  assert.equal(last?.stats.aborted, true)
  assert.equal(last?.stats.ctxUsed, 3000, 'a thrown AbortError still carries forward the last known context, not 0')
  assert.equal(store.getAgentRun(sessionId)?.status, 'interrupted')
})

// ── steer/followUp dispatch (Phase 1, ADR-246) ─────────────────────────────────────────
//
// These drive the manager's steer() vs enqueue() dispatch with an injected runner that exposes
// (or refuses) a live steer handle, exactly the way the real runCodeSession publishes pi's
// session.steer via onSteerable — no loaded model needed.

/** A runner that publishes a steer handle via onSteerable (like runCodeSession does once its pi
 *  session is streaming), records every steered text into `steerLog`, and stays "active" long
 *  enough (holdMs) for a test to steer into it before it settles. `streaming: false` makes the
 *  handle refuse (return false) to simulate the turn having just finished (the race the fallback
 *  guards). Honors the abort signal like the real runner. */
function steerableRunner(opts: { steerLog: string[]; streaming?: boolean; holdMs?: number }): CodeSessionRunner {
  return (async (params) => {
    const { signal } = params
    params.onSteerable?.(async (text: string) => {
      if (opts.streaming === false) return false
      opts.steerLog.push(text)
      return true
    })
    const hold = opts.holdMs ?? 120
    const start = Date.now()
    while (Date.now() - start < hold) {
      if (signal.aborted) break
      await delay(10)
    }
    params.onSteerable?.(null)
    return { finalText: 'ok', contextUsed: 100, contextMax: 8192, aborted: signal.aborted }
  }) as CodeSessionRunner
}

test('enqueue tags a queued follow-up with kind:followUp by default', async () => {
  const { d, store } = makeDeps()
  const mgr = new CodeRunManager(d, { runner: pacedRunner('fu') })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  const sub1 = mgr.subscribe(sessionId, 0)
  await collect(sub1, (ev) => ev.event === 'tool_call')
  const u2 = store.addMessage(convId, 'user', 'second')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  assert.deepEqual(mgr.queued(sessionId), [{ userMsgId: u2.id, task: 'second', kind: 'followUp' }])
  sub1.close()
  await collect(mgr.subscribe(sessionId, 0), () => false)
})

test('steer() injects into the ACTIVE turn via the live handle, and does NOT queue', async () => {
  const { d, store } = makeDeps()
  const steerLog: string[] = []
  const mgr = new CodeRunManager(d, { runner: steerableRunner({ steerLog, holdMs: 250 }) })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')

  mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await delay(40) // let the turn start and register its steer handle
  assert.equal(mgr.isActive(sessionId), true)

  const u2 = store.addMessage(convId, 'user', 'go left instead')
  const res = await mgr.steer(sessionId, { convId, repoRoot, task: 'go left instead', userMsgId: u2.id })
  assert.equal(res.steered, true, 'delivered into the live turn')
  assert.equal(res.queued, false)
  assert.deepEqual(steerLog, ['go left instead'], 'pi steer handle received the message')
  assert.deepEqual(mgr.queued(sessionId), [], 'a steered message is never queued')

  await collect(mgr.subscribe(sessionId, 0), () => false)
})

test('steer() with no active turn falls back to starting the turn (never errors)', async () => {
  const { d, store } = makeDeps()
  const steerLog: string[] = []
  const mgr = new CodeRunManager(d, { runner: steerableRunner({ steerLog, holdMs: 20 }) })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')

  // Idle session: nothing live to steer, so it falls back to enqueue, which STARTS the turn.
  const res = await mgr.steer(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  assert.equal(res.steered, false, 'nothing live to steer')
  assert.equal(res.queued, false, 'idle session: fell back to starting the turn, not queuing behind one')
  assert.deepEqual(steerLog, [], 'the handle was never called (no active turn existed)')
  assert.equal(mgr.isActive(sessionId), true, 'the fallback started the turn')

  await collect(mgr.subscribe(sessionId, 0), () => false)
})

test('steer() falls back to the queue (tagged kind:steer) when the live turn is no longer streaming', async () => {
  const { d, store } = makeDeps()
  const steerLog: string[] = []
  // streaming:false → the handle returns false, simulating the turn having just settled (race).
  const mgr = new CodeRunManager(d, { runner: steerableRunner({ steerLog, streaming: false, holdMs: 250 }) })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')

  mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await delay(40)

  const u2 = store.addMessage(convId, 'user', 'redirect')
  const res = await mgr.steer(sessionId, { convId, repoRoot, task: 'redirect', userMsgId: u2.id })
  assert.equal(res.steered, false, 'the handle refused (not streaming)')
  assert.equal(res.queued, true, 'fell back to queuing behind the still-active turn')
  assert.deepEqual(steerLog, [], 'no message delivered live')
  assert.deepEqual(mgr.queued(sessionId), [{ userMsgId: u2.id, task: 'redirect', kind: 'steer' }], 'the fallback queue entry preserves the requested kind')

  await collect(mgr.subscribe(sessionId, 0), () => false)
})

// ── todo/step checklist live state (ADR-255) ───────────────────────────────────────────

/** A runner that emits one `todos` frame (the update_todos tool's SSE shape) then completes. */
function todoRunner(todos: Array<{ content: string; status: string }>): CodeSessionRunner {
  return (async (params) => {
    params.sink({ event: 'todos', data: { todos } })
    return { finalText: 'ok', contextUsed: 100, contextMax: 8192, aborted: false }
  }) as CodeSessionRunner
}

test('a todos frame is captured into the run\'s live state and exposed via todos() for reconnect', async () => {
  const { d, store } = makeDeps()
  const list = [{ content: 'step 1', status: 'in_progress' }, { content: 'step 2', status: 'pending' }]
  const mgr = new CodeRunManager(d, { runner: todoRunner(list) })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'multi-step')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'multi-step', userMsgId })
  await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.deepEqual(mgr.todos(sessionId), list, 'the latest checklist is held in live state (snapshot on connect)')
})

test('a new turn resets the checklist so a prior turn\'s todos never leak forward', async () => {
  const { d, store } = makeDeps()
  const runner: CodeSessionRunner = (params) => {
    if (params.task === 'first') return todoRunner([{ content: 'a', status: 'pending' }])(params)
    // Turn 2 emits NO todos frame — the pump-time reset must clear turn 1's list on its own.
    return (async () => ({ finalText: 'ok', contextUsed: 1, contextMax: 2, aborted: false }))()
  }
  const mgr = new CodeRunManager(d, { runner })
  const repoRoot = tmp('tllm-code-repo-')
  const { sessionId, convId, userMsgId } = makeSession(store, repoRoot, 'first')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'first', userMsgId })
  await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.deepEqual(mgr.todos(sessionId), [{ content: 'a', status: 'pending' }], 'turn 1 left a checklist')

  const u2 = store.addMessage(convId, 'user', 'second')
  mgr.enqueue(sessionId, { convId, repoRoot, task: 'second', userMsgId: u2.id })
  await collect(mgr.subscribe(sessionId, 0), () => false)
  assert.deepEqual(mgr.todos(sessionId), [], 'turn 2 emitted no checklist, so the reset left it empty — no leak from turn 1')
})

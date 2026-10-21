// GitHub #177 — generated output must NEVER be silently discarded, plus the prompt half of
// #52 item 9's interrupted-turn token counts.
//
// The reported bucket was assistant rows that are EMPTY with `stats.aborted === false`: the
// backend inserts that placeholder row before the first token exists, and the single write-back
// that fills it in (`db.updateMessage`) sits at the very END of runGeneration. Anything that
// throws on the way there — historically `await emit({ event: 'error', … })` INSIDE the catch
// block, which no `finally` can contain — took the whole turn's text with it.
//
// These tests drive the real runGeneration (not a re-implementation of its control flow) with a
// sink that fails the way a torn-down SSE stream does, and assert on what actually landed in the
// database, because the database row is the artifact the user loses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { runGeneration, resilientSink } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import type { EmitSink } from './emit-sink.js'
import { tmpDir } from '../test-support/tmp'

interface Harness {
  d: Deps
  store: ConversationStore
  cleanup: () => void
}

function mkHarness(): Harness {
  const dir = tmpDir('tllm-chat-persist-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    db: store,
    store: { snapshot: () => cfg, dir: () => dir },
    scanner: { get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'Test Model', ctx: 8192 } }),
      target: () => 'http://127.0.0.1:8081',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
  } as unknown as Deps
  return { d, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** Conversation + the EMPTY assistant placeholder the route inserts before any token exists
 *  (chat-routes.ts: `db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })`). */
function seed(store: ConversationStore) {
  const conv = store.createConversation()
  store.addMessage(conv.id, 'user', 'hi')
  store.addMessage(conv.id, 'assistant', '', { stats: { aborted: false } })
  const assistantMsg = store.getLastMessage(conv.id)!
  return { conv: store.getConversation(conv.id, true)!, assistantMsg }
}

function ctxFor(seeded: ReturnType<typeof seed>, ac: AbortController) {
  return {
    convId: seeded.conv.id,
    conv: seeded.conv,
    engineMessages: [{ role: 'user', content: 'hi' }],
    assistantMsg: seeded.assistantMsg,
    upstream: { modelField: 'm', modelName: 'Test Model', ctxMax: 8192, target: 'http://127.0.0.1:8081' },
    ac,
    thinkingBudget: -1,
    reasoningEffort: undefined,
    isCodeAuthorized: false,
  }
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** A fake llama.cpp stream. `script` runs against the controller; on abort it mirrors what Node 22's
 *  plain fetch body does — it ERRORS the in-flight body with an AbortError. `onAbort: 'end'` mirrors
 *  the bodies that END instead (done: true): the tee'd branch the request log hands the turn, and
 *  Node 18's fetch body (the Android app's runtime). */
function fakeUpstream(script: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>, opts: { onAbort?: 'error' | 'end' } = {}): {
  restore: () => void
} {
  const original = globalThis.fetch
  const enc = new TextEncoder()
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => {
          try {
            if (opts.onAbort === 'end') controller.close()
            else controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
          } catch { /* already closed */ }
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        const write = (s: string) => controller.enqueue(enc.encode(s))
        void (async () => {
          try {
            await script({
              enqueue: (chunk: Uint8Array) => controller.enqueue(chunk),
              close: () => controller.close(),
              error: (e: unknown) => controller.error(e),
              // convenience for the scripts below
              write,
            } as unknown as ReadableStreamDefaultController<Uint8Array>)
          } catch { /* the script decides how the stream ends */ }
        })()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

type Scripted = ReadableStreamDefaultController<Uint8Array> & { write: (s: string) => void }

const tick = () => new Promise((r) => setTimeout(r, 5))

// ── 1. The seam itself ────────────────────────────────────────────────────────

test('resilientSink swallows a write failure and latches the client as gone', async () => {
  const seen: string[] = []
  let calls = 0
  const sink: EmitSink = (ev) => {
    calls++
    if (ev.event === 'delta') throw new Error('stream closed')
    seen.push(ev.event)
  }
  const emit = resilientSink(sink)

  await emit({ event: 'reasoning', data: {} })
  assert.equal(emit.clientGone(), false)

  // The failing write must NOT propagate — this is the rejection that used to unwind past the
  // persistence write at the end of runGeneration.
  await assert.doesNotReject(() => emit({ event: 'delta', data: {} }) as Promise<void>)
  assert.equal(emit.clientGone(), true)

  // …and nothing is written to a stream already known to be dead.
  await emit({ event: 'done', data: {} })
  assert.deepEqual(seen, ['reasoning'])
  assert.equal(calls, 2, 'the sink must not be called again after it failed once')
})

test('resilientSink swallows an async rejection too (a real stream write is async)', async () => {
  const emit = resilientSink(() => Promise.reject(new Error('epipe')))
  await assert.doesNotReject(() => emit({ event: 'delta', data: {} }) as Promise<void>)
  assert.equal(emit.clientGone(), true)
})

// ── 2. The invariant, end to end ──────────────────────────────────────────────

test('a client that is gone for the WHOLE turn still gets its output persisted', async () => {
  const h = mkHarness()
  // Every write fails, from the first token on — a tab closed the instant the turn started.
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'the answer ' } }] }))
    await tick()
    s.write(sseLine({ choices: [{ delta: { content: 'is 42' } }] }))
    await tick()
    // The engine then dies mid-stream: a NON-abort throw, which lands in the catch block whose
    // `await emit({ event: 'error' })` was the unguarded one.
    s.error(new Error('engine process exited'))
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    await assert.doesNotReject(() =>
      runGeneration(h.d, () => { throw new Error('client gone') }, ctxFor(seeded, ac) as never))
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'the answer is 42', 'generated output was discarded')
    assert.equal(row.stats.aborted, false)
    assert.ok((row.stats.totalMs ?? 0) >= 0, 'the row must be finalized, not left as a placeholder')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a write that fails only on the error event (the #177 catch-block path) still persists', async () => {
  const h = mkHarness()
  const delivered: string[] = []
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    // Long enough to clear the parser's 29-char lookahead so a real 'delta' write happens.
    s.write(sseLine({ choices: [{ delta: { content: 'a partial reply that really did reach the client' } }] }))
    await tick()
    s.error(new Error('engine process exited'))
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const sink: EmitSink = (ev) => {
      if (ev.event === 'error') throw new Error('stream closed')
      delivered.push(ev.event)
    }
    await assert.doesNotReject(() => runGeneration(h.d, sink, ctxFor(seeded, ac) as never))
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'a partial reply that really did reach the client')
    assert.ok(delivered.length > 0 && delivered.every((e) => e === 'delta'),
      'the deltas were delivered; only the error write failed')
  } finally {
    f.restore()
    h.cleanup()
  }
})

// ── 3. Abort semantics are untouched ──────────────────────────────────────────

test('a real Stop click still records aborted:true, with the text generated so far', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'half an ans' } }] }))
    // …and then nothing: the stream stays open until the abort tears it down.
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    await tick()
    ac.abort()  // POST .../stop
    await done
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, true, 'a user Stop must still be recorded as an abort')
    assert.equal(row.content, 'half an ans')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a Stop whose read ENDS instead of failing (a tee\'d or Node 18 body) still records aborted:true', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'half an ans' } }] }))
  }, { onAbort: 'end' })
  const events: string[] = []
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, (ev) => { events.push(ev.event) }, ctxFor(seeded, ac) as never)
    await tick()
    ac.abort()  // POST .../stop: the pending read resolves done:true
    await done
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, true, 'a Stop is a Stop however the read ended')
    assert.equal(row.content, 'half an ans')
    assert.ok(!events.includes('error'), 'and not an engine failure')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a Stop whose read ends quietly while a tool call streams starts no tool call', async () => {
  const h = mkHarness()
  const executed: string[] = []
  ;(h.d as { tools?: unknown }).tools = {
    buildToolDefinitions: async () => [{ type: 'function', function: { name: 'run_code', description: '', parameters: { type: 'object', properties: {} } } }],
    executeTool: async (call: { name: string }) => { executed.push(call.name); return '42' },
  }
  ;(h.d.store.snapshot() as { tools: { toolPolicies: Record<string, string> } }).tools.toolPolicies = { run_code: 'allow' }
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    // The whole call has streamed; the model has not finished the round yet.
    s.write(sseLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'run_code', arguments: '{"code":"6*7"}' } }] } }] }))
  }, { onAbort: 'end' })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    await tick()
    ac.abort()
    await done
    assert.deepEqual(executed, [], 'the call set to Allow does not run after Stop')
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, true)
    assert.deepEqual(row.toolCalls ?? [], [])
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a Stop during one tool call of a round starts none of the round\'s later calls', async () => {
  const h = mkHarness()
  const ac = new AbortController()
  const executed: string[] = []
  ;(h.d as { tools?: unknown }).tools = {
    buildToolDefinitions: async () => ['first', 'second'].map((name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } })),
    // Stop comes while the first call runs; it does not honour the abort and returns its result.
    executeTool: async (call: { name: string }) => { executed.push(call.name); if (call.name === 'first') ac.abort(); return 'ok' },
  }
  ;(h.d.store.snapshot() as { tools: { autoAllowAll: boolean } }).tools.autoAllowAll = true
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'tc1', function: { name: 'first', arguments: '{}' } },
      { index: 1, id: 'tc2', function: { name: 'second', arguments: '{}' } },
    ] } }] }))
    s.write(sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    s.write('data: [DONE]\n\n')
    s.close()
  })
  try {
    const seeded = seed(h.store)
    await runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    assert.deepEqual(executed, ['first'], 'the second call does not start after Stop')
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, true)
    assert.deepEqual(row.toolCalls?.map((t) => t.name), ['first'], 'the call that ran is kept')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('an aborted turn with a dead client is STILL an abort, not a silent empty row', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'text' } }] }))
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, () => { throw new Error('client gone') }, ctxFor(seeded, ac) as never)
    await tick()
    ac.abort()
    await done
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, true)
    assert.equal(row.content, 'text')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a SHORT interrupted reply is not lost in the parser lookahead', async () => {
  // The parser withholds up to 29 chars (it cannot yet rule out a `<|channel|>analysis…` tag) and
  // only releases them at end-of-stream — which an abort throws straight past. Every reply the
  // user stopped early used to be persisted as an empty string because of it.
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'hi there' } }] }))
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    await tick()
    ac.abort()
    await done
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'hi there')
    assert.equal(row.stats.aborted, true)
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a normal turn is never double-flushed by the interrupted-turn drain', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'short tail' } }] }))
    s.write('data: [DONE]\n\n')
    s.close()
  })
  try {
    const seeded = seed(h.store)
    await runGeneration(h.d, () => {}, ctxFor(seeded, new AbortController()) as never)
    assert.equal(h.store.getMessage(seeded.assistantMsg.id)!.content, 'short tail')
  } finally {
    f.restore()
    h.cleanup()
  }
})

// ── 4. GitHub #52 item 9 — the prompt half of the interrupted-turn token counts ──

test('an interrupted turn reports the prompt tokens the engine streamed, not 0', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    // llama.cpp streams prompt_progress WHILE ingesting the prompt; `total` is the prompt size.
    s.write(sseLine({ prompt_progress: { processed: 137, total: 137, tps: 900 } }))
    await tick()
    // Long enough to clear the parser's 29-char lookahead, so these really do stream as deltas.
    s.write(sseLine({ choices: [{ delta: { content: 'the first half of a streamed reply ' } }] }))
    await tick()
    s.write(sseLine({ choices: [{ delta: { content: 'and the second half of it as well ' } }] }))
    // No usage chunk, no timings — interrupted before the engine could send either.
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    await tick(); await tick(); await tick()
    ac.abort()
    await done
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, true)
    assert.equal(row.stats.promptTokens, 137, 'prompt tokens must not report 0 for a real prompt')
    const gen = row.stats.genTokens ?? 0
    assert.ok(gen > 0, 'liveOut fallback (already shipped) still applies')
    assert.equal(row.stats.ctxUsed, 137 + gen, 'ctxUsed must not understate context by the whole prompt')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('with no prompt-progress source the prompt count stays 0 — never an invented number', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'x' } }] }))
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    const done = runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    await tick()
    ac.abort()
    await done
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.promptTokens, 0)
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a complete turn still prefers the engine usage/timings numbers over the fallbacks', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ prompt_progress: { processed: 100, total: 100 } }))
    s.write(sseLine({ choices: [{ delta: { content: 'done' } }] }))
    s.write(sseLine({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 512, completion_tokens: 9 },
      timings: { prompt_n: 512, prompt_ms: 100, prompt_per_second: 5120, predicted_n: 9, predicted_ms: 90, predicted_per_second: 100 },
    }))
    s.write('data: [DONE]\n\n')
    s.close()
  })
  try {
    const seeded = seed(h.store)
    const ac = new AbortController()
    await runGeneration(h.d, () => {}, ctxFor(seeded, ac) as never)
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'done')
    assert.equal(row.stats.aborted, false)
    assert.equal(row.stats.promptTokens, 512)
    assert.equal(row.stats.genTokens, 9)
    assert.equal(row.stats.ctxUsed, 521)
  } finally {
    f.restore()
    h.cleanup()
  }
})

// ── 5. Engine errors inside a 200 stream, and in a non-OK body ────────────────

test('an in-stream {"error": …} chunk ends the turn with the engine\'s message and keeps the text so far', async () => {
  const h = mkHarness()
  const f = fakeUpstream(async (c) => {
    const s = c as Scripted
    s.write(sseLine({ choices: [{ delta: { content: 'Partial' } }] }))
    await tick()
    s.write('event: response.error\n' + sseLine({ error: `RuntimeError: GPU lost while reading ${h.d.store.dir()}/models/x.litertlm` }))
  })
  const events: Array<{ event: string; data: unknown }> = []
  try {
    const seeded = seed(h.store)
    await runGeneration(h.d, (ev) => { events.push(ev) }, ctxFor(seeded, new AbortController()) as never)
    const err = events.find((e) => e.event === 'error')?.data as { code: string; message: string } | undefined
    assert.equal(err?.code, 'engine_error')
    assert.match(err!.message, /GPU lost/)
    assert.ok(!err!.message.includes(h.d.store.dir()), 'the data dir is redacted from what clients see')
    assert.equal(h.store.getMessage(seeded.assistantMsg.id)!.content, 'Partial')
  } finally {
    f.restore()
    h.cleanup()
  }
})

test('a non-OK engine response reports the reason from its body, not just the status', async () => {
  const h = mkHarness()
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: 'error', message: 'context length exceeded' }), { status: 400 })) as unknown as typeof fetch
  const events: Array<{ event: string; data: unknown }> = []
  try {
    const seeded = seed(h.store)
    await runGeneration(h.d, (ev) => { events.push(ev) }, ctxFor(seeded, new AbortController()) as never)
    const err = events.find((e) => e.event === 'error')?.data as { message: string } | undefined
    assert.equal(err?.message, 'Engine returned 400: context length exceeded')
  } finally {
    globalThis.fetch = original
    h.cleanup()
  }
})

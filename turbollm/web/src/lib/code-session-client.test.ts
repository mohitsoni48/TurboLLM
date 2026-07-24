import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { CodeSessionClient, reduceLive, type CodeSessionClientHandlers, type CodeStreamFn, type LiveState } from './code-session-client'
import type { CodeStreamEvent } from './code-types'
import type { LiveToolCall } from './chat-types'

function makeHandlers() {
  const liveStates: (LiveState | null)[] = []
  const handlers: CodeSessionClientHandlers = {
    onLive: vi.fn((s) => { liveStates.push(s) }),
    onQueue: vi.fn(),
    onTurnStart: vi.fn(),
    onTurnDone: vi.fn(),
    onTurnError: vi.fn(),
    onIdle: vi.fn(),
    onLostConnection: vi.fn(),
  }
  return { handlers, liveStates }
}

/** A stream that yields the given frames (each with its `seq`) then completes. */
function streamOf(frames: CodeStreamEvent[]): CodeStreamFn {
  return async function* () {
    for (const f of frames) yield f
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('reduceLive', () => {
  it('creates a base block anchored to the fallback id when none exists', () => {
    const out = reduceLive(null, 'a1', (b) => ({ ...b, content: b.content + 'hi' }))
    expect(out).toEqual({ assistantId: 'a1', content: 'hi', reasoning: '', timeline: [] })
  })

  it('applies fn to the existing block, keeping its id', () => {
    const base: LiveState = { assistantId: 'a1', content: 'x', reasoning: '', timeline: [] }
    const out = reduceLive(base, 'ignored', (b) => ({ ...b, content: b.content + 'y' }))
    expect(out.assistantId).toBe('a1')
    expect(out.content).toBe('xy')
  })
})

describe('CodeSessionClient', () => {
  afterEach(() => { vi.useRealTimers() })

  it('reduces meta/reasoning/delta/tool_call into an interleaved live timeline', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'reasoning', data: { delta: 'thinking' }, seq: 1 },
      { event: 'delta', data: { delta: 'Hello ' }, seq: 2 },
      { event: 'tool_call', data: { id: 't1', name: 'read', args: { path: 'x' }, status: 'pending' }, seq: 3 },
      { event: 'delta', data: { delta: 'world' }, seq: 4 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()

    expect(handlers.onTurnStart).toHaveBeenCalledTimes(1)
    // The stream completing emits a trailing null (idle) — assert on the last real turn state.
    const final = liveStates.filter((s): s is LiveState => s !== null).at(-1)!
    expect(final.assistantId).toBe('a1')
    expect(final.reasoning).toBe('thinking')
    expect(final.content).toBe('Hello world')
    // Interleaving: text "Hello " → tool t1 → text "world" (two separate text blocks, not merged).
    expect(final.timeline).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'tool', call: { id: 't1', name: 'read', args: { path: 'x' }, status: 'pending', result: undefined, diff: undefined, patch: undefined, firstChangedLine: undefined } },
      { kind: 'text', text: 'world' },
    ])
  })

  it('preserves the live block when meta repeats the same assistant id (reconnect replay)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'delta', data: { delta: 'partial' }, seq: 1 },
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    // The second meta must NOT wipe the accumulated 'partial' content.
    const afterSecondMeta = liveStates.filter((s): s is LiveState => s !== null).at(-1)!
    expect(afterSecondMeta.content).toBe('partial')
  })

  it('forwards queue frames without touching live state', async () => {
    const { handlers } = makeHandlers()
    const queued = [{ userMsgId: 'q1', task: 'later', kind: 'followUp' as const }]
    const stream = streamOf([{ event: 'queue', data: { queued }, seq: 0 }] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(handlers.onQueue).toHaveBeenCalledWith(queued)
  })

  it('clears live and fires onTurnDone on a done frame, then onIdle when the stream completes', async () => {
    const { handlers } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'done', data: { contextUsed: 1, contextMax: 2, aborted: false }, seq: 1 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(handlers.onTurnDone).toHaveBeenCalledTimes(1)
    expect(handlers.onIdle).toHaveBeenCalledTimes(1)
    expect(handlers.onLive).toHaveBeenLastCalledWith(null)
  })

  it('surfaces an error frame via onTurnError', async () => {
    const { handlers } = makeHandlers()
    const stream = streamOf([
      { event: 'error', data: { code: 'boom', message: 'it broke' }, seq: 0 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(handlers.onTurnError).toHaveBeenCalledWith('it broke')
  })

  it('is idle after the stream completes and connect() is a no-op while active', async () => {
    const { handlers } = makeHandlers()
    let calls = 0
    const stream: CodeStreamFn = async function* () { calls++; yield { event: 'queue', data: { queued: [] }, seq: 0 } as CodeStreamEvent }
    const client = new CodeSessionClient('s1', handlers, stream)
    client.connect()
    client.connect() // guarded: must not open a second stream
    await flush()
    expect(calls).toBe(1)
    expect(client.isActive).toBe(false) // stream completed → idle
  })

  it('reconnects from the last consumed seq on a mid-run drop', async () => {
    vi.useFakeTimers()
    const { handlers } = makeHandlers()
    const seenFromSeq: number[] = []
    let attempt = 0
    const stream: CodeStreamFn = async function* (_sid, fromSeq) {
      seenFromSeq.push(fromSeq)
      if (attempt++ === 0) {
        yield { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 } as CodeStreamEvent
        yield { event: 'delta', data: { delta: 'x' }, seq: 5 } as CodeStreamEvent
        throw new Error('network drop')
      }
      yield { event: 'done', data: { contextUsed: 1, contextMax: 2, aborted: false }, seq: 6 } as CodeStreamEvent
    }
    new CodeSessionClient('s1', handlers, stream).connect()
    await vi.advanceTimersByTimeAsync(3000)
    // First connect from 0; reconnect resumes from lastSeq = 5 + 1 = 6.
    expect(seenFromSeq).toEqual([0, 6])
    expect(handlers.onTurnDone).toHaveBeenCalledTimes(1)
  })

  it('reports a silent lost-connection for a 404 (run is gone)', async () => {
    vi.useFakeTimers()
    const { handlers } = makeHandlers()
    const stream: CodeStreamFn = async function* () {
      throw new ApiError('not_found', 'gone', 404)
    }
    new CodeSessionClient('s1', handlers, stream).connect()
    await vi.advanceTimersByTimeAsync(30_000) // drain all reconnect backoffs
    expect(handlers.onLostConnection).toHaveBeenCalledWith(true)
  })

  it('abort() detaches and marks the client idle', async () => {
    const { handlers } = makeHandlers()
    // A stream that never completes on its own, so only abort() ends it.
    const stream: CodeStreamFn = async function* (_sid, _seq, signal) {
      yield { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 } as CodeStreamEvent
      await new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
    }
    const client = new CodeSessionClient('s1', handlers, stream)
    client.connect()
    await flush()
    expect(client.isActive).toBe(true)
    client.abort()
    await flush()
    expect(client.isActive).toBe(false)
    // Aborting must NOT trigger a lost-connection toast.
    expect(handlers.onLostConnection).not.toHaveBeenCalled()
  })
})

describe('CodeSessionClient — Phase 2 events (turn / retry / tool_progress)', () => {
  const lastLive = (states: (LiveState | null)[]) => states.filter((s): s is LiveState => s !== null).at(-1)

  it('folds a tool_progress snapshot into the matching tool block by id, REPLACING (cumulative)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'tool_call', data: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'pending' }, seq: 1 },
      { event: 'tool_progress', data: { id: 't1', name: 'bash', partial: 'line1\n' }, seq: 2 },
      { event: 'tool_progress', data: { id: 't1', name: 'bash', partial: 'line1\nline2\n' }, seq: 3 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const final = lastLive(liveStates)!
    const toolBlock = final.timeline.find((b) => b.kind === 'tool')
    expect(toolBlock).toBeDefined()
    // Cumulative: the second snapshot REPLACES the first (not appended), and name/args are preserved.
    expect(toolBlock).toMatchObject({ kind: 'tool', call: { id: 't1', name: 'bash', partial: 'line1\nline2\n' } })
    expect((toolBlock as { call: { args: unknown } }).call.args).toEqual({ command: 'ls' })
  })

  it('ignores a tool_progress snapshot for a tool block that is not in the timeline', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'tool_progress', data: { id: 'ghost', name: 'bash', partial: 'x' }, seq: 1 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const final = lastLive(liveStates)!
    // No synthesized nameless card — timeline stays empty.
    expect(final.timeline).toEqual([])
  })

  it('inserts a turn divider before rounds AFTER the first (index > 0), never for index 0', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'turn', data: { phase: 'start', index: 0 }, seq: 1 }, // first round — no divider
      { event: 'delta', data: { delta: 'round zero' }, seq: 2 },
      { event: 'turn', data: { phase: 'start', index: 1 }, seq: 3 }, // second round — divider
      { event: 'delta', data: { delta: 'round one' }, seq: 4 },
      { event: 'turn', data: { phase: 'end', index: 1, toolResults: 0 }, seq: 5 }, // end carries no visual
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const final = lastLive(liveStates)!
    expect(final.timeline).toEqual([
      { kind: 'text', text: 'round zero' },
      { kind: 'turn', index: 1 },
      { kind: 'text', text: 'round one' },
    ])
  })

  it('sets retry state on a retry start and clears it on the matching end', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'retry', data: { phase: 'start', attempt: 2, maxAttempts: 5, delayMs: 1500, message: 'rate limited' }, seq: 1 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.retry).toEqual({ attempt: 2, maxAttempts: 5, message: 'rate limited' })

    const { handlers: h2, liveStates: s2 } = makeHandlers()
    const stream2 = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'retry', data: { phase: 'start', attempt: 2, maxAttempts: 5, delayMs: 1500, message: 'rate limited' }, seq: 1 },
      { event: 'retry', data: { phase: 'end', attempt: 2, success: true }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', h2, stream2).connect()
    await flush()
    expect(lastLive(s2)!.retry).toBeNull()
  })

  it('updates the banner across back-to-back auto-retries (3 starts in a row), never stacking', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'retry', data: { phase: 'start', attempt: 1, maxAttempts: 5, delayMs: 500, message: 'overloaded' }, seq: 1 },
      { event: 'retry', data: { phase: 'start', attempt: 2, maxAttempts: 5, delayMs: 1000, message: 'overloaded' }, seq: 2 },
      { event: 'retry', data: { phase: 'start', attempt: 3, maxAttempts: 5, delayMs: 2000, message: 'still overloaded' }, seq: 3 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    // retry is a single object, always the LATEST attempt — there's no array to stack duplicates in.
    expect(lastLive(liveStates)!.retry).toEqual({ attempt: 3, maxAttempts: 5, message: 'still overloaded' })
  })

  it('clears the banner when a retry ultimately FAILS (end with success:false), not just on success', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'retry', data: { phase: 'start', attempt: 5, maxAttempts: 5, delayMs: 2000, message: 'overloaded' }, seq: 1 },
      { event: 'retry', data: { phase: 'end', attempt: 5, success: false, finalError: 'gave up' }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    // Any end frame clears the banner — a failed retry then surfaces as the turn's error frame, not
    // a stuck "Retrying…" left hanging.
    expect(lastLive(liveStates)!.retry).toBeNull()
  })

  it('lets retry state and an in-flight tool call coexist — neither clobbers the other', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'tool_call', data: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'pending' }, seq: 1 },
      { event: 'retry', data: { phase: 'start', attempt: 2, maxAttempts: 5, delayMs: 500, message: 'blip' }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const final = lastLive(liveStates)!
    expect(final.retry).toEqual({ attempt: 2, maxAttempts: 5, message: 'blip' })
    expect(final.timeline.find((b) => b.kind === 'tool')).toBeDefined() // the tool block survives the retry update
  })

  it('inserts a divider for every round after the first, across 3+ rounds (each with its own index)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'turn', data: { phase: 'start', index: 0 }, seq: 1 },
      { event: 'delta', data: { delta: 'r0' }, seq: 2 },
      { event: 'turn', data: { phase: 'start', index: 1 }, seq: 3 },
      { event: 'delta', data: { delta: 'r1' }, seq: 4 },
      { event: 'turn', data: { phase: 'start', index: 2 }, seq: 5 },
      { event: 'delta', data: { delta: 'r2' }, seq: 6 },
      { event: 'turn', data: { phase: 'start', index: 3 }, seq: 7 },
      { event: 'delta', data: { delta: 'r3' }, seq: 8 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const markers = lastLive(liveStates)!.timeline.filter((b) => b.kind === 'turn')
    // One divider per round after the first (indices 1,2,3) — round 0 opens the turn with no divider.
    expect(markers).toEqual([{ kind: 'turn', index: 1 }, { kind: 'turn', index: 2 }, { kind: 'turn', index: 3 }])
  })

  it('preserves a tool call\'s streamed partial output when it then ERRORS mid-stream (nothing dropped)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'tool_call', data: { id: 't1', name: 'bash', args: { command: 'sleep 1' }, status: 'pending' }, seq: 1 },
      { event: 'tool_progress', data: { id: 't1', name: 'bash', partial: 'partial line before the failure\n' }, seq: 2 },
      { event: 'tool_call', data: { id: 't1', name: 'bash', args: { command: 'sleep 1' }, status: 'error', result: 'killed' }, seq: 3 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const toolBlock = lastLive(liveStates)!.timeline.find((b) => b.kind === 'tool') as { call: LiveToolCall }
    expect(toolBlock.call.status).toBe('error')
    expect(toolBlock.call.result).toBe('killed')
    // The partial captured before the error survives the error upsert (the merge keeps prior fields
    // the terminal frame doesn't carry) — the pre-failure output is never silently dropped.
    expect(toolBlock.call.partial).toBe('partial line before the failure\n')
  })

  it('a late, out-of-order tool_progress for an ALREADY-completed tool does not corrupt its terminal state', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'tool_call', data: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'pending' }, seq: 1 },
      { event: 'tool_call', data: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'done', result: 'final output' }, seq: 2 },
      { event: 'tool_progress', data: { id: 't1', name: 'bash', partial: 'a late snapshot arriving after done' }, seq: 3 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const toolBlock = lastLive(liveStates)!.timeline.find((b) => b.kind === 'tool') as { call: LiveToolCall }
    // The late progress can't revert status or drop the result — the terminal state stands (and the
    // transcript already supersedes any partial with the result once a tool is done).
    expect(toolBlock.call.status).toBe('done')
    expect(toolBlock.call.result).toBe('final output')
  })
})

describe('CodeSessionClient — todos (ADR-255)', () => {
  const lastLive = (states: (LiveState | null)[]) => states.filter((s): s is LiveState => s !== null).at(-1)

  it('reduces a todos frame into LiveState.todos, with mixed statuses preserved as-is', async () => {
    const { handlers, liveStates } = makeHandlers()
    const todos = [
      { content: 'Read the file', status: 'completed' as const },
      { content: 'Fix the bug', status: 'in_progress' as const },
      { content: 'Add a test', status: 'pending' as const },
    ]
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'todos', data: { todos }, seq: 1 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.todos).toEqual(todos)
  })

  it('is undefined until the first todos frame arrives (nothing to render yet)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'delta', data: { delta: 'working on it' }, seq: 1 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.todos).toBeUndefined()
  })

  it('a later todos frame REPLACES the list wholesale, not a merge', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'todos', data: { todos: [{ content: 'Step 1', status: 'in_progress' }, { content: 'Step 2', status: 'pending' }] }, seq: 1 },
      { event: 'todos', data: { todos: [{ content: 'Step 1', status: 'completed' }, { content: 'Step 2', status: 'in_progress' }] }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.todos).toEqual([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress' },
    ])
  })

  it('an explicit empty-array todos frame is a real (not undefined) empty list', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'todos', data: { todos: [{ content: 'Step 1', status: 'pending' }] }, seq: 1 },
      { event: 'todos', data: { todos: [] }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.todos).toEqual([])
  })

  it('resets to undefined on a genuinely NEW turn (new assistantId) — mirrors the backend clearing its own todos per turn', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'todos', data: { todos: [{ content: 'Old plan step', status: 'completed' }] }, seq: 1 },
      { event: 'done', data: { contextUsed: 1, contextMax: 2, aborted: false }, seq: 2 },
      { event: 'meta', data: { userMessageId: 'u2', assistantMessageId: 'a2' }, seq: 3 }, // NEW turn
      { event: 'delta', data: { delta: 'new turn, no plan yet' }, seq: 4 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.todos).toBeUndefined()
  })

  it('preserves todos across a reconnect replay (same assistantId meta repeats)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'todos', data: { todos: [{ content: 'Step 1', status: 'in_progress' }] }, seq: 1 },
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 2 }, // same turn, reconnect
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    expect(lastLive(liveStates)!.todos).toEqual([{ content: 'Step 1', status: 'in_progress' }])
  })
})

describe('CodeSessionClient — prefill (llama.cpp /slots progress)', () => {
  const lastLive = (states: (LiveState | null)[]) => states.filter((s): s is LiveState => s !== null).at(-1)

  it('reduces a prefill frame into LiveState.prefill, latest snapshot winning', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'prefill', data: { processed: 512, total: 2048, pct: 25 }, seq: 1 },
      { event: 'prefill', data: { processed: 1536, total: 2048, pct: 75 }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    // Deduped/latest-wins: the second frame replaces the first.
    expect(lastLive(liveStates)!.prefill).toEqual({ processed: 1536, total: 2048, pct: 75 })
  })

  it('clears prefill to null the instant the first content delta arrives', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'prefill', data: { processed: 2000, total: 2048, pct: 98 }, seq: 1 },
      { event: 'delta', data: { delta: 'Hello' }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const final = lastLive(liveStates)!
    expect(final.prefill).toBeNull()
    expect(final.content).toBe('Hello')
  })

  it('clears prefill to null when the first token is a reasoning delta (thinking model)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'prefill', data: { processed: 1000, total: 1000, pct: 100 }, seq: 1 },
      { event: 'reasoning', data: { delta: 'let me think' }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    const final = lastLive(liveStates)!
    expect(final.prefill).toBeNull()
    expect(final.reasoning).toBe('let me think')
  })

  it('clears prefill on turn end (done discards the whole live state → next turn has no stale bar)', async () => {
    const { handlers } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'prefill', data: { processed: 500, total: 1000, pct: 50 }, seq: 1 },
      { event: 'done', data: { contextUsed: 1, contextMax: 2, aborted: false }, seq: 2 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    // The turn ended: live is null, so there's no prefill left to render.
    expect(handlers.onLive).toHaveBeenLastCalledWith(null)
  })

  it('is undefined when no prefill frame ever arrives (non-llama.cpp / sub-poll prompt — the normal path)', async () => {
    const { handlers, liveStates } = makeHandlers()
    const stream = streamOf([
      { event: 'meta', data: { userMessageId: 'u1', assistantMessageId: 'a1' }, seq: 0 },
      { event: 'delta', data: { delta: 'straight to generation' }, seq: 1 },
    ] as CodeStreamEvent[])
    new CodeSessionClient('s1', handlers, stream).connect()
    await flush()
    // Falsy (never-set undefined, or nulled by the delta clear) — either way no bar renders.
    expect(lastLive(liveStates)!.prefill).toBeFalsy()
  })
})

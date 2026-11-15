// The llama.cpp realtime adapter: the pure collector on events a real engine sent (src/engines/fixtures/llamacpp-realtime,
// captured against LFM3-Audio-2B on llama.cpp b1-de32b26), and the transport against a local WebSocket server that
// replays them. No engine and no network beyond the loopback socket.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFakeRealtimeEngine, loadRealtimeFixture, type FakeRealtimeEngine } from '../../test-support/fake-realtime-engine'
import { AudioReplyError, type AudioReplyRequest } from './types'
import { createRealtimeCollector, requestRealtimeAudioReply, type RealtimeSocket } from './llamacpp-realtime'
import { decodeWavToPcm16Mono } from './wav'

function collect(name: Parameters<typeof loadRealtimeFixture>[0]) {
  const c = createRealtimeCollector()
  for (const e of loadRealtimeFixture(name)) c.push(e)
  return c
}

// ── collector ───────────────────────────────────────────────────────────────────────────

test('a spoken answer: the text, a WAV at the rate session.created announced, the token count', () => {
  const c = collect('realtime-text-audio')
  assert.equal(c.done, true)
  const reply = c.result()
  assert.equal(reply.text, 'The capital of France is Paris.')
  assert.equal(reply.status, 'completed')
  assert.equal(reply.outputTokens, 42)
  assert.ok(reply.audio)
  assert.equal(reply.audio.format, 'wav')
  assert.equal(reply.audio.sampleRate, 24000)
  const wav = decodeWavToPcm16Mono(reply.audio.data)
  assert.equal(wav.sampleRate, 24000)
  assert.equal(wav.pcm16.length, 3360, 'every kept delta, decoded and joined')
})

test('audio without text (the missing-text case): empty text, the clip stands', () => {
  const reply = collect('realtime-audio-only').result()
  assert.equal(reply.text, '')
  assert.equal(reply.audio?.data.length, 44 + 2400)
})

test('text without audio (the missing-audio case): the text has its <think> block stripped, and there is no clip', () => {
  const reply = collect('realtime-text-only').result()
  assert.equal(reply.audio, null)
  assert.equal(reply.text, 'The capital of France is Paris.')
  assert.equal(reply.status, 'completed')
})

test('a cancelled reply keeps what arrived and says so', () => {
  const reply = collect('realtime-cancelled').result()
  assert.equal(reply.status, 'cancelled')
  assert.equal(reply.text, 'The capital of France is Paris')
  assert.ok(reply.audio && reply.audio.data.length > 44)
})

test('an error event is an AudioReplyError carrying the engine\'s message; an invalid request keeps that code', () => {
  const c = collect('realtime-error-unknown-voice')
  assert.ok(c.error instanceof AudioReplyError)
  assert.equal(c.error.code, 'invalid_request')
  assert.match(c.error.message, /unknown voice "robot"/)
  assert.throws(() => c.result(), (e: unknown) => e instanceof AudioReplyError && e.code === 'invalid_request')
  const other = createRealtimeCollector()
  other.push({ type: 'error', error: { type: 'server_error', message: 'boom' } })
  assert.equal(other.error?.code, 'engine_error')
})

test('unknown and malformed events are ignored; a half sample at the end is dropped; whitespace-only text is empty', () => {
  const c = createRealtimeCollector()
  for (const junk of [null, 7, 'x', {}, { type: 42 }, { type: 'rate_limits.updated' }, { type: 'response.output_text.delta', delta: 5 }]) c.push(junk)
  c.push({ type: 'response.output_text.delta', delta: ' \n ' })
  c.push({ type: 'response.output_audio.delta', delta: Buffer.from([1, 0, 2]).toString('base64') })
  const reply = c.result()
  assert.equal(reply.text, '')
  assert.equal(reply.audio?.data.length, 44 + 2)
})

test('zero bytes of audio is no clip; an unclosed <think> block is all reasoning; the rate falls back to 24 kHz', () => {
  const c = createRealtimeCollector()
  c.push({ type: 'response.output_text.delta', delta: '<think>still thinking' })
  c.push({ type: 'response.output_audio.delta', delta: '' })
  const reply = c.result('cancelled')
  assert.equal(reply.audio, null)
  assert.equal(reply.text, '')
  assert.equal(reply.status, 'cancelled', 'a stop before response.done forces the status')
  const spoken = createRealtimeCollector()
  spoken.push({ type: 'response.output_audio.delta', delta: Buffer.from([1, 0]).toString('base64') })
  assert.equal(spoken.result().audio?.sampleRate, 24000)
})

// ── transport ───────────────────────────────────────────────────────────────────────────

const noAbort = () => new AbortController().signal
const pcm = (ms: number, rate = 16000) => Buffer.alloc(Math.floor((rate * ms) / 1000) * 2, 1)
const spoken = (over: Partial<AudioReplyRequest> = {}): AudioReplyRequest => ({
  instructions: 'Be brief.',
  input: { kind: 'audio', pcm16: pcm(250), sampleRate: 16000 },
  maxOutputTokens: 512,
  ...over,
})

async function withEngine(t: { after: (fn: () => unknown) => void }, opts?: Parameters<typeof startFakeRealtimeEngine>[0]): Promise<FakeRealtimeEngine> {
  const engine = await startFakeRealtimeEngine(opts)
  t.after(() => engine.stop())
  return engine
}

const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a spoken question: session.update first, the clip in about 100 ms chunks, commit, response.create, then the reply', async (t) => {
  const engine = await withEngine(t)
  const reply = await requestRealtimeAudioReply(engine.baseUrl, spoken({ voice: 'female' }), noAbort())
  assert.equal(reply.text, 'The capital of France is Paris.')
  assert.equal(reply.audio?.sampleRate, 24000)

  const [update, ...rest] = engine.received
  assert.equal(update.type, 'session.update')
  assert.deepEqual(update.session.output_modalities, ['text', 'audio'], 'never ["audio"] alone: it loses the transcript')
  assert.equal(update.session.instructions, 'Be brief.')
  assert.equal(update.session.max_output_tokens, 512)
  assert.equal(update.session.audio.input.format.rate, 16000)
  assert.equal(update.session.audio.output.voice, 'female')
  assert.deepEqual(rest.map((m) => m.type), ['input_audio_buffer.append', 'input_audio_buffer.append', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create'])
  const sent = rest.filter((m) => m.type === 'input_audio_buffer.append').map((m) => Buffer.from(m.audio, 'base64').length)
  assert.deepEqual(sent, [3200, 3200, 1600], '100 ms of 16 kHz PCM16 is 3200 bytes; the last chunk is the rest')
})

test('the session is closed as soon as the reply is done: it holds an engine slot until it is', async (t) => {
  const engine = await withEngine(t)
  await requestRealtimeAudioReply(engine.baseUrl, spoken(), noAbort())
  await until(() => engine.closed() === 1, 'the server to see the close')
  assert.equal(engine.opened(), 1)
})

test('a typed question goes as one input_text item, and no voice or input rate is sent unasked', async (t) => {
  const engine = await withEngine(t)
  await requestRealtimeAudioReply(engine.baseUrl, spoken({ input: { kind: 'text', text: 'What is the capital of France?' } }), noAbort())
  assert.deepEqual(engine.received.map((m) => m.type), ['session.update', 'conversation.item.create', 'response.create'])
  assert.deepEqual(engine.received[0].session.audio, {})
  assert.deepEqual(engine.received[1].item, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the capital of France?' }] })
})

test('an engine\'s refusal of the voice rejects with its own message, and the session is closed', async (t) => {
  const engine = await withEngine(t, { rejectVoice: 'robot' })
  await assert.rejects(
    requestRealtimeAudioReply(engine.baseUrl, spoken({ voice: 'robot' }), noAbort()),
    (e: unknown) => e instanceof AudioReplyError && e.code === 'invalid_request' && /unknown voice "robot"/.test(e.message),
  )
  await until(() => engine.closed() === 1, 'the close')
})

test('stopping sends response.cancel and resolves with what arrived as a cancelled reply', async (t) => {
  const engine = await withEngine(t, { mode: 'cancellable' })
  const ac = new AbortController()
  const pending = requestRealtimeAudioReply(engine.baseUrl, spoken(), ac.signal)
  await until(() => engine.received.some((m) => m.type === 'response.create'), 'the request')
  // Give the first audio delta time to arrive, as a stop pressed once the reply is speaking would.
  await new Promise((r) => setTimeout(r, 100))
  ac.abort()
  const reply = await pending
  assert.equal(reply.status, 'cancelled')
  assert.equal(reply.text, 'The capital of France is Paris')
  assert.ok(reply.audio)
  assert.equal(engine.received.at(-1)?.type, 'response.cancel')
  await until(() => engine.closed() === 1, 'the close')
})

test('a stop during prefill, which the engine drops, is sent again until the reply is done, and the session stays open until then', async (t) => {
  const engine = await withEngine(t, { mode: 'prefill', prefillMs: 400 })
  const ac = new AbortController()
  const pending = requestRealtimeAudioReply(engine.baseUrl, spoken(), ac.signal, { cancelResendMs: 50 })
  await until(() => engine.received.some((m) => m.type === 'response.create'), 'the request')
  ac.abort()
  const reply = await pending
  assert.equal(reply.status, 'cancelled')
  assert.ok(reply.audio, 'what arrived once the reply got under way is kept')
  assert.ok(engine.received.filter((m) => m.type === 'response.cancel').length >= 2, 'the first cancel was dropped, a later one was not')
  assert.ok(engine.sent.includes('response.done'), 'the engine was still connected when it ended the reply')
  assert.equal(engine.closed(), 0, 'nothing closed the session before the reply was done')
  await until(() => engine.closed() === 1, 'the close')
})

test('a stop that lands while an engine error arrives keeps waiting for response.done', async () => {
  const events = loadRealtimeFixture('realtime-text-audio')
  const ac = new AbortController()
  const pending = requestRealtimeAudioReply('http://127.0.0.1:1', spoken(), ac.signal, { WebSocket: FakeSocket, cancelResendMs: 1000 })
  const ws = FakeSocket.last
  ws.emit('message', JSON.stringify(events[0]))
  ws.emit('message', JSON.stringify(events[1]))
  ac.abort()
  ws.emit('message', JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'busy' } }))
  assert.deepEqual(ws.calls, [], 'an error does not close the session while the reply may still be running')
  ws.emit('message', JSON.stringify(events.at(-1)))
  assert.equal((await pending).status, 'completed')
  assert.deepEqual(ws.calls, ['close'])
})

test('a stop the engine never acknowledges settles at the ceiling, still cancelled, and closes the session', async (t) => {
  const engine = await withEngine(t, { mode: 'silent' })
  const ac = new AbortController()
  const pending = requestRealtimeAudioReply(engine.baseUrl, spoken(), ac.signal, { cancelWaitMs: 60 })
  await until(() => engine.received.some((m) => m.type === 'response.create'), 'the request')
  const t0 = Date.now()
  ac.abort()
  const reply = await pending
  assert.equal(reply.status, 'cancelled')
  assert.equal(reply.audio, null)
  assert.ok(Date.now() - t0 >= 50, 'it waited for the engine before giving up')
  assert.ok(engine.received.some((m) => m.type === 'response.cancel'))
  await until(() => engine.closed() === 1, 'the close')
})

test('a signal that is already aborted never connects', async (t) => {
  const engine = await withEngine(t)
  const reply = await requestRealtimeAudioReply(engine.baseUrl, spoken(), AbortSignal.abort())
  assert.deepEqual(reply, { text: '', audio: null, status: 'cancelled' })
  assert.equal(engine.opened(), 0)
})

test('the overall timeout cancels the same way and rejects with timeout', async (t) => {
  const engine = await withEngine(t, { mode: 'silent' })
  await assert.rejects(
    requestRealtimeAudioReply(engine.baseUrl, spoken(), noAbort(), { timeoutMs: 80, cancelWaitMs: 40 }),
    (e: unknown) => e instanceof AudioReplyError && e.code === 'timeout',
  )
  assert.ok(engine.received.some((m) => m.type === 'response.cancel'))
  await until(() => engine.closed() === 1, 'the close')
})

test('the budget running out is a timeout even when the engine acknowledges the cancel', async (t) => {
  const engine = await withEngine(t, { mode: 'cancellable' })
  await assert.rejects(
    requestRealtimeAudioReply(engine.baseUrl, spoken(), noAbort(), { timeoutMs: 120, cancelWaitMs: 2000 }),
    (e: unknown) => e instanceof AudioReplyError && e.code === 'timeout',
  )
  assert.ok(engine.received.some((m) => m.type === 'response.cancel'))
  await until(() => engine.closed() === 1, 'the close')
})

test('an engine that accepts the connection and never starts a session is given up on after the handshake deadline', async () => {
  const pending = requestRealtimeAudioReply('http://127.0.0.1:1', spoken(), noAbort(), { WebSocket: FakeSocket, handshakeMs: 40, closeWaitMs: 20 })
  const ws = FakeSocket.last
  await assert.rejects(pending, (e: unknown) => e instanceof AudioReplyError && e.code === 'engine_unreachable')
  assert.equal(ws.calls[0], 'close')
})

test('an engine nobody listens on is engine_unreachable', async () => {
  const engine = await startFakeRealtimeEngine()
  const baseUrl = engine.baseUrl
  await engine.stop()
  await assert.rejects(
    requestRealtimeAudioReply(baseUrl, spoken(), noAbort()),
    (e: unknown) => e instanceof AudioReplyError && e.code === 'engine_unreachable',
  )
})

test('an engine that hangs up before the reply is done is an engine_error', async (t) => {
  const engine = await withEngine(t, { mode: 'silent' })
  const pending = requestRealtimeAudioReply(engine.baseUrl, spoken(), noAbort())
  await until(() => engine.received.some((m) => m.type === 'response.create'), 'the request')
  await engine.stop()
  await assert.rejects(pending, (e: unknown) => e instanceof AudioReplyError && e.code === 'engine_error')
})

// A socket that records what is done to it, to see the close and terminate steps a real engine's slow handshake makes
// unobservable.
class FakeSocket implements RealtimeSocket {
  static last: FakeSocket
  sent: any[] = []
  calls: string[] = []
  private handlers: Record<string, (...a: any[]) => void> = {}
  constructor(readonly url: string) {
    FakeSocket.last = this
  }
  on(event: string, fn: (...a: any[]) => void): void {
    this.handlers[event] = fn
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.calls.push('close')
  }
  terminate(): void {
    this.calls.push('terminate')
  }
  emit(event: string, ...args: any[]): void {
    this.handlers[event]?.(...args)
  }
}

test('a close the engine does not answer is followed by terminate; one it answers is not', async () => {
  const events = loadRealtimeFixture('realtime-text-audio')
  const run = async (answerClose: boolean) => {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
    const pending = requestRealtimeAudioReply('http://127.0.0.1:1', spoken(), noAbort(), {
      WebSocket: FakeSocket,
      setTimeout: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h },
      clearTimeout: (h) => { (h as { live: boolean }).live = false },
      closeWaitMs: 1000,
    })
    const ws = FakeSocket.last
    assert.equal(ws.url, 'ws://127.0.0.1:1/v1/realtime')
    for (const e of events) ws.emit('message', JSON.stringify(e))
    await pending
    assert.deepEqual(ws.calls, ['close'])
    if (answerClose) ws.emit('close')
    for (const tm of timers.filter((x) => x.live && x.ms === 1000)) tm.fn()
    return ws.calls
  }
  assert.deepEqual(await run(false), ['close', 'terminate'])
  assert.deepEqual(await run(true), ['close'])
})

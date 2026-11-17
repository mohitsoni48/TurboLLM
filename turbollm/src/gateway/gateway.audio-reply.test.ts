// POST /v1/chat/completions with `modalities` including "audio", through the real gateway handler, with a local
// WebSocket server standing in for llama-server's /v1/realtime (src/test-support/fake-realtime-engine.ts). The other half
// of the contract is proved too: a request that does not ask for audio is proxied exactly as it was, and a request that
// does is never proxied.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { asksForAudioOutput, audioChatCompletion, parseAudioChatRequest } from './audio-chat'
import type { Deps } from '../deps'
import { decodeWavToPcm16Mono, pcm16ToWav } from '../engines/audio-reply/wav'
import { startFakeRealtimeEngine, type FakeRealtimeOptions } from '../test-support/fake-realtime-engine'

const wavB64 = (rate = 16000, samples = 4800) => pcm16ToWav(Buffer.alloc(samples * 2, 3), rate).toString('base64')

interface Opts {
  audioOut?: boolean
  engine?: FakeRealtimeOptions
  engineKind?: string
  route?: Record<string, unknown>
  maxTokens?: number
  gate?: { acquire: () => Promise<() => void> }
}

async function harness(t: { after: (fn: () => unknown) => void }, opts: Opts = {}) {
  const engine = await startFakeRealtimeEngine(opts.engine)
  t.after(() => engine.stop())
  const usage: Array<Record<string, unknown>> = []
  const routed: string[] = []
  const completions: Array<Record<string, unknown>> = []
  const cfg = { modelDefaults: { maxTokens: opts.maxTokens ?? 0 }, gateway: { autoSwap: true } }
  const d = {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async (m: string) => { routed.push(m); return { target: engine.baseUrl, ...(opts.route ?? {}) } } },
    store: { snapshot: () => cfg, read: () => cfg },
    manager: {
      status: () => ({ state: 'running', model: { key: 'lfm3-audio', name: 'LFM3 Audio', ctx: 8192, audio: true, ...(opts.audioOut === false ? {} : { audioOut: true }) } }),
      target: () => engine.baseUrl,
      currentOpts: () => null,
      whenModalitiesKnown: async () => {},
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: (c: Record<string, unknown>) => completions.push(c),
    },
    registry: { active: () => ({ kind: opts.engineKind ?? 'llama-server' }) },
    ...(opts.gate ? { gate: opts.gate } : {}),
    db: { recordApiUsage: (u: Record<string, unknown>) => usage.push(u) },
  } as unknown as Deps
  const app = new Hono()
  registerGateway(app, d)
  const ask = (body: unknown) => app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { app, ask, engine, usage, completions, routed }
}

/** The proxied path: what the engine's HTTP endpoint is sent, and what comes back. */
function proxyStub(t: { after: (fn: () => unknown) => void }, reply = '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}') {
  const original = globalThis.fetch
  const sent: Array<{ url: string; body: string }> = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body) })
    return new Response(reply, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return { sent, reply }
}

const spokenAsk = (over: Record<string, unknown> = {}) => ({
  model: 'lfm3-audio',
  modalities: ['text', 'audio'],
  audio: { voice: 'female', format: 'wav' },
  messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wavB64(), format: 'wav' } }] }],
  ...over,
})
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; type: string; message: string } }).error

// ── asking for audio ────────────────────────────────────────────────────────────────────────────────

test('a request for audio on a model that speaks gets message.audio in OpenAI\'s shape, and is never proxied', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  const before = Math.floor(Date.now() / 1000)
  const res = await h.ask(spokenAsk())
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.match(body.id, /^chatcmpl-[0-9a-f]{32}$/)
  assert.equal(body.object, 'chat.completion')
  assert.ok(body.created >= before)
  assert.equal(body.model, 'lfm3-audio')
  assert.equal(body.choices.length, 1)
  const [choice] = body.choices
  assert.equal(choice.index, 0)
  assert.equal(choice.finish_reason, 'stop')
  assert.equal(choice.message.role, 'assistant')
  assert.equal(choice.message.content, null)
  assert.equal(choice.message.refusal, null)
  assert.match(choice.message.audio.id, /^audio_[0-9a-f]{32}$/)
  assert.equal(choice.message.audio.expires_at, body.created + 3600)
  assert.equal(choice.message.audio.transcript, 'The capital of France is Paris.')
  const wav = decodeWavToPcm16Mono(Buffer.from(choice.message.audio.data, 'base64'))
  assert.equal(wav.sampleRate, 24000)
  assert.equal(wav.pcm16.length, 3360)
  assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 42, total_tokens: 42 })

  assert.equal(proxied.sent.length, 0, 'an audio request is never forwarded to the engine')
  // The clip went to the engine as PCM, with the voice and a bounded reply.
  const update = h.engine.received.find((m) => m.type === 'session.update')!
  assert.equal(update.session.audio.output.voice, 'female')
  assert.equal(update.session.max_output_tokens, 1024)
  assert.equal(update.session.audio.input.format.rate, 16000)
  assert.ok(h.engine.received.some((m) => m.type === 'input_audio_buffer.commit'))
  // The request is counted like any other chat request.
  assert.deepEqual(h.completions, [{ inputTokens: 0, outputTokens: 42, promptTps: undefined, genTps: undefined }])
  assert.equal(h.usage.length, 1)
  assert.equal(h.usage[0].genTokens, 42)
})

test('format "pcm16" returns the raw samples with no header', async (t) => {
  const h = await harness(t)
  const body = await (await h.ask(spokenAsk({ audio: { voice: 'female', format: 'pcm16' } }))).json() as any
  assert.equal(Buffer.from(body.choices[0].message.audio.data, 'base64').length, 3360)
})

test('system and developer messages and the earlier turns become the text instructions; earlier audio is named, never sent', async (t) => {
  const h = await harness(t)
  const res = await h.ask(spokenAsk({
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: [{ type: 'text', text: 'Speak plainly.' }] },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wavB64(), format: 'wav' } }] },
      { role: 'assistant', content: null, audio: { id: 'audio_abc123' } },
      { role: 'user', content: 'And Germany?' },
      { role: 'assistant', content: 'Berlin.' },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wavB64(), format: 'wav' } }, { type: 'text', text: 'in French' }] },
    ],
  }))
  assert.equal(res.status, 200)
  const update = h.engine.received.find((m) => m.type === 'session.update')!
  assert.equal(update.session.instructions, [
    'Be brief.\n\nSpeak plainly.',
    'Earlier conversation (text transcript):\nUser: [Voice message]\nAssistant: [Spoken reply]\nUser: And Germany?\nAssistant: Berlin.',
    'The user also wrote, with this message: in French',
  ].join('\n\n'))
  assert.equal(h.engine.received.filter((m) => m.type === 'input_audio_buffer.commit').length, 1, 'only the last turn\'s clip is the input')
})

test('a typed last turn is the input text; max_completion_tokens beats max_tokens, and the text token limit setting does not apply to speech', async (t) => {
  const h = await harness(t, { maxTokens: 300 })
  await h.ask(spokenAsk({ messages: [{ role: 'user', content: 'What is the capital of France?' }], max_completion_tokens: 200, max_tokens: 100 }))
  assert.equal(h.engine.received.find((m) => m.type === 'session.update')!.session.max_output_tokens, 200)
  assert.deepEqual(h.engine.received.find((m) => m.type === 'conversation.item.create')!.item.content, [{ type: 'input_text', text: 'What is the capital of France?' }])
  // Asked for nothing, the cap is the speech default whatever the text setting says (300 here would be about 24 s).
  await h.ask(spokenAsk({ messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(h.engine.received.filter((m) => m.type === 'session.update')[1].session.max_output_tokens, 1024)
})

test('a reply that used its whole budget is finish_reason "length"', async (t) => {
  const h = await harness(t)
  const body = await (await h.ask(spokenAsk({ max_tokens: 42 }))).json() as any
  assert.equal(body.choices[0].finish_reason, 'length')
})

test('the engine refusing the voice is a 400 carrying the engine\'s own message', async (t) => {
  const h = await harness(t, { engine: { rejectVoice: 'alloy' } })
  const res = await h.ask(spokenAsk({ audio: { voice: 'alloy', format: 'wav' } }))
  assert.equal(res.status, 400)
  const e = await errorOf(res)
  assert.equal(e.type, 'invalid_request_error')
  assert.match(e.message, /unknown voice/)
})

test('an engine that answers without audio is a 502 audio_not_returned naming the transcript, never a text reply', async (t) => {
  const h = await harness(t, { engine: { fixture: 'realtime-text-only' } })
  const res = await h.ask(spokenAsk())
  assert.equal(res.status, 502)
  const e = await errorOf(res)
  assert.equal(e.code, 'audio_not_returned')
  assert.match(e.message, /transcript of 31 characters but no audio/)
})

test('an engine nobody listens on is reported as the engine\'s failure, not a text reply', async (t) => {
  const h = await harness(t)
  await h.engine.stop()
  const res = await h.ask(spokenAsk())
  assert.equal(res.status, 500)
  assert.equal((await errorOf(res)).code, 'engine_unreachable')
})

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────

async function refused(h: Awaited<ReturnType<typeof harness>>, proxied: ReturnType<typeof proxyStub>, body: unknown, status: number, code: string, pattern?: RegExp) {
  const res = await h.ask(body)
  assert.equal(res.status, status)
  const e = await errorOf(res)
  assert.equal(e.code, code)
  if (pattern) assert.match(e.message, pattern)
  assert.equal(proxied.sent.length, 0, 'never forwarded to an engine, whatever the answer')
  assert.equal(h.engine.opened(), 0, 'the realtime engine was not asked')
}

test('a model that does not answer aloud, a linked host and a pool slot all refuse with audio_output_unsupported', async (t) => {
  const cases: Opts[] = [
    { audioOut: false },
    { route: { remote: { linkId: 'l', baseUrl: 'https://rig.invalid', token: 't', modelKey: 'm' } } },
    { route: { manager: {} } },
    { engineKind: 'vllm' },
  ]
  for (const opts of cases) {
    const h = await harness(t, opts)
    const proxied = proxyStub(t)
    await refused(h, proxied, spokenAsk(), 409, 'audio_output_unsupported', /cannot answer with audio/)
  }
})

test('stream: true is refused with 400 audio_stream_unsupported', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  await refused(h, proxied, spokenAsk({ stream: true }), 400, 'audio_stream_unsupported', /stream: false/)
})

test('an MP3 input or an unsupported output format is refused with audio_format_unsupported', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  await refused(h, proxied, spokenAsk({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: Buffer.from('ID3\u0004frames').toString('base64'), format: 'mp3' } }] }] }), 400, 'audio_format_unsupported', /WAV/)
  await refused(h, proxied, spokenAsk({ audio: { voice: 'female', format: 'mp3' } }), 400, 'audio_format_unsupported', /wav|pcm16/)
  await refused(h, proxied, spokenAsk({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wavB64(16000), format: 'wav' } }, { type: 'input_audio', input_audio: { data: wavB64(44100), format: 'wav' } }] }] }), 400, 'audio_format_unsupported', /different sample rates/)
})

test('a request its own body makes unanswerable is refused before the router is asked for a model, so it swaps nothing in', async (t) => {
  const h = await harness(t, { audioOut: false })
  const proxied = proxyStub(t)
  const { audio: _audio, ...noAudio } = spokenAsk({ model: 'some-other-text-model' })
  await refused(h, proxied, spokenAsk({ model: 'some-other-text-model', stream: true }), 400, 'audio_stream_unsupported')
  await refused(h, proxied, noAudio, 400, 'invalid_request_error')
  await refused(h, proxied, spokenAsk({ audio: { format: 'mp3' } }), 400, 'audio_format_unsupported')
  assert.deepEqual(h.routed, [])
  // One that needs the model's answer is asked of the model the router chose.
  await refused(h, proxied, spokenAsk({ model: 'some-other-text-model' }), 409, 'audio_output_unsupported')
  assert.deepEqual(h.routed, ['some-other-text-model'])
})

test('an empty clip and an absurd sample rate are refused with audio_format_unsupported', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  const ask = (data: string) => spokenAsk({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'wav' } }] }] })
  await refused(h, proxied, ask(wavB64(16000, 0)), 400, 'audio_format_unsupported', /no audio/)
  await refused(h, proxied, ask(wavB64(1, 100)), 400, 'audio_format_unsupported', /sample rate/)
})

test('audio longer than the recorder allows is refused before the router is asked for a model', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  const ask = (...data: string[]) => spokenAsk({ messages: [{ role: 'user', content: data.map((d) => ({ type: 'input_audio', input_audio: { data: d, format: 'wav' } })) }] })
  await refused(h, proxied, ask(wavB64(16000, 301 * 16000)), 400, 'audio_format_unsupported', /at most 5 minutes/)
  await refused(h, proxied, ask(wavB64(16000, 120 * 16000), wavB64(16000, 120 * 16000), wavB64(16000, 120 * 16000)), 400, 'audio_format_unsupported', /at most 5 minutes/)
  assert.deepEqual(h.routed, [])
})

test('a request that cannot get the engine slot is described as every queued gateway request is', async (t) => {
  for (const [message, status, type, code] of [
    ['gate_acquire_aborted', 400, 'invalid_request_error', 'client_disconnected'],
    ['gate_acquire_timeout', 503, 'overloaded_error', 'engine_busy'],
  ] as const) {
    const h = await harness(t, { gate: { acquire: async () => { throw new Error(message) } } })
    const res = await h.ask(spokenAsk())
    assert.equal(res.status, status)
    const e = await errorOf(res)
    assert.equal(e.type, type)
    assert.equal(e.code, code)
    assert.equal(h.engine.opened(), 0)
  }
})

test('a request with no audio object, or malformed messages, is a 400 invalid_request_error', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  const { audio: _audio, ...noAudio } = spokenAsk()
  await refused(h, proxied, noAudio, 400, 'invalid_request_error', /audio/)
  await refused(h, proxied, spokenAsk({ messages: [] }), 400, 'invalid_request_error')
  await refused(h, proxied, spokenAsk({ messages: [{ role: 'assistant', content: 'hi' }] }), 400, 'invalid_request_error', /last message/)
  await refused(h, proxied, spokenAsk({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }), 400, 'invalid_request_error', /Images/)
})

// ── a request that does not ask for audio ───────────────────────────────────────────────────────────

test('a request that does not ask for audio is proxied exactly as before and its reply relayed untouched', async (t) => {
  const h = await harness(t)
  const proxied = proxyStub(t)
  const bodies: Record<string, unknown>[] = [
    { model: 'lfm3-audio', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'lfm3-audio', modalities: ['text'], messages: [{ role: 'user', content: 'hi' }] },
    { model: 'lfm3-audio', modalities: [], audio: { voice: 'x', format: 'wav' }, messages: [{ role: 'user', content: 'hi' }] },
    { model: 'lfm3-audio', modalities: 'audio', messages: [{ role: 'user', content: 'hi' }] },
  ]
  for (const body of bodies) {
    const res = await h.ask(body)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), proxied.reply, 'the engine\'s reply byte for byte')
    const forwarded = proxied.sent.at(-1)!
    assert.equal(forwarded.url, `${h.engine.baseUrl}/v1/chat/completions`)
    assert.equal(forwarded.body, JSON.stringify(body), 'the body the engine gets is the caller\'s, re-serialised as it always was')
  }
  assert.equal(proxied.sent.length, bodies.length)
  assert.equal(h.engine.opened(), 0)
})

test('a text-only model still proxies a plain request: nothing about audio output touches it', async (t) => {
  const h = await harness(t, { audioOut: false })
  const proxied = proxyStub(t)
  const res = await h.ask({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), proxied.reply)
  assert.equal(proxied.sent.length, 1)
})

// ── pure parts ──────────────────────────────────────────────────────────────────────────────────────

test('asksForAudioOutput is true only for a modalities array containing "audio"', () => {
  assert.equal(asksForAudioOutput({ modalities: ['text', 'audio'] }), true)
  assert.equal(asksForAudioOutput({ modalities: ['audio'] }), true)
  for (const modalities of [['text'], [], 'audio', null, undefined, { audio: true }, 1]) assert.equal(asksForAudioOutput({ modalities }), false, JSON.stringify(modalities))
  assert.equal(asksForAudioOutput({ audio: { voice: 'x', format: 'wav' } }), false)
})

test('parseAudioChatRequest bounds the transcript to half the context', () => {
  const messages: unknown[] = []
  for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'x'.repeat(200)}` })
  messages.push({ role: 'user', content: 'latest' })
  const parsed = parseAudioChatRequest({ audio: { format: 'wav' }, messages }, 1000)
  assert.ok('request' in parsed)
  assert.ok(parsed.request.instructions.includes('turn 19 ') && !parsed.request.instructions.includes('turn 0 '))
})

test('audioChatCompletion is OpenAI\'s shape', () => {
  const out = audioChatCompletion({ model: 'm', text: 'hi', audio: { data: pcm16ToWav(Buffer.alloc(4), 24000), sampleRate: 24000 }, format: 'wav', outputTokens: 3, maxOutputTokens: 10, now: 1000 }) as any
  assert.deepEqual(Object.keys(out), ['id', 'object', 'created', 'model', 'choices', 'usage'])
  assert.equal(out.choices[0].message.audio.expires_at, 4600)
  assert.deepEqual(Object.keys(out.choices[0].message.audio), ['id', 'data', 'expires_at', 'transcript'])
})


// A chat turn answered with speech, through the real routes over a real store, with a local WebSocket server standing in
// for llama-server's /v1/realtime (src/test-support/fake-realtime-engine.ts, replaying real captured events).
// The other half of the contract is proved here too: a send that does not ask for audio takes today's text path and
// never touches the realtime endpoint.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import { attachmentRefId } from './attachments.js'
import type { Deps } from '../deps.js'
import { pcm16ToWav, decodeWavToPcm16Mono } from '../engines/audio-reply/wav.js'
import { chatRegistries } from '../test-support/chat-registries'
import { startFakeRealtimeEngine, type FakeRealtimeEngine, type FakeRealtimeOptions } from '../test-support/fake-realtime-engine'
import { tmpDir } from '../test-support/tmp'

const wavUrl = (rate = 16000, samples = 4800) => `data:audio/wav;base64,${pcm16ToWav(Buffer.alloc(samples * 2, 3), rate).toString('base64')}`
const WAV_URL = wavUrl()

interface Harness {
  app: Hono
  store: ConversationStore
  d: Deps
  engine: FakeRealtimeEngine
  cleanup: () => Promise<void>
}

/** The real chat routes with a model that hears and (by default) answers aloud, on the fake realtime engine. */
async function harness(t: { after: (fn: () => unknown) => void }, opts: { audioOut?: boolean; engine?: FakeRealtimeOptions; engineKind?: string; titles?: boolean; textMaxTokens?: number } = {}): Promise<Harness> {
  const dir = tmpDir('tllm-chat-audio-reply-')
  const store = new ConversationStore(dir)
  const engine = await startFakeRealtimeEngine(opts.engine)
  const cfg = {
    modelDefaults: { maxTokens: opts.textMaxTokens ?? 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: opts.titles ?? false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    ...chatRegistries(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: opts.engineKind ?? 'llama-server', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
    manager: {
      status: () => ({ state: 'running', model: { key: 'lfm3-audio', name: 'LFM3 Audio', ctx: 8192, audio: true, ...(opts.audioOut === false ? {} : { audioOut: true }) } }),
      target: () => engine.baseUrl,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  const cleanup = async () => {
    await engine.stop()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
  t.after(cleanup)
  return { app, store, d, engine, cleanup }
}

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const send = (h: Harness, convId: string, body: unknown) => h.app.request(`/api/v1/conversations/${convId}/messages`, post(body))
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error

function frames(text: string): Array<{ event: string; data: any }> {
  return text.split('\n\n').filter((b) => b.trim() && !b.startsWith(':')).map((block) => {
    const lines = block.split('\n')
    return { event: lines.find((l) => l.startsWith('event:'))!.slice(6).trim(), data: JSON.parse(lines.find((l) => l.startsWith('data:'))!.slice(5)) }
  })
}

const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('a recording sent with replyAudio is answered with its text and a stored clip, over the SSE vocabulary the page already follows', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation({ systemPrompt: 'Be brief.' } as never)
  const res = await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })
  assert.equal(res.status, 200)
  const fs = frames(await res.text())
  assert.deepEqual(fs.map((f) => f.event), ['meta', 'delta', 'done'])
  assert.equal(fs[1].data.delta, 'The capital of France is Paris.')

  const [user, reply] = h.store.getMessages(conv.id)
  assert.match(user.attachments[0], /\.wav$/, 'the question\'s clip is kept as before')
  assert.equal(reply.role, 'assistant')
  assert.equal(reply.content, 'The capital of France is Paris.')
  assert.equal(reply.attachments.length, 1)
  assert.match(reply.attachments[0], /^attachment:[0-9a-f]{64}\.wav$/)
  assert.equal(reply.stats.aborted, false)
  assert.equal(reply.stats.genTokens, 42)
  assert.equal(reply.stats.model, 'LFM3 Audio')
  assert.deepEqual(fs[2].data.message.attachments, reply.attachments)

  const served = await h.app.request(`/api/v1/attachments/${attachmentRefId(reply.attachments[0])}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'audio/wav')
  const wav = decodeWavToPcm16Mono(Buffer.from(await served.arrayBuffer()))
  assert.equal(wav.sampleRate, 24000)
  assert.equal(wav.pcm16.length, 3360)

  // What the engine was asked: the conversation's system prompt as instructions, the clip as PCM, and a bounded reply.
  const update = h.engine.received.find((m) => m.type === 'session.update')!
  assert.match(update.session.instructions, /^Be brief\./)
  assert.equal(update.session.audio.input.format.rate, 16000)
  assert.equal(update.session.max_output_tokens, 1024)
  assert.equal(h.engine.received.filter((m) => m.type === 'input_audio_buffer.append').length, 3)
  await until(() => h.engine.closed() === 1, 'the session to close')
  assert.deepEqual(h.d.chatTurns.inFlightChatIds(), [])
})

test('the text token limit setting does not cap a spoken reply: it gets the speech default', async (t) => {
  const h = await harness(t, { textMaxTokens: 256 })
  const conv = h.store.createConversation()
  await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text()
  assert.equal(h.engine.received.find((m) => m.type === 'session.update')!.session.max_output_tokens, 1024)
})

test('the next turn sends earlier turns as text: the clip as [Voice message], the reply as its words, no audio of either', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text()
  await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text()
  const second = h.engine.received.filter((m) => m.type === 'session.update')[1]
  assert.match(second.session.instructions, /Earlier conversation \(text transcript\):\nUser: \[Voice message\]\nAssistant: The capital of France is Paris\./)
  assert.equal(h.engine.received.filter((m) => m.type === 'input_audio_buffer.commit').length, 2)
  assert.equal(h.engine.received.filter((m) => m.type === 'conversation.item.create').length, 0)
})

test('a typed message with replyAudio is answered aloud as an input_text item', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  await (await send(h, conv.id, { content: 'What is the capital of France?', replyAudio: true })).text()
  assert.deepEqual(h.engine.received.filter((m) => m.type === 'conversation.item.create').map((m) => m.item.content[0]), [{ type: 'input_text', text: 'What is the capital of France?' }])
  assert.equal(h.store.getMessages(conv.id)[1].attachments.length, 1)
})

test('text typed with a recording goes to the model as the user\'s note, with the recording as the input', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  await (await send(h, conv.id, { content: 'answer in French', audio: [WAV_URL], replyAudio: true })).text()
  const update = h.engine.received.find((m) => m.type === 'session.update')!
  assert.match(update.session.instructions, /The user also wrote, with this message: answer in French/)
  assert.ok(h.engine.received.some((m) => m.type === 'input_audio_buffer.commit'))
})

test('a reply with text and no audio is saved as text with no attachment', async (t) => {
  const h = await harness(t, { engine: { fixture: 'realtime-text-only' } })
  const conv = h.store.createConversation()
  const fs = frames(await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text())
  assert.deepEqual(fs.map((f) => f.event), ['meta', 'delta', 'done'])
  const reply = h.store.getMessages(conv.id)[1]
  assert.equal(reply.content, 'The capital of France is Paris.')
  assert.deepEqual(reply.attachments, [])
})

test('a reply with audio and no text has empty content and the clip: the player is the message', async (t) => {
  const h = await harness(t, { engine: { fixture: 'realtime-audio-only' } })
  const conv = h.store.createConversation()
  const fs = frames(await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text())
  assert.deepEqual(fs.map((f) => f.event), ['meta', 'done'], 'no text, so no delta')
  const reply = h.store.getMessages(conv.id)[1]
  assert.equal(reply.content, '')
  assert.equal(reply.attachments.length, 1)
  assert.equal(reply.stats.aborted, false)
})

test('Stop aborts the turn into the engine\'s cancel: what arrived is kept, marked aborted, and the session is closed', async (t) => {
  const h = await harness(t, { engine: { mode: 'cancellable' } })
  const conv = h.store.createConversation()
  const res = await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })
  await until(() => h.engine.received.some((m) => m.type === 'response.create'), 'the request')
  await new Promise((r) => setTimeout(r, 100))
  const stop = await h.app.request('/api/v1/chat/stop', post({ conversationId: conv.id }))
  assert.deepEqual(await stop.json(), { ok: true, stopped: true })
  const fs = frames(await res.text())
  assert.equal(fs.at(-1)!.event, 'done')
  assert.ok(h.engine.received.some((m) => m.type === 'response.cancel'))
  const reply = h.store.getMessages(conv.id)[1]
  assert.equal(reply.stats.aborted, true)
  assert.equal(reply.content, 'The capital of France is Paris')
  assert.equal(reply.attachments.length, 1)
  await until(() => h.engine.closed() === 1, 'the session to close')
  assert.deepEqual(h.d.chatTurns.inFlightChatIds(), [])
})

test('an engine that cannot be reached ends the turn with an error frame and an empty, unfinished reply, as a text turn does', async (t) => {
  const h = await harness(t)
  await h.engine.stop()
  const conv = h.store.createConversation()
  const fs = frames(await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text())
  assert.deepEqual(fs.map((f) => f.event), ['meta', 'error', 'done'])
  assert.equal(fs[1].data.code, 'engine_error')
  assert.match(fs[1].data.message, /Could not reach the audio engine/)
  const reply = h.store.getMessages(conv.id)[1]
  assert.equal(reply.content, '')
  assert.equal(reply.stats.aborted, false)
  assert.deepEqual(h.d.chatTurns.inFlightChatIds(), [])
})

// ── refusals, each before anything is stored ────────────────────────────────────────────────────────

async function refused(h: Harness, body: unknown, status: number, code: string, messagePattern?: RegExp) {
  const conv = h.store.createConversation()
  const res = await send(h, conv.id, body)
  assert.equal(res.status, status)
  const e = await errorOf(res)
  assert.equal(e.code, code)
  if (messagePattern) assert.match(e.message, messagePattern)
  assert.deepEqual(h.store.getMessages(conv.id), [], 'no turn is stored')
  assert.deepEqual(h.d.chatTurns.inFlightChatIds(), [])
  assert.equal(h.engine.opened(), 0, 'the engine was never asked')
}

test('a model that does not answer aloud refuses with 409 audio_output_unsupported, never a text reply', async (t) => {
  const h = await harness(t, { audioOut: false })
  await refused(h, { audio: [WAV_URL], replyAudio: true }, 409, 'audio_output_unsupported', /cannot answer aloud/)
  await refused(h, { content: 'hi', replyAudio: true }, 409, 'audio_output_unsupported')
})

test('an engine kind with no spoken-reply runtime refuses the same way, even when the model says it speaks', async (t) => {
  const h = await harness(t, { engineKind: 'vllm' })
  await refused(h, { audio: [WAV_URL], replyAudio: true }, 409, 'audio_output_unsupported')
})

test('a linked host\'s model refuses with audio_output_unsupported: it never speaks, whatever the local model does', async (t) => {
  const h = await harness(t)
  ;(h.d.modelRouter as unknown as { resolveRemoteTarget: unknown }).resolveRemoteTarget = () => ({
    target: 'https://rig.invalid', remote: { linkId: 'l', baseUrl: 'https://rig.invalid', token: 't', modelKey: 'm' },
  })
  await refused(h, { content: 'hi', replyAudio: true, model: 'Rig/m' }, 409, 'audio_output_unsupported')
})

test('an MP3 clip is refused with 400 audio_format_unsupported, and says to send a WAV', async (t) => {
  const h = await harness(t)
  await refused(h, { audio: [`data:audio/mpeg;base64,${Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000frames').toString('base64')}`], replyAudio: true }, 400, 'audio_format_unsupported', /WAV/)
})

test('clips at different sample rates are refused; at the same rate they are one turn, joined', async (t) => {
  const h = await harness(t)
  await refused(h, { audio: [wavUrl(16000), wavUrl(44100)], replyAudio: true }, 400, 'audio_format_unsupported', /different sample rates/)
  const conv = h.store.createConversation()
  await (await send(h, conv.id, { audio: [wavUrl(16000, 1600), wavUrl(16000, 1600)], replyAudio: true })).text()
  const bytes = h.engine.received.filter((m) => m.type === 'input_audio_buffer.append').reduce((n, m) => n + Buffer.from(m.audio, 'base64').length, 0)
  assert.equal(bytes, 6400, 'two 100 ms clips, back to back')
})

test('an empty recording and an absurd sample rate are refused with 400 before anything is stored', async (t) => {
  const h = await harness(t)
  const url = (rate: number, samples: number) => `data:audio/wav;base64,${pcm16ToWav(Buffer.alloc(samples * 2, 3), rate).toString('base64')}`
  await refused(h, { audio: [url(16000, 0)], replyAudio: true }, 400, 'audio_format_unsupported', /no audio/)
  await refused(h, { audio: [url(1, 100)], replyAudio: true }, 400, 'audio_format_unsupported', /sample rate/)
})

test('recordings longer than the recorder allows, in total, are refused with 400 before anything is stored or decoded', async (t) => {
  const h = await harness(t)
  const long = (seconds: number) => wavUrl(16000, seconds * 16000)
  await refused(h, { audio: [long(311)], replyAudio: true }, 400, 'audio_format_unsupported', /longer than 5 minutes/)
  await refused(h, { audio: [long(120), long(120), long(120)], replyAudio: true }, 400, 'audio_format_unsupported', /longer than 5 minutes/)
})

test('a WAV the decoder cannot read, images, and a replyAudio that is not a boolean are refused with 400', async (t) => {
  const h = await harness(t)
  const eightBit = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x25, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0]), Buffer.from('data'), Buffer.from([1, 0, 0, 0, 128])])
  await refused(h, { audio: [`data:audio/wav;base64,${eightBit.toString('base64')}`], replyAudio: true }, 400, 'audio_format_unsupported', /PCM16 or float32/)
  await refused(h, { content: 'look', images: ['data:image/png;base64,AAAA'], replyAudio: true }, 400, 'invalid_input', /images/)
  await refused(h, { content: 'hi', replyAudio: 'yes' }, 400, 'invalid_input', /boolean/)
})

// ── the text path is untouched ──────────────────────────────────────────────────────────────────────

function textEngine() {
  const original = globalThis.fetch
  const bodies: string[] = []
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = original } }
}

test('a send that does not ask for audio takes the text path on an audio-output model: the same engine request, never the realtime endpoint', async (t) => {
  const h = await harness(t)
  const engine = textEngine()
  t.after(() => engine.restore())
  const sent: string[] = []
  for (const extra of [{}, { replyAudio: false }]) {
    const conv = h.store.createConversation()
    const res = await send(h, conv.id, { content: 'hi', audio: [WAV_URL], ...extra })
    const fs = frames(await res.text())
    assert.deepEqual(fs.map((f) => f.event), ['meta', 'delta', 'done'])
    assert.equal(fs[1].data.delta, 'hello')
    const reply = h.store.getMessages(conv.id)[1]
    assert.equal(reply.content, 'hello')
    assert.deepEqual(reply.attachments, [])
    sent.push(engine.bodies.at(-1)!)
  }
  assert.equal(h.engine.opened(), 0)
  assert.equal(sent[0], sent[1], 'replyAudio: false changes nothing about the request the engine gets')
  assert.equal(JSON.parse(sent[0]).modalities, undefined)
})

test('a model without audio output still gets its ordinary text turn when audio is not asked for', async (t) => {
  const h = await harness(t, { audioOut: false })
  const engine = textEngine()
  t.after(() => engine.restore())
  const conv = h.store.createConversation()
  const res = await send(h, conv.id, { content: 'hi', audio: [WAV_URL] })
  assert.equal(res.status, 200)
  assert.equal(frames(await res.text()).at(-1)!.data.message.content, 'hello')
})

test('the stored speed is of the generation alone: from the first output to the end, or absent when the runtime gave no timing', async (t) => {
  const { runAudioReply } = await import('./audio-reply-turn.js')
  const h = await harness(t)
  const run = async (reply: Record<string, unknown>) => {
    const conv = h.store.createConversation()
    const placeholder = h.store.addMessage(conv.id, 'assistant', '', { stats: { aborted: false } })
    const upstream = { modelField: 'm', modelName: 'LFM3 Audio', ctxMax: 8192, target: h.engine.baseUrl, engineKind: 'llama-server', speaksAudio: true as const }
    const runtime = { reply: async () => ({ text: 'hi', audio: null, status: 'completed' as const, ...reply }) }
    await runAudioReply(h.d, () => {}, {
      convId: conv.id, conv: h.store.getConversation(conv.id)!, history: [], assistantMsg: placeholder, upstream, ac: new AbortController(),
      turn: { runtime, input: { kind: 'text', text: 'q' }, note: '' }, userMessageId: 'u-none', clips: [],
    })
    return h.store.getMessage(placeholder.id)!.stats
  }
  const timed = await run({ outputTokens: 40, generationMs: 2000 })
  assert.equal(timed.genTokens, 40)
  assert.equal(timed.genMs, 2000)
  assert.equal(timed.tps, 20)
  const untimed = await run({ outputTokens: 40 })
  assert.equal(untimed.genTokens, 40)
  assert.ok(!('genMs' in untimed) && !('tps' in untimed), 'no timing, no speed')
})

// ── streamed reply audio and the heard report (arch 2.5, 4.2, 4.3; A1, AA-1) ──────────────────────────

/** One SSE block as written: its event, its data, and its `id:` if it had one. */
interface Block { event: string; data: any; id?: string }

/** Reads an SSE response block by block as it arrives, so a test can act mid-stream. */
function sse(res: Response) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const blocks: Block[] = []
  let text = ''
  const pump = async (): Promise<boolean> => {
    const { value, done } = await reader.read()
    if (done) return false
    text += decoder.decode(value, { stream: true })
    let end: number
    while ((end = text.indexOf('\n\n')) >= 0) {
      const raw = text.slice(0, end)
      text = text.slice(end + 2)
      if (!raw.trim() || raw.startsWith(':')) continue
      const lines = raw.split('\n')
      const field = (name: string) => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim()
      blocks.push({ event: field('event')!, data: JSON.parse(field('data')!), ...(field('id') === undefined ? {} : { id: field('id') }) })
    }
    return true
  }
  return {
    blocks,
    async until(seen: (b: Block) => boolean): Promise<void> {
      while (!blocks.some(seen)) if (!(await pump())) assert.fail('the stream ended first')
    },
    async rest(): Promise<Block[]> {
      while (await pump());
      return blocks
    },
  }
}

/** Lets the routes' awaits run until `ready` holds; never sleeps. */
async function turnsUntil(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !ready(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(ready(), `never got to ${what}`)
}

const heard = (h: Harness, convId: string, msgId: string, body: unknown) => h.app.request(`/api/v1/conversations/${convId}/messages/${msgId}/heard`, post(body))

/** The invalidation keys announced while `fn` ran. */
async function announcedDuring(t: TestContext, fn: () => Promise<unknown>): Promise<string[]> {
  const { eventBus } = await import('../events/bus.js')
  const emitted: string[] = []
  const spy = t.mock.method(eventBus, 'emit', (key: string) => { emitted.push(key) })
  try {
    await fn()
  } finally {
    spy.mock.restore()
  }
  return emitted
}

test('streamAudio must be a boolean, and asks for nothing without replyAudio', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  await refused(h, { audio: [WAV_URL], replyAudio: true, streamAudio: 'yes' }, 400, 'invalid_input')
  await refused(h, { audio: [WAV_URL], streamAudio: true }, 400, 'invalid_input')
  await refused(h, { audio: [WAV_URL], replyAudio: false, streamAudio: true }, 400, 'invalid_input')
  assert.equal(h.store.getMessages(conv.id).length, 0)
})

test('a spoken send that does not ask for streamed audio gets no audio_chunk and no audio_end', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  const text = await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text()
  assert.ok(!text.includes('audio_chunk') && !text.includes('audio_end'), text.slice(0, 300))
})

test('with streamAudio: unnumbered audio_chunk frames, then a numbered audio_end, then the text and done; the chunks are the stored clip', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  const blocks = await sse(await send(h, conv.id, { audio: [WAV_URL], replyAudio: true, streamAudio: true })).rest()
  const events = blocks.map((b) => b.event)
  const chunks = blocks.filter((b) => b.event === 'audio_chunk')
  assert.ok(chunks.length >= 2, events.join(','))
  assert.deepEqual(events, ['meta', ...chunks.map(() => 'audio_chunk'), 'audio_end', 'delta', 'done'])
  assert.ok(chunks.every((b) => b.id === undefined), 'a chunk moves no resume cursor')
  const end = blocks.find((b) => b.event === 'audio_end')!
  assert.ok(end.id !== undefined, 'audio_end is numbered')
  assert.deepEqual(chunks.map((b) => b.data.index), chunks.map((_, i) => i))
  assert.equal(end.data.chunks, chunks.length)

  const reply = h.store.getMessages(conv.id)[1]
  const served = await h.app.request(`/api/v1/attachments/${attachmentRefId(reply.attachments[0])}`)
  const stored = decodeWavToPcm16Mono(Buffer.from(await served.arrayBuffer())).pcm16
  assert.deepEqual(Buffer.concat(chunks.map((b) => Buffer.from(b.data.pcm16, 'base64'))), stored)
  assert.equal(end.data.samples, stored.length / 2)
})

test('a viewer attaching mid-reply gets no audio unless it asks with audio=1, and then only what is produced after it attached', async (t) => {
  const h = await harness(t, { engine: { mode: 'held' } })
  const conv = h.store.createConversation()
  const sender = sse(await send(h, conv.id, { audio: [WAV_URL], replyAudio: true, streamAudio: true }))
  await sender.until((b) => b.event === 'audio_chunk')
  const run = h.d.chatRuns.latestRun(conv.id)!
  const listening = run.emitter.listenerCount('event')
  const plain = sse(await h.app.request(`/api/v1/conversations/${conv.id}/stream`))
  const withAudio = sse(await h.app.request(`/api/v1/conversations/${conv.id}/stream?audio=1`))
  await turnsUntil(() => run.emitter.listenerCount('event') >= listening + 4, 'both viewers attached')
  h.engine.release()

  const sent = (await sender.rest()).filter((b) => b.event === 'audio_chunk').map((b) => b.data.index)
  const plainBlocks = await plain.rest()
  const audioBlocks = await withAudio.rest()
  assert.ok(sent.length >= 2, `${sent}`)
  assert.equal(plainBlocks.some((b) => b.event === 'audio_chunk'), false)
  assert.ok(plainBlocks.some((b) => b.event === 'audio_end'), 'audio_end is an ordinary frame')
  assert.deepEqual(audioBlocks.filter((b) => b.event === 'audio_chunk').map((b) => b.data.index), sent.slice(1), 'not the chunk sent before it attached')
})

test('heard: 404 for an unknown chat or message or another chat\'s message, 400 for a bad number or a user message, 409 for a reply with no clip', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  const other = h.store.createConversation()
  const user = h.store.addMessage(conv.id, 'user', 'hi')
  const textReply = h.store.addMessage(conv.id, 'assistant', 'hello')
  const elsewhere = h.store.addMessage(other.id, 'assistant', 'there')
  const status = async (res: Response | Promise<Response>) => { const r = await res; return [r.status, (await r.json() as { error?: { code: string } }).error?.code] }
  assert.deepEqual(await status(heard(h, 'missing', textReply.id, { heardMs: 10 })), [404, 'not_found'])
  assert.deepEqual(await status(heard(h, conv.id, 'missing', { heardMs: 10 })), [404, 'not_found'])
  assert.deepEqual(await status(heard(h, conv.id, elsewhere.id, { heardMs: 10 })), [404, 'not_found'])
  for (const bad of [{}, { heardMs: 'x' }, { heardMs: -1 }, { heardMs: null }]) assert.deepEqual(await status(heard(h, conv.id, textReply.id, bad)), [400, 'invalid_input'], JSON.stringify(bad))
  assert.deepEqual(await status(heard(h, conv.id, user.id, { heardMs: 10 })), [400, 'invalid_input'])
  assert.deepEqual(await status(heard(h, conv.id, textReply.id, { heardMs: 10 })), [409, 'not_spoken_reply'])
})

test('heard while the reply is still running: pending, nothing announced, and the saved reply is cut to it', async (t) => {
  const h = await harness(t, { engine: { mode: 'held' } })
  const conv = h.store.createConversation()
  const sender = sse(await send(h, conv.id, { audio: [WAV_URL], replyAudio: true }))
  await turnsUntil(() => h.engine.sent.includes('response.output_audio.delta'), 'the reply under way')
  const replyId = h.d.chatRuns.latestRun(conv.id)!.meta.assistantMessageId
  let answer: unknown
  const announced = await announcedDuring(t, async () => { answer = await (await heard(h, conv.id, replyId, { heardMs: 20 })).json() })
  assert.deepEqual(answer, { ok: true, applied: 'pending' })
  assert.deepEqual(announced, [])
  h.engine.release()
  await sender.rest()

  const reply = h.store.getMessage(replyId)!
  assert.equal(reply.content, '', 'no whole sentence was heard')
  assert.equal(reply.stats.heardMs, 20)
  const served = await h.app.request(`/api/v1/attachments/${attachmentRefId(reply.attachments[0])}`)
  assert.equal(decodeWavToPcm16Mono(Buffer.from(await served.arrayBuffer())).pcm16.length, 480 * 2, '20 ms at 24 kHz')
})

/** A heard request whose JSON body the test sends when it chooses; `reading` resolves once the route starts reading it. */
function heldHeard(h: Harness, convId: string, msgId: string) {
  let sendBody!: (json: unknown) => void
  let markReading!: () => void
  const reading = new Promise<void>((resolve) => { markReading = resolve })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sendBody = (json) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(json)))
        controller.close()
      }
    },
    pull() { markReading() },
  }, { highWaterMark: 0 })
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit
  const response = Promise.resolve(h.app.request(`/api/v1/conversations/${convId}/messages/${msgId}/heard`, init))
  return { reading, sendBody, response }
}

test('a heard report whose body arrives after the reply was saved is applied to the saved row', async (t) => {
  const h = await harness(t, { engine: { mode: 'held' } })
  const conv = h.store.createConversation()
  const sender = sse(await send(h, conv.id, { audio: [WAV_URL], replyAudio: true }))
  await turnsUntil(() => h.engine.sent.includes('response.output_audio.delta'), 'the reply under way')
  const replyId = h.d.chatRuns.latestRun(conv.id)!.meta.assistantMessageId
  const report = heldHeard(h, conv.id, replyId)
  await report.reading
  h.engine.release()
  await sender.rest()

  let res!: Response
  const announced = await announcedDuring(t, async () => {
    report.sendBody({ heardMs: 20 })
    res = await report.response
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, applied: 'saved' })
  assert.deepEqual(announced, [`conversation:${conv.id}`])
  const reply = h.store.getMessage(replyId)!
  assert.equal(reply.stats.heardMs, 20)
  const served = await h.app.request(`/api/v1/attachments/${attachmentRefId(reply.attachments[0])}`)
  assert.equal(decodeWavToPcm16Mono(Buffer.from(await served.arrayBuffer())).pcm16.length, 480 * 2, 'the cut clip')
})

test('heard after the reply was saved: the reply is cut, announced once, and a refetch shows the cut; a larger report changes nothing', async (t) => {
  const h = await harness(t)
  const conv = h.store.createConversation()
  await (await send(h, conv.id, { audio: [WAV_URL], replyAudio: true })).text()
  const before = h.store.getMessages(conv.id)[1]

  let answer: unknown
  const announced = await announcedDuring(t, async () => { answer = await (await heard(h, conv.id, before.id, { heardMs: 20 })).json() })
  assert.deepEqual(answer, { ok: true, applied: 'saved' })
  assert.deepEqual(announced, [`conversation:${conv.id}`])

  const shown = (await (await h.app.request(`/api/v1/conversations/${conv.id}`)).json()) as { messages: Array<{ id: string; content: string; attachments: string[] }> }
  const cut = shown.messages.find((m) => m.id === before.id)!
  assert.equal(cut.content, '')
  assert.notDeepEqual(cut.attachments, before.attachments, 'the new clip')

  const again = await announcedDuring(t, async () => { answer = await (await heard(h, conv.id, before.id, { heardMs: 40 })).json() })
  assert.deepEqual(answer, { ok: true, applied: 'unchanged' })
  assert.deepEqual(again, [])
})

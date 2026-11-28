// What a spoken reply's clip does once it is stored on an assistant message: it is an ordinary attachment of the store
// that already keeps voice clips, so the janitor, the retention sweep, compaction and export treat it as they treat any
// message's, and nothing about it needs a store of its own.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { AttachmentJanitor } from './attachment-janitor'
import { attachmentRefId, isAudioAttachment } from './attachments'
import { applyHeardToSavedReply, runAudioReply } from './audio-reply-turn'
import { ChatTurns } from './chat-turns'
import type { ChatUpstream } from './chat-upstream'
import type { Deps } from '../deps'
import { AudioReplyError, type AudioReply, type AudioReplyRequest, type AudioReplyRuntime } from '../engines/audio-reply/types'
import { decodeWavToPcm16Mono, pcm16ToWav } from '../engines/audio-reply/wav'
import { buildSnapshot } from './chat-export'
import { buildEngineMessages, pickCompactionCut, SPOKEN_REPLY_PLACEHOLDER } from './chat-compaction'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { RetentionSweeper } from './retention'
import { defaultConfig } from '../config/config'
import { tmpDir } from '../test-support/tmp'

const clip = (n: number) => `data:audio/wav;base64,${Buffer.from(`RIFF-reply-${n}`.padEnd(40, '.')).toString('base64')}`
const files = (dir: string) => (existsSync(join(dir, 'attachments')) ? readdirSync(join(dir, 'attachments')).sort() : [])
const age = (dir: string, ref: string) => {
  const old = new Date(Date.now() - 2 * 3600_000)
  utimesSync(join(dir, 'attachments', attachmentRefId(ref)!), old, old)
}

async function withStore(fn: (store: ConversationStore, dir: string) => Promise<void>): Promise<void> {
  const dir = tmpDir('tllm-audio-reply-storage-')
  const store = new ConversationStore(dir)
  try {
    await fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const janitor = (store: ConversationStore) => new AttachmentJanitor({ db: store, log: () => {}, graceMs: 3600_000 })

test('the janitor keeps a reply\'s clip while an assistant message names it, and collects it once nothing does', () => withStore(async (store, dir) => {
  const conv = store.createConversation()
  store.addMessage(conv.id, 'user', 'q')
  const [ref] = await store.attachments.save([clip(1)])
  const reply = store.addMessage(conv.id, 'assistant', 'Paris.', { attachments: [ref] })
  age(dir, ref)
  assert.equal((await janitor(store).run())?.deleted, 0)
  assert.deepEqual(files(dir), [attachmentRefId(ref)])

  store.deleteMessage(reply.id)
  assert.deepEqual(files(dir), [attachmentRefId(ref)], 'deleting the message leaves the file for the janitor')
  assert.equal((await janitor(store).run())?.deleted, 1)
  assert.deepEqual(files(dir), [])
}))

test('deleting the conversation leaves a reply\'s clip for the janitor too, and a clip another chat names stays', () => withStore(async (store, dir) => {
  const a = store.createConversation()
  const b = store.createConversation()
  const [mine, shared] = await store.attachments.save([clip(1), clip(2)])
  store.addMessage(a.id, 'assistant', '', { attachments: [mine, shared] })
  store.addMessage(b.id, 'assistant', 'x', { attachments: [shared] })
  for (const ref of [mine, shared]) age(dir, ref)
  store.deleteConversation(a.id)
  assert.equal(files(dir).length, 2, 'nothing deleted with the conversation')
  assert.equal((await janitor(store).run())?.deleted, 1)
  assert.deepEqual(files(dir), [attachmentRefId(shared)])
}))

test('the retention sweep removing a routine run\'s conversation leaves the clip of its assistant message for the janitor', () => withStore(async (store, dir) => {
  const r = store.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm' })
  const [ref] = await store.attachments.save([clip(3)])
  const runs: string[] = []
  for (let i = 0; i < 3; i++) {
    const run = store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
    const raw = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db
    const startedAt = Date.now() - (10 - i) * 86_400_000
    raw.prepare(`UPDATE routine_runs SET started_at = ?, ended_at = ?, status = 'ok' WHERE id = ?`).run(new Date(startedAt).toISOString(), new Date(startedAt + 500).toISOString(), run.id)
    const conv = store.createConversation({ kind: 'agent', modelKey: 'm' })
    const written = store.addMessage(conv.id, 'assistant', 'spoken', i === 0 ? { attachments: [ref] } : {})
    raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(startedAt + 100).toISOString(), written.id)
    store.updateRoutineRun(run.id, { conversationId: conv.id })
    runs.push(conv.id)
  }
  age(dir, ref)
  const sweeper = new RetentionSweeper({ db: store, settings: () => ({ enabled: true, apiUsageRawDays: 90, routineRunsKept: 2 }), log: () => {} })
  assert.equal((await sweeper.sweep())?.conversationsDeleted, 1)
  assert.equal(store.getConversation(runs[0]), null)
  assert.deepEqual(files(dir), [attachmentRefId(ref)], 'the sweep deletes rows, not files')
  assert.equal((await janitor(store).run())?.deleted, 1)
  assert.deepEqual(files(dir), [])
}))

// ── compaction and what a later text model is sent ──────────────────────────────────────────────────

const REPLY_REF = `attachment:${'ef'.repeat(32)}.wav`
let seq = 0
const msg = (role: 'user' | 'assistant', content: string, attachments: string[] = []) => ({
  id: `m${++seq}`, convId: 'c', seq, role, content, reasoning: '', attachments, textAttachments: [], toolCalls: [], stats: {},
  createdAt: '2026-09-09T00:00:00.000Z', variantGroup: null, isActive: true, branchOf: null, edited: false,
}) as never

test('compaction counts an assistant\'s clip as nothing, for a model that hears audio or not: the text stands in', () => {
  const build = (clips: string[]) => Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i} ${'x'.repeat(400)}`, i % 2 ? clips : []))
  for (const hearsAudio of [true, false]) {
    const plain = pickCompactionCut(build([]), 2000, undefined, false, hearsAudio)
    const spoken = pickCompactionCut(build([REPLY_REF, REPLY_REF]), 2000, undefined, false, hearsAudio)
    assert.ok(plain && spoken)
    assert.equal(spoken.toSummarize.length, plain.toSummarize.length)
    assert.equal(spoken.tokensBefore, plain.tokensBefore)
  }
})

test('a later text model is never sent an assistant\'s clip, and an empty spoken reply is [Spoken reply], not an empty turn', () => {
  const history = [msg('user', 'q'), msg('assistant', '', [REPLY_REF]), msg('user', 'and?'), msg('assistant', 'Berlin.', [REPLY_REF])]
  for (const hearsAudio of [true, false]) {
    const out = buildEngineMessages({ id: 'c', systemPrompt: '', modelKey: 'm', sampling: {}, expertMode: false, kind: 'chat', preserveThinking: false, title: 't', createdAt: '', updatedAt: '' } as never, history, undefined, { hearsAudio })
    assert.deepEqual(out.map((m) => m.content), ['q', SPOKEN_REPLY_PLACEHOLDER, 'and?', 'Berlin.'])
  }
})

test('export keeps a reply\'s text and carries no audio bytes, as it does for a voice message', () => {
  const conv = { id: 'c', title: 't', systemPrompt: '', modelKey: 'm', sampling: {}, expertMode: false, kind: 'chat', preserveThinking: false, createdAt: '', updatedAt: '', messages: [msg('user', '', [REPLY_REF]), msg('assistant', 'Paris.', [REPLY_REF]), msg('assistant', '', [clip(9)])] } as never
  const snapshot = buildSnapshot(conv, defaultConfig(), '1.0.0', '2026-09-09T00:00:00.000Z', 'export')
  assert.deepEqual(snapshot.messages.map((m) => m.content), ['', 'Paris.', ''])
  const json = JSON.stringify(snapshot)
  assert.ok(!json.includes('attachment:') && !json.includes('base64') && !json.includes('RIFF'))
})

test('an in-memory store keeps a reply\'s clip inline, as it does a voice message\'s: nothing on disk to outlive it', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const [kept] = await store.attachments.save([clip(5)])
  assert.equal(kept, clip(5))
  store.close()
})

// ── runAudioReply: streamed audio, audio_end, the heard cut, the transcript job (arch 2.6, PG-4, PG-5, AA-5) ────────

const REPLY_TEXT = 'One two three. Four five six.'
const REPLY_RATE = 24_000
/** One second of reply speech. */
const replyWav = (samples = REPLY_RATE) => pcm16ToWav(Buffer.alloc(samples * 2, 5), REPLY_RATE)

/** What happened during a turn, in order: frames the turn emitted, live audio, and the transcript queue's calls. */
type Step = { event: string; data?: any }

/** A turn on a scripted runtime over a real store, a real ChatTurns and a fake transcript queue. */
async function spokenTurn(
  t: { after: (fn: () => unknown) => void },
  o: {
    live?: boolean
    input?: 'audio' | 'text'
    /** Runs once the question is stored, just before the turn: to stub the store. */
    beforeRun?: (store: ConversationStore) => void
    reply: (req: AudioReplyRequest, ctl: { signal: AbortSignal; steps: Step[]; replyId: string; convId: string; store: ConversationStore; turns: ChatTurns; ac: AbortController }) => Promise<AudioReply>
  },
) {
  const dir = tmpDir('tllm-audio-reply-run-')
  const store = new ConversationStore(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const steps: Step[] = []
  const requests: AudioReplyRequest[] = []
  const turns = new ChatTurns()
  const transcripts = {
    pause: () => steps.push({ event: 'pause' }),
    resume: () => steps.push({ event: 'resume' }),
    enqueue: (job: unknown) => steps.push({ event: 'enqueue', data: job }),
  }
  const d = {
    db: store, chatTurns: turns, transcripts,
    manager: { generationStart: () => {}, generationEnd: () => {}, recordCompletion: () => {} },
  } as unknown as Deps
  const conv = store.createConversation()
  const [userClip] = await store.attachments.save([`data:audio/wav;base64,${pcm16ToWav(Buffer.alloc(3200, 1), 16_000).toString('base64')}`])
  const user = store.addMessage(conv.id, 'user', '', { attachments: [userClip] })
  const assistantMsg = store.addMessage(conv.id, 'assistant', '')
  const ac = new AbortController()
  const input = o.input === 'text' ? { kind: 'text' as const, text: 'hi' } : { kind: 'audio' as const, pcm16: Buffer.alloc(3200, 1), sampleRate: 16_000 }
  const runtime: AudioReplyRuntime = {
    reply: (_url, req, signal) => {
      requests.push(req)
      steps.push({ event: 'engine' })
      return o.reply(req, { signal, steps, replyId: assistantMsg.id, convId: conv.id, store, turns, ac })
    },
  }
  o.beforeRun?.(store)
  const outcome = await runAudioReply(d, (ev) => { steps.push(ev) }, {
    convId: conv.id, conv: store.getConversation(conv.id)!, history: [], assistantMsg,
    upstream: { target: 'http://engine.invalid', ctxMax: 8192, modelName: 'Spoken', modelField: 'm' } as ChatUpstream,
    ac, turn: { runtime, input, note: '' },
    userMessageId: user.id, clips: o.input === 'text' ? [] : [userClip],
    ...(o.live ? { live: (event: string, data: unknown) => { steps.push({ event, data }) } } : {}),
  })
  const saved = store.getMessage(assistantMsg.id)!
  const savedWav = async () => {
    const url = await store.attachments.inline(saved.attachments[0])
    return Buffer.from(url!.slice(url!.indexOf(',') + 1), 'base64')
  }
  const savedClip = async () => decodeWavToPcm16Mono(await savedWav())
  return { steps, events: () => steps.map((s) => s.event), requests, outcome, saved, savedWav, savedClip, turns, user, userClip, replyId: assistantMsg.id, d, store }
}

const answered = (text = REPLY_TEXT, wav = replyWav()): AudioReply => ({ text, audio: { data: wav, format: 'wav', sampleRate: REPLY_RATE }, status: 'completed', outputTokens: 7 })
const streamTwo = (req: AudioReplyRequest) => {
  req.onAudio?.({ pcm16: Buffer.alloc(400, 1), sampleRate: REPLY_RATE })
  req.onAudio?.({ pcm16: Buffer.alloc(400, 2), sampleRate: REPLY_RATE })
}

test('with live audio: the chunks, then audio_end, then the text, then done', async (t) => {
  const h = await spokenTurn(t, { live: true, reply: async (req) => { streamTwo(req); return answered() } })
  const frames = h.events().filter((e) => !['engine', 'pause', 'resume', 'enqueue'].includes(e))
  assert.deepEqual(frames, ['audio_chunk', 'audio_chunk', 'audio_end', 'delta', 'done'])
  const end = h.steps.find((s) => s.event === 'audio_end')!.data
  assert.deepEqual([end.replyId, end.chunks, end.samples, end.sampleRate], [h.replyId, 2, 400, REPLY_RATE])
})

test('with live audio and an engine error after some chunks: audio_end, then error, then done', async (t) => {
  const h = await spokenTurn(t, { live: true, reply: async (req) => { streamTwo(req); throw new AudioReplyError('engine_error', 'boom') } })
  const frames = h.events().filter((e) => !['engine', 'pause', 'resume', 'enqueue'].includes(e))
  assert.deepEqual(frames, ['audio_chunk', 'audio_chunk', 'audio_end', 'error', 'done'])
})

test('without live audio the runtime is asked exactly as before, and the frames are today\'s', async (t) => {
  const h = await spokenTurn(t, { reply: async () => answered() })
  assert.equal('onAudio' in h.requests[0], false)
  assert.deepEqual(h.events().filter((e) => !['engine', 'pause', 'resume', 'enqueue'].includes(e)), ['delta', 'done'])
  assert.equal(h.saved.content, REPLY_TEXT)
  assert.equal(h.saved.stats.heardMs, undefined, 'nothing heard reported, nothing cut')
  assert.equal((await h.savedClip()).pcm16.length, REPLY_RATE * 2)
})

test('a heard report while the reply runs cuts the saved reply to what was heard, before done', async (t) => {
  const h = await spokenTurn(t, { reply: async (_req, ctl) => { ctl.turns.noteHeard(ctl.replyId, 500); return answered() } })
  assert.equal(h.saved.content, 'One two three.')
  assert.equal(h.saved.stats.heardMs, 500)
  assert.equal((await h.savedClip()).pcm16.length, REPLY_RATE, 'half a second of samples')
  const done = h.steps.find((s) => s.event === 'done')!.data.message
  assert.equal(done.content, 'One two three.', 'done carries the cut row')
  assert.deepEqual(done.attachments, h.saved.attachments)
})

test('a heard report below one sample keeps a zero-sample clip and no text: still an audio reply', async (t) => {
  const h = await spokenTurn(t, { reply: async (_req, ctl) => { ctl.turns.noteHeard(ctl.replyId, 0.01); return answered() } })
  assert.equal(h.saved.content, '')
  assert.equal(h.saved.attachments.length, 1)
  assert.ok(isAudioAttachment(h.saved.attachments[0]))
  const wav = await h.savedWav()
  assert.equal(wav.length, 44, 'a WAV header and no samples')
  assert.equal(wav.readUInt32LE(40), 0)
  assert.equal(wav.readUInt32LE(24), REPLY_RATE)
})

/** The turn's frames, without the steps the fakes record. */
const framesOf = (events: string[]) => events.filter((e) => !['engine', 'pause', 'resume', 'enqueue'].includes(e))

test('a chat deleted after a heard report still ends the turn with done', async (t) => {
  const h = await spokenTurn(t, {
    reply: async (_req, ctl) => {
      ctl.turns.noteHeard(ctl.replyId, 20)
      ctl.store.deleteConversation(ctl.convId)
      return answered()
    },
  })
  const frames = framesOf(h.events())
  assert.equal(frames.at(-1), 'done')
  assert.equal(frames.includes('error'), false)
})

test('a heard cut that fails keeps the uncut reply and still sends done', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {})
  const h = await spokenTurn(t, {
    beforeRun: (store) => {
      const save = store.attachments.save.bind(store.attachments)
      let saves = 0
      t.mock.method(store.attachments, 'save', async (refs: string[]) => {
        if (++saves === 2) throw new Error('the disk is full')
        return save(refs)
      })
    },
    reply: async (_req, ctl) => { ctl.turns.noteHeard(ctl.replyId, 500); return answered() },
  })
  assert.equal(h.saved.content, REPLY_TEXT)
  assert.equal(h.saved.stats.heardMs, undefined)
  assert.equal((await h.savedClip()).pcm16.length, REPLY_RATE * 2, 'the original clip')
  assert.equal(warned.mock.callCount(), 1)
  const frames = framesOf(h.events())
  assert.equal(frames.at(-1), 'done')
  assert.equal(frames.includes('error'), false)
})

test('the spoken-reply registry is empty after every exit', async (t) => {
  const completed = await spokenTurn(t, { reply: async () => answered() })
  const failed = await spokenTurn(t, { reply: async () => { throw new AudioReplyError('engine_error', 'boom') } })
  for (const h of [completed, failed]) assert.equal(h.turns.isSpokenReplyRunning(h.replyId), false)
  const running: boolean[] = []
  await spokenTurn(t, { reply: async (_req, ctl) => { running.push(ctl.turns.isSpokenReplyRunning(ctl.replyId)); return answered() } })
  assert.deepEqual(running, [true], 'registered while the engine runs')
})

test('the transcript job is queued after done for a recorded question, whether the reply completed, was stopped or failed', async (t) => {
  const stopped = async (_req: AudioReplyRequest, ctl: { ac: AbortController }) => {
    ctl.ac.abort()
    return { ...answered(), status: 'cancelled' as const }
  }
  const outcomes = [
    await spokenTurn(t, { reply: async () => answered() }),
    await spokenTurn(t, { reply: stopped }),
    await spokenTurn(t, { reply: async () => { throw new AudioReplyError('engine_error', 'boom') } }),
  ]
  for (const h of outcomes) {
    const events = h.events()
    assert.equal(events.filter((e) => e === 'enqueue').length, 1, events.join(','))
    assert.ok(events.indexOf('enqueue') > events.indexOf('done'), 'after done')
    assert.deepEqual(h.steps.find((s) => s.event === 'enqueue')!.data, { convId: h.user.convId, messageId: h.user.id, clips: [h.userClip] })
  }
})

test('no transcript job is queued for a chat deleted while its reply ran', async (t) => {
  const h = await spokenTurn(t, {
    reply: async (_req, ctl) => {
      ctl.store.deleteConversation(ctl.convId)
      return answered()
    },
  })
  assert.equal(h.events().includes('enqueue'), false)
})

test('a typed question answered aloud queues no transcript job', async (t) => {
  const h = await spokenTurn(t, { input: 'text', reply: async () => answered() })
  assert.equal(h.events().includes('enqueue'), false)
})

test('the transcript queue gives way while the engine runs: paused before it is asked, resumed once on every exit', async (t) => {
  const stopped = async (_req: AudioReplyRequest, ctl: { ac: AbortController }) => {
    ctl.ac.abort()
    return { ...answered(), status: 'cancelled' as const }
  }
  const replies = [async () => answered(), stopped, async () => { throw new AudioReplyError('engine_error', 'boom') }]
  for (const reply of replies) {
    const h = await spokenTurn(t, { reply })
    const events = h.events()
    assert.ok(events.indexOf('pause') >= 0 && events.indexOf('pause') < events.indexOf('engine'), events.join(','))
    assert.equal(events.filter((e) => e === 'pause').length, 1)
    assert.equal(events.filter((e) => e === 'resume').length, 1)
    assert.ok(events.indexOf('resume') < events.indexOf('done'), 'resumed once the engine is done')
  }
})

// ── applyHeardToSavedReply: a heard report for a reply already saved (arch 2.6, PG-4) ──────────────

test('applyHeardToSavedReply cuts a saved reply once, never grows it back, and leaves an edited one alone', async (t) => {
  const h = await spokenTurn(t, { reply: async () => answered() })
  assert.equal(await applyHeardToSavedReply(h.d, h.store.getMessage(h.replyId)!, 500), 'saved')
  const cut = h.store.getMessage(h.replyId)!
  assert.equal(cut.content, 'One two three.')
  assert.equal(cut.stats.heardMs, 500)
  assert.notDeepEqual(cut.attachments, h.saved.attachments, 'a new clip')
  assert.equal(await applyHeardToSavedReply(h.d, cut, 800), 'unchanged', 'a larger report never grows it back')

  const edited = await spokenTurn(t, { reply: async () => answered() })
  edited.store.updateMessage(edited.replyId, { edited: true })
  assert.equal(await applyHeardToSavedReply(edited.d, edited.store.getMessage(edited.replyId)!, 500), 'unchanged')
})

test('applyHeardToSavedReply leaves a reply heard in full unchanged', async (t) => {
  const h = await spokenTurn(t, { reply: async () => answered() })
  assert.equal(await applyHeardToSavedReply(h.d, h.saved, 990), 'unchanged')
  assert.deepEqual(h.store.getMessage(h.replyId)!.attachments, h.saved.attachments)
})

test('applyHeardToSavedReply tries once more when its swap of the clip loses a race', async (t) => {
  const h = await spokenTurn(t, { reply: async () => answered() })
  let swaps = 0
  const racing = Object.assign(Object.create(h.store) as ConversationStore, {
    replaceMessageAttachments: (id: string, previous: string, next: string[]) => (++swaps === 1 ? false : h.store.replaceMessageAttachments(id, previous, next)),
  })
  assert.equal(await applyHeardToSavedReply({ ...h.d, db: racing } as Deps, h.saved, 500), 'saved')
  assert.equal(swaps, 2)
  assert.equal(h.store.getMessage(h.replyId)!.content, 'One two three.')
})

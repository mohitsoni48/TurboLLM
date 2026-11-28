// VoiceTranscripts (ADR-485 D1, arch 2.9, plan A-5 with AA-5 and PG-3): a voice message's clip becomes words after
// the reply, one whisper job at a time, off the reply's path. A fake voice service stands in for whisper: no process,
// no port.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { pcm16ToWav } from '../engines/audio-reply/wav'
import { VoiceError } from '../voice/voice-service'
import { TRANSCRIPT_MAX_YIELDS, TRANSCRIPT_QUEUE_MAX, VoiceTranscripts, type VoiceTranscriptsDeps } from './voice-transcripts'

const CLIP_WAV = pcm16ToWav(Buffer.alloc(3200), 16_000)
const CLIP_REF = `attachment:${'ab'.repeat(32)}.wav`
const GONE_REF = `attachment:${'cd'.repeat(32)}.wav`

/** One transcribeText call the fake whisper is holding: it settles when the test says, or rejects on abort. */
interface WhisperCall { audio: Blob; signal: AbortSignal; answer: (text: string) => void; fail: (error: Error) => void }

/** A whisper that answers only when told, and stops, as the real one does, when its signal aborts. */
class FakeWhisper {
  readonly calls: WhisperCall[] = []
  ready = true
  /** Off: a reply that ignores its signal and answers anyway, as a request already on the wire can. */
  honorsAbort = true

  available(): boolean {
    return this.ready
  }

  transcribeText(audio: Blob, _opts: object, signal?: AbortSignal): Promise<{ text: string; tookMs: number }> {
    return new Promise((resolve, reject) => {
      const call: WhisperCall = { audio, signal: signal!, answer: (text) => resolve({ text, tookMs: 1 }), fail: reject }
      if (this.honorsAbort) signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      this.calls.push(call)
    })
  }
}

/** The queue over an in-memory store, a fake whisper, and recorded announcements and log lines. Each job's deadline
 *  is a controller the test fires itself (`deadlines`, in the order jobs start), so no test waits on the clock. While
 *  `clipRead.hold` is set, reading a clip waits on it. */
function harness(over: Partial<VoiceTranscriptsDeps> = {}) {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const whisper = new FakeWhisper()
  const announced: string[] = []
  const logged: string[] = []
  const deadlines: AbortController[] = []
  const clipRead: { hold: Promise<void> | null } = { hold: null }
  const attachments = {
    inline: async (ref: string) => {
      await clipRead.hold
      return ref === GONE_REF ? null : `data:audio/wav;base64,${CLIP_WAV.toString('base64')}`
    },
  }
  const db = Object.assign(Object.create(store) as ConversationStore, { attachments })
  const deadline = () => {
    const controller = new AbortController()
    deadlines.push(controller)
    return controller.signal
  }
  const queue = new VoiceTranscripts({
    db, voice: whisper, announce: (key) => announced.push(key), log: (msg) => logged.push(msg), deadline, ...over,
  })
  const conv = store.createConversation()
  const voiceMessage = (convId = conv.id) => store.addMessage(convId, 'user', '', { attachments: [CLIP_REF] })
  const job = (messageId: string, convId = conv.id, clips = [CLIP_REF]) => ({ convId, messageId, clips })
  return { store, whisper, announced, logged, deadlines, clipRead, queue, conv, voiceMessage, job, close: () => { queue.stopAll(); store.close() } }
}

/** What a deadline aborts with, as AbortSignal.timeout does. */
function timedOut(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError')
}

/** Lets the queue's awaits run until `ready` holds. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(ready(), 'the queue never got there')
}

/** Lets every queued await run, so a job that would wrongly start has the chance to. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

test('the words are saved, trimmed, and the chat is announced once', async () => {
  const h = harness()
  try {
    const m = h.voiceMessage()
    h.queue.enqueue(h.job(m.id))
    await until(() => h.whisper.calls.length === 1)
    assert.equal(Buffer.from(await h.whisper.calls[0].audio.arrayBuffer()).subarray(0, 4).toString('ascii'), 'RIFF')
    h.whisper.calls[0].answer('  what is the weather \n')
    await h.queue.idle()

    assert.equal(h.store.getMessage(m.id)!.transcript, 'what is the weather')
    assert.deepEqual(h.announced, [`conversation:${h.conv.id}`])
  } finally {
    h.close()
  }
})

test('no voice service, or speech-to-text not ready: nothing is queued and whisper is never asked', async () => {
  const absent = harness({ voice: undefined })
  const notReady = harness()
  try {
    notReady.whisper.ready = false
    absent.queue.enqueue(absent.job(absent.voiceMessage().id))
    notReady.queue.enqueue(notReady.job(notReady.voiceMessage().id))
    await settle()
    await absent.queue.idle()
    await notReady.queue.idle()
    assert.equal(notReady.whisper.calls.length, 0)
  } finally {
    absent.close()
    notReady.close()
  }
})

test('a job that fails keeps the placeholder, is logged once, and the next job still runs', async () => {
  const h = harness()
  try {
    const failing = h.voiceMessage()
    const next = h.voiceMessage()
    h.queue.enqueue(h.job(failing.id))
    h.queue.enqueue(h.job(next.id))
    await until(() => h.whisper.calls.length === 1)
    h.whisper.calls[0].fail(new VoiceError(503, 'stt_unavailable', 'whisper is not installed'))
    await until(() => h.whisper.calls.length === 2)
    h.whisper.calls[1].answer('second')
    await h.queue.idle()

    assert.equal(h.store.getMessage(failing.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(next.id)!.transcript, 'second')
    assert.equal(h.logged.length, 1)
  } finally {
    h.close()
  }
})

test('empty words write nothing and are logged', async () => {
  const h = harness()
  try {
    const m = h.voiceMessage()
    h.queue.enqueue(h.job(m.id))
    await until(() => h.whisper.calls.length === 1)
    h.whisper.calls[0].answer('   ')
    await h.queue.idle()
    assert.equal(h.store.getMessage(m.id)!.transcript, undefined)
    assert.deepEqual(h.announced, [])
    assert.equal(h.logged.length, 1)
  } finally {
    h.close()
  }
})

test('a clip that cannot be read writes nothing, never reaches whisper, and the queue moves on', async () => {
  const h = harness()
  try {
    const gone = h.voiceMessage()
    const next = h.voiceMessage()
    h.queue.enqueue(h.job(gone.id, h.conv.id, [GONE_REF]))
    h.queue.enqueue(h.job(next.id))
    await until(() => h.whisper.calls.length === 1)
    h.whisper.calls[0].answer('second')
    await h.queue.idle()
    assert.equal(h.store.getMessage(gone.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(next.id)!.transcript, 'second')
    assert.equal(h.logged.length, 1)
  } finally {
    h.close()
  }
})

test('a job past its time limit is abandoned at once, even by a whisper that does not stop, and its late words are never saved', async () => {
  const h = harness()
  try {
    h.whisper.honorsAbort = false
    const slow = h.voiceMessage()
    const next = h.voiceMessage()
    h.queue.enqueue(h.job(slow.id))
    h.queue.enqueue(h.job(next.id))
    await until(() => h.whisper.calls.length === 1)

    h.deadlines[0].abort(timedOut())
    await until(() => h.whisper.calls.length === 2)
    assert.equal(h.whisper.calls[0].signal.aborted, true, 'whisper is told the deadline passed')
    h.whisper.calls[0].answer('too late')
    h.whisper.calls[1].answer('second')
    await h.queue.idle()
    await settle()

    assert.equal(h.store.getMessage(slow.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(next.id)!.transcript, 'second')
    assert.deepEqual(h.announced, [`conversation:${h.conv.id}`])
    assert.equal(h.logged.length, 1)
    assert.ok(h.logged[0].includes(slow.id), h.logged[0])
  } finally {
    h.close()
  }
})

test('a time limit that passes while the clip is still being read means whisper is never asked for that job', async () => {
  const h = harness()
  try {
    let release!: () => void
    h.clipRead.hold = new Promise((r) => { release = r })
    const slow = h.voiceMessage()
    const next = h.voiceMessage()
    h.queue.enqueue(h.job(slow.id))
    h.queue.enqueue(h.job(next.id))
    await until(() => h.deadlines.length === 1)

    h.deadlines[0].abort(timedOut())
    h.clipRead.hold = null
    await until(() => h.whisper.calls.length === 1)
    h.whisper.calls[0].answer('second')
    release()
    await h.queue.idle()
    await settle()

    assert.equal(h.whisper.calls.length, 1, 'only the next job reached whisper')
    assert.equal(h.store.getMessage(slow.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(next.id)!.transcript, 'second')
    assert.equal(h.logged.length, 1)
  } finally {
    h.close()
  }
})

test('two jobs run strictly one after the other', async () => {
  const h = harness()
  try {
    const first = h.voiceMessage()
    const second = h.voiceMessage()
    h.queue.enqueue(h.job(first.id))
    h.queue.enqueue(h.job(second.id))
    await until(() => h.whisper.calls.length === 1)
    await settle()
    assert.equal(h.whisper.calls.length, 1, 'the second waits for the first')
    h.whisper.calls[0].answer('one')
    await until(() => h.whisper.calls.length === 2)
    h.whisper.calls[1].answer('two')
    await h.queue.idle()
    assert.deepEqual([h.store.getMessage(first.id)!.transcript, h.store.getMessage(second.id)!.transcript], ['one', 'two'])
  } finally {
    h.close()
  }
})

test(`past ${TRANSCRIPT_QUEUE_MAX} waiting jobs the oldest waiting one is dropped and logged`, async () => {
  const h = harness()
  try {
    const running = h.voiceMessage()
    h.queue.enqueue(h.job(running.id))
    await until(() => h.whisper.calls.length === 1)
    const waiting = Array.from({ length: TRANSCRIPT_QUEUE_MAX + 1 }, () => h.voiceMessage())
    for (const m of waiting) h.queue.enqueue(h.job(m.id))
    assert.equal(h.logged.length, 1)
    assert.ok(h.logged[0].includes(waiting[0].id), h.logged[0])

    h.whisper.calls[0].answer('words')
    for (let i = 1; i <= TRANSCRIPT_QUEUE_MAX; i++) {
      await until(() => h.whisper.calls.length === i + 1)
      h.whisper.calls[i].answer('words')
    }
    await h.queue.idle()
    assert.equal(h.whisper.calls.length, TRANSCRIPT_QUEUE_MAX + 1)
    assert.equal(h.store.getMessage(waiting[0].id)!.transcript, undefined)
    assert.equal(h.store.getMessage(waiting[1].id)!.transcript, 'words')
  } finally {
    h.close()
  }
})

test('cancelling a chat aborts its running job and drops its waiting ones; another chat\'s job still runs', async () => {
  const h = harness()
  try {
    const other = h.store.createConversation()
    const running = h.voiceMessage()
    const waiting = h.voiceMessage()
    const otherChats = h.voiceMessage(other.id)
    h.queue.enqueue(h.job(running.id))
    h.queue.enqueue(h.job(waiting.id))
    h.queue.enqueue(h.job(otherChats.id, other.id))
    await until(() => h.whisper.calls.length === 1)

    h.queue.cancelConversation(h.conv.id)
    await until(() => h.whisper.calls.length === 2)
    assert.equal(h.whisper.calls[0].signal.aborted, true)
    h.whisper.calls[1].answer('elsewhere')
    await h.queue.idle()

    assert.equal(h.store.getMessage(running.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(waiting.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(otherChats.id)!.transcript, 'elsewhere')
    assert.equal(h.whisper.calls.length, 2)
    assert.equal(h.logged.length, 1, h.logged.join('\n'))
    assert.ok(h.logged[0].includes(running.id) && h.logged[0].includes('cancelled with its chat'), h.logged[0])
    assert.ok(!h.logged[0].includes('not transcribed'), h.logged[0])
  } finally {
    h.close()
  }
})

test('after stopAll a job that still finishes writes nothing, and a later enqueue never reaches whisper', async () => {
  const h = harness()
  try {
    h.whisper.honorsAbort = false
    const running = h.voiceMessage()
    h.queue.enqueue(h.job(running.id))
    h.queue.enqueue(h.job(h.voiceMessage().id))
    await until(() => h.whisper.calls.length === 1)

    h.queue.stopAll()
    assert.equal(h.whisper.calls[0].signal.aborted, true)
    h.whisper.calls[0].answer('too late')
    h.queue.enqueue(h.job(h.voiceMessage().id))
    await h.queue.idle()
    await settle()

    assert.equal(h.store.getMessage(running.id)!.transcript, undefined)
    assert.equal(h.whisper.calls.length, 1)
    assert.deepEqual(h.announced, [])
  } finally {
    h.close()
  }
})

test('a shutdown with a job running logs nothing, not even once the job has unwound', async () => {
  const h = harness()
  try {
    h.queue.enqueue(h.job(h.voiceMessage().id))
    h.queue.enqueue(h.job(h.voiceMessage().id))
    await until(() => h.whisper.calls.length === 1)
    h.queue.stopAll()
    await h.queue.idle()
    await settle()
    assert.deepEqual(h.logged, [])
  } finally {
    h.close()
  }
})

test('a message deleted before its words arrive gets nothing and announces nothing', async () => {
  const h = harness()
  try {
    const m = h.voiceMessage()
    h.queue.enqueue(h.job(m.id))
    await until(() => h.whisper.calls.length === 1)
    h.store.deleteConversation(h.conv.id)
    h.whisper.calls[0].answer('words')
    await h.queue.idle()
    assert.equal(h.store.getMessage(m.id), null)
    assert.deepEqual(h.announced, [])
  } finally {
    h.close()
  }
})

test('pause mid-job aborts it without writing, and the same job runs first after resume', async () => {
  const h = harness()
  try {
    const first = h.voiceMessage()
    const second = h.voiceMessage()
    h.queue.enqueue(h.job(first.id))
    h.queue.enqueue(h.job(second.id))
    await until(() => h.whisper.calls.length === 1)

    h.queue.pause()
    assert.equal(h.whisper.calls[0].signal.aborted, true)
    h.whisper.calls[0].answer('heard while paused')
    await settle()
    assert.equal(h.whisper.calls.length, 1, 'nothing starts while paused')
    assert.equal(h.store.getMessage(first.id)!.transcript, undefined)

    h.queue.resume()
    await until(() => h.whisper.calls.length === 2)
    h.whisper.calls[1].answer('first again')
    await until(() => h.whisper.calls.length === 3)
    h.whisper.calls[2].answer('second')
    await h.queue.idle()
    assert.equal(h.store.getMessage(first.id)!.transcript, 'first again')
    assert.equal(h.store.getMessage(second.id)!.transcript, 'second')
    assert.deepEqual(h.logged, [], 'a yield is not a failure')
  } finally {
    h.close()
  }
})

test('pauses are counted: pause, pause, resume starts nothing; the last resume starts the next job', async () => {
  const h = harness()
  try {
    h.queue.pause()
    h.queue.pause()
    h.queue.enqueue(h.job(h.voiceMessage().id))
    h.queue.resume()
    await settle()
    assert.equal(h.whisper.calls.length, 0, 'an enqueue while paused waits')
    h.queue.resume()
    await until(() => h.whisper.calls.length === 1)
  } finally {
    h.close()
  }
})

test(`a job interrupted by a pause ${TRANSCRIPT_MAX_YIELDS} times is dropped and logged, and the next job runs`, async () => {
  const h = harness()
  try {
    const yielding = h.voiceMessage()
    const next = h.voiceMessage()
    h.queue.enqueue(h.job(yielding.id))
    h.queue.enqueue(h.job(next.id))
    for (let i = 1; i <= TRANSCRIPT_MAX_YIELDS; i++) {
      await until(() => h.whisper.calls.length === i)
      h.queue.pause()
      h.queue.resume()
    }
    await until(() => h.whisper.calls.length === TRANSCRIPT_MAX_YIELDS + 1)
    h.whisper.calls[TRANSCRIPT_MAX_YIELDS].answer('next')
    await h.queue.idle()

    assert.equal(h.store.getMessage(yielding.id)!.transcript, undefined)
    assert.equal(h.store.getMessage(next.id)!.transcript, 'next')
    assert.equal(h.logged.length, 1)
    assert.ok(h.logged[0].includes(yielding.id), h.logged[0])
  } finally {
    h.close()
  }
})

test('stopAll while paused leaves nothing to resume', async () => {
  const h = harness()
  try {
    h.queue.enqueue(h.job(h.voiceMessage().id))
    await until(() => h.whisper.calls.length === 1)
    h.queue.pause()
    h.queue.stopAll()
    h.queue.resume()
    await h.queue.idle()
    await settle()
    assert.equal(h.whisper.calls.length, 1)
  } finally {
    h.close()
  }
})

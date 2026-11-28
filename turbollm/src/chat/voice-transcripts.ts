// A voice message's words (ADR-485 D1, arch 2.9): after the reply, its clip goes to whisper in the background and the
// text is saved as the message's transcript. One job at a time: whisper-server is one process, and a dictation from
// the composer must not wait behind several of these. No engine slot and no generation gate is taken (ADR-457).
// Transcription yields to a spoken reply (AA-5): while paused no job starts, and the running one goes back to the
// front of the queue. Once stopped (PG-3) nothing is queued, started or written again.
import type { AttachmentStore } from './attachments.js'
import type { ConversationStore } from './db.js'
import { decodeWavClips, pcm16ToWav } from '../engines/audio-reply/wav.js'
import { emitInvalidation } from '../events/bus.js'
import type { VoiceService } from '../voice/voice-service.js'

export const TRANSCRIPT_JOB_TIMEOUT_MS = 60_000
export const TRANSCRIPT_QUEUE_MAX = 16
/** How many times a job may give way to a spoken reply before it is dropped (AA-5). */
export const TRANSCRIPT_MAX_YIELDS = 3

export interface VoiceTranscriptsDeps {
  db: Pick<ConversationStore, 'getMessage' | 'setMessageTranscript'> & { attachments: Pick<AttachmentStore, 'inline'> }
  voice: Pick<VoiceService, 'available' | 'transcribeText'> | undefined
  /** emitInvalidation by default. */
  announce?: (key: string) => void
  log?: (msg: string) => void
  /** TRANSCRIPT_JOB_TIMEOUT_MS by default; a test sets a short one. */
  jobTimeoutMs?: number
}

export interface TranscriptJob {
  convId: string
  messageId: string
  clips: string[]
}

interface QueuedJob extends TranscriptJob {
  yields: number
}

interface RunningJob {
  job: QueuedJob
  stop: AbortController
  cancelled: boolean
}

/** The abort reason of a job that gives way to a spoken reply: requeued, not failed. */
const YIELDED = Symbol('yielded to a spoken reply')

export class VoiceTranscripts {
  private readonly pending: QueuedJob[] = []
  private running: RunningJob | null = null
  private pauses = 0
  private closed = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly deps: VoiceTranscriptsDeps) {}

  /** Queues a voice message's clips for transcription; a no-op without speech-to-text or once stopped. */
  enqueue(job: TranscriptJob): void {
    if (this.closed || !this.deps.voice?.available()) return
    this.pending.push({ ...job, yields: 0 })
    if (this.pending.length > TRANSCRIPT_QUEUE_MAX) {
      const dropped = this.pending.shift()!
      this.log(`voice transcript: queue full, dropped message ${dropped.messageId}`)
    }
    this.startNext()
  }

  /** A spoken reply starts: no job starts until every pause is resumed, and the running one gives way. */
  pause(): void {
    this.pauses++
    this.running?.stop.abort(YIELDED)
  }

  resume(): void {
    if (this.pauses === 0) return
    this.pauses--
    this.startNext()
  }

  /** A chat is deleted: its waiting jobs are dropped and its running one is aborted. */
  cancelConversation(convId: string): void {
    this.dropPendingWhere((job) => job.convId === convId)
    if (this.running?.job.convId === convId) this.cancelRunning()
  }

  /** Teardown: nothing is queued, started or written from now on. */
  stopAll(): void {
    this.closed = true
    this.dropPendingWhere(() => true)
    this.cancelRunning()
    this.settleIdle()
  }

  /** For tests and teardown: resolves when the queue is empty. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private startNext(): void {
    if (this.running || this.closed || this.pauses > 0) return this.settleIdle()
    const job = this.pending.shift()
    if (!job) return this.settleIdle()
    const running: RunningJob = { job, stop: new AbortController(), cancelled: false }
    this.running = running
    void this.run(job, running.stop.signal).finally(() => this.finish(running))
  }

  private finish(running: RunningJob): void {
    this.running = null
    if (running.stop.signal.reason === YIELDED && !running.cancelled && !this.closed) this.requeueYielded(running.job)
    this.startNext()
  }

  private requeueYielded(job: QueuedJob): void {
    const yields = job.yields + 1
    if (yields >= TRANSCRIPT_MAX_YIELDS) {
      this.log(`voice transcript: message ${job.messageId} gave way to spoken replies ${yields} times, dropped`)
      return
    }
    this.pending.unshift({ ...job, yields })
  }

  private async run(job: QueuedJob, stop: AbortSignal): Promise<void> {
    try {
      const words = await this.transcribe(job, stop)
      if (stop.aborted || this.closed) return
      if (!words) return this.log(`voice transcript: no words in message ${job.messageId}`)
      if (this.deps.db.setMessageTranscript(job.messageId, words)) this.announce(`conversation:${job.convId}`)
    } catch (error) {
      if (stop.reason === YIELDED) return
      this.log(`voice transcript: message ${job.messageId} not transcribed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async transcribe(job: QueuedJob, stop: AbortSignal): Promise<string> {
    const wav = await this.wavOf(job.clips)
    stop.throwIfAborted()
    const signal = AbortSignal.any([stop, AbortSignal.timeout(this.deps.jobTimeoutMs ?? TRANSCRIPT_JOB_TIMEOUT_MS)])
    const { text } = await this.deps.voice!.transcribeText(new Blob([new Uint8Array(wav)]), {}, signal)
    return text.trim()
  }

  /** The turn's clips as one WAV, as whisper reads it. */
  private async wavOf(clips: string[]): Promise<Buffer> {
    const wavs = await Promise.all(clips.map(async (clip) => bytesOfDataUrl(await this.deps.db.attachments.inline(clip))))
    const { pcm16, sampleRate } = decodeWavClips(wavs)
    return pcm16ToWav(pcm16, sampleRate)
  }

  private cancelRunning(): void {
    if (!this.running) return
    this.running.cancelled = true
    this.running.stop.abort()
  }

  private dropPendingWhere(dropped: (job: QueuedJob) => boolean): void {
    const kept = this.pending.filter((job) => !dropped(job))
    this.pending.splice(0, this.pending.length, ...kept)
  }

  private isIdle(): boolean {
    return !this.running && (this.pending.length === 0 || this.closed)
  }

  private settleIdle(): void {
    if (!this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private announce(key: string): void {
    (this.deps.announce ?? emitInvalidation)(key)
  }

  private log(msg: string): void {
    (this.deps.log ?? console.log)(msg)
  }
}

/** A stored clip's bytes from the data URL AttachmentStore.inline gives back. */
function bytesOfDataUrl(dataUrl: string | null): Buffer {
  const comma = dataUrl?.indexOf(',') ?? -1
  if (!dataUrl?.startsWith('data:') || comma < 0) throw new Error('its recording is no longer stored')
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

// A chat turn answered with speech. The ordinary turn (generation-core.ts) streams text from /v1/chat/completions;
// this one asks the engine's spoken-reply runtime (engines/audio-reply) for a finished clip with its transcript, and
// writes the same things a text turn writes, so the page needs nothing new to follow it: a `delta` with the text,
// then `done` with the saved message, or `error` and then `done` when the engine fails.
//
// Nothing here knows a runtime's wire. prepareAudioReplyTurn decides, before anything is stored, whether the turn can
// be answered aloud at all and turns the recording into what a runtime takes; runAudioReply runs it and persists it.
//
// What is stored: the message content is the reply's text, and the clip is saved through the same attachment store a
// voice message's clip is (attachments.ts), its reference on the assistant message's `attachments`. So the janitor, the
// retention sweep and the size limits are the existing ones, and a message deleted leaves the file for the janitor.
// A reply with text and no clip is just text; one with a clip and no text has empty content, and its player is the
// message (the page shows a voice message the same way).
import type { Deps } from '../deps.js'
import {
  audioReplyRuntimeFor, AudioReplyError, DEFAULT_AUDIO_REPLY_MAX_TOKENS,
  type AudioReply, type AudioReplyRequest, type AudioReplyRuntime,
} from '../engines/audio-reply/index.js'
import { withUserNote } from '../engines/audio-reply/instructions.js'
import { decodeWavClips, decodeWavToPcm16Mono, pcm16ToWav, type DecodedWav } from '../engines/audio-reply/wav.js'
import { noteLocalActivity } from '../link/host-idle.js'
import { audioAttachmentFormat, isAudioAttachment } from './attachments.js'
import { createAudioFramer, type AudioFramer } from './audio-frames.js'
import { HEARD_COMPLETE_FRACTION, heardPcm, heardText } from './spoken-reply-cut.js'
import { buildAudioReplyInstructions } from './chat-compaction.js'
import type { ChatUpstream } from './chat-upstream.js'
import type { Conversation, Message, MessageStats } from './db.js'
import type { EmitSink } from './emit-sink.js'
import { resilientSink } from './generation-core.js'

/** A turn that may be answered aloud: the runtime to ask, and the one new turn as the runtime takes it. */
export interface SpokenTurn {
  runtime: AudioReplyRuntime
  input: AudioReplyRequest['input']
  /** Typed words that came with a recording, which go to the model beside it as the user's note. */
  note: string
}

export type SpokenTurnCheck =
  | { ok: true; turn: SpokenTurn }
  | { ok: false; status: 400 | 409; code: string; message: string }

/** Whether the turn about to be stored can be answered aloud, decided before anything is written so a refusal leaves
 *  no row and no file behind. `audio` are the turn's clips as the route received them (data URLs or stored
 *  references); `text` its typed words with any attached documents folded in. */
export async function prepareAudioReplyTurn(
  d: Pick<Deps, 'db'>,
  upstream: ChatUpstream,
  turn: { audio: string[]; images: string[]; text: string },
): Promise<SpokenTurnCheck> {
  // A linked host's model and a pool slot's never carry speaksAudio, whatever engine they run.
  const runtime = upstream.remote || !upstream.speaksAudio ? null : audioReplyRuntimeFor(upstream.engineKind)
  if (!runtime) {
    return {
      ok: false, status: 409, code: 'audio_output_unsupported',
      message: `${upstream.modelName} cannot answer aloud. Send the message without asking for a spoken reply, or load a model that outputs audio.`,
    }
  }
  if (turn.images.length) {
    return { ok: false, status: 400, code: 'invalid_input', message: 'A spoken reply cannot take images. Send the message without them, or without asking for a spoken reply.' }
  }
  if (turn.audio.length === 0) {
    // A typed question can be answered aloud too.
    if (!turn.text) return { ok: false, status: 400, code: 'invalid_input', message: 'Type a message or record one to get a spoken reply.' }
    return { ok: true, turn: { runtime, input: { kind: 'text', text: turn.text }, note: '' } }
  }
  const wavs: Buffer[] = []
  for (const clip of turn.audio) {
    if (audioAttachmentFormat(clip) !== 'wav') {
      return { ok: false, status: 400, code: 'audio_format_unsupported', message: 'A spoken reply needs the recording as a WAV file; MP3 cannot be read here. Record again, or send a WAV.' }
    }
    const url = await d.db.attachments.inline(clip)
    if (url === null) return { ok: false, status: 400, code: 'invalid_input', message: 'A voice clip is no longer available.' }
    wavs.push(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
  }
  try {
    const { pcm16, sampleRate } = decodeWavClips(wavs)
    return { ok: true, turn: { runtime, input: { kind: 'audio', pcm16, sampleRate }, note: turn.text } }
  } catch (e) {
    return { ok: false, status: 400, code: 'audio_format_unsupported', message: (e as Error).message }
  }
}

export interface AudioReplyCtx {
  convId: string
  conv: Conversation
  /** The turns before this one, as they stand in the conversation. */
  history: Message[]
  assistantMsg: Message
  upstream: ChatUpstream
  ac: AbortController
  turn: SpokenTurn
  userMessageId: string
  /** The turn's stored voice clips (attachment refs): what the transcript job reads. Empty for a typed question. */
  clips: string[]
  /** The run's transient lane, present only when the sending page asked for streamed audio. */
  live?: (event: string, data: unknown, bytes: number) => void
}

export interface AudioReplyOutcome {
  aborted: boolean
  /** The reply's words, empty when there were none or the engine failed. */
  content: string
}

/** The instructions a runtime is given: the conversation as text (buildAudioReplyInstructions), and the typed note
 *  that came with a recording. */
function instructionsFor(ctx: AudioReplyCtx): string {
  return withUserNote(buildAudioReplyInstructions(ctx.conv, ctx.history, ctx.upstream.ctxMax), ctx.turn.note)
}

/** Runs the turn and persists it. Every exit saves the placeholder: a finished reply, a stopped one (whatever arrived,
 *  marked aborted) and an engine failure (an error frame, then the empty reply, as a text turn leaves one).
 *  With `ctx.live` the reply's audio is streamed as it arrives (`audio_chunk` on the transient lane), and `audio_end`
 *  reports what was sent before the text or the error. A heard report made while the reply ran cuts the saved reply to
 *  what was heard before `done` (PG-4). After `done`, a recorded question's clip goes to the transcript queue. */
export async function runAudioReply(d: Deps, emit: EmitSink, ctx: AudioReplyCtx): Promise<AudioReplyOutcome> {
  d.chatTurns.beginSpokenReply(ctx.assistantMsg.id)
  try {
    return await runSpokenTurn(d, emit, ctx)
  } finally {
    d.chatTurns.finishSpokenReply(ctx.assistantMsg.id)
    queueTranscript(d, ctx)
  }
}

async function runSpokenTurn(d: Deps, emit: EmitSink, ctx: AudioReplyCtx): Promise<AudioReplyOutcome> {
  const { db } = d
  const { convId, assistantMsg, upstream, ac } = ctx
  const sink = resilientSink(emit)
  const started = Date.now()
  const framer = ctx.live && createAudioFramer({ replyId: assistantMsg.id, emit: (f) => ctx.live!('audio_chunk', f, f.pcm16.length) })
  let content = ''
  let attachments: string[] = []
  let aborted = false
  let failed = false
  let outputTokens: number | undefined
  let generationMs: number | undefined

  noteLocalActivity()
  d.manager.generationStart()
  // The transcript queue's whisper gives way to the engine while it speaks (AA-5).
  d.transcripts?.pause()
  let settled: { reply: AudioReply } | { error: unknown }
  try {
    settled = { reply: await ctx.turn.runtime.reply(upstream.target, spokenRequest(ctx, framer), ac.signal) }
  } catch (error) {
    settled = { error }
  } finally {
    d.manager.generationEnd()
    d.transcripts?.resume()
  }
  if (framer) await sink({ event: 'audio_end', data: framer.flush() })

  try {
    if ('error' in settled) throw settled.error
    const { reply } = settled
    aborted = reply.status === 'cancelled' || ac.signal.aborted
    content = reply.text
    outputTokens = reply.outputTokens
    generationMs = reply.generationMs
    if (content) await sink({ event: 'delta', data: { delta: content } })
    if (reply.audio) {
      // A full disk keeps the clip inline in the row, as an image is, rather than losing the reply.
      attachments = await db.attachments.save([`data:audio/wav;base64,${reply.audio.data.toString('base64')}`])
    }
  } catch (e) {
    aborted = ac.signal.aborted
    if (!aborted) {
      failed = true
      const message = e instanceof AudioReplyError ? e.message : (e as Error)?.message || 'The audio reply failed.'
      await sink({ event: 'error', data: { code: 'engine_error', message } })
    }
  }

  const totalMs = Date.now() - started
  const stats: Partial<MessageStats> = {
    totalMs,
    // Speed is of the generation alone (first output to the end of the reply), never of the whole turn, which also holds
    // connecting, reading the recording and a stop's wait: without that timing the speed is left out, not guessed.
    ...(outputTokens === undefined ? {} : { genTokens: outputTokens }),
    ...(outputTokens !== undefined && generationMs ? { genMs: generationMs, tps: Math.round((outputTokens / generationMs) * 1000 * 10) / 10 } : {}),
    ctxMax: upstream.ctxMax,
    model: upstream.modelName,
    aborted,
  }
  // A heard report lands either before this line (applied here) or after it, onto the saved row (the route applies it).
  // Nothing awaits between the two lines, so none is lost (PG-4).
  const heardMs = d.chatTurns.finishSpokenReply(assistantMsg.id)
  db.updateMessage(assistantMsg.id, { content, reasoning: '', toolCalls: [], stats, ...(attachments.length ? { attachments } : {}) })
  if (heardMs !== undefined && attachments.length) await applyHeardToSavedReply(d, db.getMessage(assistantMsg.id)!, heardMs)
  db.touchConversation(convId)
  if (!failed) {
    try {
      d.manager.recordCompletion({ outputTokens })
    } catch { /* stats are best-effort */ }
  }
  d.chatTurns.release(convId, ac)
  await sink({ event: 'done', data: { message: db.getMessage(assistantMsg.id) } })
  return { aborted, content }
}

/** What the runtime is asked. Without a live viewer it is exactly the request it always was (no `onAudio`). */
function spokenRequest(ctx: AudioReplyCtx, framer: AudioFramer | undefined): AudioReplyRequest {
  return {
    instructions: instructionsFor(ctx),
    input: ctx.turn.input,
    // Sized for speech, not the text turn's token limit setting: an audio token is a frame of speech (about 80 ms), so
    // that limit would cut a reply to a few seconds.
    maxOutputTokens: DEFAULT_AUDIO_REPLY_MAX_TOKENS,
    ...(framer ? { onAudio: (c) => framer.push(c.pcm16, c.sampleRate) } : {}),
  }
}

/** The user still said something, whether the reply completed, was stopped or failed: its words are made in the
 *  background, after the reply (ADR-485 D1). A typed question has no clip to read. Never awaited. */
function queueTranscript(d: Deps, ctx: AudioReplyCtx): void {
  if (ctx.turn.input.kind !== 'audio' || !ctx.clips.length) return
  d.transcripts?.enqueue({ convId: ctx.convId, messageId: ctx.userMessageId, clips: ctx.clips })
}

/** Cuts a saved spoken reply to what its listener heard (arch 2.6, A4): its text to the last whole sentence heard and
 *  its clip to the samples heard, saved as a new clip swapped in with a compare-and-swap (tried once more if another
 *  change won the race). It only ever shrinks: `unchanged` when a cut as small or smaller was already applied, when the
 *  reply was edited, or when the cut keeps everything. A cut below one sample keeps a zero-sample clip, so the reply
 *  stays a spoken one (PG-5). */
export async function applyHeardToSavedReply(d: Pick<Deps, 'db'>, msg: Message, heardMs: number): Promise<'saved' | 'unchanged'> {
  const first = await cutSavedReply(d, msg, heardMs)
  if (first !== 'lost-race') return first
  const reread = d.db.getMessage(msg.id)
  if (!reread) return 'unchanged'
  const second = await cutSavedReply(d, reread, heardMs)
  return second === 'lost-race' ? 'unchanged' : second
}

async function cutSavedReply(d: Pick<Deps, 'db'>, msg: Message, heardMs: number): Promise<'saved' | 'unchanged' | 'lost-race'> {
  const { db } = d
  if (msg.edited || (msg.stats.heardMs !== undefined && msg.stats.heardMs <= heardMs)) return 'unchanged'
  const clipRef = msg.attachments.find(isAudioAttachment)
  const previousJson = db.messageAttachmentsJson(msg.id)
  if (!clipRef || previousJson === null) return 'unchanged'
  const clip = await readClip(d, clipRef)
  if (!clip) return 'unchanged'
  const clipMs = (clip.pcm16.length / 2 / clip.sampleRate) * 1000
  if (heardMs / clipMs >= HEARD_COMPLETE_FRACTION) return 'unchanged'
  const text = heardText(msg.content, heardMs, clipMs)
  const pcm16 = heardPcm(clip.pcm16, clip.sampleRate, heardMs)
  if (text === msg.content && pcm16.length === clip.pcm16.length) return 'unchanged'
  const [cutClip] = await db.attachments.save([`data:audio/wav;base64,${pcm16ToWav(pcm16, clip.sampleRate).toString('base64')}`])
  const next = msg.attachments.map((a) => (a === clipRef ? cutClip : a))
  if (!db.replaceMessageAttachments(msg.id, previousJson, next)) return 'lost-race'
  db.updateMessage(msg.id, { content: text, stats: { ...msg.stats, heardMs } })
  return 'saved'
}

/** A stored clip's samples, or null when it is gone or cannot be read. */
async function readClip(d: Pick<Deps, 'db'>, ref: string): Promise<DecodedWav | null> {
  const url = await d.db.attachments.inline(ref)
  if (url === null) return null
  try {
    return decodeWavToPcm16Mono(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
  } catch {
    return null
  }
}

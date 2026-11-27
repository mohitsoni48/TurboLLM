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
  type AudioReplyRequest, type AudioReplyRuntime,
} from '../engines/audio-reply/index.js'
import { withUserNote } from '../engines/audio-reply/instructions.js'
import { decodeWavClips } from '../engines/audio-reply/wav.js'
import { noteLocalActivity } from '../link/host-idle.js'
import { audioAttachmentFormat } from './attachments.js'
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
 *  marked aborted) and an engine failure (an error frame, then the empty reply, as a text turn leaves one). */
export async function runAudioReply(d: Deps, emit: EmitSink, ctx: AudioReplyCtx): Promise<AudioReplyOutcome> {
  const { db } = d
  const { convId, assistantMsg, upstream, ac } = ctx
  const sink = resilientSink(emit)
  const started = Date.now()
  let content = ''
  let attachments: string[] = []
  let aborted = false
  let failed = false
  let outputTokens: number | undefined
  let generationMs: number | undefined

  noteLocalActivity()
  d.manager.generationStart()
  try {
    const reply = await ctx.turn.runtime.reply(
      upstream.target,
      {
        instructions: instructionsFor(ctx),
        input: ctx.turn.input,
        // Sized for speech, not the text turn's token limit setting: an audio token is a frame of speech (about 80 ms), so
        // that limit would cut a reply to a few seconds.
        maxOutputTokens: DEFAULT_AUDIO_REPLY_MAX_TOKENS,
      },
      ac.signal,
    )
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
  } finally {
    d.manager.generationEnd()
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
  db.updateMessage(assistantMsg.id, { content, reasoning: '', toolCalls: [], stats, ...(attachments.length ? { attachments } : {}) })
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

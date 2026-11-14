// Full voice mode (GitHub #311, maintainer's stated next step): one toggle turns the chat into a
// hands-free conversation - record, hear the reply spoken, record again - instead of three separate
// switches (auto-stop, auto-send, read-aloud) that still need a tap between turns.
//
// This module is the loop's state machine and nothing else: no DOM, no recorder, no network. The
// wiring hook (use-conversation-mode) feeds it events and performs its effects, so every transition
// is testable in node. The rules it encodes:
//
//   idle -> recording -> transcribing -> generating -> speaking -> recording -> ...
//
// - The mic only reopens AFTER the reply has been read to the end: opening it while the reply is
//   still speaking would record TurboLLM's own voice and send it back as the user's next turn.
// - Interrupting (one tap) stops the speech and the reply's place in the loop and goes straight
//   back to recording: barge-in is the point of talking instead of typing.
// - A failure anywhere (no speech heard, transcription failed, the model errored, TTS missing)
//   ends the turn at idle, with the mode still on: the next tap starts a fresh turn, and one bad
//   turn does not disable the mode.
// - Turning the mode off cancels whatever is mid-flight: recording, speech, or the wait for the
//   reply.

/** Where one hands-free turn is. */
export type ConversationPhase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'generating'
  | 'speaking'

/** Events the wiring reports to the machine. */
export type ConversationEvent =
  /** The mode toggle turned on (from idle or mid-turn: a fresh turn starts). */
  | { type: 'start' }
  /** The mode toggle turned off, or the conversation's chat was left. */
  | { type: 'stop' }
  /** One tap on the mic while the mode is on: barge-in - stop speaking, hear me now. */
  | { type: 'interrupt' }
  /** The recorder ended a clip (silence auto-stop, its time cap, or Done). */
  | { type: 'clip-ended' }
  /** The recording held no speech (silence the whole time, or the user cancelled). */
  | { type: 'clip-empty' }
  /** The clip became a sent user message (transcribed then auto-sent, or attached then sent). */
  | { type: 'message-sent' }
  /** Sending or transcribing failed. */
  | { type: 'send-failed' }
  /** The reply finished streaming. */
  | { type: 'reply-done' }
  /** The reply failed or was stopped before any speech of it could start. */
  | { type: 'reply-failed' }
  /** The reply's read-aloud reached its end. */
  | { type: 'speak-done' }
  /** Reading the reply aloud could not start or broke off (no voice, audio denied). */
  | { type: 'speak-failed' }

/** Side effects the machine asks the wiring to perform, in the order they must happen. */
export type ConversationEffect =
  /** Open the mic for a fresh turn. */
  | { type: 'start-recording' }
  /** A recording is open and should end now (mode off, or barge-in while recording). */
  | { type: 'cancel-recording' }
  /** The reply is being read aloud and should stop now (barge-in, or mode off). */
  | { type: 'stop-speaking' }
  /** The mode is off: anything still generating belongs to the normal chat again, not the loop. */
  | { type: 'detach' }

export interface ConversationTransition {
  readonly phase: ConversationPhase
  readonly effects: readonly ConversationEffect[]
}

const IDLE: ConversationTransition = { phase: 'idle', effects: [] }

/** The one record the machine keeps: the phase the turn is in. All context lives in the events. */
export function reduceConversation(phase: ConversationPhase, event: ConversationEvent): ConversationTransition {
  switch (event.type) {
    case 'start':
      // From anywhere, including mid-turn: a fresh turn begins with the mic open. Speech stops so
      // it is not recorded, and a recording already open is ended so its clip is not sent twice.
      return {
        phase: 'recording',
        effects: [
          ...(phase === 'speaking' ? [{ type: 'stop-speaking' } as const] : []),
          ...(phase === 'recording' ? [{ type: 'cancel-recording' } as const] : []),
          { type: 'start-recording' },
        ],
      }

    case 'stop':
      if (phase === 'idle') return IDLE
      return {
        phase: 'idle',
        effects: [
          ...(phase === 'recording' ? [{ type: 'cancel-recording' } as const] : []),
          ...(phase === 'speaking' ? [{ type: 'stop-speaking' } as const] : []),
          { type: 'detach' },
        ],
      }

    case 'interrupt':
      // Barge-in matters while the reply is speaking or still being written; earlier in the turn
      // the mic is already the live thing, so the tap only ends the current clip.
      if (phase === 'speaking') return { phase: 'recording', effects: [{ type: 'stop-speaking' }, { type: 'start-recording' }] }
      if (phase === 'generating') return { phase: 'recording', effects: [{ type: 'start-recording' }] }
      return { phase, effects: [] }

    case 'clip-ended':
      if (phase !== 'recording') return { phase, effects: [] }
      return { phase: 'transcribing', effects: [] }

    case 'clip-empty':
      // Nothing was said (or the clip was cancelled by barge-in/off): the turn is over, the mode
      // is not. A cancelled clip must never reach transcribing, or an empty message would send.
      return IDLE

    case 'message-sent':
      if (phase !== 'transcribing') return { phase, effects: [] }
      return { phase: 'generating', effects: [] }

    case 'send-failed':
      return IDLE

    case 'reply-done':
      if (phase !== 'generating') return { phase, effects: [] }
      return { phase: 'speaking', effects: [] }

    case 'reply-failed':
      // A reply that never started speaking has nothing to wait out: idle, mode still on.
      return IDLE

    case 'speak-done':
      if (phase !== 'speaking') return { phase, effects: [] }
      return { phase: 'recording', effects: [{ type: 'start-recording' }] }

    case 'speak-failed':
      // The reply is on screen unread; the loop cannot hear its cue to continue. Back to idle so
      // the next turn starts on the user's tap instead of never, or over the unread reply.
      return IDLE
  }
}

/** Every effect of a transition has fired; adopt its phase. */
export function applyConversation(phase: ConversationPhase, event: ConversationEvent): ConversationPhase {
  return reduceConversation(phase, event).phase
}

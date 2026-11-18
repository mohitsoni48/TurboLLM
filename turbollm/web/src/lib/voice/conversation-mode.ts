// Full voice mode (GitHub #311, maintainer's stated next step): one toggle turns the chat into a
// hands-free conversation - record, hear the reply spoken, record again - instead of three separate
// switches (auto-stop, auto-send, read-aloud) that still need a tap between turns.
//
// This module is the loop's state machine and nothing else: no DOM, no recorder, no network. The
// wiring hook (useConversationMode) feeds it events and performs its effects, so every transition
// is testable in node. The state is two things, kept apart on purpose:
//
//   on     whether the mode is on: only the toggle, leaving the chat or hiding the tab change it.
//   phase  where the current turn is: idle -> recording -> transcribing -> generating -> speaking -> recording -> ...
//
// Rules it encodes:
//
// - The mic only reopens AFTER the reply has been read to the end: opening it while the reply is
//   still speaking would record TurboLLM's own voice and send it back as the user's next turn.
// - A failure anywhere (no speech heard, transcription failed or came back empty, the microphone
//   would not open, the send was refused, the model errored, TTS missing) ends the TURN: the phase
//   goes to idle and `on` stays true. The next tap on the mic starts a fresh turn.
// - A tap on the mic is barge-in from every phase but recording (where it finishes the clip, which
//   the screen handles): it stops the speech, aborts a reply that is still being written, or drops
//   a transcription, and goes straight back to recording. From idle it starts the next turn.
// - Turning the mode off cancels whatever is mid-flight: recording, transcription or speech. A
//   reply that is still being written is left to finish: it belongs to the normal chat again.
// - Events that arrive while the mode is off, or for a phase that has moved on, change nothing.

/** Where one hands-free turn is. */
export type ConversationPhase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'generating'
  | 'speaking'

/** The one record the machine keeps. All other context lives in the events. */
export interface ConversationState {
  readonly on: boolean
  readonly phase: ConversationPhase
}

export const CONVERSATION_OFF: ConversationState = { on: false, phase: 'idle' }

/** Events the wiring reports to the machine. */
export type ConversationEvent =
  /** The mode toggle turned on (a fresh turn starts, from any phase). */
  | { type: 'start' }
  /** The mode toggle turned off, the chat was left, or the tab was hidden. */
  | { type: 'stop' }
  /** One tap on the mic while the mode is on: barge-in, or the start of the next turn from idle. */
  | { type: 'interrupt' }
  /** The recorder ended a clip (silence auto-stop, its time cap, or Done) and it is being transcribed. */
  | { type: 'clip-ended' }
  /** The turn produced no message: no speech, a cancelled clip, an empty or failed transcription, a microphone that
   *  would not open. */
  | { type: 'clip-empty' }
  /** The clip became a user message handed to the chat (transcribed then sent, or attached as audio then sent). */
  | { type: 'message-sent' }
  /** The message could not be sent (a reply still running, no model ready, the daemon refused it). */
  | { type: 'send-failed' }
  /** The reply finished streaming and is being read aloud. */
  | { type: 'reply-done' }
  /** The reply never started, failed, or was stopped before any speech of it could start. */
  | { type: 'reply-failed' }
  /** The reply's read-aloud reached its end. */
  | { type: 'speak-done' }
  /** Reading the reply aloud could not start or broke off (no voice, audio denied). */
  | { type: 'speak-failed' }

/** Side effects the machine asks the wiring to perform, in the order they must happen. */
export type ConversationEffect =
  /** Open the mic for a fresh turn. */
  | { type: 'start-recording' }
  /** Drop the recording or the transcription in progress, without using it. */
  | { type: 'cancel-recording' }
  /** The reply is being read aloud and should stop now. */
  | { type: 'stop-speaking' }
  /** The reply is still being written and should be stopped now (barge-in). */
  | { type: 'stop-reply' }

export interface ConversationTransition {
  readonly state: ConversationState
  readonly effects: readonly ConversationEffect[]
}

const stay = (state: ConversationState): ConversationTransition => ({ state, effects: [] })
const turn = (state: ConversationState, phase: ConversationPhase, effects: readonly ConversationEffect[] = []): ConversationTransition =>
  ({ state: { on: state.on, phase }, effects })

export function reduceConversation(state: ConversationState, event: ConversationEvent): ConversationTransition {
  const { phase } = state

  if (event.type === 'start') {
    // From anywhere, including mid-turn: a fresh turn begins with the mic open. Speech stops so it is not recorded, a reply
    // still being written is stopped, and a recording or transcription already open is dropped so it is not sent twice.
    return {
      state: { on: true, phase: 'recording' },
      effects: [
        ...(phase === 'speaking' ? [{ type: 'stop-speaking' } as const] : []),
        ...(phase === 'generating' ? [{ type: 'stop-reply' } as const] : []),
        ...(phase === 'recording' || phase === 'transcribing' ? [{ type: 'cancel-recording' } as const] : []),
        { type: 'start-recording' },
      ],
    }
  }

  // Off: nothing but `start` does anything.
  if (!state.on) return stay(CONVERSATION_OFF)

  switch (event.type) {
    case 'stop':
      return {
        state: CONVERSATION_OFF,
        effects: [
          ...(phase === 'recording' || phase === 'transcribing' ? [{ type: 'cancel-recording' } as const] : []),
          ...(phase === 'speaking' ? [{ type: 'stop-speaking' } as const] : []),
        ],
      }

    case 'interrupt':
      switch (phase) {
        case 'idle': return turn(state, 'recording', [{ type: 'start-recording' }])
        case 'speaking': return turn(state, 'recording', [{ type: 'stop-speaking' }, { type: 'start-recording' }])
        case 'generating': return turn(state, 'recording', [{ type: 'stop-reply' }, { type: 'start-recording' }])
        case 'transcribing': return turn(state, 'recording', [{ type: 'cancel-recording' }, { type: 'start-recording' }])
        // The clip is already live: the screen finishes it on this tap.
        case 'recording': return stay(state)
      }
      return stay(state)

    case 'clip-ended':
      return phase === 'recording' ? turn(state, 'transcribing') : stay(state)

    case 'clip-empty':
      // Nothing was said, or the clip was cancelled, or transcription gave nothing: the turn is over, the mode is not. A
      // late clip-empty for a turn that has moved on (the audio route sends before the recorder lets go) is ignored.
      return phase === 'recording' || phase === 'transcribing' ? turn(state, 'idle') : stay(state)

    case 'message-sent':
      // The audio route hands the clip over straight from recording; the text route from transcribing.
      return phase === 'recording' || phase === 'transcribing' ? turn(state, 'generating') : stay(state)

    case 'send-failed':
      return phase === 'recording' || phase === 'transcribing' || phase === 'generating' ? turn(state, 'idle') : stay(state)

    case 'reply-done':
      return phase === 'generating' ? turn(state, 'speaking') : stay(state)

    case 'reply-failed':
      // A reply that never started speaking has nothing to wait out.
      return phase === 'generating' ? turn(state, 'idle') : stay(state)

    case 'speak-done':
      return phase === 'speaking' ? turn(state, 'recording', [{ type: 'start-recording' }]) : stay(state)

    case 'speak-failed':
      // The reply is on screen unread; the loop cannot hear its cue to continue. Back to idle so the next turn starts on the
      // user's tap instead of never, or over the unread reply.
      return phase === 'generating' || phase === 'speaking' ? turn(state, 'idle') : stay(state)
  }
}

/** Every effect of a transition has fired; adopt its state. */
export function applyConversation(state: ConversationState, event: ConversationEvent): ConversationState {
  return reduceConversation(state, event).state
}

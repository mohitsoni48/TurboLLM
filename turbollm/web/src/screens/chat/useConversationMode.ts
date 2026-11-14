// Full voice mode (GitHub #311): the wiring that drives the pure machine in
// lib/voice/conversation-mode.ts from ChatScreen's real pieces - useVoiceInput for the mic, the
// existing send() for the turn, the speaker for the reply, and the stream state for when the reply
// is done.
//
// What the machine never sees lives here: which clip route a hands-free turn takes (an undecided
// "ask every time" cannot work without hands, so enabling the mode settles it to text), how "the
// reply was read to the end" is observed (the speaker's active id clearing), and the small grace
// between the stream ending and its last sentences reaching the speaker.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  reduceConversation,
  type ConversationEffect,
  type ConversationEvent,
  type ConversationPhase,
} from '../../lib/voice/conversation-mode'
import { speaker } from '../../lib/voice/tts'
import { useVoiceStore } from '../../stores/voice'
import type { VoiceInput } from './useVoiceInput'

export interface ConversationModeOptions {
  voice: VoiceInput
  /** True while a reply is streaming in the open chat (live or on the daemon). */
  replyStreaming: boolean
  /** The composer cannot send right now (a reply in flight, no model ready). */
  composerLocked: boolean
}

export interface ConversationMode {
  active: boolean
  phase: ConversationPhase
  /** The one button: off -> on -> (barge-in) -> off is a long press on the mode itself. */
  enable: () => void
  disable: () => void
  /** One tap while on: barge-in. */
  interrupt: () => void
  /** Feed an event from the wiring around it (send succeeded/failed, clip routing). */
  emit: (event: ConversationEvent) => void
}

/** The reply's last sentences are spoken from the saved message just after the stream ends: this
 *  long without the speaker picking the reply up means it is not being read. */
const SPEAK_CLAIM_MS = 1500

export function useConversationMode(opts: ConversationModeOptions): ConversationMode {
  const { voice, replyStreaming, composerLocked } = opts
  const [phase, setPhase] = useState<ConversationPhase>('idle')
  const phaseRef = useRef<ConversationPhase>('idle')
  const wasStreaming = useRef(replyStreaming)
  const lockedRef = useRef(composerLocked)
  lockedRef.current = composerLocked

  const dispatch = useCallback((event: ConversationEvent) => {
    const t = reduceConversation(phaseRef.current, event)
    phaseRef.current = t.phase
    setPhase(t.phase)
    for (const effect of t.effects) runEffect(effect, voice, lockedRef.current, dispatch)
  }, [voice])

  const enable = useCallback(() => {
    // Hands-free cannot stop to ask "audio or text?" after every clip: an undecided route is
    // settled to text (the clip is transcribed, so a mishearing is still fixable afterwards in
    // the message list). An explicit 'audio' choice is kept.
    const store = useVoiceStore.getState()
    if (store.audioMode === 'ask') store.setAudioMode('text')
    // Talking means hearing the answers: a mode that never spoke would end every turn at
    // speak-failed. 'always' is left alone; 'off' becomes replies-to-spoken-messages.
    if (store.readAloud === 'off') store.setReadAloud('voice')
    dispatch({ type: 'start' })
  }, [dispatch])

  const disable = useCallback(() => dispatch({ type: 'stop' }), [dispatch])
  const interrupt = useCallback(() => dispatch({ type: 'interrupt' }), [dispatch])

  // Clip routing: the recorder's own phase says how its clip ended. recording -> transcribing is
  // a clip on its way; recording -> idle is a dropped one (no speech, cancelled, too short).
  const voicePhase = voice.phase
  const prevVoicePhase = useRef(voicePhase)
  useEffect(() => {
    const was = prevVoicePhase.current
    prevVoicePhase.current = voicePhase
    if (phaseRef.current !== 'recording') return
    if (was === 'recording' && voicePhase === 'transcribing') dispatch({ type: 'clip-ended' })
    else if (was === 'recording' && voicePhase === 'idle') dispatch({ type: 'clip-empty' })
  }, [voicePhase, dispatch])

  // The reply's end: streaming true -> false while the machine waits for it.
  useEffect(() => {
    const was = wasStreaming.current
    wasStreaming.current = replyStreaming
    if (phaseRef.current !== 'generating' || was === replyStreaming) return
    if (replyStreaming) return
    // Spoken from the first complete sentence, so by the time the stream ends the speaker already
    // holds this reply - or picks its last sentences up within the grace.
    const claimedAt = Date.now()
    const check = (): void => {
      if (phaseRef.current !== 'generating') return
      if (speaker.activeId() !== null) {
        dispatch({ type: 'reply-done' })
        return
      }
      if (Date.now() - claimedAt >= SPEAK_CLAIM_MS) dispatch({ type: 'speak-failed' })
      else setTimeout(check, 150)
    }
    check()
  }, [replyStreaming, dispatch])

  // The reply read to its end: the speaker goes silent. Then the mic reopens (the machine's
  // speak-done effect), and only then - an open mic would record the reply itself.
  useEffect(() => {
    if (phase !== 'speaking') return
    const un = speaker.subscribe(() => {
      if (speaker.activeId() === null) dispatch({ type: 'speak-done' })
    })
    return un
  }, [phase, dispatch])

  // Leaving the screen with the mode on: the machine's off, so nothing keeps the mic or speaker
  // claimed for a chat nobody is looking at. (useVoiceInput separately ends the recording itself.)
  useEffect(() => () => {
    if (phaseRef.current !== 'idle') {
      phaseRef.current = 'idle'
      speaker.stop()
    }
  }, [])

  return {
    active: phase !== 'idle',
    phase,
    enable,
    disable,
    interrupt,
    emit: dispatch,
  }
}

function runEffect(
  effect: ConversationEffect,
  voice: VoiceInput,
  composerLocked: boolean,
  dispatch: (event: ConversationEvent) => void,
): void {
  switch (effect.type) {
    case 'start-recording':
      // Programmatic open: permitted once the browser has granted the mic in this session (the
      // first turn starts from the toggle's own tap, which is the gesture that grants it).
      // A locked composer (no model ready, reply still owed) cannot accept the clip's send, so
      // the turn is failed back to listening-ready idle instead of opening a mic that goes nowhere.
      if (composerLocked) { dispatch({ type: 'clip-empty' }); return }
      void voice.start()
      return
    case 'cancel-recording':
      voice.cancel()
      return
    case 'stop-speaking':
      speaker.stop()
      return
    case 'detach':
      return
  }
}

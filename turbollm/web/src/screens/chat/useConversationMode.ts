// Full voice mode (GitHub #311): the wiring that drives the pure machine in
// lib/voice/conversation-mode.ts from ChatScreen's real pieces - useVoiceInput for the mic, the
// existing send() for the turn, the speaker for the reply, and the stream state for when the reply
// is done.
//
// What the machine never sees lives here:
//  - how the recorder's own phase says how a clip ended (and that it never reached `recording`);
//  - how "the reply was read to the end" is observed (the speaker's active id clearing), and the small grace
//    between the stream ending and its last sentences reaching the speaker;
//  - the watchdog for a reply that never starts, because a send the chat refused leaves nothing to wait for;
//  - the privacy rules: the mic never opens in a hidden tab, and hiding the tab ends the mode instead of sending what
//    was recorded so far;
//  - that the mode borrows the user's voice settings for as long as it is on and never rewrites them: the screen asks
//    `handsFree()` where a setting would otherwise need a hand (the "audio or text?" choice, auto-stop, read-aloud).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CONVERSATION_OFF,
  reduceConversation,
  type ConversationEffect,
  type ConversationEvent,
  type ConversationPhase,
  type ConversationState,
} from '../../lib/voice/conversation-mode'
import { speaker } from '../../lib/voice/tts'
import type { VoicePhase } from './useVoiceInput'

/** What the loop needs from the microphone hook, narrowed so a test can stand in for it. */
export interface ConversationVoice {
  phase: VoicePhase
  start: () => Promise<void> | void
  /** Drop the recording, the pending choice or the transcription in progress. */
  cancel: () => void
}

export interface ConversationModeOptions {
  voice: ConversationVoice
  /** True while a reply is streaming in the open chat (live or on the daemon). */
  replyStreaming: boolean
  /** A model is ready to take a message: without one the mic is not opened for a turn. */
  canListen: boolean
  /** The open chat. Moving to another chat, or to a new one, ends the loop; the chat being created by this loop's first
   *  message (null to its new id) does not. */
  chatKey: string | null
  /** Stop the reply that is still being written (barge-in). */
  stopReply: () => void
  /** The Settings → Voice opt-in for the beta. The master switch: the mode cannot be turned on without it, and turning it off
   *  while the mode is on ends the mode (so a composer that no longer offers it cannot keep a live loop running). */
  enabled: boolean
  /** End mode-owned output, including queued speech and current manual or
   *  always-on reading. Does not cancel generation. */
  onStop?: () => void
}

export interface ConversationMode {
  /** The mode is on (the phase may be idle between turns). */
  active: boolean
  phase: ConversationPhase
  enable: () => void
  disable: () => void
  /** One tap on the mic while on: barge-in, or the next turn from idle. */
  interrupt: () => void
  /** Feed an event from the wiring around it (the message was sent or refused). */
  emit: (event: ConversationEvent) => void
  /** Whether the mode is on right now, for callers that must not wait for a render. */
  handsFree: () => boolean
}

/** The reply's last sentences are spoken from the saved message just after the stream ends: this
 *  long without the speaker picking the reply up means it is not being read. */
export const SPEAK_CLAIM_MS = 1500

/** A message was handed over and no reply started streaming in this long: the chat refused it or it failed, and there is
 *  nothing to wait for. */
export const REPLY_START_MS = 15_000

export function useConversationMode(options: ConversationModeOptions): ConversationMode {
  const [state, setState] = useState<ConversationState>(CONVERSATION_OFF)
  const stateRef = useRef<ConversationState>(CONVERSATION_OFF)
  const latest = useRef(options)
  latest.current = options
  const dispatchRef = useRef<(event: ConversationEvent) => void>(() => {})
  /** The machine wants the mic open and is waiting for the recorder to be free. */
  const wantMic = useRef(false)
  /** This hook asked the recorder to drop a clip: its going idle is not an empty clip. */
  const cancelling = useRef(false)

  const tryStartMic = useCallback(() => {
    if (!wantMic.current) return
    const { voice, canListen } = latest.current
    if (voice.phase !== 'idle') return // tried again when the recorder settles
    wantMic.current = false
    // A mic that opens in a hidden tab, or with no model to take what is said, is a turn that failed, not one to wait out.
    if (!canListen || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      dispatchRef.current({ type: 'clip-empty' })
      return
    }
    void voice.start()
  }, [])

  const runEffect = useCallback((effect: ConversationEffect) => {
    switch (effect.type) {
      case 'start-recording':
        wantMic.current = true
        tryStartMic()
        return
      case 'cancel-recording':
        wantMic.current = false
        cancelling.current = latest.current.voice.phase !== 'idle'
        latest.current.voice.cancel()
        return
      case 'stop-speaking':
        speaker.stop()
        return
      case 'stop-reply':
        latest.current.stopReply()
        return
    }
  }, [tryStartMic])

  const dispatch = useCallback((event: ConversationEvent) => {
    if (event.type === 'stop' && stateRef.current.on) latest.current.onStop?.()
    const t = reduceConversation(stateRef.current, event)
    stateRef.current = t.state
    setState(t.state)
    for (const effect of t.effects) runEffect(effect)
  }, [runEffect])
  dispatchRef.current = dispatch

  const enable = useCallback(() => {
    if (!latest.current.canListen || !latest.current.enabled) return
    dispatch({ type: 'start' })
  }, [dispatch])
  const disable = useCallback(() => dispatch({ type: 'stop' }), [dispatch])
  const interrupt = useCallback(() => dispatch({ type: 'interrupt' }), [dispatch])
  const handsFree = useCallback(() => stateRef.current.on, [])

  // The recorder's own phase says how a clip ended: recording -> transcribing is a clip on its way; recording ->
  // idle is a dropped one (no speech, cancelled, too short); transcribing -> idle without a message is a transcription
  // that came back empty or failed; starting -> idle is a microphone that was denied or would not open. The machine
  // ignores each of those unless the turn is in the phase it ends, so the audio route (which sends the message before it
  // lets the recorder go) and a message already sent are not read as empty clips.
  const voicePhase = options.voice.phase
  const prevVoicePhase = useRef(voicePhase)
  useEffect(() => {
    const was = prevVoicePhase.current
    prevVoicePhase.current = voicePhase
    if (voicePhase === 'idle' && cancelling.current) {
      cancelling.current = false
    } else if (was !== voicePhase && stateRef.current.on) {
      if (voicePhase === 'choosing') {
        // "Send as audio or convert to text?" needs a hand: hands-free never asks (the screen settles the route while the
        // mode is on), so a clip that still lands here is dropped.
        cancelling.current = true
        latest.current.voice.cancel()
        dispatch({ type: 'clip-empty' })
      } else if (was === 'recording' && voicePhase === 'transcribing') {
        dispatch({ type: 'clip-ended' })
      } else if (voicePhase === 'idle' && (was === 'recording' || was === 'transcribing' || was === 'starting')) {
        dispatch({ type: 'clip-empty' })
      }
    }
    tryStartMic()
  }, [voicePhase, dispatch, tryStartMic])

  // The reply: once the message is handed over, wait for it to start streaming (or give up), then for it to end.
  const replyStreaming = options.replyStreaming
  const sawReply = useRef(false)
  useEffect(() => {
    if (state.phase !== 'generating') { sawReply.current = false; return }
    if (replyStreaming) { sawReply.current = true; return }
    if (!sawReply.current) {
      const giveUp = setTimeout(() => dispatchRef.current({ type: 'reply-failed' }), REPLY_START_MS)
      return () => clearTimeout(giveUp)
    }
    // Streaming ended. Spoken from the first complete sentence, so by now the speaker already holds this reply - or
    // picks its last sentences up within the grace.
    const claimedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      if (stateRef.current.phase !== 'generating') return
      if (speaker.activeId() !== null) {
        dispatchRef.current({ type: 'reply-done' })
        return
      }
      if (Date.now() - claimedAt >= SPEAK_CLAIM_MS) dispatchRef.current({ type: 'speak-failed' })
      else timer = setTimeout(check, 150)
    }
    check()
    return () => clearTimeout(timer)
  }, [state.phase, replyStreaming])

  // The reply read to its end: the speaker goes silent. Then the mic reopens (the machine's speak-done effect), and only
  // then - an open mic would record the reply itself. Checked once on subscribing too: a short reply can finish before
  // this effect has registered.
  useEffect(() => {
    if (state.phase !== 'speaking') return
    const check = (): void => { if (speaker.activeId() === null) dispatchRef.current({ type: 'speak-done' }) }
    const unsubscribe = speaker.subscribe(check)
    check()
    return unsubscribe
  }, [state.phase])

  // Nothing is recorded while the page is not on screen. The recorder's own handler would send what was said so far and the
  // loop would go on listening in the background, so the mode ends instead (this listener is registered first, and the
  // cancel it causes leaves the recorder's handler nothing to send).
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden' && stateRef.current.on) dispatchRef.current({ type: 'stop' })
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  // The opt-in revoked (in Settings, or in another tab: see the store's storage listener) ends the mode, whatever is mid-flight.
  const enabled = options.enabled
  const prevEnabled = useRef(enabled)
  useEffect(() => {
    const was = prevEnabled.current
    prevEnabled.current = enabled
    if (was && !enabled && stateRef.current.on) dispatchRef.current({ type: 'stop' })
  }, [enabled])

  // Eject/model loading can abort a send before any stream metadata exists.
  // End the turn immediately rather than waiting for the reply-start watchdog.
  useEffect(() => {
    if (!options.canListen && stateRef.current.on && stateRef.current.phase === 'generating') {
      dispatchRef.current({ type: 'reply-failed' })
    }
  }, [options.canListen])

  // Another chat, or a new one, is not this loop's: the mode ends. The new chat a first message creates is.
  const chatKey = options.chatKey
  const prevChatKey = useRef(chatKey)
  useEffect(() => {
    const was = prevChatKey.current
    prevChatKey.current = chatKey
    if (was !== null && was !== chatKey && stateRef.current.on) dispatchRef.current({ type: 'stop' })
  }, [chatKey])

  // Leaving the screen with the mode on: nothing keeps the speaker claimed for a chat nobody is looking at.
  // (useVoiceInput separately ends the recording itself.)
  useEffect(() => () => {
    if (stateRef.current.on) {
      stateRef.current = CONVERSATION_OFF
      speaker.stop()
    }
  }, [])

  return { active: state.on, phase: state.phase, enable, disable, interrupt, emit: dispatch, handsFree }
}

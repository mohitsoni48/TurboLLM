// The composer's microphone: record, then either turn the recording into text or send it as it is.
//
// Which of the two depends on what is there. A model that hears audio can take the clip itself; whisper on the daemon
// (Settings → Voice) can turn it into text. With both, the user chooses, once or every time (stores/voice.ts
// AudioMode). With one, that one. With neither, the button says how to set one up.
//
// The level meter is not React state: the microphone reports it a couple of dozen times a second, and this hook lives
// in ChatScreen, which is far too large to re-render at that rate. The bar that draws it subscribes to `meter`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { MicError, VoiceRecorder, clipDataUrl, micSupport, type AutoStop, type VoiceClip } from '../../lib/voice/recorder'
import { transcribeClip, warmVoice } from '../../lib/voice/voice-api'
import { useVoiceStatus } from '../../lib/voice/voice-queries'
import { useVoiceStore } from '../../stores/voice'

export type VoicePhase =
  | 'idle'
  /** Waiting for the browser to hand over the microphone (its permission prompt may be showing). */
  | 'starting'
  | 'recording'
  /** Recorded; waiting for the user to pick "send as audio" or "convert to text". */
  | 'choosing'
  | 'transcribing'

/** A recording ready to go into the composer as an attachment. */
export interface ComposerClip {
  file: File
  dataUrl: string
  durationMs: number
}

export interface LevelMeter {
  subscribe: (listener: () => void) => () => void
  /** The input level, 0 to 1. */
  level: () => number
}

/** Why the microphone cannot be used right now, in words for a toast. */
export type VoiceBlock =
  | { kind: 'insecure' | 'unsupported'; message: string }
  /** Nothing can take a recording yet: `message` says what to set up, in Settings → Voice. */
  | { kind: 'setup'; message: string }

export interface VoiceInputOptions {
  /** The model the chat is pointed at takes audio input. */
  modelHears: boolean
  onText: (text: string) => void
  onClip: (clip: ComposerClip) => void
  /** Something to tell the user: a refusal, a failure, or why a recording was dropped. */
  notify: (message: string, kind: 'error' | 'info') => void
}

/** A recording shorter than this holds no word: a tap on the button, not a message. */
const MIN_CLIP_MS = 400

const INSECURE_MESSAGE = 'The browser only allows the microphone on a secure page. Open TurboLLM on this machine itself, or reach it over https (Settings → Network & sharing → remote access).'
const UNSUPPORTED_MESSAGE = 'This browser cannot record audio.'
const SETUP_MESSAGE = 'Voice input needs speech-to-text. Set it up in Settings → Voice.'

export function useVoiceInput(opts: VoiceInputOptions) {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [pendingMs, setPendingMs] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const voiceQ = useVoiceStatus()
  const sttAvailable = voiceQ.data?.stt.available === true

  // The callbacks and flags as of the latest render: the recorder's own callbacks fire long after the render that
  // started it.
  const latest = useRef({ ...opts, sttAvailable })
  latest.current = { ...opts, sttAvailable }

  const recorder = useRef<VoiceRecorder | null>(null)
  const pending = useRef<VoiceClip | null>(null)
  const transcription = useRef<AbortController | null>(null)
  /** Goes up whenever the current recording or transcription is abandoned, so its late result is dropped. */
  const run = useRef(0)

  const levelNow = useRef(0)
  const levelListeners = useRef(new Set<() => void>())
  const meter = useMemo<LevelMeter>(() => ({
    subscribe: (listener) => {
      levelListeners.current.add(listener)
      return () => levelListeners.current.delete(listener)
    },
    level: () => levelNow.current,
  }), [])
  const setLevel = useCallback((level: number) => {
    levelNow.current = level
    for (const listener of levelListeners.current) listener()
  }, [])

  const idle = useCallback(() => {
    recorder.current = null
    pending.current = null
    transcription.current = null
    setLevel(0)
    setPhase('idle')
  }, [setLevel])

  const attach = useCallback(async (clip: VoiceClip) => {
    const mine = run.current
    try {
      const dataUrl = await clipDataUrl(clip.blob)
      if (mine !== run.current) return
      latest.current.onClip({ file: new File([clip.blob], 'voice-message.wav', { type: 'audio/wav' }), dataUrl, durationMs: clip.durationMs })
    } catch {
      if (mine === run.current) latest.current.notify('The recording could not be read.', 'error')
    }
    if (mine === run.current) idle()
  }, [idle])

  const transcribe = useCallback(async (clip: VoiceClip) => {
    const mine = run.current
    const abort = new AbortController()
    transcription.current = abort
    setPhase('transcribing')
    try {
      const { text } = await transcribeClip(clip.blob, { signal: abort.signal })
      if (mine !== run.current) return
      if (text) latest.current.onText(text)
      else latest.current.notify('No speech was recognised in that recording.', 'info')
    } catch (e) {
      if (mine !== run.current || abort.signal.aborted) return
      latest.current.notify(e instanceof ApiError ? e.message : 'The recording could not be converted to text.', 'error')
    }
    if (mine === run.current) idle()
  }, [idle])

  /** A finished recording goes where the setup and the saved choice send it. */
  const route = useCallback((clip: VoiceClip) => {
    if (clip.durationMs < MIN_CLIP_MS) {
      latest.current.notify('That was too short to hear anything.', 'info')
      idle()
      return
    }
    const { modelHears, sttAvailable: stt } = latest.current
    if (modelHears && stt) {
      const mode = useVoiceStore.getState().audioMode
      if (mode === 'ask') {
        pending.current = clip
        setPendingMs(clip.durationMs)
        setLevel(0)
        setPhase('choosing')
        return
      }
      void (mode === 'audio' ? attach(clip) : transcribe(clip))
      return
    }
    if (modelHears) void attach(clip)
    else if (stt) void transcribe(clip)
    else {
      // The model was swapped, or speech-to-text removed, while this was being recorded.
      latest.current.notify(SETUP_MESSAGE, 'error')
      idle()
    }
  }, [attach, idle, setLevel, transcribe])

  const finish = useCallback(async () => {
    const active = recorder.current
    if (!active) return
    recorder.current = null
    const mine = run.current
    const clip = await active.stop()
    if (mine === run.current) route(clip)
  }, [route])

  const cancel = useCallback(() => {
    run.current++
    recorder.current?.cancel()
    transcription.current?.abort()
    idle()
  }, [idle])

  const onAutoStop = useCallback((why: AutoStop) => {
    if (why === 'no-speech') {
      cancel()
      latest.current.notify('Nothing was heard, so the recording was dropped.', 'info')
      return
    }
    if (why === 'max-length') latest.current.notify('The recording reached its five-minute limit.', 'info')
    void finish()
  }, [cancel, finish])

  /** Why the microphone cannot be used, or null when it can. */
  const block = useMemo<VoiceBlock | null>(() => {
    const support = micSupport()
    if (support === 'insecure') return { kind: 'insecure', message: INSECURE_MESSAGE }
    if (support === 'unsupported') return { kind: 'unsupported', message: UNSUPPORTED_MESSAGE }
    if (!opts.modelHears && !sttAvailable) return { kind: 'setup', message: SETUP_MESSAGE }
    return null
  }, [opts.modelHears, sttAvailable])

  /** Start recording. Call from the click itself: the browser asks for the microphone only on a user's action. */
  const start = useCallback(async () => {
    if (phase !== 'idle') return
    const mine = ++run.current
    setPhase('starting')
    const { modelHears, sttAvailable: stt } = latest.current
    const { audioMode, autoStop } = useVoiceStore.getState()
    // whisper loads its model while the user is still talking, unless the clip is certain to go as audio.
    if (stt && !(modelHears && audioMode === 'audio')) warmVoice()
    try {
      const started = await VoiceRecorder.start({ autoStop, onLevel: setLevel, onAutoStop })
      if (mine !== run.current) {
        started.cancel() // cancelled while the permission prompt was up
        return
      }
      recorder.current = started
      setStartedAt(Date.now())
      setPhase('recording')
    } catch (e) {
      if (mine !== run.current) return
      latest.current.notify(e instanceof MicError ? e.message : 'The microphone could not be opened.', 'error')
      idle()
    }
  }, [idle, onAutoStop, phase, setLevel])

  /** The answer to "send as audio, or convert to text?" for the recording waiting on it. */
  const choose = useCallback((mode: 'audio' | 'text', remember: boolean) => {
    const clip = pending.current
    if (!clip) return
    pending.current = null
    if (remember) useVoiceStore.getState().setAudioMode(mode)
    void (mode === 'audio' ? attach(clip) : transcribe(clip))
  }, [attach, transcribe])

  // Nothing is recorded while the page is not on screen (another tab, the Android app in the background): the
  // recording ends there, and what was said so far goes where a finished recording goes.
  useEffect(() => {
    if (phase !== 'recording') return
    const onHide = () => { if (document.visibilityState === 'hidden') void finish() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [phase, finish])

  // Leaving the screen ends whatever was in progress: a microphone left open keeps the browser's recording light on.
  useEffect(() => () => {
    run.current++
    recorder.current?.cancel()
    transcription.current?.abort()
  }, [])

  return {
    phase,
    /** When the current recording began (Date.now()), for its clock. */
    startedAt,
    /** The length of the recording waiting for a choice. */
    pendingMs,
    meter,
    block,
    start,
    /** End the recording and use it. */
    stop: finish,
    /** Drop the recording, the pending choice or the transcription in progress. */
    cancel,
    choose,
  }
}

export type VoiceInput = ReturnType<typeof useVoiceInput>

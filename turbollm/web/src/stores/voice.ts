// Voice preferences that belong to this browser on this device, kept in localStorage like the theme and the font size
// (stores/ui.ts): which voice reads replies, how fast, and what a recording does once it ends. They are not daemon
// settings because they are about the device in the user's hand: a phone and the desktop it chats through have
// different voices and different habits. What the daemon keeps is the speech-to-text side (Settings → Voice,
// `speechToText` in /api/v1/settings).
import { create } from 'zustand'

/** What a recording becomes when the loaded model hears audio and speech-to-text is also set up. */
export type AudioMode =
  /** Ask after each recording. */
  | 'ask'
  /** Send the recording itself: the model hears the voice, the tone and what is not words. */
  | 'audio'
  /** Convert it to text first: the message can be read, edited and searched, and costs fewer tokens. */
  | 'text'

/** When replies are read aloud without pressing the button on each. */
export type ReadAloud =
  | 'off'
  /** Replies to a message that was spoken. */
  | 'voice'
  | 'always'

export const TTS_RATE_MIN = 0.5
export const TTS_RATE_MAX = 2

const KEYS = {
  audioMode: 'tllm.voice.audioMode',
  autoSend: 'tllm.voice.autoSend',
  autoStop: 'tllm.voice.autoStop',
  readAloud: 'tllm.voice.readAloud',
  ttsVoice: 'tllm.voice.ttsVoice',
  ttsRate: 'tllm.voice.ttsRate',
  onlineVoices: 'tllm.voice.onlineVoices',
} as const

// localStorage can throw (a private window with storage blocked): a preference that cannot be read is its default,
// and one that cannot be saved still applies for this visit.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* kept in memory only */
  }
}

function readAudioMode(): AudioMode {
  const v = read(KEYS.audioMode)
  return v === 'audio' || v === 'text' ? v : 'ask'
}

function readReadAloud(): ReadAloud {
  const v = read(KEYS.readAloud)
  return v === 'voice' || v === 'always' ? v : 'off'
}

function readRate(): number {
  const v = Number(read(KEYS.ttsRate))
  return Number.isFinite(v) && v >= TTS_RATE_MIN && v <= TTS_RATE_MAX ? v : 1
}

type VoiceState = {
  audioMode: AudioMode
  setAudioMode: (mode: AudioMode) => void
  /** Send as soon as a recording has been turned into text or attached, without a look first. Off by default: a
   *  misheard word is cheaper to fix before it is sent. */
  autoSend: boolean
  setAutoSend: (on: boolean) => void
  /** End a recording by itself when the speaker stops talking. */
  autoStop: boolean
  setAutoStop: (on: boolean) => void
  readAloud: ReadAloud
  setReadAloud: (mode: ReadAloud) => void
  /** The id of the voice replies are read in (lib/voice/tts.ts TtsVoice); '' picks one for each reply's language.
   *  A picked voice reads its own language; a reply in another still gets a voice of that language. */
  ttsVoice: string
  setTtsVoice: (id: string) => void
  /** Voices that speak through their maker's servers may read a language this device has no voice for. Off by
   *  default: such a voice is sent the text of the reply. */
  onlineVoices: boolean
  setOnlineVoices: (on: boolean) => void
  ttsRate: number
  setTtsRate: (rate: number) => void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  audioMode: readAudioMode(),
  setAudioMode: (audioMode) => {
    write(KEYS.audioMode, audioMode)
    set({ audioMode })
  },
  autoSend: read(KEYS.autoSend) === 'true',
  setAutoSend: (autoSend) => {
    write(KEYS.autoSend, String(autoSend))
    set({ autoSend })
  },
  autoStop: read(KEYS.autoStop) !== 'false',
  setAutoStop: (autoStop) => {
    write(KEYS.autoStop, String(autoStop))
    set({ autoStop })
  },
  readAloud: readReadAloud(),
  setReadAloud: (readAloud) => {
    write(KEYS.readAloud, readAloud)
    set({ readAloud })
  },
  ttsVoice: read(KEYS.ttsVoice) ?? '',
  setTtsVoice: (ttsVoice) => {
    write(KEYS.ttsVoice, ttsVoice)
    set({ ttsVoice })
  },
  onlineVoices: read(KEYS.onlineVoices) === 'true',
  setOnlineVoices: (onlineVoices) => {
    write(KEYS.onlineVoices, String(onlineVoices))
    set({ onlineVoices })
  },
  ttsRate: readRate(),
  setTtsRate: (ttsRate) => {
    const clamped = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, ttsRate))
    write(KEYS.ttsRate, String(clamped))
    set({ ttsRate: clamped })
  },
}))

// Speaking: the device's own voices, behind one small interface.
//
// Text-to-speech stays on the device the user is listening on. In a browser and in the desktop app that is the Web
// Speech API (`speechSynthesis`), which speaks with the operating system's voices and needs nothing downloaded. The
// Android app's WebView has no working `speechSynthesis` (its voice list is empty there), so the app injects a small
// bridge to Android's TextToSpeech instead, `window.TurboLLMNative`; the page talks to whichever is there.
//
// Only voices that work offline are offered by default: Chrome also lists Google's network voices, and reading a
// local model's answer aloud should not send it to a server.
import { completeLength, speakableText, speechPieces } from './speakable'

export interface TtsVoice {
  /** What the saved preference names. */
  id: string
  name: string
  /** BCP 47, e.g. `en-US`. */
  lang: string
  /** Synthesised on this device. */
  local: boolean
}

export interface SpeakOptions {
  /** A {@link TtsVoice} id; '' picks one for the device's language. */
  voiceId: string
  /** 1 is the voice's normal speed. */
  rate: number
}

interface TtsBackend {
  voices(): TtsVoice[]
  /** Voices load late in some browsers; call back when the list changes. Returns the unsubscribe. */
  onVoices(listener: () => void): () => void
  /** Speak one piece. `done(true)` when it was spoken to the end, `done(false)` when it failed or was cut short. */
  speak(text: string, opts: SpeakOptions, done: (spoken: boolean) => void): void
  cancel(): void
}

/** The Android app's bridge (TurboLLM-Android, TtsBridge.kt): a message port the app injects into its own page only
 *  (never into a chat artifact's sandboxed frame). Both directions carry JSON text:
 *
 *    page → app   {"type":"tts.voices"}
 *                 {"type":"tts.speak","id":"u1","text":"…","voice":"<voice id or ''>","rate":1}
 *                 {"type":"tts.stop"}
 *    app → page   {"type":"tts.voices","voices":[{"id":"…","name":"…","lang":"en-US"}]}   (empty: nothing can speak)
 *                 {"type":"tts.done","id":"u1","ok":true}
 */
interface NativePort {
  postMessage(message: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

function nativePort(): NativePort | null {
  const port = (globalThis as { TurboLLMNative?: Partial<NativePort> }).TurboLLMNative
  return port && typeof port.postMessage === 'function' && typeof port.addEventListener === 'function' ? (port as NativePort) : null
}

function androidBackend(port: NativePort): TtsBackend {
  let voices: TtsVoice[] = []
  let next = 0
  const voiceListeners = new Set<() => void>()
  const pending = new Map<string, (spoken: boolean) => void>()
  const send = (message: Record<string, unknown>): boolean => {
    try {
      port.postMessage(JSON.stringify(message))
      return true
    } catch {
      return false // the port went with its page
    }
  }
  port.addEventListener('message', (event) => {
    let message: { type?: unknown; id?: unknown; ok?: unknown; voices?: unknown }
    try {
      message = JSON.parse(String(event.data)) as typeof message
    } catch {
      return
    }
    if (message.type === 'tts.voices' && Array.isArray(message.voices)) {
      voices = (message.voices as Array<{ id?: unknown; name?: unknown; lang?: unknown }>)
        .filter((v) => typeof v?.id === 'string' && typeof v.name === 'string')
        .map((v) => ({ id: v.id as string, name: v.name as string, lang: typeof v.lang === 'string' ? v.lang : '', local: true }))
      for (const listener of voiceListeners) listener()
    } else if (message.type === 'tts.done' && typeof message.id === 'string') {
      const done = pending.get(message.id)
      pending.delete(message.id)
      done?.(message.ok === true)
    }
  })
  // The engine starts with the app; its voices arrive as the answer to this, and again if it is asked again.
  send({ type: 'tts.voices' })
  return {
    voices: () => voices,
    onVoices: (listener) => {
      voiceListeners.add(listener)
      return () => voiceListeners.delete(listener)
    },
    speak: (text, opts, done) => {
      const id = `u${++next}`
      pending.set(id, done)
      if (!send({ type: 'tts.speak', id, text, voice: opts.voiceId, rate: opts.rate })) {
        pending.delete(id)
        done(false)
      }
    },
    cancel: () => {
      // The app answers nothing for what it was told to stop: settle those here.
      const waiting = [...pending.values()]
      pending.clear()
      send({ type: 'tts.stop' })
      for (const done of waiting) done(false)
    },
  }
}

function webSpeechBackend(synth: SpeechSynthesis): TtsBackend {
  const toVoice = (v: SpeechSynthesisVoice): TtsVoice => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService })
  return {
    voices: () => synth.getVoices().map(toVoice),
    onVoices: (listener) => {
      synth.addEventListener?.('voiceschanged', listener)
      return () => synth.removeEventListener?.('voiceschanged', listener)
    },
    speak: (text, opts, done) => {
      const utterance = new SpeechSynthesisUtterance(text)
      const voice = synth.getVoices().find((v) => v.voiceURI === opts.voiceId) ?? defaultWebVoice(synth.getVoices())
      if (voice) {
        utterance.voice = voice
        utterance.lang = voice.lang
      }
      utterance.rate = opts.rate
      let settled = false
      const settle = (spoken: boolean) => {
        if (settled) return
        settled = true
        done(spoken)
      }
      utterance.onend = () => settle(true)
      utterance.onerror = () => settle(false)
      synth.speak(utterance)
    },
    cancel: () => synth.cancel(),
  }
}

/** The voice used when none is chosen: one that runs on this device, in the browser's language if there is one. */
function defaultWebVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const local = voices.filter((v) => v.localService)
  const pool = local.length > 0 ? local : voices
  const want = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase()
  const sameLanguage = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().split(/[-_]/)[0] === want.split('-')[0]
  return pool.find((v) => v.lang.toLowerCase().replace('_', '-') === want && v.default)
    ?? pool.find((v) => v.lang.toLowerCase().replace('_', '-') === want)
    ?? pool.find((v) => sameLanguage(v) && v.default)
    ?? pool.find(sameLanguage)
    ?? pool.find((v) => v.default)
    ?? pool[0]
}

let cachedBackend: TtsBackend | null | undefined

function backend(): TtsBackend | null {
  if (cachedBackend !== undefined) return cachedBackend
  const port = nativePort()
  if (port) {
    cachedBackend = androidBackend(port)
  } else if (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
    cachedBackend = webSpeechBackend(window.speechSynthesis)
  } else {
    cachedBackend = null
  }
  return cachedBackend
}

/** For tests: forget which backend was found, so the next call looks again. */
export function resetTtsBackend(): void {
  cachedBackend = undefined
}

/** The voices to choose from: those that speak on this device, or every voice when the device reports none as local
 *  (some Linux speech setups mark nothing). Sorted by language, then name. */
export function ttsVoices(): TtsVoice[] {
  const all = backend()?.voices() ?? []
  const local = all.filter((v) => v.local)
  return (local.length > 0 ? local : all).sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
}

export function onTtsVoices(listener: () => void): () => void {
  return backend()?.onVoices(listener) ?? (() => {})
}

/** Whether anything can be spoken here: a speech engine with at least one voice. A browser with the API and no voice
 *  (Chrome on Linux without speech-dispatcher) would accept text and stay silent, so it does not count. */
export function ttsAvailable(): boolean {
  const b = backend()
  return b !== null && b.voices().length > 0
}

const CANCEL_SETTLE_MS = 80

/** A reply being read as it is written: give it the Markdown so far each time more arrives, then end it. */
export interface SpeechStream {
  update(markdownSoFar: string): void
  /** The reply is complete: speak what is left of it. */
  end(finalMarkdown: string): void
}

/** What is being read aloud, one thing at a time. Reading something else, or stop(), ends the current reading. */
class Speaker {
  private queue: string[] = []
  private speaking = false
  /** What the reading in progress is of (a message id), or null when silent. */
  private current: string | null = null
  /** Set while a stream may still add pieces, so an empty queue is a pause and not the end. */
  private streaming = false
  /** Goes up at each new reading, so a piece ending late cannot continue one that was replaced. */
  private generation = 0
  private options: SpeakOptions = { voiceId: '', rate: 1 }
  /** Nothing is spoken before this time: Chrome drops an utterance handed to it in the same breath as a cancel(). */
  private holdUntil = 0
  private readonly listeners = new Set<() => void>()

  /** The id of what is being read, for the button that shows "stop". */
  activeId = (): string | null => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Read a whole message. */
  speak(id: string, markdown: string, opts: SpeakOptions): void {
    this.begin(id, opts)
    this.enqueue(speechPieces(speakableText(markdown)))
    this.streaming = false
    this.finishIfIdle()
  }

  /** Read a message that is still arriving. */
  stream(id: string, opts: SpeakOptions): SpeechStream {
    this.begin(id, opts)
    this.streaming = true
    const generation = this.generation
    let spoken = 0
    const say = (text: string, upTo: number) => {
      if (generation !== this.generation) return
      // What was said is never said twice, even if the text ahead of it was reshaped as more of the reply arrived.
      const from = Math.min(spoken, upTo)
      if (upTo > from) this.enqueue(speechPieces(text.slice(from, upTo)))
      spoken = Math.max(spoken, upTo)
    }
    return {
      update: (markdownSoFar) => {
        const text = speakableText(markdownSoFar)
        say(text, completeLength(text))
      },
      end: (finalMarkdown) => {
        const text = speakableText(finalMarkdown)
        say(text, text.length)
        if (generation !== this.generation) return
        this.streaming = false
        this.finishIfIdle()
      },
    }
  }

  stop(): void {
    if (this.current === null && !this.speaking) return
    this.generation++
    this.queue = []
    this.speaking = false
    this.streaming = false
    this.current = null
    backend()?.cancel()
    this.announce()
  }

  private begin(id: string, opts: SpeakOptions): void {
    this.generation++
    this.queue = []
    if (this.speaking) {
      backend()?.cancel()
      this.holdUntil = Date.now() + CANCEL_SETTLE_MS
    }
    this.speaking = false
    this.current = id
    this.options = opts
    this.announce()
  }

  private enqueue(pieces: string[]): void {
    this.queue.push(...pieces)
    this.next()
  }

  private next(): void {
    const b = backend()
    if (this.speaking || !b) return
    const wait = this.holdUntil - Date.now()
    if (wait > 0) {
      const generation = this.generation
      setTimeout(() => { if (generation === this.generation) this.next() }, wait)
      return
    }
    const piece = this.queue.shift()
    if (piece === undefined) {
      this.finishIfIdle()
      return
    }
    this.speaking = true
    const generation = this.generation
    b.speak(piece, this.options, () => {
      if (generation !== this.generation) return
      this.speaking = false
      this.next()
    })
  }

  private finishIfIdle(): void {
    if (this.speaking || this.streaming || this.queue.length > 0 || this.current === null) return
    this.current = null
    this.announce()
  }

  private announce(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The page's one voice. */
export const speaker = new Speaker()

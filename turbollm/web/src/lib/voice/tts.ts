// Speaking: the device's own voices, behind one small interface.
//
// Text-to-speech stays on the device the user is listening on. In a browser and in the desktop app that is the Web
// Speech API (`speechSynthesis`), which speaks with the operating system's voices and needs nothing downloaded. The
// Android app's WebView has no working `speechSynthesis` (its voice list is empty there), so the app injects a small
// bridge to Android's TextToSpeech instead, `window.TurboLLMNative`; the page talks to whichever is there.
//
// The voice follows the text. Each piece is read by a voice for the language it is written in (language.ts tells the
// language, voice-choice.ts picks the voice), so a reply in Spanish is not read by the English voice the browser
// happens to list first.
//
// Only voices that work offline are used by default: Chrome and Android's speech engine also list network voices,
// and reading a local model's answer aloud should not send it to a server unless the user has said it may.
import { detectLanguage, languageScript } from './language'
import { completeLength, speakableText, speechPieces } from './speakable'
import { chooseVoice, usableVoices, voiceLanguage, type TtsVoice } from './voice-choice'

export type { TtsVoice }

export interface SpeakOptions {
  /** A {@link TtsVoice} id; '' picks one for the language of what is read. */
  voiceId: string
  /** 1 is the voice's normal speed. */
  rate: number
  /** Voices that speak through a server may be used for a language the device has no voice for. */
  allowOnline?: boolean
  /** The language of the text, when the caller knows it (a sample sentence): it is not worked out from the text. */
  language?: string
}

/** A language with nothing on this device to read it, and what read it instead. */
export interface MissingVoice {
  /** The language of the text, as a primary subtag ('ja'). */
  language: string
  /** The voice that stood in for one, if the device has any. */
  stoodIn: TtsVoice | null
  /** An online voice speaks the language; the user has not allowed those. */
  onlineOnly: boolean
  /** The text was left unread: it is in a script the stand-in cannot read at all. */
  skipped: boolean
}

/** One piece on its way to the engine. */
interface Utterance {
  text: string
  voice: TtsVoice | null
  /** The text's language, for an engine whose voice does not say what it speaks. */
  language: string | null
  rate: number
}

interface TtsBackend {
  voices(): TtsVoice[]
  /** Voices load late in some browsers; call back when the list changes. Returns the unsubscribe. */
  onVoices(listener: () => void): () => void
  /** Speak one piece. `done(true)` when it was spoken to the end, `done(false)` when it failed or was cut short. */
  speak(utterance: Utterance, done: (spoken: boolean) => void): void
  cancel(): void
  /** Opens the place this device's voices are added, where the page can open it. */
  installVoices?: () => void
}

/** The Android app's bridge (TurboLLM-Android, TtsBridge.kt): a message port the app injects into its own page only
 *  (never into a chat artifact's sandboxed frame). Both directions carry JSON text:
 *
 *    page → app   {"type":"tts.voices"}
 *                 {"type":"tts.speak","id":"u1","text":"…","voice":"<voice id or ''>","lang":"<language or ''>","rate":1}
 *                 {"type":"tts.stop"}
 *                 {"type":"tts.install"}                      (open the speech engine's voice downloads)
 *    app → page   {"type":"tts.voices","voices":[{"id":"…","name":"…","lang":"en-US","local":true}]}   (empty: nothing can speak)
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
      voices = (message.voices as Array<{ id?: unknown; name?: unknown; lang?: unknown; local?: unknown }>)
        .filter((v) => typeof v?.id === 'string' && typeof v.name === 'string')
        // `local` is absent from an app that only ever listed on-device voices.
        .map((v) => ({ id: v.id as string, name: v.name as string, lang: typeof v.lang === 'string' ? v.lang : '', local: v.local !== false }))
      for (const listener of voiceListeners) listener()
    } else if (message.type === 'tts.done' && typeof message.id === 'string') {
      const done = pending.get(message.id)
      pending.delete(message.id)
      done?.(message.ok === true)
    }
  })
  // The engine starts with the app's first message; its voices arrive as the answer to this, and again each time it
  // is asked.
  send({ type: 'tts.voices' })
  // Asked again when the app comes back to the front: that is where the user returns from, having added a voice.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') send({ type: 'tts.voices' })
    })
  }
  return {
    voices: () => voices,
    onVoices: (listener) => {
      voiceListeners.add(listener)
      return () => voiceListeners.delete(listener)
    },
    speak: (utterance, done) => {
      const id = `u${++next}`
      pending.set(id, done)
      const message = { type: 'tts.speak', id, text: utterance.text, voice: utterance.voice?.id ?? '', lang: utterance.language ?? '', rate: utterance.rate }
      if (!send(message)) {
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
    installVoices: () => { send({ type: 'tts.install' }) },
  }
}

function webSpeechBackend(synth: SpeechSynthesis): TtsBackend {
  const toVoice = (v: SpeechSynthesisVoice): TtsVoice => ({ id: v.voiceURI, name: v.name, lang: v.lang.replace(/_/g, '-'), local: v.localService, isDefault: v.default })
  return {
    voices: () => synth.getVoices().map(toVoice),
    onVoices: (listener) => {
      synth.addEventListener?.('voiceschanged', listener)
      return () => synth.removeEventListener?.('voiceschanged', listener)
    },
    speak: (spoken, done) => {
      const utterance = new SpeechSynthesisUtterance(spoken.text)
      const voice = spoken.voice ? synth.getVoices().find((v) => v.voiceURI === spoken.voice?.id) : undefined
      if (voice) {
        utterance.voice = voice
        utterance.lang = voice.lang
      } else if (spoken.language) {
        // No voice of ours to name: the browser is told the language and picks.
        utterance.lang = spoken.language
      }
      utterance.rate = spoken.rate
      let settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        done(ok)
      }
      utterance.onend = () => settle(true)
      utterance.onerror = () => settle(false)
      synth.speak(utterance)
    },
    cancel: () => synth.cancel(),
  }
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
  speaker.forgetMissing()
}

/** Every voice the engine lists, the online ones included, in the engine's order. */
export function ttsAllVoices(): TtsVoice[] {
  return backend()?.voices() ?? []
}

/** The voices to choose from: those that speak on this device (or every voice when the device reports none as local;
 *  some Linux speech setups mark nothing), and the online ones too when they are allowed. Sorted by language, then
 *  name. */
export function ttsVoices(allowOnline = false): TtsVoice[] {
  return usableVoices(ttsAllVoices(), allowOnline).sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
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

/** Opens the place this device's voices are added, or null where the page cannot (a browser: the user goes to the
 *  system's speech settings themselves). */
export function ttsVoiceInstaller(): (() => void) | null {
  return backend()?.installVoices ?? null
}

/** The user's own languages, most wanted first. */
function preferredLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return ['en']
  if (navigator.languages?.length) return navigator.languages
  return navigator.language ? [navigator.language] : ['en']
}

/** PURE: the language one piece is read in, given the language of the reading it belongs to. The piece's own counts
 *  only when it is in another script (a Japanese sentence in an English reply): one sentence is too little to tell
 *  Spanish from Portuguese or Russian from Ukrainian, and a voice that changed on a guess would be worse than an
 *  accent. */
export function pieceLanguage(piece: string, reading: string | null): string | null {
  const own = detectLanguage(piece)
  if (!own || !reading || own === reading) return own ?? reading
  return languageScript(own) === languageScript(reading) ? reading : own
}

/** PURE: whether a stand-in voice would make nothing of text in `language`. A voice of a Latin-script language given
 *  Japanese or Arabic stays silent on some systems and spells out "letter, letter, letter" on others, so such text is
 *  skipped; a wrong accent on a script the voice does read (German by an English voice) is still worth hearing. Only
 *  that one direction is sure: voices of other scripts are built to read Latin text too. */
export function cannotRead(voice: TtsVoice | null, language: string): boolean {
  if (!voice) return false
  return languageScript(language) !== 'latin' && languageScript(voiceLanguage(voice.lang)) === 'latin'
}

const CANCEL_SETTLE_MS = 80
/** A reply still arriving is not started on until this much of it is here, unless its language is already plain: its
 *  first words ("¡Claro!") are too few to tell, and would be read by the wrong voice. */
const LANGUAGE_WAIT_CHARS = 80
/** How much more of a reply has to arrive before its language is looked at again. */
const LANGUAGE_RECHECK_CHARS = 40
/** Past this much, the start of a reply has said what language it is in. */
const LANGUAGE_SETTLED_CHARS = 2000

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
  /** The language of the reading in progress, once it can be told. */
  private language: string | null = null
  /** The language last told from a reading: what a reply too short to tell ("¡Claro!", "Ja, genau.") is taken to be
   *  in. A conversation keeps to its language far more often than it changes, and the alternative, the system's
   *  language, is the guess that made every short answer English. */
  private recent: string | null = null
  /** Nothing is spoken before this time: Chrome drops an utterance handed to it in the same breath as a cancel(). */
  private holdUntil = 0
  private readonly listeners = new Set<() => void>()
  private readonly missingListeners = new Set<(missing: MissingVoice) => void>()
  /** The languages already reported as having no voice: once each is enough. */
  private readonly reported = new Set<string>()
  /** The same, within the reading in progress. */
  private readonly reportedNow = new Set<string>()
  /** The reading in progress was asked for by hand (the button), not started by a reply arriving. */
  private asked = false

  /** The id of what is being read, for the button that shows "stop". */
  activeId = (): string | null => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Hear about text in a language this device has no voice for, once per language. */
  onVoiceMissing = (listener: (missing: MissingVoice) => void): (() => void) => {
    this.missingListeners.add(listener)
    return () => this.missingListeners.delete(listener)
  }

  /** Report a missing voice again the next time it is met: the device's voices may have changed. */
  forgetMissing(): void {
    this.reported.clear()
    this.recent = null
  }

  /** Read a whole message. */
  speak(id: string, markdown: string, opts: SpeakOptions): void {
    this.begin(id, opts)
    this.asked = true
    const text = speakableText(markdown)
    if (!opts.language) this.heard(detectLanguage(text))
    this.enqueue(speechPieces(text))
    this.streaming = false
    this.finishIfIdle()
  }

  /** Read a message that is still arriving. */
  stream(id: string, opts: SpeakOptions): SpeechStream {
    this.begin(id, opts)
    this.streaming = true
    const generation = this.generation
    let spoken = 0
    let heardAt = 0
    const listen = (text: string, final: boolean) => {
      if (opts.language || heardAt >= LANGUAGE_SETTLED_CHARS) return
      if (!final && text.length - heardAt < LANGUAGE_RECHECK_CHARS) return
      heardAt = text.length
      this.heard(detectLanguage(text))
    }
    const say = (text: string, upTo: number) => {
      // What was said is never said twice, even if the text ahead of it was reshaped as more of the reply arrived.
      const from = Math.min(spoken, upTo)
      if (upTo > from) this.enqueue(speechPieces(text.slice(from, upTo)))
      spoken = Math.max(spoken, upTo)
    }
    return {
      update: (markdownSoFar) => {
        if (generation !== this.generation) return
        const text = speakableText(markdownSoFar)
        listen(text, false)
        if (this.language === null && text.length < LANGUAGE_WAIT_CHARS) return
        say(text, completeLength(text))
      },
      end: (finalMarkdown) => {
        if (generation !== this.generation) return
        const text = speakableText(finalMarkdown)
        listen(text, true)
        say(text, text.length)
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
    this.language = opts.language ?? null
    this.asked = false
    this.reportedNow.clear()
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
    const { voiceId, rate, allowOnline = false } = this.options
    const voices = b.voices()
    let piece: string | undefined
    let language: string | null = null
    let voice: TtsVoice | null = null
    // The next piece there is a voice to read with.
    while ((piece = this.queue.shift()) !== undefined) {
      language = this.options.language ?? pieceLanguage(piece, this.language ?? this.recent)
      const choice = chooseVoice(voices, { voiceId, language, allowOnline, preferred: preferredLanguages() })
      voice = choice.voice
      if (!choice.missing) break
      const skipped = cannotRead(choice.voice, choice.missing)
      this.reportMissing({ language: choice.missing, stoodIn: choice.voice, onlineOnly: choice.onlineOnly, skipped })
      if (!skipped) break
    }
    if (piece === undefined) {
      this.finishIfIdle()
      return
    }
    this.speaking = true
    const generation = this.generation
    b.speak({ text: piece, voice, language: language ? voiceLanguage(language) : null, rate }, () => {
      if (generation !== this.generation) return
      this.speaking = false
      this.next()
    })
  }

  /** The language of the reading in progress, as just told from its text; null leaves what is known. */
  private heard(language: string | null): void {
    if (!language) return
    this.language = language
    this.recent = language
  }

  /** Once per language, so replies read as they arrive do not repeat it. A reading asked for by hand that leaves
   *  text unread says so each time: otherwise the button would seem to do nothing. */
  private reportMissing(missing: MissingVoice): void {
    const again = missing.skipped && this.asked && !this.reportedNow.has(missing.language)
    if (this.reported.has(missing.language) && !again) return
    this.reported.add(missing.language)
    this.reportedNow.add(missing.language)
    for (const listener of this.missingListeners) listener(missing)
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

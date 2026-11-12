import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectLanguage } from './language'
import { cannotRead, onTtsVoices, pieceLanguage, resetTtsBackend, speaker, ttsAllVoices, ttsAvailable, ttsVoiceInstaller, ttsVoices, type MissingVoice } from './tts'

interface FakeVoice {
  voiceURI: string
  name: string
  lang: string
  localService: boolean
  default: boolean
}

const voice = (voiceURI: string, lang: string, over: Partial<FakeVoice> = {}): FakeVoice => ({
  voiceURI, name: voiceURI, lang, localService: true, default: false, ...over,
})

class FakeUtterance {
  voice: FakeVoice | null = null
  lang = ''
  rate = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly text: string) {}
}

/** A stand-in for window.speechSynthesis: it records what it is asked to say and says nothing until the test ends an
 *  utterance by hand. */
function installSpeechSynthesis(voices: FakeVoice[]) {
  const utterances: FakeUtterance[] = []
  const listeners = new Set<() => void>()
  const synth = {
    voices,
    getVoices: () => synth.voices,
    speak: vi.fn((u: FakeUtterance) => { utterances.push(u) }),
    cancel: vi.fn(),
    addEventListener: vi.fn((_type: string, l: () => void) => { listeners.add(l) }),
    removeEventListener: vi.fn((_type: string, l: () => void) => { listeners.delete(l) }),
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  return { synth, utterances, listeners, texts: () => utterances.map((u) => u.text) }
}

const OPTS = { voiceId: '', rate: 1 }

const SPANISH = 'Claro, con mucho gusto te explico cómo funciona.\nPrimero hay que abrir la configuración del programa.\nLuego se elige la opción que más te conviene.'
const ENGLISH = 'Sure, I would be happy to explain how it works.\nFirst you have to open the settings of the program.\nThen you choose the option that suits you best.'
const GERMAN = 'Natürlich, ich erkläre es dir gerne.\nZuerst musst du die Einstellungen des Programms öffnen.\nDann wählst du die Option, die am besten zu dir passt.'
const JAPANESE = 'こんにちは、元気ですか。\nこれは日本語の長い文章です。\n今日はとてもいい天気ですね。'
/** For streams under test that are not about language detection: the reply's language is given, so nothing waits for it. */
const EN = { voiceId: '', rate: 1, language: 'en' }

/** Ends every utterance handed to the engine, and whatever follows from that, until it has nothing more to say. */
function drain(utterances: FakeUtterance[]): void {
  for (let i = 0; i < utterances.length; i++) utterances[i].onend?.()
}

// The speaker is one object for the whole file and remembers (by the clock) how long it holds off after a cancel: each
// test starts well after the last test's clock ended, so a hold left by one cannot delay the next.
let clock = 1_000_000

beforeEach(() => {
  clock += 60_000
  vi.useFakeTimers({ now: clock })
  resetTtsBackend()
})

afterEach(() => {
  speaker.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  delete (globalThis as { TurboLLMNative?: unknown }).TurboLLMNative
  resetTtsBackend()
})

describe('the Web Speech backend', () => {
  describe('ttsAvailable', () => {
    it('is false without a speech API', () => {
      expect(ttsAvailable()).toBe(false)
      expect(ttsVoices()).toEqual([])
    })

    it('is false when the API is there but lists no voice (it would accept text and stay silent)', () => {
      installSpeechSynthesis([])
      expect(ttsAvailable()).toBe(false)
    })

    it('is true once there is a voice', () => {
      installSpeechSynthesis([voice('a', 'en-US')])
      expect(ttsAvailable()).toBe(true)
    })
  })

  describe('ttsVoices', () => {
    it('offers only the voices that run on this device when there are any, sorted by language then name', () => {
      installSpeechSynthesis([
        voice('Zed', 'en-US'), voice('Net', 'en-US', { localService: false }), voice('Ann', 'en-US'), voice('Bob', 'de-DE'),
      ])
      expect(ttsVoices().map((v) => v.id)).toEqual(['Bob', 'Ann', 'Zed'])
      expect(ttsVoices()[0]).toEqual({ id: 'Bob', name: 'Bob', lang: 'de-DE', local: true, isDefault: false })
    })

    it('offers every voice when none is marked local', () => {
      installSpeechSynthesis([voice('B', 'en-US', { localService: false }), voice('A', 'fr-FR', { localService: false })])
      expect(ttsVoices().map((v) => v.id)).toEqual(['B', 'A'])
    })
  })

  describe('onTtsVoices', () => {
    it('follows voiceschanged until unsubscribed', () => {
      const { synth, listeners } = installSpeechSynthesis([voice('a', 'en-US')])
      const listener = vi.fn()
      const off = onTtsVoices(listener)
      expect(synth.addEventListener).toHaveBeenCalledWith('voiceschanged', listener)
      expect(listeners.has(listener)).toBe(true)
      off()
      expect(listeners.has(listener)).toBe(false)
    })

    it('does nothing where there is no speech API', () => {
      expect(() => onTtsVoices(() => {})()).not.toThrow()
    })
  })

  describe('choosing the voice', () => {
    const voices = [
      voice('en-gb-local', 'en-GB'),
      voice('fr-local', 'fr-FR', { default: true }),
      voice('en-us-network', 'en-US', { localService: false }),
      voice('en-us-local', 'en-US'),
    ]

    it('picks a local voice in the browser\'s language when none is chosen', () => {
      expect(navigator.language).toBe('en-US')
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', 'Hello.', OPTS)
      expect(utterances[0].voice?.voiceURI).toBe('en-us-local')
      expect(utterances[0].lang).toBe('en-US')
    })

    it('falls back to the same language in another region, then to the default voice', () => {
      const { utterances } = installSpeechSynthesis([voice('fr-local', 'fr-FR'), voice('en-gb-local', 'en-GB')])
      speaker.speak('m', 'Hello.', OPTS)
      expect(utterances[0].voice?.voiceURI).toBe('en-gb-local')
    })

    it('uses the voice that was chosen, whatever the language', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', 'Bonjour.', { voiceId: 'fr-local', rate: 1 })
      expect(utterances[0].voice?.voiceURI).toBe('fr-local')
      expect(utterances[0].lang).toBe('fr-FR')
    })

    it('applies the rate', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', 'Hello.', { voiceId: '', rate: 1.5 })
      expect(utterances[0].rate).toBe(1.5)
    })
  })

  describe('speak', () => {
    it('says the pieces one after another, the next only once the last has ended', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.speak('m1', 'One.\nTwo.\nThree.', OPTS)
      expect(texts()).toEqual(['One.'])
      utterances[0].onend?.()
      expect(texts()).toEqual(['One.', 'Two.'])
      utterances[1].onend?.()
      expect(texts()).toEqual(['One.', 'Two.', 'Three.'])
    })

    it('reports the id while speaking and null after the last piece, telling subscribers at each change', () => {
      const { utterances } = installSpeechSynthesis([voice('a', 'en-US')])
      const listener = vi.fn()
      const off = speaker.subscribe(listener)
      expect(speaker.activeId()).toBeNull()
      speaker.speak('m1', 'One.\nTwo.', OPTS)
      expect(speaker.activeId()).toBe('m1')
      expect(listener).toHaveBeenCalledTimes(1)
      utterances[0].onend?.()
      expect(speaker.activeId()).toBe('m1')
      utterances[1].onend?.()
      expect(speaker.activeId()).toBeNull()
      expect(listener).toHaveBeenCalledTimes(2)
      off()
      speaker.speak('m2', 'Again.', OPTS)
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('is over at once for text with nothing to say', () => {
      const { utterances } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.speak('m1', '```\ncode only\n```', OPTS)
      expect(utterances).toHaveLength(0)
      expect(speaker.activeId()).toBeNull()
    })

    // Chrome drops an utterance handed over in the same breath as a cancel().
    it('replaces a reading in progress: cancels it, never says its rest, and starts the new one a moment later', () => {
      const { synth, utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.speak('old', 'One.\nTwo.', OPTS)
      speaker.speak('new', 'Fresh.', OPTS)
      expect(synth.cancel).toHaveBeenCalledTimes(1)
      expect(speaker.activeId()).toBe('new')
      expect(texts()).toEqual(['One.'])
      vi.advanceTimersByTime(79)
      expect(texts()).toEqual(['One.'])
      vi.advanceTimersByTime(1)
      expect(texts()).toEqual(['One.', 'Fresh.'])
      // The cancelled piece ends late: that must not carry on with "Two.".
      utterances[0].onend?.()
      expect(texts()).toEqual(['One.', 'Fresh.'])
      utterances[1].onend?.()
      expect(speaker.activeId()).toBeNull()
    })

    it('does not cancel when nothing was being said', () => {
      const { synth } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.speak('m', 'One.', OPTS)
      utterances_end(synth)
      speaker.speak('n', 'Two.', OPTS)
      expect(synth.cancel).not.toHaveBeenCalled()
    })

    it('stop() cancels, clears what was queued and ends the reading', () => {
      const { synth, utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const listener = vi.fn()
      speaker.subscribe(listener)
      speaker.speak('m', 'One.\nTwo.', OPTS)
      listener.mockClear()
      speaker.stop()
      expect(synth.cancel).toHaveBeenCalledTimes(1)
      expect(speaker.activeId()).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
      utterances[0].onend?.()
      expect(texts()).toEqual(['One.'])
    })

    it('stop() with nothing playing does nothing', () => {
      const { synth } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.stop()
      expect(synth.cancel).not.toHaveBeenCalled()
    })

    it('moves on to the next piece when one fails, rather than hanging', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.speak('m', 'One.\nTwo.', OPTS)
      utterances[0].onerror?.()
      expect(texts()).toEqual(['One.', 'Two.'])
      utterances[1].onerror?.()
      expect(speaker.activeId()).toBeNull()
    })

    it('counts a piece that both errors and ends once', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      speaker.speak('m', 'One.\nTwo.\nThree.', OPTS)
      utterances[0].onerror?.()
      utterances[0].onend?.()
      expect(texts()).toEqual(['One.', 'Two.'])
    })
  })

  describe('stream', () => {
    it('speaks each complete sentence once as the reply grows, and nothing of an unfinished one', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', EN)
      s.update('Hello')
      s.update('Hello there. How a')
      expect(texts()).toEqual(['Hello there.'])
      s.update('Hello there. How are you? I am')
      s.update('Hello there. How are you? I am fine')
      drain(utterances)
      expect(texts()).toEqual(['Hello there.', 'How are you?'])
      s.update('Hello there. How are you? I am fine')
      drain(utterances)
      expect(texts()).toEqual(['Hello there.', 'How are you?'])
    })

    it('stays active through a pause between sentences, then speaks the remainder at end() and finishes once it is said', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', EN)
      s.update('Hello there. And')
      utterances[0].onend?.()
      expect(speaker.activeId()).toBe('m')
      s.end('Hello there. And goodbye')
      expect(texts()).toEqual(['Hello there.', 'And goodbye'])
      expect(speaker.activeId()).toBe('m')
      utterances[1].onend?.()
      expect(speaker.activeId()).toBeNull()
    })

    it('is over at end() when everything was already said', () => {
      const { utterances } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', EN)
      s.update('Hello there. And')
      utterances[0].onend?.()
      s.end('Hello there.')
      expect(speaker.activeId()).toBeNull()
    })

    it('says nothing from an update that arrives after stop()', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', EN)
      s.update('Hello there. And')
      speaker.stop()
      s.update('Hello there. And more. And more still. Yes')
      s.end('Hello there. And more. And more still. Yes.')
      utterances[0].onend?.()
      expect(texts()).toEqual(['Hello there.'])
      expect(speaker.activeId()).toBeNull()
    })

    it('says nothing from a stream that another reading has replaced', () => {
      const { texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('old', EN)
      speaker.speak('new', 'Fresh.', OPTS)
      s.update('Stale sentence. More')
      vi.advanceTimersByTime(200)
      expect(texts()).toEqual(['Fresh.'])
      expect(speaker.activeId()).toBe('new')
    })

    it('does not speak what is inside a code fence that is still open', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', EN)
      s.update('Run this. Now:\n```js\nconst x = 1.\nconsole.log(x). Done.\n')
      drain(utterances)
      expect(texts().join(' ')).not.toMatch(/const|console/)
      s.end('Run this. Now:\n```js\nconst x = 1.\nconsole.log(x). Done.\n```\nThat prints one.')
      drain(utterances)
      expect(texts()).toEqual(['Run this.', 'Now:', 'That prints one.'])
    })

    // The reply is Markdown that is still being written, so text already counted as plain prose can change shape.
    describe.each([
      ['headings, emphasis, links and lists', '# Title here\n\nHello **world** today. This is `code` and a [link text](https://example.com/page). More words arrive here!\n\n- item one is first.\n- item two is second.\n\nFinal words end it.'],
      ['a table and a fence', 'Intro sentence one.\n\n| col a | col b |\n| --- | --- |\n| 11 | 22 |\n\n```py\nprint(1)\n```\n\nOutro sentence two.'],
      ['a think block', '<think>Reasoning about it. Another thought.</think>Answer number one. Answer number two.'],
      ['numbers and abbreviations', 'Pi is 3.14159 roughly. Euler is 2.718 roughly. Use e.g. this one. Done at last.'],
      ['an ordered list and emphasis across sentences', 'Steps follow.\n\n1. Open the **main window. Then wait** here.\n2. Press _start_ now.\n10. Last step is this one.\n\n> Quoted line one. Quoted line two.'],
      ['a bare URL', 'Go to https://www.example.com/some/page?q=1 now. Then come back again. Finish.'],
    ])('as a reply growing a character at a time: %s', (_name, sample) => {
      it('speaks no piece twice, and everything once the reply ends', () => {
        const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
        const s = speaker.stream('m', EN)
        for (let n = 1; n <= sample.length; n++) {
          s.update(sample.slice(0, n))
          drain(utterances)
        }
        s.end(sample)
        drain(utterances)
        const said = texts()
        expect(new Set(said).size).toBe(said.length)
        // What a whole-message reading says, in the same words.
        speaker.speak('whole', sample, OPTS)
        drain(utterances)
        const wholeTexts = texts().slice(said.length)
        const words = (list: string[]) => list.join(' ').split(/\s+/).filter(Boolean)
        expect(words(said)).toEqual(words(wholeTexts))
        expect(speaker.activeId()).toBeNull()
      })
    })
  })

  describe('following the language of the text', () => {
    const voices = [voice('en', 'en-US', { default: true }), voice('es', 'es-ES')]
    const missing: MissingVoice[] = []
    let off = () => {}
    beforeEach(() => {
      missing.length = 0
      off = speaker.onVoiceMissing((m) => missing.push(m))
    })
    afterEach(() => off())

    it('has fixtures that detect as what the tests below say they are', () => {
      expect(detectLanguage(SPANISH)).toBe('es')
      expect(detectLanguage(ENGLISH)).toBe('en')
      expect(detectLanguage(JAPANESE)).toBe('ja')
    })

    it('reads every piece of a Spanish paragraph with the Spanish voice, not the default English one', () => {
      const { utterances, texts } = installSpeechSynthesis(voices)
      speaker.speak('m', SPANISH, OPTS)
      drain(utterances)
      expect(texts().length).toBeGreaterThan(1)
      for (const u of utterances) {
        expect(u.voice?.voiceURI).toBe('es')
        expect(u.lang).toBe('es-ES')
      }
      expect(missing).toEqual([])
    })

    it('reads an English paragraph with the English voice', () => {
      const { utterances } = installSpeechSynthesis([voice('es', 'es-ES'), voice('en', 'en-US')])
      speaker.speak('m', ENGLISH, OPTS)
      drain(utterances)
      expect(utterances.length).toBeGreaterThan(1)
      for (const u of utterances) {
        expect(u.voice?.voiceURI).toBe('en')
        expect(u.lang).toBe('en-US')
      }
    })

    it('has a German fixture that detects as German', () => {
      expect(detectLanguage(GERMAN)).toBe('de')
    })

    it('skips text the stand-in voice cannot read (Japanese with only Latin-script voices): nothing is spoken and the reading ends', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', JAPANESE, OPTS)
      expect(utterances).toHaveLength(0)
      expect(speaker.activeId()).toBeNull()
      expect(missing).toHaveLength(1)
      expect(missing[0]).toMatchObject({ language: 'ja', onlineOnly: false, skipped: true })
      expect(missing[0].stoodIn?.id).toBe('en')
    })

    it('still reads a language the stand-in voice has the script for (German by an English voice), not skipped', () => {
      const { utterances, texts } = installSpeechSynthesis(voices)
      speaker.speak('m', GERMAN, OPTS)
      drain(utterances)
      expect(texts().length).toBeGreaterThan(1)
      for (const u of utterances) expect(u.voice?.voiceURI).toBe('en')
      expect(missing).toHaveLength(1)
      expect(missing[0]).toMatchObject({ language: 'de', skipped: false })
      expect(missing[0].stoodIn?.id).toBe('en')
    })

    it('reads the English pieces of a mixed reply and leaves the Japanese one out', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('en', 'en-US', { default: true })])
      speaker.speak('m', `${ENGLISH}\n${JAPANESE}\n${ENGLISH}`, OPTS)
      drain(utterances)
      const said = texts()
      expect(said.some((t) => /こんにちは|日本語/.test(t))).toBe(false)
      expect(said.filter((t) => /explain|settings/.test(t)).length).toBeGreaterThan(1)
      expect(speaker.activeId()).toBeNull()
      expect(missing).toHaveLength(1)
      expect(missing[0]).toMatchObject({ language: 'ja', skipped: true })
    })

    it('reports a skipped language at every reading asked for by hand, once per reading however many pieces', () => {
      installSpeechSynthesis(voices)
      speaker.speak('m', JAPANESE, OPTS)
      expect(missing).toHaveLength(1)
      speaker.speak('again', JAPANESE, OPTS)
      expect(missing).toHaveLength(2)
    })

    it('reports a skipped language once per reading even when a spoken piece comes between its pieces', () => {
      const { utterances } = installSpeechSynthesis([voice('en', 'en-US', { default: true })])
      speaker.speak('m', `${JAPANESE}\n${ENGLISH}\n${JAPANESE}`, OPTS)
      drain(utterances)
      expect(missing.filter((m) => m.language === 'ja')).toHaveLength(1)
    })

    it('reports a skipped language of a streamed reading once in total', () => {
      const { utterances } = installSpeechSynthesis(voices)
      for (const id of ['a', 'b']) {
        const s = speaker.stream(id, OPTS)
        s.update(JAPANESE)
        s.end(JAPANESE)
        drain(utterances)
      }
      expect(utterances).toHaveLength(0)
      expect(missing.filter((m) => m.language === 'ja')).toHaveLength(1)
    })

    it('reports a language that is not skipped once in total, across readings', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', GERMAN, OPTS)
      drain(utterances)
      speaker.speak('again', GERMAN, OPTS)
      drain(utterances)
      expect(missing.filter((m) => m.language === 'de')).toHaveLength(1)
    })

    it('says so again after forgetMissing()', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', GERMAN, OPTS)
      drain(utterances)
      expect(missing).toHaveLength(1)
      speaker.forgetMissing()
      speaker.speak('m2', GERMAN, OPTS)
      drain(utterances)
      expect(missing).toHaveLength(2)
    })

    it('says so again after resetTtsBackend(), and not to a listener that has gone', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', GERMAN, OPTS)
      drain(utterances)
      resetTtsBackend()
      installSpeechSynthesis(voices)
      speaker.speak('m2', GERMAN, OPTS)
      expect(missing).toHaveLength(2)
      off()
      speaker.forgetMissing()
      speaker.speak('m3', GERMAN, OPTS)
      expect(missing).toHaveLength(2)
    })

    it('does not report a language for a picked voice that speaks it', () => {
      const { utterances } = installSpeechSynthesis([...voices, voice('ja', 'ja-JP')])
      speaker.speak('m', JAPANESE, { voiceId: 'ja', rate: 1 })
      drain(utterances)
      expect(utterances.every((u) => u.voice?.voiceURI === 'ja')).toBe(true)
      expect(missing).toEqual([])
    })

    it('uses opts.language instead of detecting it', () => {
      const { utterances } = installSpeechSynthesis([voice('en', 'en-US', { default: true }), voice('fr', 'fr-FR')])
      speaker.speak('m', 'This is an English sentence.', { voiceId: '', rate: 1, language: 'fr' })
      expect(utterances[0].voice?.voiceURI).toBe('fr')
      expect(utterances[0].lang).toBe('fr-FR')
    })

    it('hands the browser the language to choose by when no voice is named', () => {
      const { utterances } = installSpeechSynthesis([])
      speaker.speak('m', SPANISH, OPTS)
      expect(utterances[0].voice).toBeNull()
      expect(utterances[0].lang).toBe('es')
    })

    it('does not use an online voice unless allowOnline is set', () => {
      const list = [voice('en', 'en-US', { default: true }), voice('ja-net', 'ja-JP', { localService: false })]
      const first = installSpeechSynthesis(list)
      speaker.speak('m', JAPANESE, OPTS)
      expect(first.utterances).toHaveLength(0) // an English voice cannot read it, and the online one is not allowed
      expect(missing[0]).toMatchObject({ language: 'ja', onlineOnly: true, skipped: true })
      speaker.stop()
      resetTtsBackend()
      const second = installSpeechSynthesis(list)
      speaker.speak('m2', JAPANESE, { voiceId: '', rate: 1, allowOnline: true })
      expect(second.utterances[0].voice?.voiceURI).toBe('ja-net')
      expect(second.utterances[0].lang).toBe('ja-JP')
    })
  })

  describe('the language of a reading too short to tell', () => {
    const voices = [voice('en', 'en-US', { default: true }), voice('es', 'es-ES'), voice('fr', 'fr-FR')]

    it('goes to the system\'s language in a fresh state', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('m', '¡Claro!', OPTS)
      expect(utterances[0].voice?.voiceURI).toBe('en')
    })

    it('goes to the language last told from an earlier reading', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('a', SPANISH, OPTS)
      drain(utterances)
      speaker.speak('b', '¡Claro!', OPTS)
      expect(utterances.at(-1)?.text).toBe('¡Claro!')
      expect(utterances.at(-1)?.voice?.voiceURI).toBe('es')
    })

    it('is not changed by a reading whose language was given (the Settings sample)', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('sample', 'Voici un exemple.', { voiceId: '', rate: 1, language: 'fr' })
      drain(utterances)
      expect(utterances[0].voice?.voiceURI).toBe('fr')
      speaker.speak('b', '¡Claro!', OPTS)
      expect(utterances.at(-1)?.voice?.voiceURI).toBe('en')
    })

    it('is forgotten by forgetMissing() and by resetTtsBackend()', () => {
      const first = installSpeechSynthesis(voices)
      speaker.speak('a', SPANISH, OPTS)
      drain(first.utterances)
      speaker.forgetMissing()
      speaker.speak('b', '¡Claro!', OPTS)
      expect(first.utterances.at(-1)?.voice?.voiceURI).toBe('en')
      drain(first.utterances)
      speaker.speak('c', SPANISH, OPTS)
      drain(first.utterances)
      resetTtsBackend()
      const second = installSpeechSynthesis(voices)
      speaker.speak('d', '¡Claro!', OPTS)
      expect(second.utterances[0].voice?.voiceURI).toBe('en')
    })

    it('applies to a streamed reply too', () => {
      const { utterances } = installSpeechSynthesis(voices)
      speaker.speak('a', SPANISH, OPTS)
      drain(utterances)
      const s = speaker.stream('b', OPTS)
      s.update('Vale.')
      s.end('Vale.')
      expect(utterances.at(-1)?.text).toBe('Vale.')
      expect(utterances.at(-1)?.voice?.voiceURI).toBe('es')
    })
  })

  describe('cannotRead', () => {
    const en = { id: 'en', name: 'English', lang: 'en-US', local: true }
    const es = { id: 'es', name: 'Spanish', lang: 'es-ES', local: true }
    const ja = { id: 'ja', name: 'Japanese', lang: 'ja-JP', local: true }
    const unnamed = { id: 'u', name: 'Unnamed', lang: '', local: true }

    it('is true for text of another script than the Latin voice that would read it', () => {
      for (const language of ['ja', 'ar', 'ru', 'ko', 'zh', 'el']) {
        expect(cannotRead(en, language)).toBe(true)
        expect(cannotRead(es, language)).toBe(true)
      }
    })

    it('is false for no voice', () => {
      expect(cannotRead(null, 'ja')).toBe(false)
    })

    it('is false for Latin-script text, with any voice', () => {
      expect(cannotRead(en, 'de')).toBe(false)
      expect(cannotRead(ja, 'de')).toBe(false)
      expect(cannotRead(en, 'es')).toBe(false)
    })

    it('is false for a voice that is not of a Latin-script language, with any text', () => {
      expect(cannotRead(ja, 'en')).toBe(false)
      expect(cannotRead(ja, 'ru')).toBe(false)
      expect(cannotRead(unnamed, 'ja')).toBe(false)
    })
  })

  describe('the lists of voices', () => {
    const list = [voice('Zed', 'en-US'), voice('Net', 'ja-JP', { localService: false }), voice('Ann', 'en-US'), voice('Bob', 'de-DE', { default: true })]

    it('ttsVoices() is the local ones, and ttsVoices(true) the online ones too, sorted by language then name', () => {
      installSpeechSynthesis(list)
      expect(ttsVoices().map((v) => v.id)).toEqual(['Bob', 'Ann', 'Zed'])
      expect(ttsVoices(true).map((v) => v.id)).toEqual(['Bob', 'Ann', 'Zed', 'Net'])
    })

    it('ttsAllVoices() is everything, in the engine\'s order, with the default marked', () => {
      installSpeechSynthesis(list)
      expect(ttsAllVoices().map((v) => v.id)).toEqual(['Zed', 'Net', 'Ann', 'Bob'])
      expect(ttsAllVoices().map((v) => v.local)).toEqual([true, false, true, true])
      expect(ttsAllVoices().find((v) => v.id === 'Bob')?.isDefault).toBe(true)
    })

    it('ttsAllVoices() does not reorder what ttsVoices() sorts', () => {
      installSpeechSynthesis(list)
      ttsVoices(true)
      expect(ttsAllVoices().map((v) => v.id)).toEqual(['Zed', 'Net', 'Ann', 'Bob'])
    })

    it('has no installer in a browser, nor anything to list without an engine', () => {
      expect(ttsVoiceInstaller()).toBeNull()
      expect(ttsAllVoices()).toEqual([])
      installSpeechSynthesis(list)
      resetTtsBackend()
      expect(ttsVoiceInstaller()).toBeNull()
    })
  })

  describe('stream, language not given', () => {
    const voices = [voice('en', 'en-US', { default: true }), voice('es', 'es-ES')]

    it('speaks nothing while the reply is short and its language cannot be told, then reads on', () => {
      const { texts } = installSpeechSynthesis(voices)
      const s = speaker.stream('m', OPTS)
      s.update('Ok. Fine. And')
      s.update('Ok. Fine. And so')
      expect(texts()).toEqual([])
      expect(speaker.activeId()).toBe('m')
    })

    it('sends the pieces, the first sentence included, to the Spanish voice once enough Spanish has arrived', () => {
      const { utterances, texts } = installSpeechSynthesis(voices)
      const s = speaker.stream('m', OPTS)
      s.update('¡Claro! Sí. Vale.')
      s.update('¡Claro! Sí. Vale. Te explico cómo')
      expect(texts()).toEqual([])
      s.update('¡Claro! Sí. Vale.\nTe explico cómo funciona todo esto.\nPrimero hay que abrir la configuración del programa.\nLuego se elige')
      drain(utterances)
      expect(texts().length).toBeGreaterThan(1)
      expect(texts()[0]).toMatch(/^¡Claro!/)
      for (const u of utterances) {
        expect(u.voice?.voiceURI).toBe('es')
        expect(u.lang).toBe('es-ES')
      }
    })

    it('starts at 80 characters of speakable text even when the language is still unknown, with the default voice', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('es', 'es-ES'), voice('en', 'en-US', { default: true })])
      const s = speaker.stream('m', OPTS)
      const ok = 'Ok. '.repeat(25)
      expect(detectLanguage(ok)).toBeNull()
      s.update(ok.slice(0, 60))
      expect(texts()).toEqual([])
      s.update(ok)
      drain(utterances)
      expect(texts().length).toBeGreaterThan(0)
      expect(utterances[0].voice?.voiceURI).toBe('en')
    })

    it('speaks a short reply of unknown language at end(), with the default voice', () => {
      const { utterances, texts } = installSpeechSynthesis(voices)
      const s = speaker.stream('m', OPTS)
      s.update('OK.')
      expect(texts()).toEqual([])
      s.end('OK.')
      expect(texts()).toEqual(['OK.'])
      expect(utterances[0].voice?.voiceURI).toBe('en')
      utterances[0].onend?.()
      expect(speaker.activeId()).toBeNull()
    })

    it('does not speak what it has spoken twice, across the wait and at end()', () => {
      const { utterances, texts } = installSpeechSynthesis(voices)
      const s = speaker.stream('m', OPTS)
      const text = 'Claro, con mucho gusto te explico cómo funciona. Primero hay que abrir la configuración del programa. Luego se elige la opción.'
      for (let n = 10; n <= text.length; n += 10) {
        s.update(text.slice(0, n))
        drain(utterances)
      }
      s.update(text)
      s.end(text)
      drain(utterances)
      const said = texts()
      expect(new Set(said).size).toBe(said.length)
      expect(said.join(' ')).toBe(text)
    })

    it('with opts.language given, does not wait', () => {
      const { texts } = installSpeechSynthesis(voices)
      const s = speaker.stream('m', { voiceId: '', rate: 1, language: 'es' })
      s.update('Hola a todos. Y')
      expect(texts()).toEqual(['Hola a todos.'])
    })
  })

  describe('pieceLanguage', () => {
    it('takes the piece\'s own language when it is in another script than the reading', () => {
      expect(pieceLanguage('こんにちは、元気ですか。これは日本語です。', 'en')).toBe('ja')
    })

    it('keeps the reading\'s language for a piece in the same script (one sentence cannot tell Spanish from Portuguese)', () => {
      const piece = 'Esto es una frase corta.'
      expect(detectLanguage(piece)).toBe('es')
      expect(pieceLanguage(piece, 'pt')).toBe('pt')
    })

    it('uses the reading\'s language for a piece that cannot be told', () => {
      expect(pieceLanguage('OK.', 'de')).toBe('de')
    })

    it('uses the piece\'s own language when the reading\'s is not known', () => {
      expect(pieceLanguage('Esto es una frase corta.', null)).toBe('es')
    })

    it('is null when neither is known', () => {
      expect(pieceLanguage('OK.', null)).toBeNull()
    })

    it('is the language of both when they agree', () => {
      expect(pieceLanguage('Esto es una frase corta.', 'es')).toBe('es')
    })
  })
})

/** Ends the one utterance the fake engine holds. */
function utterances_end(synth: { speak: { mock: { calls: Array<[FakeUtterance]> } } }): void {
  for (const [u] of synth.speak.mock.calls) u.onend?.()
}

describe('the Android bridge', () => {
  type Sent = { type: string; id?: string; text?: string; voice?: string; lang?: string; rate?: number }

  /** A stand-in for the message port the app injects: records what the page posts, and lets the test answer. */
  function installPort(over: { postMessage?: (m: string) => void } = {}) {
    const posted: Sent[] = []
    const listeners: Array<(e: { data: unknown }) => void> = []
    const port = {
      postMessage: vi.fn((m: string) => {
        if (over.postMessage) over.postMessage(m)
        posted.push(JSON.parse(m) as Sent)
      }),
      addEventListener: vi.fn((_type: string, l: (e: { data: unknown }) => void) => { listeners.push(l) }),
    }
    ;(globalThis as { TurboLLMNative?: unknown }).TurboLLMNative = port
    const emit = (data: unknown) => { for (const l of listeners) l({ data }) }
    const emitJson = (message: unknown) => emit(JSON.stringify(message))
    const speaks = () => posted.filter((m) => m.type === 'tts.speak')
    return { port, posted, emit, emitJson, speaks }
  }

  const VOICES = [
    { id: 'en-us-x', name: 'English (US)', lang: 'en-US' },
    { id: 'de', name: 'Deutsch', lang: 'de-DE' },
    { name: 'no id' },
    { id: 'nolang', name: 'No language' },
  ]

  it('sends the app nothing until its voices are listed, then asks for them once', () => {
    // The app starts its speech engine with the first message it is sent: a chat that only shows the button must
    // not start it.
    const { posted, port } = installPort()
    expect(port.addEventListener).not.toHaveBeenCalled()
    ttsAvailable()
    expect(posted).toEqual([])
    expect(port.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    ttsVoices()
    ttsAllVoices()
    expect(posted).toEqual([{ type: 'tts.voices' }])
  })

  it('asks for the voices with the first thing it is given to say', () => {
    const { posted } = installPort()
    speaker.speak('m', 'One.', OPTS)
    expect(posted.map((m) => m.type)).toEqual(['tts.voices', 'tts.speak'])
  })

  it('counts as able to speak until the app answers that it has no voice', () => {
    const { emitJson } = installPort()
    expect(ttsAvailable()).toBe(true)
    emitJson({ type: 'tts.voices', voices: [] })
    expect(ttsAvailable()).toBe(false)
    emitJson({ type: 'tts.voices', voices: VOICES })
    expect(ttsAvailable()).toBe(true)
  })

  it('tells voice listeners when the list arrives, and not after they unsubscribe', () => {
    const { emitJson } = installPort()
    const listener = vi.fn()
    const off = onTtsVoices(listener)
    emitJson({ type: 'tts.voices', voices: VOICES })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    emitJson({ type: 'tts.voices', voices: VOICES })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('lists the voices of that message, a voice with no `local` field as local, skipping malformed entries', () => {
    const { emitJson } = installPort()
    ttsAvailable() // the backend, and with it the page's listener, is created on first use
    emitJson({ type: 'tts.voices', voices: VOICES })
    expect(ttsVoices()).toEqual([
      { id: 'nolang', name: 'No language', lang: '', local: true },
      { id: 'de', name: 'Deutsch', lang: 'de-DE', local: true },
      { id: 'en-us-x', name: 'English (US)', lang: 'en-US', local: true },
    ])
  })

  it('is preferred over speechSynthesis when both are there', () => {
    installSpeechSynthesis([voice('web', 'en-US')])
    installPort()
    expect(ttsAllVoices()).toEqual([])
    expect(ttsVoices().map((v) => v.id)).not.toContain('web')
  })

  it('ignores malformed JSON, a non-array voices, and messages of other types', () => {
    const { emit, emitJson } = installPort()
    ttsAvailable()
    emitJson({ type: 'tts.voices', voices: VOICES })
    emit('not json')
    emit(undefined)
    emitJson({ type: 'tts.voices', voices: 'nope' })
    emitJson({ type: 'something.else', voices: [] })
    expect(ttsVoices()).toHaveLength(3)
  })

  it('speaks with tts.speak, and goes on to the next piece only when that id\'s tts.done arrives', () => {
    const { speaks, emitJson } = installPort()
    ttsAvailable()
    emitJson({ type: 'tts.voices', voices: VOICES })
    speaker.speak('m', 'One.\nTwo.', { voiceId: 'de', rate: 1.25 })
    expect(speaks()).toHaveLength(1)
    const first = speaks()[0]
    expect(first).toMatchObject({ text: 'One.', voice: 'de', lang: '', rate: 1.25 })
    emitJson({ type: 'tts.done', id: 'someone-else', ok: true })
    expect(speaks()).toHaveLength(1)
    emitJson({ type: 'tts.done', id: first.id, ok: true })
    expect(speaks()).toHaveLength(2)
    expect(speaks()[1].text).toBe('Two.')
    expect(speaks()[1].id).not.toBe(first.id)
    emitJson({ type: 'tts.done', id: speaks()[1].id, ok: true })
    expect(speaker.activeId()).toBeNull()
  })

  it('moves on when a piece fails (ok: false)', () => {
    const { speaks, emitJson } = installPort()
    speaker.speak('m', 'One.\nTwo.', OPTS)
    emitJson({ type: 'tts.done', id: speaks()[0].id, ok: false })
    expect(speaks()).toHaveLength(2)
  })

  it('finishes a piece as not spoken, rather than hanging, when the port throws', () => {
    let calls = 0
    const { speaks } = installPort({ postMessage: () => { if (++calls > 1) throw new Error('port gone') } })
    speaker.speak('m', 'One.\nTwo.', OPTS)
    // The voices request was call 1; both speak attempts throw, so nothing stays pending and the reading ends.
    expect(speaks()).toHaveLength(0)
    expect(speaker.activeId()).toBeNull()
  })

  it('stop() posts tts.stop and settles the piece in flight without waiting for the app', () => {
    const { posted, speaks, emitJson } = installPort()
    speaker.speak('m', 'One.\nTwo.', OPTS)
    speaker.stop()
    expect(posted.at(-1)).toEqual({ type: 'tts.stop' })
    expect(speaker.activeId()).toBeNull()
    // The app's late answer for the stopped piece must not start the next one.
    emitJson({ type: 'tts.done', id: speaks()[0].id, ok: false })
    expect(speaks()).toHaveLength(1)
  })

  it('replacing a reading stops the old one on the app too', () => {
    const { posted, speaks } = installPort()
    speaker.speak('old', 'One.\nTwo.', OPTS)
    speaker.speak('new', 'Fresh.', OPTS)
    expect(posted.filter((m) => m.type === 'tts.stop')).toHaveLength(1)
    vi.advanceTimersByTime(80)
    expect(speaks().map((m) => m.text)).toEqual(['One.', 'Fresh.'])
  })

  describe('voices and languages', () => {
    const MIXED = [
      { id: 'en', name: 'English', lang: 'en-US', local: true },
      { id: 'es', name: 'Spanish', lang: 'es-ES', local: true },
      { id: 'ja-net', name: 'Japanese (network)', lang: 'ja-JP', local: false },
      { id: 'old', name: 'Old app voice', lang: 'fr-FR' },
    ]

    it('sends the voice read the text with and the primary language of the text', () => {
      const { speaks, emitJson } = installPort()
      ttsAvailable()
      emitJson({ type: 'tts.voices', voices: MIXED })
      speaker.speak('m', SPANISH, OPTS)
      expect(speaks()[0]).toMatchObject({ voice: 'es', lang: 'es' })
    })

    it('sends an empty lang when the language is not known, and the language given in the options', () => {
      const { speaks, emitJson } = installPort()
      ttsAvailable()
      emitJson({ type: 'tts.voices', voices: MIXED })
      speaker.speak('m', 'OK.', OPTS)
      expect(speaks()[0]).toMatchObject({ text: 'OK.', lang: '' })
      speaker.stop()
      speaker.speak('m2', 'OK.', { voiceId: '', rate: 1, language: 'pt' })
      expect(speaks().at(-1)).toMatchObject({ text: 'OK.', lang: 'pt' })
    })

    it('sends no voice (an empty id) when the app has listed none', () => {
      const { speaks } = installPort()
      speaker.speak('m', SPANISH, OPTS)
      expect(speaks()[0]).toMatchObject({ voice: '', lang: 'es' })
    })

    it('leaves voices that arrive as not local out of ttsVoices(), and puts them in ttsVoices(true)', () => {
      const { emitJson } = installPort()
      ttsAvailable()
      emitJson({ type: 'tts.voices', voices: MIXED })
      expect(ttsVoices().map((v) => v.id)).toEqual(['en', 'es', 'old'])
      expect(ttsVoices().map((v) => v.id)).not.toContain('ja-net')
      expect(ttsVoices(true).map((v) => v.id)).toContain('ja-net')
      expect(ttsAllVoices()).toHaveLength(4)
    })

    it('counts a voice with no local field as local, and one with local: false as not', () => {
      const { emitJson } = installPort()
      ttsAvailable()
      emitJson({ type: 'tts.voices', voices: MIXED })
      const byId = Object.fromEntries(ttsAllVoices().map((v) => [v.id, v.local]))
      expect(byId).toEqual({ en: true, es: true, 'ja-net': false, old: true })
    })

    it('uses an online voice only when allowOnline is set, and reports the language missing otherwise', () => {
      const { speaks, emitJson } = installPort()
      ttsAvailable()
      emitJson({ type: 'tts.voices', voices: MIXED })
      const missing: MissingVoice[] = []
      const off = speaker.onVoiceMissing((m) => missing.push(m))
      speaker.speak('m', JAPANESE, OPTS)
      expect(speaks()).toHaveLength(0) // the voices that are allowed cannot read it
      expect(missing).toHaveLength(1)
      expect(missing[0]).toMatchObject({ language: 'ja', onlineOnly: true, skipped: true })
      speaker.stop()
      speaker.speak('m2', JAPANESE, { voiceId: '', rate: 1, allowOnline: true })
      expect(speaks().at(-1)).toMatchObject({ voice: 'ja-net', lang: 'ja' })
      off()
    })

    it('offers an installer that asks the app to open its voice downloads', () => {
      const { posted } = installPort()
      const install = ttsVoiceInstaller()
      expect(install).toBeTypeOf('function')
      expect(posted.filter((m) => m.type === 'tts.install')).toHaveLength(0)
      install?.()
      expect(posted.at(-1)).toEqual({ type: 'tts.install' })
    })

    describe('when the app comes back to the front', () => {
      const setVisibility = (state: string) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
      afterEach(() => { delete (document as { visibilityState?: unknown }).visibilityState })

      it('asks nothing of an app that was never asked for its voices', () => {
        const { posted } = installPort()
        ttsAvailable()
        setVisibility('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(posted).toEqual([])
      })

      it('asks for the voices again, and not when it goes away', () => {
        const { posted } = installPort()
        ttsVoices()
        const asks = () => posted.filter((m) => m.type === 'tts.voices').length
        expect(asks()).toBe(1)
        setVisibility('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(asks()).toBe(1)
        setVisibility('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(asks()).toBe(2)
      })

      it('lists the voices the app answers with, telling listeners', () => {
        const { emitJson } = installPort()
        ttsAvailable()
        const listener = vi.fn()
        onTtsVoices(listener)
        emitJson({ type: 'tts.voices', voices: [MIXED[0]] })
        emitJson({ type: 'tts.voices', voices: MIXED })
        expect(listener).toHaveBeenCalledTimes(2)
        expect(ttsAllVoices()).toHaveLength(4)
      })
    })
  })
})

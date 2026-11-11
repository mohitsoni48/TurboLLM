import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onTtsVoices, resetTtsBackend, speaker, ttsAvailable, ttsVoices } from './tts'

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
      expect(ttsVoices()[0]).toEqual({ id: 'Bob', name: 'Bob', lang: 'de-DE', local: true })
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
      const s = speaker.stream('m', OPTS)
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
      const s = speaker.stream('m', OPTS)
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
      const s = speaker.stream('m', OPTS)
      s.update('Hello there. And')
      utterances[0].onend?.()
      s.end('Hello there.')
      expect(speaker.activeId()).toBeNull()
    })

    it('says nothing from an update that arrives after stop()', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', OPTS)
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
      const s = speaker.stream('old', OPTS)
      speaker.speak('new', 'Fresh.', OPTS)
      s.update('Stale sentence. More')
      vi.advanceTimersByTime(200)
      expect(texts()).toEqual(['Fresh.'])
      expect(speaker.activeId()).toBe('new')
    })

    it('does not speak what is inside a code fence that is still open', () => {
      const { utterances, texts } = installSpeechSynthesis([voice('a', 'en-US')])
      const s = speaker.stream('m', OPTS)
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
        const s = speaker.stream('m', OPTS)
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
})

/** Ends the one utterance the fake engine holds. */
function utterances_end(synth: { speak: { mock: { calls: Array<[FakeUtterance]> } } }): void {
  for (const [u] of synth.speak.mock.calls) u.onend?.()
}

describe('the Android bridge', () => {
  type Sent = { type: string; id?: string; text?: string; voice?: string; rate?: number }

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

  it('asks the app for its voices once, when the backend is created', () => {
    const { posted, port } = installPort()
    expect(port.addEventListener).not.toHaveBeenCalled()
    ttsAvailable()
    ttsVoices()
    expect(posted).toEqual([{ type: 'tts.voices' }])
    expect(port.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('is unavailable until a tts.voices message with at least one voice arrives', () => {
    const { emitJson } = installPort()
    expect(ttsAvailable()).toBe(false)
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

  it('lists the voices of that message, all as local, skipping malformed entries', () => {
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
    expect(ttsAvailable()).toBe(false)
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
    speaker.speak('m', 'One.\nTwo.', { voiceId: 'de', rate: 1.25 })
    expect(speaks()).toHaveLength(1)
    const first = speaks()[0]
    expect(first).toMatchObject({ text: 'One.', voice: 'de', rate: 1.25 })
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
})

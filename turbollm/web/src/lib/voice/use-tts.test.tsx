import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { toast } from '../../components/ui/sonner'
import { useVoiceStore } from '../../stores/voice'
import { resetTtsBackend, speaker, ttsAvailable, type MissingVoice, type TtsVoice } from './tts'
import { missingVoiceNotice, readAloudOptions, useVoiceNotices } from './use-tts'

vi.mock('../../components/ui/sonner', () => ({ toast: vi.fn() }))

const stand: TtsVoice = { id: 'en', name: 'Samantha', lang: 'en-US', local: true }
const missing = (over: Partial<MissingVoice> = {}): MissingVoice => ({ language: 'ja', stoodIn: stand, onlineOnly: false, skipped: false, ...over })

describe('missingVoiceNotice', () => {
  it('names the language in the title', () => {
    expect(missingVoiceNotice(missing(), false).title).toBe('This device has no Japanese voice')
  })

  it('says which voice read it instead, and sends the user to the system\'s speech settings in a browser', () => {
    const { description } = missingVoiceNotice(missing(), false)
    expect(description).toContain('It is being read by the English (United States) voice.')
    expect(description).toContain('Add a Japanese voice in your system\'s speech settings')
    expect(description).not.toContain('allow online voices')
  })

  it('says the stand-in voice cannot read it and it is left out, when it was skipped', () => {
    const { description } = missingVoiceNotice(missing({ skipped: true }), false)
    expect(description).toContain('The English (United States) voice cannot read it, so it is left out.')
    expect(description).not.toContain('is being read by')
    expect(description).not.toContain('Samantha')
    expect(description).toContain('Add a Japanese voice')
  })

  it('does not say it is left out when it is read anyway', () => {
    expect(missingVoiceNotice(missing({ skipped: false }), false).description).not.toContain('left out')
  })

  it('sends the user to the phone\'s text-to-speech settings where the app can open them', () => {
    const { description } = missingVoiceNotice(missing(), true)
    expect(description).toContain('Add a Japanese voice in your phone\'s text-to-speech settings')
    expect(description).not.toContain('system\'s speech settings')
  })

  it('says it cannot be read aloud when no voice stood in', () => {
    const { description } = missingVoiceNotice(missing({ stoodIn: null }), false)
    expect(description).toContain('It cannot be read aloud here.')
    expect(description).not.toContain('is being read by')
  })

  it('calls a stand-in voice that does not say its language "the voice this device has", in both forms', () => {
    const unnamed = { ...stand, lang: '' }
    expect(missingVoiceNotice(missing({ stoodIn: unnamed }), false).description).toContain('It is being read by the voice this device has.')
    expect(missingVoiceNotice(missing({ stoodIn: unnamed, skipped: true }), false).description).toContain('The voice this device has cannot read it, so it is left out.')
  })

  it('adds the online voices clause only when an online voice would speak it', () => {
    const online = missingVoiceNotice(missing({ onlineOnly: true }), false).description
    expect(online).toContain('or allow online voices in Settings → Voice')
    expect(online.endsWith('.')).toBe(true)
    expect(missingVoiceNotice(missing({ onlineOnly: false }), false).description).not.toContain('online')
  })

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('is a complete sentence ending in a full stop (stand-in %s, install %s)', (withVoice, canInstall) => {
    const { description } = missingVoiceNotice(missing({ stoodIn: withVoice ? stand : null, onlineOnly: true }), canInstall)
    expect(description).toMatch(/\.$/)
    expect(description).not.toMatch(/\.\./)
  })
})

describe('readAloudOptions', () => {
  afterEach(() => useVoiceStore.setState({ ttsVoice: '', ttsRate: 1, onlineVoices: false }))

  it('is what the store says', () => {
    useVoiceStore.setState({ ttsVoice: 'v7', ttsRate: 1.4, onlineVoices: true })
    expect(readAloudOptions()).toEqual({ voiceId: 'v7', rate: 1.4, allowOnline: true })
    useVoiceStore.setState({ ttsVoice: '', ttsRate: 1, onlineVoices: false })
    expect(readAloudOptions()).toEqual({ voiceId: '', rate: 1, allowOnline: false })
  })
})

describe('useVoiceNotices', () => {
  const JAPANESE = 'こんにちは、元気ですか。\nこれは日本語の長い文章です。'

  function Probe() {
    useVoiceNotices()
    return <LocationShown />
  }
  function LocationShown() {
    const l = useLocation()
    return <div data-testid="at">{l.pathname + l.search}</div>
  }
  const mount = () => render(<MemoryRouter initialEntries={['/chat']}><Probe /></MemoryRouter>)

  function installWebSpeech() {
    const voices = [{ voiceURI: 'en', name: 'Samantha', lang: 'en-US', localService: true, default: true }]
    class Utterance {
      voice = null
      lang = ''
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, 'speechSynthesis', {
      value: { getVoices: () => voices, speak: vi.fn(), cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
      configurable: true,
      writable: true,
    })
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  }

  function installPort() {
    const listeners: Array<(e: { data: unknown }) => void> = []
    const port = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_t: string, l: (e: { data: unknown }) => void) => { listeners.push(l) }),
    }
    ;(globalThis as { TurboLLMNative?: unknown }).TurboLLMNative = port
    return { port, emit: (m: unknown) => { for (const l of listeners) l({ data: JSON.stringify(m) }) } }
  }

  // The speaker holds off for a moment after replacing a reading, by the clock: each test starts a minute after the last.
  let clock = Date.now()
  beforeEach(() => {
    clock += 60_000
    vi.useFakeTimers({ now: clock })
    vi.mocked(toast).mockClear()
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

  it('shows a toast when the speaker reports a missing voice, with a way to the voice settings in a browser', () => {
    installWebSpeech()
    mount()
    act(() => speaker.speak('m', JAPANESE, { voiceId: '', rate: 1 }))
    expect(toast).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast).mock.calls[0] as unknown as [string, { id: string; description: string; action: { label: string; onClick: () => void } }]
    expect(title).toBe('This device has no Japanese voice')
    expect(options.id).toBe('voice-missing-ja')
    expect(options.description).toContain('The English (United States) voice cannot read it, so it is left out.')
    expect(options.description).toContain('system\'s speech settings')
    expect(options.action.label).toBe('Voice settings')

    // Read again by hand, it is said again: under the same id, so it replaces the first notice.
    act(() => speaker.speak('again', JAPANESE, { voiceId: '', rate: 1 }))
    expect(toast).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast).mock.calls[1][1]).toMatchObject({ id: 'voice-missing-ja' })

    act(() => options.action.onClick())
    expect(screen.getByTestId('at').textContent).toBe('/settings?section=voice')
  })

  it('offers "Get voices", which asks the app to open them, when the Android port is there', () => {
    const { port, emit } = installPort()
    mount()
    ttsAvailable() // the backend, and with it the page's listener for the app's messages, is created on first use
    emit({ type: 'tts.voices', voices: [{ id: 'en', name: 'Samantha', lang: 'en-US', local: true }] })
    act(() => speaker.speak('m', JAPANESE, { voiceId: '', rate: 1 }))
    expect(toast).toHaveBeenCalledTimes(1)
    const [, options] = vi.mocked(toast).mock.calls[0] as unknown as [string, { description: string; action: { label: string; onClick: () => void } }]
    expect(options.action.label).toBe('Get voices')
    expect(options.description).toContain('phone\'s text-to-speech settings')
    act(() => options.action.onClick())
    expect(port.postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'tts.install' }))
    expect(screen.getByTestId('at').textContent).toBe('/chat')
  })

  it('shows a language that is read anyway (German by an English voice) once, and says it is being read', () => {
    installWebSpeech()
    mount()
    const german = 'Natürlich, ich erkläre es dir gerne.\nZuerst musst du die Einstellungen des Programms öffnen.'
    act(() => speaker.speak('m', german, { voiceId: '', rate: 1 }))
    act(() => speaker.stop())
    act(() => speaker.speak('again', german, { voiceId: '', rate: 1 }))
    expect(toast).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast).mock.calls[0] as unknown as [string, { id: string; description: string }]
    expect(title).toBe('This device has no German voice')
    expect(options.id).toBe('voice-missing-de')
    expect(options.description).toContain('It is being read by the English (United States) voice.')
  })

  it('shows nothing when nothing is missing, and stops listening when unmounted', () => {
    installWebSpeech()
    const { unmount } = mount()
    act(() => speaker.speak('m', 'Hello there, how are you doing today? I hope you are well.', { voiceId: '', rate: 1 }))
    expect(toast).not.toHaveBeenCalled()
    unmount()
    act(() => speaker.speak('m2', JAPANESE, { voiceId: '', rate: 1 }))
    expect(toast).not.toHaveBeenCalled()
  })
})

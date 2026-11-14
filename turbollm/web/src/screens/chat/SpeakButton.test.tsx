import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTtsBackend, speaker } from '../../lib/voice/tts'
import { useVoiceStore } from '../../stores/voice'
import { SpeakButton } from './SpeakButton'

/** A speech engine with one voice that says nothing and records what it was given. */
function installSpeech(voiceCount = 1) {
  const spoken: Array<{ text: string; voiceURI: string | undefined; rate: number }> = []
  const voices = Array.from({ length: voiceCount }, (_, i) => ({ voiceURI: `v${i}`, name: `V${i}`, lang: 'en-US', localService: true, default: i === 0 }))
  const synth = {
    getVoices: () => voices,
    speak: vi.fn((u: { text: string; voice?: { voiceURI: string }; rate: number }) => { spoken.push({ text: u.text, voiceURI: u.voice?.voiceURI, rate: u.rate }) }),
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
  vi.stubGlobal('SpeechSynthesisUtterance', class { voice: unknown = null; lang = ''; rate = 1; onend = null; onerror = null; constructor(readonly text: string) {} })
  return { synth, spoken }
}

beforeEach(() => {
  resetTtsBackend()
  useVoiceStore.setState({ ttsVoice: '', ttsRate: 1 })
})
afterEach(() => {
  act(() => speaker.stop())
  vi.unstubAllGlobals()
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  resetTtsBackend()
})

describe('SpeakButton', () => {
  it('renders nothing where nothing can speak', () => {
    const { container } = render(<SpeakButton id="m1" text="Hello." />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the engine has no voice', () => {
    installSpeech(0)
    const { container } = render(<SpeakButton id="m1" text="Hello." />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is a "Read aloud" button that is not pressed, where something can speak', () => {
    installSpeech()
    render(<SpeakButton id="m1" text="Hello." />)
    const button = screen.getByRole('button', { name: 'Read aloud' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('reads the message in the saved voice and rate when clicked', async () => {
    const { spoken } = installSpeech(2)
    useVoiceStore.setState({ ttsVoice: 'v1', ttsRate: 1.5 })
    render(<SpeakButton id="m1" text="Hello **there**." />)
    await userEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    expect(spoken).toEqual([{ text: 'Hello there.', voiceURI: 'v1', rate: 1.5 }])
    expect(speaker.activeId()).toBe('m1')
  })

  it('becomes "Stop reading", pressed, while its own message is read, and stops on click', async () => {
    const { synth } = installSpeech()
    render(<SpeakButton id="m1" text="Hello." />)
    await userEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    const stop = screen.getByRole('button', { name: 'Stop reading' })
    expect(stop).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(stop)
    expect(synth.cancel).toHaveBeenCalled()
    expect(speaker.activeId()).toBeNull()
    expect(screen.getByRole('button', { name: 'Read aloud' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('stays "Read aloud" while another message is read', async () => {
    installSpeech()
    render(<><SpeakButton id="m1" text="One." /><SpeakButton id="m2" text="Two." /></>)
    const [first] = screen.getAllByRole('button', { name: 'Read aloud' })
    await userEvent.click(first)
    expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Stop reading' })).toHaveLength(1)
  })
})

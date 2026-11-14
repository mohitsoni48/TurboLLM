import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceBar } from './VoiceBar'
import type { VoiceInput, VoicePhase } from './useVoiceInput'

function makeVoice(phase: VoicePhase, over: Partial<VoiceInput> = {}) {
  const voice = {
    phase,
    startedAt: Date.now(),
    pendingMs: 0,
    meter: { subscribe: () => () => {}, level: () => 0 },
    block: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
    choose: vi.fn(),
    ...over,
  }
  return voice as VoiceInput & { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; choose: ReturnType<typeof vi.fn> }
}

afterEach(() => vi.useRealTimers())

describe('VoiceBar', () => {
  it('renders nothing while idle', () => {
    const { container } = render(<VoiceBar voice={makeVoice('idle')} autoStop />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says it is waiting for the microphone while starting, and can be cancelled', async () => {
    const voice = makeVoice('starting')
    render(<VoiceBar voice={voice} autoStop />)
    expect(screen.getByText('Waiting for the microphone…')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(voice.cancel).toHaveBeenCalledTimes(1)
  })

  it('says it is converting while transcribing, and can be cancelled', async () => {
    const voice = makeVoice('transcribing')
    render(<VoiceBar voice={voice} autoStop />)
    expect(screen.getByText('Converting speech to text…')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(voice.cancel).toHaveBeenCalledTimes(1)
  })

  describe('while recording', () => {
    it('says it stops when the speaker finishes, if auto-stop is on', () => {
      render(<VoiceBar voice={makeVoice('recording')} autoStop />)
      expect(screen.getByText(/Listening/)).toBeInTheDocument()
      expect(screen.getByText('Stops when you finish speaking.')).toBeInTheDocument()
    })

    it('says to press the microphone again, if auto-stop is off', () => {
      render(<VoiceBar voice={makeVoice('recording')} autoStop={false} />)
      expect(screen.getByText('Press the microphone again when you are done.')).toBeInTheDocument()
      expect(screen.queryByText('Stops when you finish speaking.')).toBeNull()
    })

    it('Done finishes the recording and the discard button drops it', async () => {
      const voice = makeVoice('recording')
      render(<VoiceBar voice={voice} autoStop />)
      await userEvent.click(screen.getByRole('button', { name: /Done/ }))
      expect(voice.stop).toHaveBeenCalledTimes(1)
      expect(voice.cancel).not.toHaveBeenCalled()
      await userEvent.click(screen.getByRole('button', { name: 'Discard the recording' }))
      expect(voice.cancel).toHaveBeenCalledTimes(1)
    })

    it('shows the clock running from when the recording began', () => {
      vi.useFakeTimers()
      const voice = makeVoice('recording', { startedAt: Date.now() })
      render(<VoiceBar voice={voice} autoStop />)
      expect(screen.getByText('0:00')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(65_000) })
      expect(screen.getByText('1:05')).toBeInTheDocument()
    })

    it('draws the input level from the meter', () => {
      let level = 0
      const listeners = new Set<() => void>()
      const meter = { subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }, level: () => level }
      const { container } = render(<VoiceBar voice={makeVoice('recording', { meter })} autoStop />)
      const bar = () => container.querySelector<HTMLElement>('span[aria-hidden] > span')!
      expect(bar().style.width).toBe('0%')
      level = 0.5
      act(() => { for (const l of listeners) l() })
      expect(bar().style.width).toBe('50%')
    })
  })

  describe('while choosing', () => {
    it('shows the clip length and the two ways to send it', () => {
      render(<VoiceBar voice={makeVoice('choosing', { pendingMs: 65_000 })} autoStop />)
      expect(screen.getByText('Recorded 1:05')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send as audio' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Convert to text' })).toBeInTheDocument()
    })

    it('"Send as audio" and "Convert to text" choose without remembering by default', async () => {
      const voice = makeVoice('choosing', { pendingMs: 3000 })
      render(<VoiceBar voice={voice} autoStop />)
      await userEvent.click(screen.getByRole('button', { name: 'Send as audio' }))
      expect(voice.choose).toHaveBeenLastCalledWith('audio', false)
      await userEvent.click(screen.getByRole('button', { name: 'Convert to text' }))
      expect(voice.choose).toHaveBeenLastCalledWith('text', false)
    })

    it('with "Don\'t ask again" ticked, chooses and remembers', async () => {
      const voice = makeVoice('choosing', { pendingMs: 3000 })
      render(<VoiceBar voice={voice} autoStop />)
      await userEvent.click(screen.getByRole('checkbox', { name: /ask again/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Send as audio' }))
      expect(voice.choose).toHaveBeenLastCalledWith('audio', true)
      await userEvent.click(screen.getByRole('button', { name: 'Convert to text' }))
      expect(voice.choose).toHaveBeenLastCalledWith('text', true)
    })

    it('the discard button drops the recording', async () => {
      const voice = makeVoice('choosing', { pendingMs: 3000 })
      render(<VoiceBar voice={voice} autoStop />)
      await userEvent.click(screen.getByRole('button', { name: 'Discard the recording' }))
      expect(voice.cancel).toHaveBeenCalledTimes(1)
    })
  })
})

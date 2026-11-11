import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The store reads localStorage once, when its module is evaluated: each case seeds storage, then loads a fresh copy.
async function loadStore() {
  vi.resetModules()
  return (await import('./voice')).useVoiceStore
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('useVoiceStore defaults', () => {
  it('starts with the defaults when nothing is stored', async () => {
    const s = (await loadStore()).getState()
    expect(s.audioMode).toBe('ask')
    expect(s.autoSend).toBe(false)
    expect(s.autoStop).toBe(true)
    expect(s.readAloud).toBe('off')
    expect(s.ttsVoice).toBe('')
    expect(s.ttsRate).toBe(1)
  })

  it('reads what an earlier visit saved', async () => {
    localStorage.setItem('tllm.voice.audioMode', 'text')
    localStorage.setItem('tllm.voice.autoSend', 'true')
    localStorage.setItem('tllm.voice.autoStop', 'false')
    localStorage.setItem('tllm.voice.readAloud', 'always')
    localStorage.setItem('tllm.voice.ttsVoice', 'Samantha')
    localStorage.setItem('tllm.voice.ttsRate', '1.5')
    const s = (await loadStore()).getState()
    expect(s).toMatchObject({ audioMode: 'text', autoSend: true, autoStop: false, readAloud: 'always', ttsVoice: 'Samantha', ttsRate: 1.5 })
  })

  it('reads "audio" and "voice" as the other choices of the two modes', async () => {
    localStorage.setItem('tllm.voice.audioMode', 'audio')
    localStorage.setItem('tllm.voice.readAloud', 'voice')
    const s = (await loadStore()).getState()
    expect(s.audioMode).toBe('audio')
    expect(s.readAloud).toBe('voice')
  })

  it('falls back to the defaults for stored garbage', async () => {
    localStorage.setItem('tllm.voice.audioMode', 'banana')
    localStorage.setItem('tllm.voice.autoSend', 'yes')
    localStorage.setItem('tllm.voice.autoStop', 'nope')
    localStorage.setItem('tllm.voice.readAloud', '{}')
    localStorage.setItem('tllm.voice.ttsRate', 'fast')
    const s = (await loadStore()).getState()
    expect(s).toMatchObject({ audioMode: 'ask', autoSend: false, autoStop: true, readAloud: 'off', ttsRate: 1 })
  })

  it.each(['0.1', '3', '-1', 'Infinity', 'NaN'])('falls back to a rate of 1 for a stored rate of %s', async (stored) => {
    localStorage.setItem('tllm.voice.ttsRate', stored)
    expect((await loadStore()).getState().ttsRate).toBe(1)
  })

  it('uses the defaults when localStorage cannot be read', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => {} })
    const s = (await loadStore()).getState()
    expect(s).toMatchObject({ audioMode: 'ask', autoSend: false, autoStop: true, readAloud: 'off', ttsVoice: '', ttsRate: 1 })
  })
})

describe('useVoiceStore setters', () => {
  it('each updates the state and saves under its own tllm.voice key', async () => {
    const store = await loadStore()
    const s = store.getState()
    s.setAudioMode('audio')
    s.setAutoSend(true)
    s.setAutoStop(false)
    s.setReadAloud('voice')
    s.setTtsVoice('Daniel')
    s.setTtsRate(1.25)
    expect(store.getState()).toMatchObject({ audioMode: 'audio', autoSend: true, autoStop: false, readAloud: 'voice', ttsVoice: 'Daniel', ttsRate: 1.25 })
    expect(localStorage.getItem('tllm.voice.audioMode')).toBe('audio')
    expect(localStorage.getItem('tllm.voice.autoSend')).toBe('true')
    expect(localStorage.getItem('tllm.voice.autoStop')).toBe('false')
    expect(localStorage.getItem('tllm.voice.readAloud')).toBe('voice')
    expect(localStorage.getItem('tllm.voice.ttsVoice')).toBe('Daniel')
    expect(localStorage.getItem('tllm.voice.ttsRate')).toBe('1.25')
  })

  it('what a setter saved is what the next visit starts with', async () => {
    const first = await loadStore()
    first.getState().setAutoStop(false)
    first.getState().setAudioMode('text')
    first.getState().setTtsRate(0.75)
    const second = (await loadStore()).getState()
    expect(second).toMatchObject({ autoStop: false, audioMode: 'text', ttsRate: 0.75 })
  })

  it('clamps the rate to 0.5 to 2, in the state and in what is saved', async () => {
    const store = await loadStore()
    store.getState().setTtsRate(5)
    expect(store.getState().ttsRate).toBe(2)
    expect(localStorage.getItem('tllm.voice.ttsRate')).toBe('2')
    store.getState().setTtsRate(0.1)
    expect(store.getState().ttsRate).toBe(0.5)
    expect(localStorage.getItem('tllm.voice.ttsRate')).toBe('0.5')
  })

  it('still updates the state when saving throws (storage blocked)', async () => {
    const store = await loadStore()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') } })
    expect(() => store.getState().setAudioMode('text')).not.toThrow()
    expect(() => store.getState().setTtsRate(1.5)).not.toThrow()
    expect(store.getState().audioMode).toBe('text')
    expect(store.getState().ttsRate).toBe(1.5)
  })
})

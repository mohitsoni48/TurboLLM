// jsdom has no Web Audio and no microphone. micSupport / micErrorFor / clipDataUrl are tested as they are; the
// recorder is driven through a hand-rolled AudioContext whose ScriptProcessor node the test feeds samples to, which is
// as far as the real graph can be reached from here (the worklet path needs a browser).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicError, VoiceRecorder, clipDataUrl, micErrorFor, micSupport, type AutoStop } from './recorder'

const RATE = 48_000

function defineNavigator(name: string, value: unknown): void {
  Object.defineProperty(navigator, name, { value, configurable: true, writable: true })
}
function defineWindow(name: string, value: unknown): void {
  Object.defineProperty(window, name, { value, configurable: true, writable: true })
}
function removeWindow(name: string): void {
  delete (window as unknown as Record<string, unknown>)[name]
}

const namedError = (name: string, message = name): Error => Object.assign(new Error(message), { name })

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeTrack { stop: ReturnType<typeof vi.fn> }
const fakeStream = (tracks = 1): { stream: MediaStream; tracks: FakeTrack[] } => {
  const list: FakeTrack[] = Array.from({ length: tracks }, () => ({ stop: vi.fn() }))
  return { stream: { getTracks: () => list } as unknown as MediaStream, tracks: list }
}

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
  gain = { value: 1 }
  onaudioprocess: ((e: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void) | null = null
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  static initialState: 'running' | 'suspended' = 'running'
  sampleRate = RATE
  state: string = FakeAudioContext.initialState
  audioWorklet: undefined = undefined
  destination = {}
  processor = new FakeNode()
  close = vi.fn(async () => {})
  resume = vi.fn(async () => { this.state = 'running' })
  createMediaStreamSource = vi.fn(() => new FakeNode())
  createGain = vi.fn(() => new FakeNode())
  createScriptProcessor = vi.fn(() => this.processor)
  constructor() {
    FakeAudioContext.last = this
  }
}

/** Hands `samples` to the recorder the way the ScriptProcessor does, a chunk at a time. */
function feed(samples: Float32Array, chunk = 2048): void {
  const node = FakeAudioContext.last!.processor
  for (let i = 0; i < samples.length; i += chunk) {
    const part = samples.slice(i, i + chunk)
    node.onaudioprocess?.({ inputBuffer: { getChannelData: () => part } })
  }
}

const samplesFor = (ms: number): number => Math.round((RATE * ms) / 1000)
const quiet = (ms: number): Float32Array => Float32Array.from({ length: samplesFor(ms) }, (_, i) => 0.002 * Math.sin(i * 0.37))
// Loudness that rises and falls four times a second, as syllables do: a tone held at one level is what the silence
// detector takes for a fan, not a voice.
const speech = (ms: number): Float32Array => Float32Array.from({ length: samplesFor(ms) }, (_, i) => {
  const t = i / RATE
  return 0.3 * (0.05 + 0.95 * Math.abs(Math.sin(Math.PI * 4 * t))) * Math.sin(2 * Math.PI * 220 * t)
})
const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const readBytes = (blob: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
  reader.onerror = () => reject(reader.error)
  reader.readAsArrayBuffer(blob)
})

// ── micSupport ──────────────────────────────────────────────────────────────

describe('micSupport', () => {
  afterEach(() => {
    defineNavigator('mediaDevices', undefined)
    removeWindow('isSecureContext')
    removeWindow('AudioContext')
    removeWindow('webkitAudioContext')
  })

  it('is "unsupported" without a microphone API in a secure context', () => {
    defineNavigator('mediaDevices', undefined)
    defineWindow('isSecureContext', true)
    expect(micSupport()).toBe('unsupported')
  })

  it('is "insecure" without a microphone API on a page that is not a secure context (plain http on the LAN)', () => {
    defineNavigator('mediaDevices', undefined)
    defineWindow('isSecureContext', false)
    expect(micSupport()).toBe('insecure')
  })

  it('is "ok" with getUserMedia and an AudioContext', () => {
    defineNavigator('mediaDevices', { getUserMedia: vi.fn() })
    defineWindow('AudioContext', FakeAudioContext)
    expect(micSupport()).toBe('ok')
  })

  it('accepts Safari\'s prefixed webkitAudioContext', () => {
    defineNavigator('mediaDevices', { getUserMedia: vi.fn() })
    removeWindow('AudioContext')
    defineWindow('webkitAudioContext', FakeAudioContext)
    expect(micSupport()).toBe('ok')
  })

  it('is "unsupported" with getUserMedia but no AudioContext', () => {
    defineNavigator('mediaDevices', { getUserMedia: vi.fn() })
    removeWindow('AudioContext')
    removeWindow('webkitAudioContext')
    expect(micSupport()).toBe('unsupported')
  })

  it('is "unsupported" when mediaDevices has no getUserMedia', () => {
    defineNavigator('mediaDevices', {})
    defineWindow('AudioContext', FakeAudioContext)
    expect(micSupport()).toBe('unsupported')
  })
})

// ── micErrorFor ─────────────────────────────────────────────────────────────

describe('micErrorFor', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['TypeError', 'failed'],
    ['Error', 'failed'],
  ])('maps %s to "%s"', (name, reason) => {
    const error = micErrorFor(namedError(name))
    expect(error).toBeInstanceOf(MicError)
    expect(error.reason).toBe(reason)
    expect(error.message.length).toBeGreaterThan(0)
  })

  it('says why in the message of a failure it cannot name', () => {
    expect(micErrorFor(namedError('Error', 'driver exploded')).message).toContain('driver exploded')
  })

  it('treats a thrown non-error as a failure', () => {
    expect(micErrorFor('boom').reason).toBe('failed')
    expect(micErrorFor(undefined).reason).toBe('failed')
  })

  it('returns a MicError unchanged', () => {
    const original = new MicError('busy', 'in use')
    expect(micErrorFor(original)).toBe(original)
  })
})

// ── VoiceRecorder ───────────────────────────────────────────────────────────

describe('VoiceRecorder', () => {
  let getUserMedia: ReturnType<typeof vi.fn>
  let current: ReturnType<typeof fakeStream>

  beforeEach(() => {
    FakeAudioContext.last = null
    FakeAudioContext.initialState = 'running'
    current = fakeStream(2)
    getUserMedia = vi.fn(async () => current.stream)
    defineNavigator('mediaDevices', { getUserMedia })
    defineWindow('AudioContext', FakeAudioContext)
  })
  afterEach(() => {
    defineNavigator('mediaDevices', undefined)
    removeWindow('AudioContext')
  })

  describe('start', () => {
    it('rejects with a "denied" MicError when the browser refuses the microphone', async () => {
      getUserMedia.mockRejectedValue(namedError('NotAllowedError'))
      const error = await VoiceRecorder.start().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MicError)
      expect((error as MicError).reason).toBe('denied')
    })

    it('rejects with a "failed" MicError when the browser has no such API', async () => {
      defineNavigator('mediaDevices', undefined)
      const error = await VoiceRecorder.start().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MicError)
      expect((error as MicError).reason).toBe('failed')
    })

    it('rejects with "failed" when there is no AudioContext', async () => {
      removeWindow('AudioContext')
      await expect(VoiceRecorder.start()).rejects.toMatchObject({ reason: 'failed' })
      expect(getUserMedia).not.toHaveBeenCalled()
    })

    it('asks for a single, cleaned-up audio channel', async () => {
      await VoiceRecorder.start()
      expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ channelCount: 1, echoCancellation: true }) })
    })

    it('lets go of the microphone when the audio graph cannot be built', async () => {
      const original = FakeAudioContext.prototype
      void original
      defineWindow('AudioContext', class extends FakeAudioContext {
        constructor() {
          super()
          this.createMediaStreamSource = vi.fn(() => { throw namedError('InvalidStateError', 'graph') })
        }
      })
      await expect(VoiceRecorder.start()).rejects.toMatchObject({ name: 'MicError', reason: 'failed' })
      for (const track of current.tracks) expect(track.stop).toHaveBeenCalled()
      expect(FakeAudioContext.last!.close).toHaveBeenCalled()
    })

    it('resumes an AudioContext that starts suspended', async () => {
      FakeAudioContext.initialState = 'suspended'
      await VoiceRecorder.start()
      expect(FakeAudioContext.last!.resume).toHaveBeenCalled()
    })

    it('captures through a muted gain so the user does not hear themselves', async () => {
      await VoiceRecorder.start()
      const ctx = FakeAudioContext.last!
      const mute = ctx.createGain.mock.results[0].value as FakeNode
      expect(mute.gain.value).toBe(0)
      expect(mute.connect).toHaveBeenCalledWith(ctx.destination)
      expect(ctx.processor.connect).toHaveBeenCalledWith(mute)
    })
  })

  describe('stop', () => {
    it('returns a 16 kHz mono 16-bit WAV of about the length that was fed in, and releases the microphone', async () => {
      const recorder = await VoiceRecorder.start()
      feed(new Float32Array(RATE).fill(0.25), 2000)
      expect(recorder.elapsedMs()).toBeCloseTo(1000, 3)
      const clip = await recorder.stop()
      expect(clip.blob.type).toBe('audio/wav')
      expect(clip.durationMs).toBeCloseTo(1000, 3)
      const bytes = await readBytes(clip.blob)
      const view = new DataView(bytes.buffer)
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF')
      expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE')
      expect(view.getUint16(20, true)).toBe(1)
      expect(view.getUint16(22, true)).toBe(1)
      expect(view.getUint32(24, true)).toBe(16_000)
      expect(view.getUint16(34, true)).toBe(16)
      expect(bytes.length).toBe(44 + 16_000 * 2)
      expect(view.getInt16(44 + 2000, true)).toBe(Math.round(0.25 * 0x7fff))
      for (const track of current.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
      expect(FakeAudioContext.last!.close).toHaveBeenCalledTimes(1)
    })

    it('returns a header-only clip of zero length for nothing recorded', async () => {
      const recorder = await VoiceRecorder.start()
      const clip = await recorder.stop()
      expect(clip.durationMs).toBe(0)
      expect((await readBytes(clip.blob)).length).toBe(44)
    })

    it('ignores samples that arrive after it, and stopping twice is harmless', async () => {
      const recorder = await VoiceRecorder.start()
      feed(new Float32Array(2048))
      await recorder.stop()
      feed(new Float32Array(2048))
      await expect(recorder.stop()).resolves.toMatchObject({ blob: expect.any(Blob) })
      for (const track of current.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel', () => {
    it('releases the microphone and the context, and ignores what arrives afterwards', async () => {
      const onLevel = vi.fn()
      const recorder = await VoiceRecorder.start({ onLevel })
      feed(new Float32Array(2048).fill(0.1))
      onLevel.mockClear()
      recorder.cancel()
      for (const track of current.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
      expect(FakeAudioContext.last!.close).toHaveBeenCalledTimes(1)
      feed(new Float32Array(2048).fill(0.1))
      expect(onLevel).not.toHaveBeenCalled()
    })
  })

  describe('onLevel', () => {
    it('reports a level between 0 and 1: 0 for silence, 1 for something very loud', async () => {
      const levels: number[] = []
      await VoiceRecorder.start({ onLevel: (l) => levels.push(l) })
      feed(new Float32Array(2048))
      feed(new Float32Array(2048).fill(0.9))
      feed(speech(100))
      expect(levels[0]).toBe(0)
      expect(levels[1]).toBe(1)
      expect(levels.length).toBeGreaterThan(3)
      for (const l of levels) {
        expect(l).toBeGreaterThanOrEqual(0)
        expect(l).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('automatic stop', () => {
    const SILENCE = { silenceMs: 600, noSpeechMs: 1500 }

    it('calls onAutoStop("finished") exactly once after speech and enough silence', async () => {
      const calls: AutoStop[] = []
      await VoiceRecorder.start({ autoStop: true, silence: SILENCE, onAutoStop: (why) => calls.push(why) })
      feed(quiet(300))
      feed(speech(1000))
      expect(calls).toEqual([])
      feed(quiet(300))
      expect(calls).toEqual([])
      feed(quiet(1500))
      expect(calls).toEqual(['finished'])
      feed(quiet(1000))
      expect(calls).toEqual(['finished'])
    })

    it('calls onAutoStop("no-speech") when nothing is said', async () => {
      const calls: AutoStop[] = []
      await VoiceRecorder.start({ autoStop: true, silence: SILENCE, onAutoStop: (why) => calls.push(why) })
      feed(quiet(1000))
      expect(calls).toEqual([])
      feed(quiet(3000))
      expect(calls).toEqual(['no-speech'])
    })

    it('does not stop by itself without autoStop', async () => {
      const onAutoStop = vi.fn()
      await VoiceRecorder.start({ silence: SILENCE, onAutoStop })
      feed(join(quiet(300), speech(500), quiet(3000)))
      expect(onAutoStop).not.toHaveBeenCalled()
    })

    it('calls onAutoStop("max-length") once the recording reaches maxMs', async () => {
      const calls: AutoStop[] = []
      await VoiceRecorder.start({ maxMs: 500, onAutoStop: (why) => calls.push(why) })
      feed(speech(400))
      expect(calls).toEqual([])
      feed(speech(600))
      expect(calls).toEqual(['max-length'])
    })

    it('leaves it to the caller to stop: the recording goes on collecting until stop() or cancel()', async () => {
      const recorder = await VoiceRecorder.start({ maxMs: 200, onAutoStop: () => {} })
      feed(speech(400))
      const clip = await recorder.stop()
      expect(clip.durationMs).toBeCloseTo(400, 0)
    })
  })
})

// ── clipDataUrl ─────────────────────────────────────────────────────────────

describe('clipDataUrl', () => {
  it('is a data:audio/wav;base64 URL whose payload is the clip\'s bytes', async () => {
    const bytes = Uint8Array.from([82, 73, 70, 70, 0, 255, 128, 1, 2, 3])
    const url = await clipDataUrl(new Blob([bytes], { type: 'audio/wav' }))
    expect(url.startsWith('data:audio/wav;base64,')).toBe(true)
    const decoded = Uint8Array.from(atob(url.slice('data:audio/wav;base64,'.length)), (c) => c.charCodeAt(0))
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })

  it('round-trips a clip the recorder made', async () => {
    const wav = new Blob([new Uint8Array(100).map((_, i) => i * 2)], { type: 'audio/wav' })
    const url = await clipDataUrl(wav)
    const decoded = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0))
    expect(Array.from(decoded)).toEqual(Array.from(await readBytes(wav)))
  })
})

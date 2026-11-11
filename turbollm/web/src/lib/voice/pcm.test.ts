import { describe, expect, it } from 'vitest'
import { CLIP_SAMPLE_RATE, Downsampler, concatSamples, encodeWav, formatClock, mixToMono, rms } from './pcm'

const constant = (value: number, length: number): Float32Array => new Float32Array(length).fill(value)
const sine = (hz: number, rate: number, length: number, amplitude = 1): Float32Array =>
  Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate))

/** Pushes `input` through a fresh Downsampler in chunks of `size` and returns everything it produced. */
function downsampleInChunks(input: Float32Array, from: number, to: number, size: number): Float32Array {
  const d = new Downsampler(from, to)
  const out: Float32Array[] = []
  for (let i = 0; i < input.length; i += size) out.push(new Float32Array(d.push(input.subarray(i, i + size))))
  return concatSamples(out)
}

describe('CLIP_SAMPLE_RATE', () => {
  it('is the 16 kHz whisper works at', () => {
    expect(CLIP_SAMPLE_RATE).toBe(16_000)
  })
})

describe('Downsampler', () => {
  it('keeps a constant signal constant, at exactly a third of the samples, from 48 kHz to 16 kHz', () => {
    const out = new Downsampler(48_000, 16_000).push(constant(0.5, 48_000))
    expect(out.length).toBe(16_000)
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 6)
  })

  it('averages a ramp in threes', () => {
    const out = new Downsampler(48_000, 16_000).push(Float32Array.from([0, 1, 2, 3, 4, 5]))
    expect(Array.from(out)).toEqual([1, 4])
  })

  it('gives 16000 samples, give or take one, for a second of 44.1 kHz input', () => {
    const out = new Downsampler(44_100, 16_000).push(constant(0.25, 44_100))
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1)
    for (const sample of out) expect(sample).toBeCloseTo(0.25, 5)
  })

  // The fraction of a sample left over at the end of a chunk has to carry into the next one, or every chunk border
  // would drop or repeat a little of the signal.
  it('gives the same samples however the input is cut into chunks', () => {
    const input = sine(300, 44_100, 44_100, 0.8)
    const whole = new Downsampler(44_100, 16_000).push(input)
    for (const size of [128, 2048, 777]) {
      const chunked = downsampleInChunks(input, 44_100, 16_000, size)
      expect(chunked.length).toBe(whole.length)
      for (let i = 0; i < whole.length; i++) expect(Math.abs(chunked[i] - whole[i])).toBeLessThan(1e-5)
    }
  })

  it('returns the input untouched when the rates are the same', () => {
    const input = Float32Array.from([0.1, -0.2, 0.3])
    expect(new Downsampler(16_000, 16_000).push(input)).toBe(input)
  })

  it('attenuates a tone above the new Nyquist (it would fold into the speech band) far below one in it', () => {
    const inBand = rms(downsampleInChunks(sine(440, 48_000, 48_000), 48_000, 16_000, 2048))
    const aliasing = rms(downsampleInChunks(sine(12_000, 48_000, 48_000), 48_000, 16_000, 2048))
    expect(inBand).toBeGreaterThan(0.6)
    expect(aliasing).toBeLessThan(inBand * 0.5)
  })

  it('refuses to raise the rate, and rates that are not positive', () => {
    expect(() => new Downsampler(16_000, 48_000)).toThrow(RangeError)
    expect(() => new Downsampler(0, 16_000)).toThrow(RangeError)
    expect(() => new Downsampler(48_000, 0)).toThrow(RangeError)
    expect(() => new Downsampler(-1, -2)).toThrow(RangeError)
    expect(() => new Downsampler(NaN, 16_000)).toThrow(RangeError)
  })
})

describe('mixToMono', () => {
  it('is empty for no channels', () => {
    expect(mixToMono([]).length).toBe(0)
  })

  it('returns a single channel as it is', () => {
    const channel = Float32Array.from([0.1, 0.2])
    expect(mixToMono([channel])).toBe(channel)
  })

  it('averages the channels sample by sample', () => {
    const mixed = mixToMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1]), Float32Array.from([2, 0, 0])])
    expect(Array.from(mixed)).toEqual([1, 0, 0])
  })

  it('does not change the channels it was given', () => {
    const left = Float32Array.from([1, 1])
    mixToMono([left, Float32Array.from([0, 0])])
    expect(Array.from(left)).toEqual([1, 1])
  })
})

describe('concatSamples', () => {
  it('joins chunks in order', () => {
    expect(Array.from(concatSamples([Float32Array.from([1, 2]), new Float32Array(0), Float32Array.from([3])]))).toEqual([1, 2, 3])
  })

  it('is empty for nothing', () => {
    expect(concatSamples([]).length).toBe(0)
  })
})

describe('rms', () => {
  it('is 0 for no samples and for silence', () => {
    expect(rms(new Float32Array(0))).toBe(0)
    expect(rms(new Float32Array(100))).toBe(0)
  })

  it('is about 0.707 for a full-scale sine', () => {
    expect(rms(sine(440, 48_000, 48_000))).toBeCloseTo(Math.SQRT1_2, 3)
  })

  it('is the level of a constant signal', () => {
    expect(rms(constant(-0.5, 10))).toBeCloseTo(0.5, 6)
  })
})

describe('encodeWav', () => {
  const view = (wav: Uint8Array) => new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const text = (wav: Uint8Array, offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length))

  it('writes a 16-bit mono PCM header for the sample rate', () => {
    const wav = encodeWav(new Float32Array(10), 16_000)
    const v = view(wav)
    expect(text(wav, 0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 20)
    expect(text(wav, 8, 4)).toBe('WAVE')
    expect(text(wav, 12, 4)).toBe('fmt ')
    expect(v.getUint32(16, true)).toBe(16)
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16_000)
    expect(v.getUint32(28, true)).toBe(32_000)
    expect(v.getUint16(32, true)).toBe(2)
    expect(v.getUint16(34, true)).toBe(16)
    expect(text(wav, 36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(20)
  })

  it('is 44 header bytes plus two per sample', () => {
    expect(encodeWav(new Float32Array(0), 16_000).length).toBe(44)
    expect(encodeWav(new Float32Array(123), 16_000).length).toBe(44 + 246)
  })

  it('writes the byte rate for another sample rate', () => {
    expect(view(encodeWav(new Float32Array(1), 8_000)).getUint32(28, true)).toBe(16_000)
  })

  it('writes -1, 0 and 1 as the 16-bit extremes and zero', () => {
    const v = view(encodeWav(Float32Array.from([-1, 0, 1]), 16_000))
    expect(v.getInt16(44, true)).toBe(-32768)
    expect(v.getInt16(46, true)).toBe(0)
    expect(v.getInt16(48, true)).toBe(32767)
  })

  it('writes a half-scale sample as half of the range', () => {
    const v = view(encodeWav(Float32Array.from([0.5, -0.5]), 16_000))
    expect(v.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff))
    expect(v.getInt16(46, true)).toBe(-16384)
  })

  it('clips samples beyond full scale instead of wrapping them', () => {
    const v = view(encodeWav(Float32Array.from([1.5, -1.5]), 16_000))
    expect(v.getInt16(44, true)).toBe(32767)
    expect(v.getInt16(46, true)).toBe(-32768)
  })
})

describe('formatClock', () => {
  it('shows minutes and zero-padded seconds, rounding down', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(999)).toBe('0:00')
    expect(formatClock(1000)).toBe('0:01')
    expect(formatClock(65_000)).toBe('1:05')
    expect(formatClock(600_000)).toBe('10:00')
  })

  it('shows a negative time as zero', () => {
    expect(formatClock(-5000)).toBe('0:00')
  })
})

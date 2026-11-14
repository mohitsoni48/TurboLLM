// Turning what the microphone gives into the clip the daemon takes: mono 16-bit WAV at speech sample rate.
//
// The browser hands over float samples at the sound card's rate (44.1 or 48 kHz). whisper works on 16 kHz mono and
// so do the models that hear audio, so that is what a clip is kept as: a third of the samples, at two bytes each, is
// 32 KB a second, small enough to send as a chat attachment and to keep in the conversation. Recording it this way
// in the page, rather than sending the browser's own compressed recording, is also what spares the daemon ffmpeg:
// whisper.cpp reads WAV itself, and not the WebM/Opus or MP4 a MediaRecorder produces.
//
// PURE: no browser API, so the tests feed it arrays.

/** The rate a clip is recorded at when the microphone's is higher. A lower one is kept as it is: both whisper.cpp and
 *  llama.cpp resample what they are given, and inventing samples here would add nothing. */
export const CLIP_SAMPLE_RATE = 16_000

/** Lowers a stream of samples to a lower rate, a chunk at a time, keeping the fraction of a sample that falls between
 *  chunks. Each output sample is the average of the input it spans (a box filter), which is the low-pass a naive
 *  "take every third sample" lacks: without it everything above the new rate's half folds back into the speech band as
 *  noise. Coarse next to a windowed-sinc resampler and entirely adequate for speech recognition. */
export class Downsampler {
  /** Input samples per output sample; at least 1. */
  private readonly ratio: number
  /** The weighted sum of the output sample in progress, and how many input samples (fractional) are in it. */
  private sum = 0
  private filled = 0

  constructor(fromRate: number, toRate: number) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive')
    if (toRate > fromRate) throw new RangeError('Downsampler only lowers the rate')
    this.ratio = fromRate / toRate
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input
    const out = new Float32Array(Math.ceil((input.length + this.filled) / this.ratio) + 1)
    let n = 0
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]
      const room = this.ratio - this.filled
      if (room > 1) {
        this.sum += sample
        this.filled += 1
        continue
      }
      // This sample completes an output sample, and what is left of it starts the next.
      out[n++] = (this.sum + sample * room) / this.ratio
      this.sum = sample * (1 - room)
      this.filled = 1 - room
    }
    return out.subarray(0, n)
  }
}

/** Several channels as one: their average. One channel is returned as it is. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const length = channels[0].length
  const out = new Float32Array(length)
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i] += channel[i]
  }
  for (let i = 0; i < length; i++) out[i] /= channels.length
  return out
}

export function concatSamples(chunks: Float32Array[]): Float32Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Root mean square of a chunk: how loud it is, 0 (silence) to 1 (full scale). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

const WAV_HEADER_BYTES = 44

/** Mono float samples as a 16-bit PCM WAV file. Samples outside -1..1 (a hot microphone) are clipped, not wrapped. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // the fmt chunk's size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per sample frame
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return new Uint8Array(buffer)
}

/** `m:ss` for a clip or a recording in progress. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

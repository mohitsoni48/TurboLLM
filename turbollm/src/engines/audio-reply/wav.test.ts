// WAV in and out: what a browser or an API client sends, as the mono PCM16 a realtime engine takes, and the engine's
// PCM16 as a file a player opens.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concatPcm16, decodeWavClips, decodeWavToPcm16Mono, MAX_SPOKEN_INPUT_MS, pcm16ToWav } from './wav'

/** A WAV file with the given format tag, channel count, rate, bit depth and raw sample bytes. */
function wav(opts: { format: number; channels: number; rate: number; bits: number; data: Buffer; extra?: Buffer; dataSize?: number }): Buffer {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(opts.format, 0)
  fmt.writeUInt16LE(opts.channels, 2)
  fmt.writeUInt32LE(opts.rate, 4)
  fmt.writeUInt32LE((opts.rate * opts.channels * opts.bits) / 8, 8)
  fmt.writeUInt16LE((opts.channels * opts.bits) / 8, 12)
  fmt.writeUInt16LE(opts.bits, 14)
  const chunk = (id: string, body: Buffer, size = body.length) => {
    const h = Buffer.alloc(8)
    h.write(id, 0, 'ascii')
    h.writeUInt32LE(size, 4)
    return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), opts.extra ?? Buffer.alloc(0), chunk('data', opts.data, opts.dataSize)])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

const int16 = (...v: number[]) => Buffer.from(Int16Array.from(v).buffer)
const float32 = (...v: number[]) => Buffer.from(Float32Array.from(v).buffer)

test('pcm16ToWav writes a canonical 44-byte header that decodes back to the same samples', () => {
  const pcm = int16(0, 1000, -1000, 32767, -32768)
  const file = pcm16ToWav(pcm, 24000)
  assert.equal(file.length, 44 + pcm.length)
  assert.equal(file.toString('ascii', 0, 4), 'RIFF')
  assert.equal(file.readUInt32LE(4), 36 + pcm.length)
  assert.equal(file.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(file.readUInt32LE(24), 24000)
  assert.equal(file.readUInt32LE(28), 48000)
  assert.equal(file.toString('ascii', 36, 40), 'data')
  const back = decodeWavToPcm16Mono(file)
  assert.equal(back.sampleRate, 24000)
  assert.deepEqual(back.pcm16, pcm)
})

test('mono PCM16 passes through at its own rate', () => {
  const pcm = int16(1, 2, 3, 4)
  assert.deepEqual(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 16000, bits: 16, data: pcm })), { pcm16: pcm, sampleRate: 16000 })
})

test('stereo is averaged to mono', () => {
  const out = decodeWavToPcm16Mono(wav({ format: 1, channels: 2, rate: 44100, bits: 16, data: int16(100, 300, -200, -400, 32767, 32767) }))
  assert.equal(out.sampleRate, 44100)
  assert.deepEqual(out.pcm16, int16(200, -300, 32767))
})

test('float32 is scaled to PCM16 and clipped, at any channel count', () => {
  const mono = decodeWavToPcm16Mono(wav({ format: 3, channels: 1, rate: 48000, bits: 32, data: float32(0, 0.5, -0.5, 1, -1, 2, -3) }))
  assert.deepEqual(mono.pcm16, int16(0, 16384, -16383, 32767, -32767, 32767, -32767))
  const stereo = decodeWavToPcm16Mono(wav({ format: 3, channels: 2, rate: 48000, bits: 32, data: float32(1, 0, 0.5, 0.5) }))
  assert.deepEqual(stereo.pcm16, int16(16384, 16384))
})

test('chunks before data, an odd-sized chunk and a streamed header (size 0) are read', () => {
  const junk = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from([1, 2, 3, 0])])
  const pcm = int16(5, 6, 7)
  assert.deepEqual(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 8000, bits: 16, data: pcm, extra: junk })).pcm16, pcm)
  assert.deepEqual(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 8000, bits: 16, data: pcm, dataSize: 0 })).pcm16, pcm)
  assert.deepEqual(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 8000, bits: 16, data: pcm, dataSize: 0xffffffff })).pcm16, pcm)
})

test('a WAV with no samples, or a sample rate no recording has, is refused', () => {
  assert.throws(() => decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 16000, bits: 16, data: Buffer.alloc(0) })), /holds no audio/)
  assert.throws(() => decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 16000, bits: 16, data: Buffer.from([1]) })), /holds no audio/)
  for (const rate of [1, 7999, 192001, 1_000_000_000]) {
    assert.throws(() => decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate, bits: 16, data: int16(1, 2) })), /sample rate of/, String(rate))
  }
  assert.equal(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 8000, bits: 16, data: int16(1) })).sampleRate, 8000)
  assert.equal(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 192000, bits: 16, data: int16(1) })).sampleRate, 192000)
})

test('a trailing half sample is dropped', () => {
  const data = Buffer.concat([int16(9, 8), Buffer.from([7])])
  assert.deepEqual(decodeWavToPcm16Mono(wav({ format: 1, channels: 1, rate: 8000, bits: 16, data })).pcm16, int16(9, 8))
})

test('anything but PCM16 or float32 is refused with a message that says what to send', () => {
  const refused = (b: Buffer) => assert.throws(() => decodeWavToPcm16Mono(b), /Unsupported WAV file: .*Send a PCM16 or float32 WAV/)
  refused(wav({ format: 1, channels: 1, rate: 8000, bits: 8, data: Buffer.from([1, 2]) }))
  refused(wav({ format: 1, channels: 1, rate: 8000, bits: 24, data: Buffer.from([1, 2, 3]) }))
  refused(wav({ format: 1, channels: 1, rate: 8000, bits: 32, data: int16(1, 2) }))
  refused(wav({ format: 6, channels: 1, rate: 8000, bits: 8, data: Buffer.from([1, 2]) }))
  refused(Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000mp3 frames follow'))
  refused(Buffer.alloc(0))
  refused(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))
})

test('clips of one turn are joined back to back when they share a rate, and refused when they do not', () => {
  const a = { pcm16: int16(1, 2), sampleRate: 16000 }
  const b = { pcm16: int16(3), sampleRate: 16000 }
  assert.deepEqual(concatPcm16([a, b]), { pcm16: int16(1, 2, 3), sampleRate: 16000 })
  assert.deepEqual(concatPcm16([a]), a)
  assert.throws(() => concatPcm16([a, { pcm16: int16(3), sampleRate: 44100 }]), /different sample rates \(16000, 44100 Hz\)/)
})

test('the clips of a turn are capped by their total duration, read from the headers before anything is decoded', () => {
  const silence = (ms: number, rate: number, channels: number, bytes: number) => Buffer.alloc(Math.round((ms / 1000) * rate) * channels * bytes)
  const clip = (ms: number) => wav({ format: 1, channels: 1, rate: 16000, bits: 16, data: silence(ms, 16000, 1, 2) })
  assert.throws(() => decodeWavClips([clip(MAX_SPOKEN_INPUT_MS + 1000)]), /301 s of audio, and at most 5 minutes/)
  // Stereo float counts its channels and sample size.
  const stereoFloat = wav({ format: 3, channels: 2, rate: 8000, bits: 32, data: silence(301_000, 8000, 2, 4) })
  assert.throws(() => decodeWavClips([stereoFloat]), /at most 5 minutes/)
  // The limit is on the total: three clips of two minutes are refused, though each alone is fine.
  assert.throws(() => decodeWavClips([clip(120_000), clip(120_000), clip(120_000)]), /at most 5 minutes/)
  // Within it, the clips decode and join.
  assert.deepEqual(decodeWavClips([wav({ format: 1, channels: 1, rate: 16000, bits: 16, data: int16(1) }), wav({ format: 1, channels: 1, rate: 16000, bits: 16, data: int16(2) })]), { pcm16: int16(1, 2), sampleRate: 16000 })
  assert.ok(decodeWavClips([clip(MAX_SPOKEN_INPUT_MS)]).pcm16.length > 0, 'exactly the limit is accepted')
})

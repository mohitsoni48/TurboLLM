// WAV in and out, pure. A recording reaches the daemon as a WAV in whatever shape the browser or a client made it; the
// realtime engines take one thing, mono PCM16, and give back raw PCM16 that has to become a playable file again.

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe
/** The rates a recording can have: speech from a phone line to studio audio. A header outside it is garbage, and a tiny
 *  rate would also make the engine's input chunks tiny. */
const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 192000

/** Mono PCM16 samples and the rate they were recorded at. */
export interface DecodedWav {
  pcm16: Buffer
  sampleRate: number
}

function fail(why: string): never {
  throw new Error(`Unsupported WAV file: ${why}. Send a PCM16 or float32 WAV.`)
}

interface WavHeader {
  isFloat: boolean
  channels: number
  sampleRate: number
  bytesPerSample: number
  data: Buffer
}

/** The header of a RIFF/WAVE file, validated, and its data chunk as a view of `buf` (nothing is copied or decoded). */
function readWavHeader(buf: Buffer): WavHeader {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') fail('not a RIFF/WAVE file')
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let data: Buffer | null = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) fail('truncated fmt chunk')
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the first two bytes of its sub-format GUID.
      if (format === FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24)
    } else if (id === 'data') {
      // A writer that streamed the file leaves 0 or 0xFFFFFFFF here: the data then runs to the end of the file.
      const end = size === 0 || body + size > buf.length ? buf.length : body + size
      data = buf.subarray(body, end)
      break
    }
    off = body + size + (size & 1)
  }
  if (!format) fail('no fmt chunk')
  if (!data) fail('no data chunk')
  if (channels < 1) fail('no channels')
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) fail(`a sample rate of ${sampleRate} Hz (from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz is read)`)
  const isFloat = format === FORMAT_FLOAT && bits === 32
  const isPcm16 = format === FORMAT_PCM && bits === 16
  if (!isFloat && !isPcm16) fail(`format ${format} at ${bits} bits`)
  return { isFloat, channels, sampleRate, bytesPerSample: bits / 8, data }
}

/** Reads a RIFF/WAVE file of 16-bit PCM or 32-bit float samples at any channel count, and returns it as mono PCM16:
 *  channels are averaged, floats are scaled and clipped. Anything else (8, 24 or 32-bit integers, A-law, a compressed
 *  codec, a file that is not WAV at all) throws with a message that says what to send instead. */
export function decodeWavToPcm16Mono(buf: Buffer): DecodedWav {
  const { isFloat, channels, sampleRate, bytesPerSample, data } = readWavHeader(buf)
  const frames = Math.floor(data.length / (bytesPerSample * channels))
  if (frames === 0) fail('it holds no audio')
  const out = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * bytesPerSample
      sum += isFloat ? Math.max(-1, Math.min(1, data.readFloatLE(at))) * 32767 : data.readInt16LE(at)
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2)
  }
  return { pcm16: out, sampleRate }
}

/** The most speech one turn may carry, in all its clips: the recorder's own limit (web/src/lib/voice/recorder.ts,
 *  MAX_RECORDING_MS). Decoding is a loop in JS on the daemon's one thread, so a clip longer than anyone can record is
 *  refused before it is decoded rather than stalling every stream and the status API while it is. */
export const MAX_SPOKEN_INPUT_MS = 5 * 60_000

/** Decodes the clips of one turn and joins them (concatPcm16). Their total length is read from their headers alone
 *  and checked against MAX_SPOKEN_INPUT_MS before any sample is decoded. Throws as decodeWavToPcm16Mono does. */
export function decodeWavClips(wavs: Buffer[]): DecodedWav {
  let ms = 0
  for (const wav of wavs) {
    const { channels, sampleRate, bytesPerSample, data } = readWavHeader(wav)
    ms += (data.length / (sampleRate * channels * bytesPerSample)) * 1000
  }
  if (ms > MAX_SPOKEN_INPUT_MS) {
    fail(`it is ${Math.round(ms / 1000)} s of audio, and at most ${MAX_SPOKEN_INPUT_MS / 60_000} minutes is read in one message`)
  }
  return concatPcm16(wavs.map((w) => decodeWavToPcm16Mono(w)))
}

/** Wraps mono PCM16 in the 44-byte header of a canonical WAV file. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(FORMAT_PCM, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Joins the clips of one turn into one: they play back to back, which is how a message with several recordings was
 *  meant. They must share a sample rate, since resampling is not done here; otherwise this throws. */
export function concatPcm16(clips: DecodedWav[]): DecodedWav {
  if (clips.length === 0) throw new Error('No audio to join.')
  const sampleRate = clips[0].sampleRate
  if (clips.some((c) => c.sampleRate !== sampleRate)) {
    throw new Error(`Unsupported WAV file: the clips were recorded at different sample rates (${[...new Set(clips.map((c) => c.sampleRate))].join(', ')} Hz). Send one clip, or clips recorded at the same rate.`)
  }
  return { pcm16: Buffer.concat(clips.map((c) => c.pcm16)), sampleRate }
}

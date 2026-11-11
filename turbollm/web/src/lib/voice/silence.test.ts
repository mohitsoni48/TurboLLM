import { describe, expect, it } from 'vitest'
import { SilenceDetector, type Hearing, type SilenceOptions } from './silence'

const RATE = 48_000
const samplesFor = (ms: number): number => Math.round((RATE * ms) / 1000)

/** A small deterministic generator, so a "noisy" test is the same noise on every run. */
function prng(seed: number): () => number {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** Low-level room noise: about 0.001 RMS. */
const room = (ms: number, seed = 1): Float32Array => {
  const next = prng(seed)
  return Float32Array.from({ length: samplesFor(ms) }, () => (next() - 0.5) * 0.004)
}
/** Steady louder background noise, the fan: about 0.03 RMS. */
const fan = (ms: number, seed = 2): Float32Array => {
  const next = prng(seed)
  return Float32Array.from({ length: samplesFor(ms) }, () => (next() - 0.5) * 0.1)
}
/** Something said: a 220 Hz tone whose loudness rises and falls four times a second, as syllables do. A tone at one
 *  level would not do: holding a level is what tells a fan from a voice (see `tone`). */
const speech = (ms: number): Float32Array =>
  Float32Array.from({ length: samplesFor(ms) }, (_, i) => {
    const t = i / RATE
    return 0.3 * (0.05 + 0.95 * Math.abs(Math.sin(Math.PI * 4 * t))) * Math.sin(2 * Math.PI * 220 * t)
  })
/** A loud sound at one level: a tone, a dial tone, a held note. */
const tone = (ms: number): Float32Array =>
  Float32Array.from({ length: samplesFor(ms) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE))
const hum = (ms: number, amplitude = 0.2): Float32Array =>
  Float32Array.from({ length: samplesFor(ms) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 50 * i) / RATE))

const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** What the detector said after each chunk of `chunk` samples. */
function hearings(signal: Float32Array, opts: SilenceOptions = {}, chunk = 2048): Hearing[] {
  const detector = new SilenceDetector(RATE, opts)
  const out: Hearing[] = []
  for (let i = 0; i < signal.length; i += chunk) out.push(detector.push(signal.subarray(i, i + chunk)))
  return out
}

/** What it said once `ms` of the signal had gone in (to the nearest chunk). */
const at = (said: Hearing[], ms: number, chunk = 2048): Hearing => said[Math.min(said.length - 1, Math.floor(samplesFor(ms) / chunk))]

describe('SilenceDetector', () => {
  it('waits while the room is quiet, then gives up after noSpeechMs', () => {
    const said = hearings(room(3000), { noSpeechMs: 1500 })
    expect(at(said, 1000)).toBe('waiting')
    expect(said.at(-1)).toBe('no-speech')
    expect(new Set(said)).toEqual(new Set(['waiting', 'no-speech']))
  })

  it('hears speech, stays speaking through it, and is finished once silenceMs of quiet has passed', () => {
    const said = hearings(join(room(300), speech(1000), room(1500)), { silenceMs: 600 })
    expect(at(said, 200)).toBe('waiting')
    expect(at(said, 1000)).toBe('speaking')
    // 1300 ms is where the speech ends; 300 ms of quiet is not yet 600.
    expect(at(said, 1600)).toBe('speaking')
    expect(at(said, 2100)).toBe('finished')
  })

  it('is not finished by a pause shorter than silenceMs between two utterances', () => {
    const said = hearings(join(room(300), speech(800), room(400), speech(800), room(300)), { silenceMs: 800 })
    expect(said).not.toContain('finished')
    expect(said.at(-1)).toBe('speaking')
  })

  it('is finished after the second utterance once the quiet is long enough', () => {
    const said = hearings(join(room(300), speech(800), room(400), speech(800), room(1200)), { silenceMs: 800 })
    expect(said.at(-1)).toBe('finished')
  })

  // A click or a cough is not a message: it must neither end the recording as 'finished' nor keep the wait for
  // speech from running out.
  it('never finishes on a 100 ms click, and the recording still ends as no-speech', () => {
    const said = hearings(join(room(300), speech(100), room(3000)), { noSpeechMs: 1500, silenceMs: 600 })
    expect(said).not.toContain('finished')
    expect(said.at(-1)).toBe('no-speech')
  })

  it('does not let two clicks add up to a message when the quiet between them was long', () => {
    const said = hearings(join(room(300), speech(150), room(2000), speech(150), room(300)), { noSpeechMs: 60_000, silenceMs: 600, minSpeechMs: 250 })
    expect(said).not.toContain('speaking')
  })

  it('absorbs steady noise that was there from the start as the room, not as speech', () => {
    const said = hearings(fan(4000), { noSpeechMs: 1500 })
    expect(said).not.toContain('speaking')
    expect(said.at(-1)).toBe('no-speech')
  })

  // A fan switching on is, for its first half second, as sudden as a word. Taken for speech, the recording either
  // never ended (the room's level only ever rose on frames already judged quiet) or ended as a message of noise.
  it('takes a steady noise that starts after a quiet room for the room, not for something said', () => {
    const said = hearings(join(room(300), fan(5000)), { noSpeechMs: 1500 })
    expect(at(said, 4000)).not.toBe('speaking')
    expect(said).not.toContain('finished')
    expect(said.at(-1)).toBe('no-speech')
  })

  it('keeps what was said before a steady noise started, and finishes on the noise as on quiet', () => {
    const said = hearings(join(room(300), speech(1000), fan(3000)), { silenceMs: 600 })
    expect(at(said, 1000)).toBe('speaking')
    expect(said.at(-1)).toBe('finished')
  })

  it('does not take a loud sound held at one level for speech', () => {
    const said = hearings(join(room(300), tone(3000)), { noSpeechMs: 2000 })
    expect(at(said, 2500)).not.toBe('speaking')
    expect(said.at(-1)).toBe('no-speech')
  })

  // The room used to be whatever the first 30 ms held, so talking as the microphone opened set the bar at the
  // speaker's own level and nothing after it counted.
  it('hears speech that begins with the very first sample', () => {
    const said = hearings(join(speech(1200), room(1500)), { silenceMs: 600 })
    expect(at(said, 1000)).toBe('speaking')
    expect(said.at(-1)).toBe('finished')
  })

  it('still hears speech over a steady noisy room', () => {
    const said = hearings(join(fan(500), speech(1000), fan(1500)), { silenceMs: 600 })
    expect(at(said, 1200)).toBe('speaking')
    expect(said.at(-1)).toBe('finished')
  })

  it('does not take mains hum and a DC offset for speech', () => {
    const offset = hum(3000).map((x) => x + 0.2)
    const said = hearings(offset, { noSpeechMs: 1500 })
    expect(said).not.toContain('speaking')
    expect(said.at(-1)).toBe('no-speech')
  })

  it('does not take 50 Hz hum alone for speech', () => {
    const said = hearings(hum(3000), { noSpeechMs: 1500 })
    expect(said).not.toContain('speaking')
    expect(said.at(-1)).toBe('no-speech')
  })

  it('says the same whether samples arrive in chunks of 128 or 4096', () => {
    const signal = join(room(400), speech(900), room(300), speech(500), room(1800))
    const padded = join(signal, new Float32Array(4096 - (signal.length % 4096)))
    const small = hearings(padded, { silenceMs: 800 }, 128).filter((_, i) => (i + 1) % 32 === 0)
    const large = hearings(padded, { silenceMs: 800 }, 4096)
    expect(small).toEqual(large)
    expect(large).toContain('speaking')
    expect(large.at(-1)).toBe('finished')
  })

  it('reports where it stands without more samples', () => {
    const detector = new SilenceDetector(RATE)
    expect(detector.hearing()).toBe('waiting')
  })
})

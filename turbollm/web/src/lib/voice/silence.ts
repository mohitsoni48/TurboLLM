// Deciding that the speaker has finished, so a recording can stop itself.
//
// The idea is whisper.cpp's own (`vad_simple` in its examples, which `stream`, `command` and `talk-llama` listen
// with): no model, only energy. Speech is louder than the room; once the recent past has dropped back to the room's
// level for long enough after some speech, the speaker is done. whisper.cpp compares the last second against the
// whole buffer. Here the room's level is tracked on its own instead, so a long wait before speaking (which fills
// that buffer with silence) does not change the answer, and neither does a room that gets louder half way through.
//
// Two facts about speech do the work:
//  - it has gaps. Between syllables and words the level falls back to the room's, several times a second. So the
//    quietest moment of the last second and a half is the room, however loud the talking around it;
//  - it is never steady. A sound that holds one level for half a second is a fan, a hum or a tone, not a voice, and
//    is taken for the room at once, with whatever it was counted as speech taken back.
//
// PURE: fed sample chunks, no browser API. The recorder owns the microphone and asks this what it heard.

export interface SilenceOptions {
  /** How long the quiet after speech must last before the recording is taken to be over. */
  silenceMs?: number
  /** How long to wait for any speech at all before giving up. */
  noSpeechMs?: number
  /** Speech this short is a click or a cough, not a message: the quiet after it does not end the recording. */
  minSpeechMs?: number
}

export type Hearing =
  /** Nothing said yet. */
  | 'waiting'
  /** Speech heard, and the speaker may still be going. */
  | 'speaking'
  /** Speech heard, then quiet for `silenceMs`: stop and use the recording. */
  | 'finished'
  /** Quiet for `noSpeechMs` with nothing said: stop and discard it. */
  | 'no-speech'

const DEFAULT_SILENCE_MS = 1600
const DEFAULT_NO_SPEECH_MS = 10_000
const DEFAULT_MIN_SPEECH_MS = 250

/** Energy is measured over frames this long: short enough to follow syllables, long enough to average a waveform. */
const FRAME_MS = 30
/** A frame is speech when it is this many times louder than the room. */
const SPEECH_OVER_ROOM = 3
/** And never below this, whatever the room: a silent room's level is near zero, and three times nothing is nothing. */
const SPEECH_FLOOR = 0.012
/** The room is the quietest frame of this long a past: long enough to hold a gap between words. */
const ROOM_WINDOW_MS = 1500
/** A sound whose level stays within {@link STEADY_RATIO} for this long is not speech. */
const STEADY_MS = 500
const STEADY_RATIO = 1.6

export class SilenceDetector {
  private readonly silenceMs: number
  private readonly noSpeechMs: number
  private readonly minSpeechMs: number
  private readonly frameSamples: number
  private readonly frameMs: number
  /** Samples of the frame in progress, and the sum of their squares. */
  private frameFill = 0
  private frameEnergy = 0
  /** The previous input and output of the high-pass filter that takes out hum and a microphone's DC offset: both sit
   *  below speech and would otherwise count as loudness. */
  private lastIn = 0
  private lastOut = 0
  private readonly highPass: number
  /** The level of each of the last frames (a ring), newest at `frames - 1`. */
  private readonly levels: Float32Array
  /** Whether each of those frames was counted as speech. */
  private readonly counted: Uint8Array
  private frames = 0
  private readonly steadyFrames: number
  private wasSteady = false
  private elapsedMs = 0
  private speechMs = 0
  private quietMs = 0

  constructor(sampleRate: number, opts: SilenceOptions = {}) {
    this.silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS
    this.noSpeechMs = opts.noSpeechMs ?? DEFAULT_NO_SPEECH_MS
    this.minSpeechMs = opts.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS
    this.frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
    this.frameMs = (this.frameSamples / sampleRate) * 1000
    const windowFrames = Math.max(1, Math.round(ROOM_WINDOW_MS / this.frameMs))
    this.levels = new Float32Array(windowFrames)
    this.counted = new Uint8Array(windowFrames)
    this.steadyFrames = Math.min(windowFrames, Math.max(2, Math.round(STEADY_MS / this.frameMs)))
    // First-order high-pass at 100 Hz, as vad_simple's.
    const rc = 1 / (2 * Math.PI * 100)
    const dt = 1 / sampleRate
    this.highPass = rc / (rc + dt)
  }

  /** Hear a chunk of mono samples. Returns where the recording stands after it. */
  push(samples: Float32Array): Hearing {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]
      const y = this.highPass * (this.lastOut + x - this.lastIn)
      this.lastIn = x
      this.lastOut = y
      this.frameEnergy += y * y
      if (++this.frameFill === this.frameSamples) this.endFrame()
    }
    return this.hearing()
  }

  hearing(): Hearing {
    if (this.speechMs >= this.minSpeechMs) return this.quietMs >= this.silenceMs ? 'finished' : 'speaking'
    return this.elapsedMs >= this.noSpeechMs ? 'no-speech' : 'waiting'
  }

  private endFrame(): void {
    const level = Math.sqrt(this.frameEnergy / this.frameSamples)
    this.frameFill = 0
    this.frameEnergy = 0
    this.elapsedMs += this.frameMs

    const slot = this.frames % this.levels.length
    this.levels[slot] = level
    this.frames++
    const held = Math.min(this.frames, this.levels.length)

    // The room: the quietest frame in the window. A steady sound is the room itself, as of now.
    let room = Infinity
    for (let i = 0; i < held; i++) room = Math.min(room, this.levels[i])
    const steady = this.steadyLevel()
    if (steady !== null) room = Math.max(room, steady)

    const isSpeech = level > Math.max(SPEECH_FLOOR, room * SPEECH_OVER_ROOM)
    this.counted[slot] = isSpeech ? 1 : 0
    if (isSpeech) {
      this.speechMs += this.frameMs
      this.quietMs = 0
    } else {
      this.quietMs += this.frameMs
      // A blip shorter than a message, then a long quiet: forget it, so it cannot add up with the next blip.
      if (this.speechMs < this.minSpeechMs && this.quietMs >= this.silenceMs) this.speechMs = 0
    }

    // A sound that has just proved steady was counted as speech while it was still new: a fan starting is, for its
    // first half second, as sudden as a word. Take that back, and count the time as the quiet it was.
    if (steady !== null && !this.wasSteady) {
      let retracted = 0
      for (let back = 0; back < this.steadyFrames; back++) {
        const i = (this.frames - 1 - back + this.levels.length * 2) % this.levels.length
        if (this.counted[i]) {
          this.counted[i] = 0
          retracted++
        }
      }
      if (retracted > 0) {
        this.speechMs = Math.max(0, this.speechMs - retracted * this.frameMs)
        this.quietMs = Math.max(this.quietMs, retracted * this.frameMs)
      }
    }
    this.wasSteady = steady !== null
  }

  /** The level the last {@link STEADY_MS} held, when it held one; null while the sound is moving (or too new to
   *  tell). */
  private steadyLevel(): number | null {
    if (this.frames < this.steadyFrames) return null
    let lo = Infinity
    let hi = 0
    for (let back = 0; back < this.steadyFrames; back++) {
      const v = this.levels[(this.frames - 1 - back + this.levels.length * 2) % this.levels.length]
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    return hi <= lo * STEADY_RATIO ? lo : null
  }
}

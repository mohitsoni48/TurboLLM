// A spoken reply's streamed audio as `audio_chunk` frames (arch 2.3, ADR-485 D4). Each frame carries at most
// AUDIO_FRAME_MAX_BYTES of whole PCM16 samples, so no frame is large for a viewer to take; `audio_end` reports the totals
// so a page can tell it missed some. Pure: no timers, nothing imported from the run or the routes. A remainder below
// the coalescing floor waits for the next delta or the flush.

/** The most PCM16 one frame carries: about 340 ms at 24 kHz, about 22 KB as base64. Spike S1 may change it. */
export const AUDIO_FRAME_MAX_BYTES = 16_384
/** The coalescing floor: below it, audio waits for more. Spike S1 sets it if engine deltas turn out tiny. */
export const AUDIO_FRAME_MIN_BYTES = 0

export interface AudioChunkFrame {
  replyId: string
  index: number
  sampleRate: number
  /** Base64 PCM16, mono, little-endian. */
  pcm16: string
}

export interface AudioEndFrame {
  replyId: string
  chunks: number
  samples: number
  sampleRate: number
}

export interface AudioFramer {
  /** Splits above the maximum, holds below the floor, emits in order. */
  push(pcm16: Buffer, sampleRate: number): void
  /** Emits what is held and returns the totals. */
  flush(): AudioEndFrame
}

export function createAudioFramer(o: { replyId: string; maxBytes?: number; minBytes?: number; emit: (f: AudioChunkFrame) => void }): AudioFramer {
  const maxBytes = wholeSamples(o.maxBytes ?? AUDIO_FRAME_MAX_BYTES)
  const minBytes = o.minBytes ?? AUDIO_FRAME_MIN_BYTES
  let held: Buffer = Buffer.alloc(0)
  let heldRate = 0
  let chunks = 0
  let samples = 0
  let lastRate = 0

  const send = (pcm16: Buffer, sampleRate: number) => {
    o.emit({ replyId: o.replyId, index: chunks, sampleRate, pcm16: pcm16.toString('base64') })
    chunks++
    samples += pcm16.length / 2
    lastRate = sampleRate
  }
  const sendHeld = () => {
    if (held.length) send(held, heldRate)
    held = Buffer.alloc(0)
  }

  return {
    push(pcm16, sampleRate) {
      if (held.length && sampleRate !== heldRate) sendHeld()
      held = held.length ? Buffer.concat([held, pcm16]) : pcm16
      heldRate = sampleRate
      while (held.length >= maxBytes) {
        send(held.subarray(0, maxBytes), sampleRate)
        held = held.subarray(maxBytes)
      }
      if (held.length && held.length >= minBytes) sendHeld()
    },
    flush() {
      sendHeld()
      return { replyId: o.replyId, chunks, samples, sampleRate: lastRate }
    },
  }
}

/** The largest even byte count not above `bytes`, and never below one sample. */
function wholeSamples(bytes: number): number {
  return Math.max(2, bytes - (bytes % 2))
}

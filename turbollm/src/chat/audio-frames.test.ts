// The framer (arch 2.3): a spoken reply's streamed audio cut into `audio_chunk` frames a viewer can take, each at most
// AUDIO_FRAME_MAX_BYTES of whole PCM16 samples, in order, with the totals `audio_end` reports. Pure: no timers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUDIO_FRAME_MAX_BYTES, AUDIO_FRAME_MIN_BYTES, createAudioFramer, type AudioChunkFrame } from './audio-frames'

/** A framer that records every frame it emits. */
function framer(o: { maxBytes?: number; minBytes?: number } = {}) {
  const frames: AudioChunkFrame[] = []
  const f = createAudioFramer({ replyId: 'reply-1', ...o, emit: (frame) => frames.push(frame) })
  const bytes = () => frames.map((x) => Buffer.from(x.pcm16, 'base64'))
  return { f, frames, bytes }
}

const pcm = (n: number, from = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (from + i) % 256))

test('the defaults: 16 KiB frames, no coalescing floor', () => {
  assert.equal(AUDIO_FRAME_MAX_BYTES, 16_384)
  assert.equal(AUDIO_FRAME_MIN_BYTES, 0)
})

test('audio above the maximum is split; every frame is at most the maximum and whole samples', () => {
  const { f, bytes } = framer({ maxBytes: 4 })
  f.push(pcm(10), 16000)
  assert.deepEqual(bytes().map((b) => b.length), [4, 4, 2])
})

test('an odd maximum still gives frames of whole samples', () => {
  const { f, bytes } = framer({ maxBytes: 5 })
  f.push(pcm(10), 16000)
  assert.ok(bytes().every((b) => b.length <= 5 && b.length % 2 === 0), bytes().map((b) => b.length).join(','))
  assert.equal(Buffer.concat(bytes()).length, 10)
})

test('audio below the floor is held until the next push, or the flush', () => {
  const { f, bytes } = framer({ maxBytes: 8, minBytes: 6 })
  f.push(pcm(4), 16000)
  assert.equal(bytes().length, 0, 'held')
  f.push(pcm(4, 4), 16000)
  assert.deepEqual(bytes().map((b) => b.length), [8])
  f.push(pcm(2, 8), 16000)
  assert.equal(bytes().length, 1, 'held again')
  f.flush()
  assert.deepEqual(bytes().map((b) => b.length), [8, 2])
})

test('frames are indexed 0..n-1 in order, name their reply and rate, and their base64 joins back to the input', () => {
  const { f, frames, bytes } = framer({ maxBytes: 6 })
  const input = [pcm(8), pcm(4, 8), pcm(10, 12)]
  for (const b of input) f.push(b, 24000)
  f.flush()
  assert.deepEqual(frames.map((x) => x.index), frames.map((_, i) => i))
  assert.ok(frames.every((x) => x.replyId === 'reply-1' && x.sampleRate === 24000))
  assert.deepEqual(Buffer.concat(bytes()), Buffer.concat(input))
})

test('the flush totals are what was emitted', () => {
  const { f, frames, bytes } = framer({ maxBytes: 6, minBytes: 4 })
  f.push(pcm(14), 24000)
  f.push(pcm(2, 14), 24000)
  const end = f.flush()
  assert.deepEqual(end, { replyId: 'reply-1', chunks: frames.length, samples: Buffer.concat(bytes()).length / 2, sampleRate: 24000 })
  assert.equal(end.samples, 8)
})

test('a reply with no audio ends with no chunks and no samples', () => {
  const { f, frames } = framer()
  const end = f.flush()
  assert.equal(frames.length, 0)
  assert.equal(end.chunks, 0)
  assert.equal(end.samples, 0)
})

test('a change of rate mid-reply first sends what was held at the old rate', () => {
  const { f, frames } = framer({ minBytes: 100 })
  f.push(pcm(4), 16000)
  f.push(pcm(4, 4), 24000)
  assert.deepEqual(frames.map((x) => [x.sampleRate, Buffer.from(x.pcm16, 'base64').length]), [[16000, 4]])
  f.flush()
  assert.deepEqual(frames.map((x) => [x.sampleRate, Buffer.from(x.pcm16, 'base64').length]), [[16000, 4], [24000, 4]])
})

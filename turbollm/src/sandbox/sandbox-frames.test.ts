import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, FrameReader, FrameViolation, MAX_HOST_HEADER } from './sandbox-frames'

test('frames: a frame round-trips, its size set from the payload', () => {
  const r = new FrameReader(1024)
  const [f] = r.push(encodeFrame({ t: 'result', ok: true }, [Buffer.from('ab'), Buffer.from('cde')]))
  assert.equal(f.header.t, 'result')
  assert.equal(f.header.size, 5)
  assert.equal(f.payload.toString(), 'abcde')
})

test('frames: split one byte at a time, and two frames in one chunk', () => {
  const bytes = Buffer.concat([encodeFrame({ t: 'ready' }), encodeFrame({ t: 'result' }, [Buffer.from('xyz')])])
  const r = new FrameReader(1024)
  const got = []
  for (const b of bytes) got.push(...r.push(Buffer.from([b])))
  assert.deepEqual(got.map((f) => f.header.t), ['ready', 'result'])
  assert.equal(got[1].payload.toString(), 'xyz')
  const both = new FrameReader(1024).push(bytes)
  assert.equal(both.length, 2)
})

test('frames: a header over its limit is a violation before it is read', () => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(MAX_HOST_HEADER + 1, 0)
  assert.throws(() => new FrameReader(1024).push(len), FrameViolation)
  // Printable text where a frame should start (escaped code writing to stdout) reads as a huge length.
  assert.throws(() => new FrameReader(1024).push(Buffer.from('hello world')), FrameViolation)
})

test('frames: a header that is not a JSON object is a violation', () => {
  const frame = (h: string) => {
    const b = Buffer.from(h)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length, 0)
    return Buffer.concat([len, b])
  }
  for (const h of ['not json', '[1,2]', 'null', '"x"', '{"t":"ready"}', '{"size":-1}', '{"size":1.5}', '{"size":"3"}']) {
    assert.throws(() => new FrameReader(1024).push(frame(h)), FrameViolation, h)
  }
})

test('frames: a payload over the limit is refused from its header, before any of it arrives', () => {
  const h = Buffer.from(JSON.stringify({ t: 'result', size: 2048 }))
  const len = Buffer.alloc(4)
  len.writeUInt32BE(h.length, 0)
  assert.throws(() => new FrameReader(1024).push(Buffer.concat([len, h])), FrameViolation)
})

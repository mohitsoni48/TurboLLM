// The PTY scrollback: appending a chunk must not copy the whole buffer (a TUI agent CLI emits hundreds of chunks
// a second), yet a replay is still exactly the newest `cap` characters.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScrollbackBuffer } from './pty-scrollback'

test('ScrollbackBuffer: under the cap, the replay is everything written', () => {
  const b = new ScrollbackBuffer(10)
  b.append('abc')
  b.append('def')
  assert.equal(b.toString(), 'abcdef')
})

test('ScrollbackBuffer: over the cap, the replay is exactly the newest `cap` characters', () => {
  const b = new ScrollbackBuffer(10)
  for (const chunk of ['abcd', 'efgh', 'ijkl', 'mnop']) b.append(chunk)
  assert.equal(b.toString(), 'ghijklmnop')
  assert.equal(b.toString().length, 10)
})

test('ScrollbackBuffer: never holds more than one chunk beyond the cap, and a replay stays full once truncated', () => {
  const b = new ScrollbackBuffer(100)
  for (let i = 0; i < 1000; i++) {
    b.append('x'.repeat(7))
    assert.ok(b.retainedLength() < 100 + 7, 'retention must stay within one chunk of the cap')
    if (i >= 15) assert.equal(b.toString().length, 100, 'a truncated replay must be a full cap (the web client relies on it)')
  }
})

test('ScrollbackBuffer: one chunk larger than the cap keeps only its tail', () => {
  const b = new ScrollbackBuffer(4)
  b.append('abcdefgh')
  assert.equal(b.toString(), 'efgh')
})

test('ScrollbackBuffer: appending does not copy the buffer (copy volume stays linear in output)', () => {
  const cap = 512 * 1024
  const b = new ScrollbackBuffer(cap)
  const chunk = 'y'.repeat(200)
  const start = process.hrtime.bigint()
  for (let i = 0; i < 20_000; i++) b.append(chunk) // 4 MB through a 512 KB cap
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  assert.ok(ms < 500, `20k appends took ${ms.toFixed(0)} ms`)
})

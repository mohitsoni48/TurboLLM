// The engine log's bounded tail reader and its size-capped stream (scalability review 3.3).
import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import { RotatingLogStream, readTail } from './engine-log'
import { tmpDir } from '../test-support/tmp'

test('readTail: last n lines, CRLF and trailing newlines stripped, missing file is empty', () => {
  const p = join(tmpDir('tllm-tail-'), 'a.log')
  writeFileSync(p, 'one\r\ntwo\r\nthree\r\n\r\n')
  assert.deepEqual(readTail(p, 2), ['two', 'three'])
  assert.deepEqual(readTail(p, 10), ['one', 'two', 'three'])
  assert.deepEqual(readTail(join(tmpDir('tllm-tail-'), 'none.log'), 5), [])
  assert.deepEqual(readTail('', 5), [])
})

test('readTail reads only a bounded window of a huge log and drops the cut first line', () => {
  const p = join(tmpDir('tllm-tail-'), 'big.log')
  const line = 'x'.repeat(99) // 100 bytes with the newline
  writeFileSync(p, Array.from({ length: 50_000 }, (_, i) => `${i}:${line}`.slice(0, 99)).join('\n') + '\n') // ~5 MB
  const tail = readTail(p, 20)
  assert.equal(tail.length, 20)
  assert.ok(tail.every((l) => l.length === 99), 'every returned line is whole')
  assert.ok(tail[19].startsWith('49999:'))
})

test('readTail drops a multibyte character cut by the window along with the partial line', () => {
  const p = join(tmpDir('tllm-tail-'), 'u.log')
  writeFileSync(p, 'é'.repeat(200_000) + '\nlast\n')
  assert.deepEqual(readTail(p, 5), ['last'])
})

test('RotatingLogStream rotates to .1 past its cap, keeping one previous file and a live file that keeps growing', async () => {
  const p = join(tmpDir('tllm-rot-'), 'engine.log')
  const log = new RotatingLogStream(p, 100)
  for (let i = 0; i < 5; i++) log.write(`line-${i}-${'y'.repeat(40)}\n`) // ~47 bytes each
  log.end()
  await once(log, 'finish')
  assert.ok(existsSync(`${p}.1`), 'rotated')
  assert.ok(!existsSync(`${p}.2`), 'only one previous file')
  const all = readFileSync(`${p}.1`, 'utf8') + readFileSync(p, 'utf8')
  assert.ok(all.includes('line-4-'), 'the newest line is in the live file or the previous one')
  assert.ok(statSync(p).size <= 100 + 60, 'live file stays near the cap')
  assert.ok(readFileSync(p, 'utf8').includes('line-4-'))
})

test('RotatingLogStream starts from an empty file and drops a stale .1', async () => {
  const p = join(tmpDir('tllm-rot-'), 'engine.log')
  writeFileSync(p, 'old run')
  writeFileSync(`${p}.1`, 'older run')
  const log = new RotatingLogStream(p)
  log.write('new\n')
  log.end()
  await once(log, 'finish')
  assert.equal(readFileSync(p, 'utf8'), 'new\n')
  assert.ok(!existsSync(`${p}.1`))
})

test('RotatingLogStream surfaces a write failure as an error event', async () => {
  const dir = tmpDir('tllm-rot-')
  const log = new RotatingLogStream(dir) // a directory: cannot be opened for writing
  const [e] = await once(log, 'error')
  assert.ok(e instanceof Error)
})

test('a failed rotation keeps both generations and keeps appending to the live file, then rotates once it can', async () => {
  const p = join(tmpDir('tllm-rot-'), 'engine.log')
  let rotationsRefused = true
  const rename: typeof renameSync = (from, to) => {
    if (rotationsRefused) throw new Error('EBUSY: held without share-delete')
    renameSync(from, to)
  }
  const log = new RotatingLogStream(p, 100, rename)
  const write = (i: number) => log.write(`line-${i}-${'y'.repeat(40)}\n`)
  for (let i = 0; i < 3; i++) write(i) // passes the cap; the rotation is refused
  await new Promise((resolve) => setTimeout(resolve, 50))
  const live = readFileSync(p, 'utf8')
  assert.ok(live.includes('line-0-') && live.includes('line-2-'), 'nothing truncated away by the failed rotation')
  assert.ok(!existsSync(`${p}.1`))
  rotationsRefused = false
  for (let i = 3; i < 5; i++) write(i) // past the retry point, but short of a second rotation
  log.end()
  await once(log, 'finish')
  assert.ok(existsSync(`${p}.1`), 'rotation was retried later')
  const all = readFileSync(`${p}.1`, 'utf8') + readFileSync(p, 'utf8')
  assert.ok(all.includes('line-0-') && all.includes('line-4-'), 'no line lost across the failed and the later rotation')
})

test('readTail right after a rotation continues into the previous generation', () => {
  const p = join(tmpDir('tllm-tail-'), 'engine.log')
  writeFileSync(`${p}.1`, 'a\nb\ncrash traceback\n')
  writeFileSync(p, 'fresh\n')
  assert.deepEqual(readTail(p, 3), ['b', 'crash traceback', 'fresh'])
  assert.deepEqual(readTail(p, 1), ['fresh'])
  writeFileSync(p, '')
  assert.deepEqual(readTail(p, 2), ['b', 'crash traceback'])
})

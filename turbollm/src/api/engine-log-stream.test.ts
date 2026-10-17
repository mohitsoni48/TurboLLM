// Regression coverage for the Monitor screen's (issue #211) BLOCKING review finding: GET
// /api/v1/engine/logs/stream kept a per-connection `sent` line-index that was never reset when
// the underlying log file changed — every engine start truncates its log file in place
// (manager.ts's `createWriteStream` truncates), and a switch points `logPath()` at a different,
// shorter file. Either way `lines.length` can drop below `sent`, and the un-reset cursor made the
// stream loop stall forever: no error, no new lines, until the new file eventually regrew past
// the old length. This only rarely bit the Engines drawer (closed by default, reopened fresh
// after most switches) but is the common case for a screen meant to stay open across exactly
// this workflow ("especially when working with multiple engines and models" — the issue's own
// words). Also covers the adjacent race this same fix closes: a fresh connection used to replay
// the WHOLE log from line 0, racing the client's own initial-tail GET for duplicated or
// truncated lines — a fresh connection should instead start from the file's current end.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

/** Reads SSE `event: ...` frames off a Response body as they arrive — same pattern as
 *  `gateway.queue-ping.test.ts`'s `sseEventReader`, duplicated locally rather than shared across
 *  an api/ <-> gateway/ boundary for one small helper. Deliberately only ever has ONE
 *  `reader.read()` request in flight at a time (never call `next()` again before the previous
 *  call has settled) — the underlying WHATWG reader queues concurrent read requests in FIFO
 *  order, so a second call issued while the first is still pending would silently steal whatever
 *  chunk was meant for it. */
function sseEventReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  return {
    /** The next frame, skipping keep-alive pings unless `pings` (the stream sends one on its
     *  first tick, carrying its resume cursor). */
    async next(timeoutMs = 3000, { pings = false } = {}): Promise<{ event: string; data: string; id?: string }> {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const frameEnd = buf.indexOf('\n\n')
        if (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd)
          buf = buf.slice(frameEnd + 2)
          const event = frame.match(/^event: (.+)$/m)?.[1] ?? ''
          const data = frame.match(/^data: (.*)$/m)?.[1] ?? ''
          const id = frame.match(/^id: (.+)$/m)?.[1]
          if (event === 'ping' && !pings) continue
          return { event, data, id }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`sseEventReader.next: no frame within ${timeoutMs}ms`)
        const { done, value } = await reader.read()
        if (done) throw new Error('sseEventReader.next: stream ended before a frame arrived')
        buf += dec.decode(value, { stream: true })
      }
    },
    /** The client goes away: hono's stream sees the cancel as an abort and stops. */
    close: () => reader.cancel(),
  }
}

function fakeApp(getPath: () => string) {
  const d = {
    version: 'test',
    store: { snapshot: () => ({}), update: (fn: (c: unknown) => void) => fn({}) },
    manager: { status: () => ({ state: 'stopped', model: null }), logPath: () => getPath() },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

test('GET /api/v1/engine/logs/stream: engine suite', async (t) => {
  const dir = tmpDir('tllm-log-stream-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await t.test('a fresh connection does NOT replay existing history — its first frame is the next NEW line, not the old backlog', async () => {
    const logA = join(dir, 'a.log')
    writeFileSync(logA, 'old line 1\nold line 2\nold line 3\n')
    const app = fakeApp(() => logA)

    const res = await app.request('/api/v1/engine/logs/stream')
    assert.ok(res.body)
    const events = sseEventReader(res.body!)

    // Give the daemon's poll loop at least one tick (400ms cadence) to seed its cursor against
    // the existing 3-line file before anything new is written — the old code would have already
    // queued all 3 old lines for delivery by this point; the fix must not have queued any of them.
    await new Promise((r) => setTimeout(r, 600))
    writeFileSync(logA, 'old line 1\nold line 2\nold line 3\nnew line 4\n')

    const frame = await events.next()
    assert.equal(frame.event, 'line')
    assert.deepEqual(
      JSON.parse(frame.data),
      { line: 'new line 4' },
      'the first frame must be the NEW line, not "old line 1" (which the pre-fix code would have sent first)',
    )
  })

  await t.test('same-path restart (truncate to a SHORTER file) does not stall the stream forever', async () => {
    const logB = join(dir, 'b.log')
    writeFileSync(logB, 'line 1\nline 2\nline 3\nline 4\nline 5\n')
    const app = fakeApp(() => logB)

    const res = await app.request('/api/v1/engine/logs/stream')
    const events = sseEventReader(res.body!)
    await new Promise((r) => setTimeout(r, 600)) // let the cursor seed against the 5-line file

    // Restart: manager.ts truncates and rewrites the SAME path, shorter than before. Pre-fix,
    // `sent` (already 5) would exceed the new `lines.length - 1` forever — the loop condition
    // `sent < lines.length - 1` never becomes true again until 5+ NEW lines accumulate, so this
    // single follow-up line would never arrive at all (the test's own timeout would catch that).
    writeFileSync(logB, 'restarted\n')
    await new Promise((r) => setTimeout(r, 600)) // let the reset-detection tick run
    writeFileSync(logB, 'restarted\nsecond\n')

    // The new run's log is read from its start: its first line — written before the tick that
    // noticed the restart — must arrive too (it used to be skipped by reseeding at the new end).
    const frame = await events.next()
    assert.equal(frame.event, 'line')
    assert.deepEqual(JSON.parse(frame.data), { line: 'restarted' }, 'the new run\'s first line must not be dropped')
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'second' }, 'must recover and keep streaming instead of stalling past the shrink')
  })

  await t.test('an engine SWITCH (logPath() changes to a different, shorter file) does not stall the stream forever', async () => {
    const logC1 = join(dir, 'c1.log')
    const logC2 = join(dir, 'c2.log')
    writeFileSync(logC1, 'engine one, line 1\nengine one, line 2\nengine one, line 3\nengine one, line 4\n')
    writeFileSync(logC2, 'engine two, line 1\n')
    let active = logC1
    const app = fakeApp(() => active)

    const res = await app.request('/api/v1/engine/logs/stream')
    const events = sseEventReader(res.body!)
    await new Promise((r) => setTimeout(r, 600)) // let the cursor seed against engine one's log

    // Switch engines: logPath() now points at a different, much shorter file.
    active = logC2
    await new Promise((r) => setTimeout(r, 600)) // let the path-change detection tick run
    writeFileSync(logC2, 'engine two, line 1\nengine two, line 2\n')

    // Engine two's log is streamed from its start, not from wherever it was when the switch was seen.
    const frame = await events.next()
    assert.equal(frame.event, 'line')
    assert.deepEqual(JSON.parse(frame.data), { line: 'engine two, line 1' })
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'engine two, line 2' })
  })

  await t.test('a log that first appears after the connection opened is streamed from its first line', async () => {
    const logE = join(dir, 'e.log')
    const app = fakeApp(() => logE)

    const res = await app.request('/api/v1/engine/logs/stream')
    const events = sseEventReader(res.body!)
    await new Promise((r) => setTimeout(r, 600)) // a tick with no log file at all (no engine run yet)
    writeFileSync(logE, 'first run, line 1\nfirst run, line 2\n')

    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'first run, line 1' })
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'first run, line 2' })
  })

  // Perf follow-up coverage (docs/TODO.md, ADR-409 review item 2): the delta-read rewrite
  // (readSync at a tracked byte offset instead of readFileSync-the-whole-file every tick)
  // must still deliver every line, across multiple ticks, byte-for-byte — including a line
  // whose content only becomes complete on a LATER write (a partial line held in `carry`)
  // and a multi-byte UTF-8 character. Doesn't assert anything about the old implementation's
  // performance (not observable from here) — only that the new read shape is still correct.
  await t.test('multi-tick delta reads: every appended line arrives exactly once, including a multi-byte UTF-8 line', async () => {
    const logD = join(dir, 'd.log')
    writeFileSync(logD, 'seed\n')
    const app = fakeApp(() => logD)

    const res = await app.request('/api/v1/engine/logs/stream')
    const events = sseEventReader(res.body!)
    await new Promise((r) => setTimeout(r, 600)) // seed the cursor at the 1-line file's end

    // Tick 1: two ASCII lines appended in one write.
    appendFileSync(logD, 'line a\nline b\n')
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'line a' })
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'line b' })

    // Tick 2: a multi-byte UTF-8 line (emoji + accented characters) — a byte-range read that
    // happened to split this character mid-sequence would previously decode as U+FFFD; a line's
    // bytes are held raw (`carry`) until its newline arrives, and decoded whole.
    appendFileSync(logD, 'GPU 温度 café 🚀\n')
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'GPU 温度 café 🚀' })

    // Tick 3: a line written WITHOUT a trailing newline yet must not be emitted early — it has
    // to be held (`carry`) until the newline that completes it arrives in a later write.
    appendFileSync(logD, 'partial-')
    await new Promise((r) => setTimeout(r, 500)) // at least one more poll tick with no complete line
    appendFileSync(logD, 'line c\n')
    assert.deepEqual(JSON.parse((await events.next()).data), { line: 'partial-line c' })
  })
  // A reconnect (a Wi-Fi drop, sleep/wake, the 3 s before the client reopens) used to start from
  // "now" like a brand-new connection, so every line written while the client was away was lost.
  // The client sends back the id of the last frame it got (web sse.ts subscribeSse).
  const resumeFrom = (app: Hono, id: string) => app.request('/api/v1/engine/logs/stream', { headers: { 'Last-Event-ID': id } })

  await t.test('a reconnect with the last id it got resumes there: the lines written while it was away arrive, none twice', async () => {
    const logF = join(dir, 'f.log')
    writeFileSync(logF, 'seed\n')
    const app = fakeApp(() => logF)
    const first = sseEventReader((await app.request('/api/v1/engine/logs/stream')).body!)
    await new Promise((r) => setTimeout(r, 600))
    appendFileSync(logF, 'line a\n')
    const a = await first.next()
    assert.deepEqual(JSON.parse(a.data), { line: 'line a' })
    assert.ok(a.id, 'each line carries its cursor as the SSE id')
    await first.close()

    appendFileSync(logF, 'while away 1\nwhile away 2\n')
    const again = sseEventReader((await resumeFrom(app, a.id!)).body!)
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'while away 1' })
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'while away 2' })
    appendFileSync(logF, 'after\n')
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'after' })
    await again.close()
  })

  await t.test('a quiet log: the first ping carries the cursor, so a connection that got no line still resumes', async () => {
    const logG = join(dir, 'g.log')
    writeFileSync(logG, 'seed\n')
    const app = fakeApp(() => logG)
    const first = sseEventReader((await app.request('/api/v1/engine/logs/stream')).body!)
    const ping = await first.next(3000, { pings: true })
    assert.equal(ping.event, 'ping')
    assert.ok(ping.id)
    await first.close()

    appendFileSync(logG, 'while away\n')
    const again = sseEventReader((await resumeFrom(app, ping.id!)).body!)
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'while away' })
    await again.close()
  })

  await t.test('an id from another log (the engine restarted while it was away) starts this one from its first line', async () => {
    const logH = join(dir, 'h.log')
    writeFileSync(logH, 'old run 1\n')
    const app = fakeApp(() => logH)
    const first = sseEventReader((await app.request('/api/v1/engine/logs/stream')).body!)
    await new Promise((r) => setTimeout(r, 600))
    appendFileSync(logH, 'old run 2\n')
    const last = await first.next()
    await first.close()

    // The restart rewrote the same path, and its log is already longer than the old cursor.
    writeFileSync(logH, 'new run, line 1 is longer than the old log\nnew run, line 2\n')
    const again = sseEventReader((await resumeFrom(app, last.id!)).body!)
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'new run, line 1 is longer than the old log' })
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'new run, line 2' })
    await again.close()
  })

  await t.test('a resume far behind replays only the last 256 KiB of the log, from the first whole line in them', async () => {
    const logI = join(dir, 'i.log')
    writeFileSync(logI, 'seed\n')
    const app = fakeApp(() => logI)
    const first = sseEventReader((await app.request('/api/v1/engine/logs/stream')).body!)
    const ping = await first.next(3000, { pings: true })
    await first.close()

    // A laptop that slept with Monitor open: 300 lines of 1000 bytes went by while it was away.
    const line = (i: number) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(990)}`
    appendFileSync(logI, Array.from({ length: 300 }, (_, i) => line(i) + '\n').join(''))
    const floor = 5 + 300 * 1000 - 256 * 1024 // routes.ts LOG_RESUME_MAX_BYTES
    const firstWhole = Math.ceil((floor - 5) / 1000) // line 37 starts before the floor and is cut

    const again = sseEventReader((await resumeFrom(app, ping.id!)).body!)
    for (let i = firstWhole; i < 300; i++) {
      assert.deepEqual(JSON.parse((await again.next()).data), { line: line(i) }, `line ${i}`)
    }
    appendFileSync(logI, 'after\n')
    assert.deepEqual(JSON.parse((await again.next()).data), { line: 'after' })
    await again.close()
  })

  // A resume whose 256 KiB floor cuts a line skips that line's tail, up to its newline. When
  // there is no newline yet (a long carriage-return progress bar) and the engine restarts or
  // switches first, that skip used to carry over to the new log and eat its first line.
  await t.test('a resume cut mid-line that switches to a new log before any newline still sends the new log\'s first line', async () => {
    for (const how of ['switch', 'restart'] as const) {
      const logJ = join(dir, `j-${how}.log`)
      const logJ2 = join(dir, `j-${how}-next.log`)
      writeFileSync(logJ, 'seed\n')
      let active = logJ
      const app = fakeApp(() => active)
      const first = sseEventReader((await app.request('/api/v1/engine/logs/stream')).body!)
      const ping = await first.next(3000, { pings: true })
      await first.close()

      appendFileSync(logJ, 'progress 50%\r'.repeat(Math.ceil((300 * 1024) / 13))) // over 256 KiB, no newline
      const again = sseEventReader((await resumeFrom(app, ping.id!)).body!)
      await new Promise((r) => setTimeout(r, 600)) // the resumed first look reads the cut tail
      if (how === 'switch') {
        writeFileSync(logJ2, 'new log line 1\nnew log line 2\n')
        active = logJ2
      } else {
        writeFileSync(logJ, 'new log line 1\nnew log line 2\n') // shorter than what was read
      }
      assert.deepEqual(JSON.parse((await again.next()).data), { line: 'new log line 1' }, how)
      assert.deepEqual(JSON.parse((await again.next()).data), { line: 'new log line 2' }, how)
      await again.close()
    }
  })
})

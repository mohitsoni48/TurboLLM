// Lifecycle tests for the usage sampling loop (ADR-383). The real readers spawn processes and
// depend on the host's hardware, so everything here runs against an injected fake: what is under
// test is the LOOP's contract — start once, never overlap, always resolve, latch off a dead
// reader, and tear the child down — not any vendor's output format (that is usage-parse.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setDiskReaderForTests,
  __setReaderForTests,
  __tickForTests,
  createLatchingReader,
  createLiveIostatParser,
  createStreamingReader,
  DISK_STREAM_PS,
  pickDiskReader,
  pickReader,
  requestUsage,
  stopUsageMonitor,
} from './usage'
import type { DiskReader, GpuReader } from './usage'
import { parseWindowsDiskSample } from './usage-parse'
import type { DiskSample, GpuSample } from './usage-parse'
import { execFileSync } from 'node:child_process'
import type { SysInfo } from './sysinfo'

const sysWith = (...gpus: SysInfo['gpus']): SysInfo => ({
  os: 'linux/x64',
  cpu: 'test',
  cores: 8,
  ramMB: 64000,
  gpus,
})

function fakeReader(over: Partial<GpuReader> & { onRead?: () => Promise<GpuSample[] | null> } = {}) {
  const calls = { start: 0, stop: 0, read: 0 }
  const reader: GpuReader = {
    kind: 'fake',
    start: () => {
      calls.start++
    },
    stop: () => {
      calls.stop++
    },
    read: async () => {
      calls.read++
      return over.onRead ? over.onRead() : []
    },
  }
  return { reader, calls }
}

// A real disk reader would spawn PowerShell (Windows) or read /proc/diskstats (Linux) — every
// test here injects this no-op instead, same discipline as fakeReader() above, so the loop's
// OWN contract is what's under test, never a real platform's disk sampler.
function fakeDiskReader(onRead?: () => Promise<DiskSample | null>): DiskReader {
  return {
    kind: 'fake-disk',
    start: () => {},
    stop: () => {},
    read: async () => (onRead ? onRead() : null),
  }
}

test('requestUsage: starts the reader exactly once, even for concurrent callers', async (t) => {
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  const { reader, calls } = fakeReader()
  __setReaderForTests(reader)
  __setDiskReaderForTests(fakeDiskReader())

  await Promise.all([requestUsage(), requestUsage(), requestUsage()])
  assert.equal(calls.start, 1, 'three concurrent callers must not spawn three readers')
})

test('stopUsageMonitor: tears the reader down and is idempotent', async (t) => {
  t.after(() => {
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  const { reader, calls } = fakeReader()
  __setReaderForTests(reader)
  __setDiskReaderForTests(fakeDiskReader())

  await requestUsage()
  stopUsageMonitor()
  stopUsageMonitor()
  assert.equal(calls.stop, 1, 'a second stop must not re-stop an already-stopped reader')
})

test('requestUsage: a reader that rejects still resolves, with null usage', async (t) => {
  // Fail open (ADR-349's convention): a broken vendor tool must degrade the GPU fields to dashes,
  // never reject the HTTP request and never surface an error to the user.
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  const { reader } = fakeReader({ onRead: () => Promise.reject(new Error('nvidia-smi exploded')) })
  __setReaderForTests(reader)
  __setDiskReaderForTests(fakeDiskReader())

  const u = await requestUsage()
  assert.ok(Array.isArray(u.gpus))
  for (const g of u.gpus) {
    assert.equal(g.utilPct, null)
    assert.equal(g.vramUsedMb, null)
  }
})

test('requestUsage: a disk reader that rejects still resolves, with null disk', async (t) => {
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  __setReaderForTests(fakeReader().reader)
  __setDiskReaderForTests(fakeDiskReader(() => Promise.reject(new Error('/proc/diskstats gone'))))

  const u = await requestUsage()
  assert.equal(u.disk, null)
})

test('requestUsage: a real disk sample flows through to HwUsage.disk', async (t) => {
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  __setReaderForTests(fakeReader().reader)
  __setDiskReaderForTests(
    fakeDiskReader(async () => ({ readMBps: 12.5, writeMBps: 3.25, combined: false })),
  )

  const u = await requestUsage()
  assert.deepEqual(u.disk, { readMBps: 12.5, writeMBps: 3.25, combined: false })
})

test('requestUsage: RAM is always readable, and used never exceeds total', async (t) => {
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  __setReaderForTests(fakeReader().reader)
  __setDiskReaderForTests(fakeDiskReader())

  const u = await requestUsage()
  assert.ok(u.ram.totalMb > 0, 'os.totalmem() must report something')
  assert.ok(u.ram.usedMb >= 0 && u.ram.usedMb <= u.ram.totalMb)
  assert.ok(u.sampledAt > 0)
})

test('cpuPct is null on the first sample and a real number on the next', async (t) => {
  // The first tick has no predecessor to difference against. Reporting 0 there would draw an idle
  // CPU bar for one tick every time the monitor opens.
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
    __setDiskReaderForTests(null)
  })
  __setReaderForTests(fakeReader().reader)
  __setDiskReaderForTests(fakeDiskReader())

  const first = await requestUsage()
  assert.equal(first.cpuPct, null)

  // The loop's real interval is 1 s. Back-to-back ticks would share a millisecond, giving a zero
  // CPU-time delta — which correctly reports null — so wait long enough for the OS counters
  // (~15.6 ms granularity on Windows) to actually move.
  await new Promise((r) => setTimeout(r, 80))
  const second = await __tickForTests()
  assert.ok(typeof second.cpuPct === 'number', `expected a number, got ${second.cpuPct}`)
  assert.ok(second.cpuPct >= 0 && second.cpuPct <= 100)
})

test('createLatchingReader: stops calling a reader that has failed three times', async () => {
  // A box with no nvidia-smi would otherwise spawn a doomed process every second, forever.
  let sampled = 0
  const r = createLatchingReader('flaky', async () => {
    sampled++
    throw new Error('nope')
  })

  for (let i = 0; i < 6; i++) assert.equal(await r.read(), null)
  assert.equal(sampled, 3, 'the reader must latch off after 3 consecutive failures')
})

test('createLatchingReader: a success resets the failure counter', async () => {
  let sampled = 0
  let succeed = false
  const r = createLatchingReader('flappy', async () => {
    sampled++
    if (!succeed) throw new Error('nope')
    return [{ id: '0', name: 'g', utilPct: 1, vramUsedMb: 1, vramTotalMb: 2, vramSharedMb: null }]
  })

  await r.read()
  await r.read() // two failures — one short of the latch
  succeed = true
  assert.ok(await r.read(), 'third call succeeds')
  succeed = false
  await r.read()
  await r.read()
  await r.read() // three fresh failures re-latch
  await r.read() // must be a no-op now
  assert.equal(sampled, 6)
})

test('pickReader: a CPU-only box gets the null reader, not a doomed vendor probe', async () => {
  const r = pickReader(sysWith())
  assert.equal(r.kind, 'null')
  assert.equal(await r.read(), null)
})

test('pickReader: any NVIDIA card wins, even beside an integrated GPU', () => {
  // ADR-306: the iGPU contributes nothing to the VRAM budget, so there is no reason to also pay
  // for the (far more expensive) vendor-neutral Windows counter stream on such a box.
  const r = pickReader(
    sysWith(
      { name: 'Intel UHD Graphics 770', vramMb: 2000, vendor: 'intel', unified: true },
      { name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16303, vendor: 'nvidia' },
    ),
  )
  assert.equal(r.kind, 'nvidia')
})

// ── createStreamingReader ────────────────────────────────────────────────────
// Driven through `process.execPath` rather than `powershell`, so these cases assert the generic's
// own contract on every platform — the two production callers only differ by command and parser.

/** A reader over a throwaway node child that prints exactly what `script` writes. */
function nodeStreamingReader(script: string) {
  return createStreamingReader('test-stream', process.execPath, ['-e', script], (line) =>
    line.startsWith('take:') ? line.slice('take:'.length) : null,
  )
}

/** Poll `read()` until it reports something, or give up. Child startup is not instantaneous and
 *  the reader's whole point is that "nothing yet" is a legal answer. */
async function readUntil<T>(reader: { read(): Promise<T | null> }, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await reader.read()
    if (v !== null) return v
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('createStreamingReader: reports nothing until the first line lands', async (t) => {
  const r = nodeStreamingReader('setTimeout(()=>{},3000)')
  t.after(() => r.stop())

  assert.equal(r.kind, 'test-stream')
  r.start()
  assert.equal(await r.read(), null, 'a warm-up read is "not ready", not a failure')
})

test('createStreamingReader: the newest parsed line wins', async (t) => {
  const r = nodeStreamingReader("console.log('take:first');console.log('take:second')")
  t.after(() => r.stop())

  r.start()
  await readUntil(r)
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(await r.read(), 'second')
})

test('createStreamingReader: an unparseable line leaves the last good sample intact', async (t) => {
  const r = nodeStreamingReader("console.log('take:good');console.log('garbage')")
  t.after(() => r.stop())

  r.start()
  assert.equal(await readUntil(r), 'good')
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(await r.read(), 'good', 'a null parse must not erase the previous sample')
})

test('createStreamingReader: a child that cannot spawn latches the reader off', async (t) => {
  const r = createStreamingReader('test-dead', 'turbollm-no-such-binary', ['--nope'], (l) => l)
  t.after(() => r.stop())

  r.start()
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(await r.read(), null, 'the error event must latch the reader dead, not retry it')
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(await r.read(), null, 'and it must stay dead')
})

test('createStreamingReader: stop() clears the cached sample and is safe before start()', async (t) => {
  const never = createStreamingReader('test-unstarted', process.execPath, ['-e', ''], (l) => l)
  never.stop() // must not throw on a reader that was never started
  assert.equal(await never.read(), null)

  const r = nodeStreamingReader("console.log('take:value');setTimeout(()=>{},3000)")
  t.after(() => r.stop())
  r.start()
  assert.equal(await readUntil(r), 'value')
  r.stop()
  assert.equal(await r.read(), null, 'stop() must drop the cached sample')
})

test('createStreamingReader: the buffer clamp keeps the newest complete line', async (t) => {
  // A child that emits a megabyte without a newline must not be able to grow the buffer without
  // bound — and the clamp must not swallow the complete line that follows it.
  const r = nodeStreamingReader("process.stdout.write('x'.repeat(1100000)+'\\ntake:after-clamp\\n')")
  t.after(() => r.stop())

  r.start()
  assert.equal(await readUntil(r), 'after-clamp')
})

// ── darwin disk reader ───────────────────────────────────────────────────────
// The reader itself spawns `iostat`, which exists only on a Mac, so what is under test here is the
// line parser it streams through — the since-boot skip is the whole of its behaviour.

test('createLiveIostatParser: the first data row is the since-boot average and is discarded', () => {
  const parse = createLiveIostatParser()

  assert.equal(parse('   24.50   12  0.29 '), null, 'the opening row averages since boot, not now')
  assert.deepEqual(parse('   30.00   20  1.50 '), { readMBps: 1.5, writeMBps: null, combined: true })
})

test('createLiveIostatParser: header rows do not consume the since-boot skip', () => {
  const parse = createLiveIostatParser()

  assert.equal(parse('              disk0 '), null)
  assert.equal(parse('    KB/t  tps  MB/s '), null)
  assert.equal(parse('   24.50   12  0.29 '), null, 'the skip still belongs to the first DATA row')
  assert.deepEqual(parse('   30.00   20  1.50 '), { readMBps: 1.5, writeMBps: null, combined: true })
})

test('pickDiskReader: picks the reader that matches the current platform', () => {
  const r = pickDiskReader()
  const expected =
    process.platform === 'win32'
      ? 'windows-disk'
      : process.platform === 'linux'
        ? 'linux-diskstats'
        : process.platform === 'darwin'
          ? 'darwin-iostat'
          : 'null'
  assert.equal(r.kind, expected)
  r.stop() // never started, so this must be a no-op regardless of platform
})

// The disk script's counter-path matching is English-substring based, and `Get-Counter`'s error
// stream is suppressed, so "what does it emit when nothing matches?" cannot be answered by
// reading the constant alone. These two run the real script body over synthetic counter samples,
// with only the `Get-Counter` source swapped out — no counters, no disks, no waiting.
const GET_COUNTER_SOURCE_LINE = 'Get-Counter -Counter $c -SampleInterval 1 -Continuous | ForEach-Object {'
const windowsOnly = process.platform === 'win32' ? false : 'PowerShell is Windows-only'

function emitDiskLineFor(samples: { path: string; bytesPerSec: number }[]): string {
  assert.ok(
    DISK_STREAM_PS.includes(GET_COUNTER_SOURCE_LINE),
    'DISK_STREAM_PS no longer contains the Get-Counter line this test substitutes',
  )
  const fakeSamples = samples
    .map((s) => `[pscustomobject]@{Path='${s.path}';CookedValue=${s.bytesPerSec}}`)
    .join(',')
  const script = DISK_STREAM_PS.replace(
    GET_COUNTER_SOURCE_LINE,
    `@([pscustomobject]@{CounterSamples=@(${fakeSamples})}) | ForEach-Object {`,
  )
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim()
}

test('DISK_STREAM_PS: counter paths it cannot match report no reading, not 0 MB/s', { skip: windowsOnly }, () => {
  const localized = emitDiskLineFor([
    { path: '\\physikalischer datentrger(_total)\\gelesene bytes/s', bytesPerSec: 4194304 },
    { path: '\\physikalischer datentrger(_total)\\geschriebene bytes/s', bytesPerSec: 2097152 },
  ])
  assert.equal(parseWindowsDiskSample(localized), null)
})

test('DISK_STREAM_PS: the English counter paths still stream a real reading', { skip: windowsOnly }, () => {
  const line = emitDiskLineFor([
    { path: '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec', bytesPerSec: 1048576 },
    { path: '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec', bytesPerSec: 524288 },
  ])
  const sample = parseWindowsDiskSample(line)
  assert.ok(sample)
  assert.ok(Math.abs(sample!.readMBps! - 1.048576) < 1e-9)
  assert.ok(Math.abs(sample!.writeMBps! - 0.524288) < 1e-9)
})

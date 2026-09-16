// Live hardware usage sampling (ADR-383). The I/O half of the monitor: picks ONE reader for the
// box, runs a 1 s loop while anyone is asking, and stops itself ~6 s after they stop.
//
// Why a self-stopping loop rather than a plain cached read: the vendor-neutral Windows path is
// only affordable as a long-lived stream. Measured on the dev box, `Get-Counter` costs 1208 ms
// (adapter memory) and 1884 ms (engine utilization, 507 instances) PER POLL, but streamed with
// `-Continuous` it delivers the first sample at ~1650 ms and then holds a ~1010 ms cadence. So
// the reader must be a process we keep, which means it must also be a process we release — hence
// the idle timer. A user who turns the status bar off costs this daemon nothing at all.
//
// Reader selection is FIRST MATCH, never a combination: an NVIDIA card beside an Intel iGPU uses
// nvidia-smi alone, because per ADR-306 the iGPU contributes nothing to the VRAM budget and there
// is no reason to also pay for the counter stream.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { getSysInfo, type SysInfo } from './sysinfo'
import {
  type CpuTimes,
  type DiskCounters,
  type DiskSample,
  type GpuSample,
  type HwUsage,
  cpuPctFromTimes,
  diskstatsRate,
  mergeUsage,
  parseAmdgpuSysfs,
  parseDiskstats,
  parseIoregAccelerator,
  parseMacIostat,
  parseNvidiaSmiUsage,
  parseRocmUsage,
  parseWddmSample,
  parseWindowsDiskSample,
  sumCpuTimes,
} from './usage-parse'

export type { HwUsage, HwGpuUsage, DiskSample } from './usage-parse'

/** How often the loop samples while someone is watching. */
const SAMPLE_MS = 1000
/** How long after the last request the loop keeps running before releasing its reader. Must
 *  comfortably exceed the UI's slowest poll (2 s) so ordinary polling never restarts the child. */
const IDLE_STOP_MS = 6000
/** Deliberately 2 s, not bench.ts's 8 s: a reader slower than the sample interval is useless. */
const READER_TIMEOUT_MS = 2000
const MAX_CONSECUTIVE_FAILURES = 3

/** One box's GPU usage source. `read()` MUST resolve — never reject — and returns null when it
 *  has nothing to report, which the merge turns into dashes rather than zeroes. */
export interface GpuReader {
  readonly kind: string
  start(): void
  read(): Promise<GpuSample[] | null>
  stop(): void
}

/** One box's disk I/O source (GitHub #211 follow-up). Same contract as {@link GpuReader}:
 *  `read()` MUST resolve — never reject — and null means "nothing to report" (no reader for
 *  this platform, or no second sample yet to rate against), which the UI renders as a dash. */
export interface DiskReader {
  readonly kind: string
  start(): void
  read(): Promise<DiskSample | null>
  stop(): void
}

// ── process helper ───────────────────────────────────────────────────────────

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(cmd, args, { timeout: READER_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout ?? ''))
      })
    } catch (e) {
      reject(e as Error)
    }
  })
}

/** Wrap a polled sampler with the failure latch. After {@link MAX_CONSECUTIVE_FAILURES} consecutive
 *  failures the reader goes permanently quiet for this process — without it, a box that simply has
 *  no rocm-smi would spawn a doomed process every second for as long as the daemon lives. Mirrors
 *  the latch in bench/spill.ts. A single success resets the count. */
export function createLatchingReader(
  kind: string,
  sample: () => Promise<GpuSample[] | null>,
  hooks: { start?: () => void; stop?: () => void } = {},
): GpuReader {
  let failures = 0
  let dead = false
  return {
    kind,
    start: () => hooks.start?.(),
    stop: () => hooks.stop?.(),
    read: async () => {
      if (dead) return null
      try {
        const r = await sample()
        if (r && r.length > 0) {
          failures = 0
          return r
        }
      } catch {
        /* fall through to the failure path — readers never surface errors upward */
      }
      if (++failures >= MAX_CONSECUTIVE_FAILURES) dead = true
      return null
    },
  }
}

/** Wrap a long-lived child that prints one sample per line. Deliberately NOT
 *  {@link createLatchingReader}: a streamed reader answers null throughout its warm-up, which the
 *  failure latch would read as three failures and switch the reader off before it ever spoke.
 *  Instead the only thing that retires this reader is the child's own `error` event — a command
 *  that cannot spawn will never spawn, so respawning it every second would be pure waste.
 *
 *  `parseLine` returns null for any line it does not recognise, and a null parse leaves the last
 *  good sample in place rather than erasing it. */
export function createStreamingReader<T>(
  kind: string,
  command: string,
  args: string[],
  parseLine: (line: string) => T | null,
): { kind: string; start(): void; read(): Promise<T | null>; stop(): void } {
  let child: ChildProcess | null = null
  let latest: T | null = null
  let buf = ''
  let dead = false

  return {
    kind,
    start() {
      if (child) return
      try {
        child = spawn(command, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        dead = true
        return
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk
        // Guard against a runaway buffer if the child ever emits without newlines.
        if (buf.length > 1_000_000) buf = buf.slice(-100_000)
        for (;;) {
          const nl = buf.indexOf('\n')
          if (nl < 0) break
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const parsed = parseLine(line)
          if (parsed !== null) latest = parsed
        }
      })
      // A child that dies (missing command, blocked execution policy, localized counter names)
      // latches this reader off rather than being respawned in a loop.
      child.on('error', () => {
        dead = true
        child = null
      })
      child.on('exit', () => {
        child = null
      })
    },
    // Returns null until the first sample lands (~1.65 s for the WDDM counter stream). That is
    // "not ready", not a failure — which is exactly why this reader is not wrapped in
    // createLatchingReader: the latch would trip during the normal warm-up.
    read: async () => (dead ? null : latest),
    stop() {
      try {
        child?.kill()
      } catch {
        /* already gone */
      }
      child = null
      latest = null
      buf = ''
    },
  }
}

// ── readers ──────────────────────────────────────────────────────────────────

function nvidiaReader(): GpuReader {
  // One query for utilization AND memory across every card: 64 ms measured, cheap enough to poll.
  return createLatchingReader('nvidia', async () =>
    parseNvidiaSmiUsage(
      await run('nvidia-smi', [
        '--query-gpu=index,name,utilization.gpu,memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ]),
    ),
  )
}

function ioregReader(): GpuReader {
  // `ioreg` needs no elevation; `powermetrics` — the other route to GPU utilization on macOS —
  // requires root and is therefore unusable from a user-launched daemon. UNVERIFIED on real
  // Apple hardware (ADR-383): it fails open to dashes if the key names differ.
  return createLatchingReader('ioreg', async () =>
    parseIoregAccelerator(await run('ioreg', ['-c', 'IOAccelerator', '-r', '-d', '1', '-w', '0'])),
  )
}

/** Read the amdgpu kernel driver's own counters straight out of sysfs. No spawn, no ROCm install —
 *  which matters because ROCm is absent on most consumer Radeon boxes (see `enumWindowsGpus`'s
 *  note on the same problem). Siblings of the files `linuxAmdgpuMem` already reads for capacity. */
function readAmdgpuCards() {
  const base = '/sys/class/drm'
  if (!existsSync(base)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(base).filter((n) => /^card\d+$/.test(n)).sort()
  } catch {
    return []
  }
  const rd = (dir: string, f: string): string | null => {
    try {
      return readFileSync(`${dir}/${f}`, 'utf8').trim()
    } catch {
      return null
    }
  }
  return entries
    .map((id) => {
      const dir = `${base}/${id}/device`
      return {
        id,
        name: id,
        vramUsed: rd(dir, 'mem_info_vram_used'),
        vramTotal: rd(dir, 'mem_info_vram_total'),
        gttUsed: rd(dir, 'mem_info_gtt_used'),
        busyPct: rd(dir, 'gpu_busy_percent'),
      }
    })
    .filter((c) => c.vramUsed !== null || c.busyPct !== null)
}

function amdReader(): GpuReader {
  return createLatchingReader('amd', async () => {
    const cards = readAmdgpuCards()
    if (cards.length > 0) return parseAmdgpuSysfs(cards)
    // sysfs said nothing (non-amdgpu driver, or a container without /sys) — try ROCm's tool.
    const mem = await run('rocm-smi', ['--showmeminfo', 'vram', '--json'])
    const use = await run('rocm-smi', ['--showuse', '--json']).catch(() => '{}')
    return parseRocmUsage(mem, use)
  })
}

/** Streams both WDDM memory counters and the per-engine utilization counter, aggregating inside
 *  PowerShell so we ship one small JSON line per second instead of ~500 counter rows. Utilization
 *  per adapter is the max across engine types of the sum over PIDs, which is how Task Manager
 *  presents "GPU %".
 *
 *  These counters are an OS facility, not a vendor one, so this single reader covers AMD, Intel
 *  and integrated adapters on Windows. Counter names are LOCALIZED, so this English path may not
 *  resolve on a non-English install — a safe failure: the child produces nothing, `read()` keeps
 *  returning null, and the GPU fields show dashes (ADR-349 hit this first). */
export const WDDM_STREAM_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$c=@('\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage','\\GPU Engine(*)\\Utilization Percentage')",
  'Get-Counter -Counter $c -SampleInterval 1 -Continuous | ForEach-Object {',
  '$ded=@{};$shr=@{};$eng=@{}',
  'foreach($s in $_.CounterSamples){',
  '$p=$s.Path.ToLower();$i=$s.InstanceName',
  "if($p -like '*dedicated usage*'){$ded[$i]=[double]$s.CookedValue}",
  "elseif($p -like '*shared usage*'){$shr[$i]=[double]$s.CookedValue}",
  "elseif($p -like '*utilization percentage*'){",
  "if($i -match 'luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\\d+).*engtype_(\\w+)'){",
  '$k="luid_$($Matches[1])_$($Matches[2])_phys_$($Matches[3])";$t=$Matches[4]',
  'if(-not $eng.ContainsKey($k)){$eng[$k]=@{}}',
  '$eng[$k][$t]=[double]$eng[$k][$t]+[double]$s.CookedValue}}}',
  '$utl=@{}',
  'foreach($k in $eng.Keys){$m=0.0;foreach($t in $eng[$k].Keys){if($eng[$k][$t] -gt $m){$m=$eng[$k][$t]}};$utl[$k]=[math]::Min(100,$m)}',
  '$keys=@($ded.Keys)+@($shr.Keys)+@($utl.Keys)|Select-Object -Unique',
  '$arr=@()',
  'foreach($k in $keys){$arr+=[pscustomobject]@{id=$k;dedicatedMb=[math]::Round([double]$ded[$k]/1MB,1);sharedMb=[math]::Round([double]$shr[$k]/1MB,1);utilPct=[math]::Round([double]$utl[$k],1)}}',
  'Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject @{adapters=@($arr)})',
  '}',
].join('\n')

function wddmReader(): GpuReader {
  return createStreamingReader(
    'wddm',
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', WDDM_STREAM_PS],
    (line) => {
      const parsed = parseWddmSample(line)
      return parsed.length > 0 ? parsed : null
    },
  )
}

function nullReader(): GpuReader {
  return { kind: 'null', start: () => {}, read: async () => null, stop: () => {} }
}

// ── disk I/O readers (GitHub #211 follow-up) ────────────────────────────────────

/** Streams the OS's own PhysicalDisk byte-rate counters, aggregated across every physical
 *  disk (`_Total`) — same spawn/parse-line shape as {@link wddmReader}, but far simpler:
 *  these two counters are already computed bytes/sec, so there is no per-adapter aggregation
 *  or manual rate math on this side, just JSON passthrough.
 *
 *  The counter NAMES are localized, exactly as in {@link WDDM_STREAM_PS}, and the substring match
 *  below is English. An unmatched path must therefore emit a null rather than the accumulator's
 *  seed value: with `$ErrorActionPreference` suppressing the error that would otherwise kill the
 *  child, a 0.0 seed would reach the UI as a confident "0.0 MB/s" on a busy disk. Nulls fail open
 *  to a hidden Disk I/O section via parseWindowsDiskSample's number guard (ADR-383). */
export const DISK_STREAM_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$c=@('\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec')",
  'Get-Counter -Counter $c -SampleInterval 1 -Continuous | ForEach-Object {',
  '$r=$null;$w=$null',
  'foreach($s in $_.CounterSamples){',
  '$p=$s.Path.ToLower()',
  "if($p -like '*read bytes*'){$r=[double]$s.CookedValue}",
  "elseif($p -like '*write bytes*'){$w=[double]$s.CookedValue}}",
  'Write-Output (ConvertTo-Json -Compress -InputObject @{readBps=$r;writeBps=$w})',
  '}',
].join('\n')

function windowsDiskReader(): DiskReader {
  return createStreamingReader(
    'windows-disk',
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', DISK_STREAM_PS],
    parseWindowsDiskSample,
  )
}

/** Reads /proc/diskstats directly — a plain sync file read, no spawn needed at all. Keeps the
 *  previous snapshot to rate against; the first tick after (re)start always reports null since
 *  there is nothing yet to diff. A read failure (no /proc, permission) latches the reader off
 *  for good: unlike a flaky vendor tool, a working /proc/diskstats never starts failing and
 *  then recovers, so retrying it every tick would be pure waste. */
function linuxDiskReader(): DiskReader {
  let prev: DiskCounters | null = null
  let prevAtMs = 0
  let dead = false
  return {
    kind: 'linux-diskstats',
    start() {
      prev = null
      prevAtMs = 0
      dead = false
    },
    read: async () => {
      if (dead) return null
      try {
        const cur = parseDiskstats(readFileSync('/proc/diskstats', 'utf8'))
        const now = Date.now()
        const rate = diskstatsRate(prev, prevAtMs, cur, now)
        prev = cur
        prevAtMs = now
        return rate
      } catch {
        dead = true
        return null
      }
    },
    stop() {
      prev = null
      prevAtMs = 0
    },
  }
}

/** A line parser over `iostat -d -w 1` output that answers only with LIVE samples: BSD iostat's
 *  first data row is an average since boot, not a measurement of now, so the first one is dropped.
 *  Header rows parse to null and do not consume that skip.
 *
 *  Exported as its own factory because the reader that streams it can only be exercised on a Mac;
 *  the since-boot skip is testable everywhere. */
export function createLiveIostatParser(): (line: string) => DiskSample | null {
  let seenFirstDataRow = false
  return (line) => {
    const sample = parseMacIostat(line)
    if (!sample) return null
    if (!seenFirstDataRow) {
      seenFirstDataRow = true
      return null
    }
    return sample
  }
}

/** macOS combined-throughput reader. Stock `iostat` has no read/write split, so this reports one
 *  number with `combined: true`. Streamed, not polled, because BSD iostat's first sample is a
 *  since-boot average — a one-shot call would either lie or cost a blocking second on the tick
 *  path. UNVERIFIED on real Apple hardware, exactly like ioregReader (ADR-383's known
 *  limitations): it fails open to a hidden section if the output shape differs. */
function darwinDiskReader(): DiskReader {
  return createStreamingReader('darwin-iostat', 'iostat', ['-d', '-w', '1'], createLiveIostatParser())
}

function nullDiskReader(): DiskReader {
  return { kind: 'null', start: () => {}, read: async () => null, stop: () => {} }
}

/** One reader per box, first match, never combined — Windows counters, Linux /proc/diskstats,
 *  macOS `iostat`. The darwin reader is COMBINED: stock `iostat` reports one un-split throughput
 *  figure per disk (no `-x`-style extended mode like Linux's), so its sample carries
 *  `combined: true` and a null `writeMBps` and the UI renders a single Throughput row rather than
 *  mislabelling a combined number as one side of a split. Anything else fails open to no reader. */
export function pickDiskReader(): DiskReader {
  if (process.platform === 'win32') return windowsDiskReader()
  if (process.platform === 'linux') return linuxDiskReader()
  if (process.platform === 'darwin') return darwinDiskReader()
  return nullDiskReader()
}

/** First match wins — readers are never combined. See the module header for why. */
export function pickReader(sys: SysInfo): GpuReader {
  const gpus = sys.gpus ?? []
  if (gpus.length === 0) return nullReader()
  // sysinfo.ts detects NVIDIA cards *via* nvidia-smi, so the presence of one here means the tool
  // is on PATH — no separate probe needed.
  if (gpus.some((g) => g.vendor === 'nvidia')) return nvidiaReader()
  if (process.platform === 'darwin') return ioregReader()
  if (process.platform === 'linux' && gpus.some((g) => g.vendor === 'amd')) return amdReader()
  if (process.platform === 'win32') return wddmReader()
  // Linux + Intel has no consistent reader across i915/xe. Fail open rather than guess.
  return nullReader()
}

// ── the loop ─────────────────────────────────────────────────────────────────

let reader: GpuReader | null = null
let injected: GpuReader | null = null
let diskReader: DiskReader | null = null
let injectedDisk: DiskReader | null = null
let timer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
let latest: HwUsage | null = null
let prevCpu: CpuTimes | null = null
let inFlight = false
let running = false

function startLoop(): void {
  if (running) return
  running = true
  prevCpu = null
  reader = injected ?? pickReader(getSysInfo())
  diskReader = injectedDisk ?? pickDiskReader()
  try {
    reader.start()
  } catch {
    /* a reader that cannot start just never reports */
  }
  try {
    diskReader.start()
  } catch {
    /* a reader that cannot start just never reports */
  }
  timer = setInterval(() => void tick(), SAMPLE_MS)
  timer.unref?.()
}

function armIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => stopUsageMonitor(), IDLE_STOP_MS)
  idleTimer.unref?.()
}

async function tick(): Promise<HwUsage> {
  // Single-flight: a reader slower than SAMPLE_MS must not have two reads in flight at once.
  if (inFlight && latest) return latest
  inFlight = true
  try {
    const cur = sumCpuTimes(os.cpus())
    const cpuPct = cpuPctFromTimes(prevCpu, cur)
    prevCpu = cur

    let samples: GpuSample[] | null = null
    try {
      samples = reader ? await reader.read() : null
    } catch {
      samples = null
    }

    let disk: DiskSample | null = null
    try {
      disk = diskReader ? await diskReader.read() : null
    } catch {
      disk = null
    }

    latest = {
      cpuPct,
      ram: {
        usedMb: Math.round((os.totalmem() - os.freemem()) / 1e6),
        totalMb: Math.round(os.totalmem() / 1e6),
      },
      gpus: mergeUsage(getSysInfo(), samples),
      disk,
      sampledAt: Date.now(),
    }
    return latest
  } finally {
    inFlight = false
  }
}

/** The API entry point: returns the freshest sample, starting the loop if it was idle and
 *  re-arming the idle stop. Awaits one tick when there is nothing cached yet, so the very first
 *  request still answers with real numbers rather than an empty body. */
export async function requestUsage(): Promise<HwUsage> {
  startLoop()
  armIdleStop()
  if (!latest) return tick()
  return latest
}

/** Stop sampling and release the reader (killing any child process). Idempotent. */
export function stopUsageMonitor(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (running) {
    try {
      reader?.stop()
    } catch {
      /* best effort */
    }
    try {
      diskReader?.stop()
    } catch {
      /* best effort */
    }
  }
  reader = null
  diskReader = null
  latest = null
  prevCpu = null
  running = false
}

// A streamed PowerShell child does not reliably die with its parent on Windows, so make sure the
// daemon never leaks one on the way out.
process.once('exit', () => stopUsageMonitor())

export function __setReaderForTests(r: GpuReader | null): void {
  injected = r
}

export function __setDiskReaderForTests(r: DiskReader | null): void {
  injectedDisk = r
}

export function __tickForTests(): Promise<HwUsage> {
  return tick()
}

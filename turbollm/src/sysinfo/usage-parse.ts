// Pure parsing + merge logic for live hardware usage (ADR-383). Deliberately I/O-free: nothing
// here spawns, reads a file, or touches `os` — `usage.ts` owns all of that and hands strings in.
// That split is what makes every vendor format testable without the vendor's hardware, which
// matters because this codebase can only physically test one of the five (see the ADR's
// "known limitations": macOS and non-NVIDIA Windows adapters are unverified on real hardware).
//
// The contract every parser here shares: never throw, and never invent a zero. A missing or
// unparseable reading is `null`, which the UI renders as an em dash. A 0 would be a lie —
// "this GPU is idle" reads very differently from "we could not measure this GPU".
import type { SysInfo } from './sysinfo'

/** One GPU as a READER sees it. `vramTotalMb` is nullable because Windows' WDDM counters expose
 *  usage without any capacity figure at all; {@link mergeUsage} fills that gap from `SysInfo`. */
export interface GpuSample {
  id: string
  name: string
  utilPct: number | null
  vramUsedMb: number | null
  vramTotalMb: number | null
  /** Host-backed ("shared"/GTT) GPU memory where the platform reports it. Null elsewhere. */
  vramSharedMb: number | null
}

/** One GPU as the API returns it: a reader sample reconciled against `SysInfo`, so `vramTotalMb`
 *  is always known and `unified` is always resolved. */
export interface HwGpuUsage {
  index: number
  name: string
  utilPct: number | null
  vramUsedMb: number | null
  vramTotalMb: number
  vramSharedMb: number | null
  /** True when `vramUsedMb` is a slice of system RAM rather than a second pool — an Apple Silicon
   *  Mac, an AMD APU, any iGPU. The UI MUST branch on this rather than on vendor: drawing RAM and
   *  VRAM as independent bars on a unified box double-counts the same bytes, which is exactly the
   *  class of bug ADR-306 / GitHub #164 already cost this codebase once. */
  unified: boolean
}

export interface HwUsage {
  cpuPct: number | null
  ram: { usedMb: number; totalMb: number }
  gpus: HwGpuUsage[]
  sampledAt: number
}

export interface CpuTimes {
  idle: number
  total: number
}

// ── CPU ──────────────────────────────────────────────────────────────────────

/** Collapse `os.cpus()` into one idle/total pair. Typed structurally rather than against
 *  `os.CpuInfo` so tests can hand in plain objects without importing `node:os`. */
export function sumCpuTimes(
  cpus: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[],
): CpuTimes {
  let idle = 0
  let total = 0
  for (const c of cpus) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** Busy percent over the interval between two samples of {@link sumCpuTimes}.
 *
 *  Null on the FIRST tick (no predecessor to difference against) and on a zero-length interval.
 *  Both matter: returning 0 instead would paint an idle CPU bar for one tick every time the
 *  monitor opens, which reads as a measurement rather than as the absence of one. */
export function cpuPctFromTimes(prev: CpuTimes | null, cur: CpuTimes): number | null {
  if (!prev) return null
  const totalDelta = cur.total - prev.total
  if (totalDelta <= 0) return null
  const idleDelta = cur.idle - prev.idle
  const pct = 100 * (1 - idleDelta / totalDelta)
  // Counters can glitch backwards across suspend/resume, which sends the naive formula past 100
  // (or below 0). Clamp rather than render an over-full bar.
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse a decimal that may legitimately be absent. Returns null for `[N/A]`, empty, or NaN —
 *  never 0, per this module's no-invented-zero rule. A real "0" parses to 0 as it should. */
function num(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s || s === '[N/A]' || s === 'N/A') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/** Bytes to MB (decimal, matching `sysinfo.ts`'s `/ 1e6` convention), preserving null. */
function bytesToMb(raw: string | null | undefined): number | null {
  const v = num(raw)
  return v === null ? null : Math.round(v / 1e6)
}

// ── nvidia-smi ───────────────────────────────────────────────────────────────

/** Parse `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total
 *  --format=csv,noheader,nounits`. One line per card, e.g.
 *  `0, NVIDIA GeForce RTX 5070 Ti, 99, 5922, 16303`.
 *
 *  This single call replaces the pair of narrower readers auto-tune uses (`readNvidiaVramMb` in
 *  bench.ts reads memory only), which is why the monitor costs one 64 ms spawn per sample rather
 *  than two. */
export function parseNvidiaSmiUsage(csv: string): GpuSample[] {
  const out: GpuSample[] = []
  for (const line of csv.split('\n')) {
    const parts = line.split(',')
    if (parts.length < 5) continue
    const id = (parts[0] ?? '').trim()
    const name = (parts[1] ?? '').trim()
    if (!id || !name) continue
    out.push({
      id,
      name,
      utilPct: num(parts[2]),
      vramUsedMb: num(parts[3]),
      vramTotalMb: num(parts[4]),
      vramSharedMb: null,
    })
  }
  return out
}

// ── Windows WDDM performance counters ────────────────────────────────────────

/** Parse one JSON line emitted by our own streaming PowerShell reader (see `WDDM_STREAM_PS` in
 *  usage.ts). We control the shape, so this is a plain JSON decode rather than counter-text
 *  scraping — the aggregation across the hundreds of per-PID `GPU Engine` instances happens in
 *  PowerShell, where the data already lives, instead of shipping 507 rows per second over a pipe.
 *
 *  These counters are the ONLY vendor-neutral usage source on Windows, which is what makes AMD,
 *  Intel and iGPU boxes work at all. Measured against nvidia-smi on the same adapter at the same
 *  moment: 5926.8 MB vs 5922 MiB. */
export function parseWddmSample(jsonLine: string): GpuSample[] {
  try {
    const parsed = JSON.parse(jsonLine) as { adapters?: unknown }
    const adapters = parsed?.adapters
    if (!Array.isArray(adapters)) return []
    return adapters
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map((a) => ({
        id: String(a.id ?? ''),
        name: String(a.id ?? ''),
        utilPct: num(a.utilPct as string),
        vramUsedMb: num(a.dedicatedMb as string),
        // WDDM reports no capacity at all — mergeUsage fills it from SysInfo.
        vramTotalMb: null,
        vramSharedMb: num(a.sharedMb as string),
      }))
      .filter((g) => g.id !== '')
  } catch {
    return []
  }
}

// ── ROCm ─────────────────────────────────────────────────────────────────────

/** Parse `rocm-smi --showmeminfo vram --json` joined with `rocm-smi --showuse --json`, both keyed
 *  by `card0`, `card1`, … Mirrors `parseRocmSmi` / `parseRocmVramUsed` elsewhere in the codebase,
 *  reading the used figure alongside the total.
 *
 *  Memory output is the authority for WHICH cards exist: rocm-smi's subcommands can disagree, and
 *  a card missing from the utilization output gets a null reading rather than being dropped. */
export function parseRocmUsage(memJson: string, useJson: string): GpuSample[] {
  let mem: Record<string, Record<string, string>>
  try {
    mem = JSON.parse(memJson) as Record<string, Record<string, string>>
  } catch {
    return []
  }
  let use: Record<string, Record<string, string>> = {}
  try {
    use = JSON.parse(useJson) as Record<string, Record<string, string>>
  } catch {
    /* utilization is optional — memory alone is still worth reporting */
  }
  if (!mem || typeof mem !== 'object') return []

  const out: GpuSample[] = []
  for (const [card, fields] of Object.entries(mem)) {
    if (!fields || typeof fields !== 'object') continue
    const usedKey = Object.keys(fields).find((k) => /VRAM Total Used Memory/i.test(k))
    const totalKey = Object.keys(fields).find((k) => /VRAM Total Memory/i.test(k))
    const useFields = use?.[card] ?? {}
    const useKey = Object.keys(useFields).find((k) => /GPU use/i.test(k))
    out.push({
      id: card,
      name: card,
      utilPct: useKey ? num(useFields[useKey]) : null,
      vramUsedMb: usedKey ? bytesToMb(fields[usedKey]) : null,
      vramTotalMb: totalKey ? bytesToMb(fields[totalKey]) : null,
      vramSharedMb: null,
    })
  }
  return out
}

// ── Linux amdgpu sysfs ───────────────────────────────────────────────────────

/** Convert raw amdgpu sysfs strings into samples. The caller reads
 *  `/sys/class/drm/card*​/device/{mem_info_vram_used,mem_info_vram_total,mem_info_gtt_used,
 *  gpu_busy_percent}` — plain file reads, so this path costs no process spawn at all and works
 *  with no ROCm installed, which is the common case on consumer Radeon hardware.
 *
 *  `gpu_busy_percent` is absent on older kernels; that is a null reading, not an idle GPU. */
export function parseAmdgpuSysfs(
  cards: {
    id: string
    name: string
    vramUsed: string | null
    vramTotal: string | null
    gttUsed: string | null
    busyPct: string | null
  }[],
): GpuSample[] {
  return cards.map((c) => ({
    id: c.id,
    name: c.name,
    utilPct: num(c.busyPct),
    vramUsedMb: bytesToMb(c.vramUsed),
    vramTotalMb: bytesToMb(c.vramTotal),
    vramSharedMb: bytesToMb(c.gttUsed),
  }))
}

// ── macOS ioreg ──────────────────────────────────────────────────────────────

/** Parse `ioreg -c IOAccelerator -r -d 1 -w 0` for the accelerator's `PerformanceStatistics`.
 *
 *  `ioreg` is chosen because it needs no elevation; `powermetrics`, the other route to GPU
 *  utilization on macOS, requires root and is therefore unusable from a user-launched daemon.
 *
 *  UNVERIFIED on real hardware — ADR-383 records this as an explicit follow-up. Written against
 *  the documented key names, and returns [] (a dash in the UI) rather than guessing if they do
 *  not appear, so an Apple box degrades to CPU+RAM instead of showing something invented. */
export function parseIoregAccelerator(text: string): GpuSample[] {
  const out: GpuSample[] = []
  const utilRe = /"Device Utilization %"\s*=\s*(\d+)/g
  const memRe = /"In use system memory"\s*=\s*(\d+)/g
  const utils: (number | null)[] = []
  const mems: (number | null)[] = []
  for (const m of text.matchAll(utilRe)) utils.push(num(m[1]))
  for (const m of text.matchAll(memRe)) mems.push(bytesToMb(m[1]))
  const count = Math.max(utils.length, mems.length)
  for (let i = 0; i < count; i++) {
    out.push({
      id: `accelerator${i}`,
      name: `accelerator${i}`,
      utilPct: utils[i] ?? null,
      // On unified memory this IS the GPU's share of system RAM, not a separate pool.
      vramUsedMb: mems[i] ?? null,
      vramTotalMb: null,
      vramSharedMb: null,
    })
  }
  return out
}

// ── merge ────────────────────────────────────────────────────────────────────

/** Reconcile a reader's samples against `SysInfo`, which is the source of truth for capacity and
 *  for the unified-memory flag.
 *
 *  Matching is by name first and position second, with each `SysInfo` GPU claimable only once —
 *  that last part is what keeps a dual-identical-card box (2x Tesla T4) from assigning both
 *  samples to card 0. When the reader is unavailable entirely, the cards are still described with
 *  null usage, so the UI shows the hardware with dashes rather than pretending it vanished. */
/** Narrow a reader's adapter list down to the cards `SysInfo` says actually exist.
 *
 *  Windows needs this: the WDDM counters enumerate every adapter the OS knows about, including
 *  software and virtual ones. Measured on the dev box, the counters reported THREE adapters where
 *  `SysInfo` knows one — a real card at 12296.8 MB, a render-only adapter at 0, and a third
 *  holding 1.5 GB of shared memory. Zipped naively, an AMD or Intel user would see two phantom
 *  GPUs with zero capacity in the status bar (ADR-239: no dead UI).
 *
 *  `SysInfo` is the authority on which GPUs exist, so when a reader over-reports we keep the
 *  cards that match by name, and otherwise the ones actually holding memory — a software adapter
 *  holds none. Under-reporting is left alone; the merge pads it from `SysInfo`. */
function selectSamples(sysGpus: SysInfo['gpus'], samples: GpuSample[]): GpuSample[] {
  if (sysGpus.length === 0 || samples.length <= sysGpus.length) return samples
  const names = new Set(sysGpus.map((g) => g.name.trim().toLowerCase()))
  const named = samples.filter((s) => names.has(s.name.trim().toLowerCase()))
  if (named.length > 0 && named.length <= sysGpus.length) return named
  const held = (s: GpuSample) => (s.vramUsedMb ?? 0) + (s.vramSharedMb ?? 0)
  return [...samples].sort((a, b) => held(b) - held(a)).slice(0, sysGpus.length)
}

export function mergeUsage(sys: SysInfo, samples: GpuSample[] | null): HwGpuUsage[] {
  const sysGpus = sys.gpus ?? []
  if (!samples || samples.length === 0) {
    return sysGpus.map((g, i) => ({
      index: i,
      name: g.name,
      utilPct: null,
      vramUsedMb: null,
      vramTotalMb: g.vramMb,
      vramSharedMb: null,
      unified: g.unified === true,
    }))
  }

  const selected = selectSamples(sysGpus, samples)
  const claimed = new Set<number>()
  const claim = (sample: GpuSample, i: number): SysInfo['gpus'][number] | undefined => {
    const wanted = sample.name.trim().toLowerCase()
    const byName = sysGpus.findIndex((g, gi) => !claimed.has(gi) && g.name.trim().toLowerCase() === wanted)
    const idx = byName >= 0 ? byName : !claimed.has(i) && i < sysGpus.length ? i : -1
    if (idx < 0) return undefined
    claimed.add(idx)
    return sysGpus[idx]
  }

  return selected.map((s, i) => {
    const match = claim(s, i)
    return {
      index: i,
      // Prefer the SysInfo name: a WDDM sample's "name" is a raw adapter LUID, which is useless
      // in a status bar. The reader's own name is the fallback when nothing matched.
      name: match?.name ?? s.name,
      utilPct: s.utilPct,
      vramUsedMb: s.vramUsedMb,
      vramTotalMb: s.vramTotalMb ?? match?.vramMb ?? 0,
      vramSharedMb: s.vramSharedMb,
      unified: match?.unified === true,
    }
  })
}

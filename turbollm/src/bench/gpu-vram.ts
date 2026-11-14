// What each GPU's memory holds right now (nvidia-smi / rocm-smi). Its own module, so the gateway reads it without
// loading the benchmark module (bench.ts re-exports these for its callers).
import { tetheredExecFile } from '../util/tether'
import type { SysInfo } from '../sysinfo/sysinfo'

// The GPU memory probes below run around every benchmark load and pool-slot load, tied to the daemon (util/tether.ts):
// their timeouts are daemon timers, so a probe hung on a wedged driver outlived a daemon that died meanwhile.
const probeExecFile = tetheredExecFile({ kind: 'probe' })

/** Pure parser for `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits`: one MB figure per GPU, in
 *  the same order sysinfo enumerated them from the same tool (an unreadable one as 0). */
export function parseNvidiaVramPerCard(stdout: string): number[] {
  return stdout
    .trim()
    .split('\n')
    .map((l) => parseInt(l.trim(), 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

/** Best-effort current NVIDIA VRAM use in MB, per GPU. Null on non-NVIDIA or when nvidia-smi is
 *  absent — never throws (spec 09 §1). */
function readNvidiaVramPerCardMb(): Promise<number[] | null> {
  return probeExecFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeout: 8000, windowsHide: true })
    .then(({ stdout }) => (stdout ? parseNvidiaVramPerCard(stdout) : null), () => null)
}

/** Pure parser for `rocm-smi --showmeminfo vram --json` output, split out for direct testing
 *  (mirrors `sysinfo.ts`'s `parseRocmSmi`): each card's "VRAM Total Used Memory (B)" in MB (a card
 *  without it as 0). Null on unparseable JSON. */
export function parseRocmVramPerCard(memJson: string): number[] | null {
  try {
    const mem = JSON.parse(memJson) as Record<string, Record<string, string>>
    const perCard: number[] = []
    for (const fields of Object.values(mem)) {
      const usedKey = Object.keys(fields).find((k) => /VRAM Total Used Memory/i.test(k))
      const bytes = usedKey ? parseInt(String(fields[usedKey]).trim(), 10) || 0 : 0
      perCard.push(bytes / 1e6)
    }
    return perCard
  } catch {
    return null
  }
}

/** Best-effort current AMD VRAM use in MB, per card, via ROCm's rocm-smi. Null when
 *  rocm-smi is absent (ROCm not installed) or its output can't be parsed — never throws.
 *  Mirrors `sysinfo.ts`'s `parseRocmSmi` (same `--showmeminfo vram --json` call), reading
 *  "VRAM Total Used Memory (B)" instead of "VRAM Total Memory (B)" (ADR-217: before this, the
 *  headroom gate had zero VRAM protection on AMD — nvidia-smi's reading silently came back
 *  null on every AMD box and {@link overHeadroom} treats unknown VRAM as "never over"). */
function readRocmVramPerCardMb(): Promise<number[] | null> {
  return probeExecFile('rocm-smi', ['--showmeminfo', 'vram', '--json'], { timeout: 8000, windowsHide: true })
    .then(({ stdout }) => (stdout ? parseRocmVramPerCard(stdout) : null), () => null)
}

/** Best-effort current GPU VRAM use in MB per card, in sysinfo's order, vendor-aware (ADR-217).
 *  Tries nvidia-smi first (unconditionally — cheap to attempt, and correct even without `sys`),
 *  then falls back to rocm-smi only when the box has a known AMD GPU. Null when neither reads a
 *  positive figure (Intel/Apple/CPU-only, or no live VRAM reader for that vendor). Never throws. */
export async function readGpuVramPerCardMb(sys: SysInfo): Promise<number[] | null> {
  const nv = await readNvidiaVramPerCardMb()
  if (nv !== null && nv.some((n) => n > 0)) return nv
  if (!sys.gpus.some((g) => g.vendor === 'amd')) return null
  const amd = await readRocmVramPerCardMb()
  return amd !== null && amd.some((n) => n > 0) ? amd : null
}

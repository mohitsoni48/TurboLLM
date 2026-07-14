// Client-side mirror of the daemon's VRAM estimate (spec 05 §6) so the load
// form can show a live fit as the user drags sliders. Deterministic math — the
// only number we show pre-run, always labeled an estimate (ADR-012).
import type { FitVerdict, LoadProfile, ModelEntry, SysGpu } from './types'

const HEAD_DIM = 128

/** Mirror of the daemon's `gpuBudgetMb` (ADR-054): a layer/row split (and the default)
 *  spans all GPUs; 'none' restricts to one. Single-GPU is unaffected (sum = that GPU). */
export function gpuBudgetMb(gpus: SysGpu[], gpu?: LoadProfile['gpu']): number {
  if (!gpus.length) return 0
  if (gpu?.splitMode === 'none') {
    const idx = gpu.mainGpu >= 0 ? gpu.mainGpu : 0
    return gpus[idx]?.vramMb ?? gpus[0]?.vramMb ?? 0
  }
  return gpus.reduce((sum, g) => sum + (g.vramMb || 0), 0)
}

const VENDOR_RANK: Record<string, number> = { nvidia: 4, amd: 3, apple: 3, intel: 2, unknown: 1 }

type VendorGpu = { name: string; vramMb: number; vendor: string }

/** Mirror of the daemon's `detectHardware` primary-vendor VRAM sum (`turbollm/src/engines/
 *  hardware.ts`) for use as the raw-sysinfo fallback on the Engines screen: before the
 *  `/recommendation` query resolves (or if it errors, since that query never retries), the
 *  hero must not regress to a single un-summed card's VRAM on a multi-GPU box. */
export function primaryVendorSummary(gpus: VendorGpu[]): { gpuName: string | null; vramMb: number; count: number } {
  if (!gpus.length) return { gpuName: null, vramMb: 0, count: 0 }
  let vendor = 'unknown'
  for (const g of gpus) if ((VENDOR_RANK[g.vendor] ?? 1) > (VENDOR_RANK[vendor] ?? 1)) vendor = g.vendor
  const ofVendor = gpus.filter((g) => g.vendor === vendor)
  const pool = ofVendor.length ? ofVendor : gpus
  const headline = pool.reduce<VendorGpu | undefined>((best, g) => (!best || g.vramMb > best.vramMb ? g : best), undefined)
  const vramMb = ofVendor.reduce((sum, g) => sum + g.vramMb, 0)
  return { gpuName: headline?.name ?? null, vramMb, count: pool.length }
}

function kvBytesPerElem(t: string): number {
  switch (t) {
    case 'f16': return 2
    case 'q8_0': case 'q8_1': return 1
    case 'q5_0': case 'q5_1': return 0.625
    case 'q4_0': case 'q4_1': case 'turbo4': return 0.5
    case 'turbo3': return 0.375
    case 'turbo2': return 0.25
    default: return 2
  }
}

export function estimateVram(
  p: LoadProfile,
  m: ModelEntry,
  totalVramMb: number,
): { estMb: number; totalVramMb: number; pct: number; verdict: FitVerdict } {
  if (!totalVramMb) return { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'cpu' }
  const sizeMb = m.sizeBytes / 1e6
  const blocks = m.blockCount || 1
  const gpuFrac = m.moe ? 1 - 0.85 * (p.nCpuMoe / blocks) : Math.min(p.ngl, blocks) / blocks
  const weightsMb = sizeMb * Math.max(0, Math.min(1, gpuFrac))
  const kvElems = 2 * blocks * p.ctx * (m.headCountKv || 8) * HEAD_DIM
  // KV cache only weighs on VRAM when offloaded to the GPU; in RAM mode (--no-kv-offload) it
  // costs no VRAM. Absent on pre-feature profiles → treated as the GPU default.
  const kvMb = p.kvOffload === false
    ? 0
    : ((kvElems * kvBytesPerElem(p.kvTypeK)) / 1e6) * (p.kvUnified ? 1 : Math.max(1, p.parallel))
  const mmprojMb = p.useMmproj && p.mmprojGpu && m.mmprojPath ? 600 : 0
  const estMb = Math.round(weightsMb + kvMb + 800 + mmprojMb)
  const pct = estMb / totalVramMb
  const verdict: FitVerdict = pct <= 0.8 ? 'fits' : pct <= 0.95 ? 'tight' : 'overflow'
  return { estMb, totalVramMb, pct, verdict }
}

// Hardware sensing in registry terms (engine overhaul, Phase 1). The ONE place
// the engine registry asks "what hardware is this?" — a thin composition over
// sysinfo (getSysInfo / primaryVendor) that flattens the multi-GPU SysInfo into
// the single profile the variant matcher (compat.evaluateVariant) and the
// recommender (recommend.recommendEngines) reason over. Pure aside from the
// default getSysInfo() call: pass `info` to inject a fake in tests.
import { type GpuVendor, type SysInfo, getSysInfo, primaryVendor } from '../sysinfo/sysinfo'

export type Arch = 'x64' | 'arm64'

export interface HardwareProfile {
  platform: NodeJS.Platform
  arch: Arch
  gpuVendor: GpuVendor // primaryVendor()
  hasGpu: boolean // gpuVendor !== 'unknown' && gpus.length > 0
  vramMb: number // sum of vramMb across gpus, 0 if none
  gpuName?: string // name of the highest-ranked gpu
  /** True when EVERY GPU that contributed to `vramMb` shares system RAM (`GpuInfo.unified`,
   *  ADR-306) — an iGPU-only laptop, an AMD APU box (Strix Halo, GitHub #85), an Apple Silicon
   *  Mac. It says `vramMb` is NOT a second pool: it is a slice of the same `SysInfo.ramMB` the
   *  CPU side is drawing from, so a consumer must not spend both budgets independently.
   *
   *  This is the missing half of ADR-306. That entry dropped unified adapters from the sum "as
   *  soon as the same vendor also has a real card" — correct, but it leaves the iGPU-ONLY box
   *  (no discrete card, so nothing to exclude against) reporting a system-RAM-derived `vramMb`
   *  with no signal that it overlaps RAM. Downstream fit checks then green-lit a plan whose
   *  GPU-resident + CPU-resident halves together exceeded the box's total memory (GitHub #164).
   *  ADR-189's iGPU heuristic and #85's raised APU budget both stay exactly as they are; this
   *  only tells callers the two budgets are one pool. False on a CPU-only box (`length > 0`
   *  guard: `[].every()` is `true`) and false whenever a real card is what's being summed. */
  unifiedMemory: boolean
}

export function detectHardware(info: SysInfo = getSysInfo()): HardwareProfile {
  const arch: Arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const gpuVendor = primaryVendor(info)
  const hasGpu = gpuVendor !== 'unknown' && info.gpus.length > 0
  // The headline GPU: prefer one matching the primary vendor (the dGPU that
  // drives backend selection), else fall back to the card with the most VRAM.
  const allOfVendor = info.gpus.filter((g) => g.vendor === gpuVendor)
  // Drop shared-memory GPUs (an APU/iGPU whose "VRAM" is a slice of system RAM) as soon as the
  // same vendor also has a real card. Those two budgets are not two pools — the iGPU's share is
  // the same RAM the box already has — so summing them double-counts it. Left unguarded, an AMD
  // APU (16 GB of GTT) next to an RX 7600M XT (8 GB) reported 24.7 GB and the fit check would
  // green-light a ~24 GB model onto an 8 GB card. Same shape on Windows for an Intel iGPU beside
  // an Intel Arc dGPU. Matches ADR-189's rule that an iGPU only counts when it's the only GPU.
  // ADR-306.
  const ofVendor = allOfVendor.some((g) => !g.unified) ? allOfVendor.filter((g) => !g.unified) : allOfVendor
  const pool = ofVendor.length ? ofVendor : info.gpus
  const headline = pool.reduce<(typeof pool)[number] | undefined>(
    (best, g) => (!best || g.vramMb > best.vramMb ? g : best),
    undefined,
  )
  // Sum VRAM across GPUs of the PRIMARY vendor only: a multi-GPU box (e.g. 2× RTX
  // 5060 Ti 16GB) pools its VRAM for inference, so the fit budget is the total, not
  // the largest card — but a non-primary-vendor GPU (an Intel iGPU alongside an
  // NVIDIA/AMD dGPU is common) isn't usable for offload, so it must not inflate the
  // budget. `ofVendor` is empty only when there's no GPU at all (vramMb correctly 0).
  const vramMb = ofVendor.reduce((sum, g) => sum + g.vramMb, 0)
  // Computed over `ofVendor` — the adapters actually SUMMED above — not over `info.gpus`, so it
  // answers the only question a fit check cares about: "is `vramMb` a slice of `ramMB`?". An
  // Intel iGPU sitting beside an NVIDIA dGPU is therefore NOT unified here (the iGPU contributed
  // nothing to `vramMb`), which is what distinguishes this from `unifiedMemoryOnly()` in
  // sysinfo.ts. GitHub #164.
  const unifiedMemory = ofVendor.length > 0 && ofVendor.every((g) => g.unified === true)
  return {
    platform: process.platform,
    arch,
    gpuVendor,
    hasGpu,
    vramMb,
    gpuName: headline?.name,
    unifiedMemory,
  }
}

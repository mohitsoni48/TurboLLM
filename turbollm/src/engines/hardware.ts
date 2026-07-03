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
}

export function detectHardware(info: SysInfo = getSysInfo()): HardwareProfile {
  const arch: Arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const gpuVendor = primaryVendor(info)
  const hasGpu = gpuVendor !== 'unknown' && info.gpus.length > 0
  // The headline GPU: prefer one matching the primary vendor (the dGPU that
  // drives backend selection), else fall back to the card with the most VRAM.
  const ofVendor = info.gpus.filter((g) => g.vendor === gpuVendor)
  const pool = ofVendor.length ? ofVendor : info.gpus
  const headline = pool.reduce<(typeof pool)[number] | undefined>(
    (best, g) => (!best || g.vramMb > best.vramMb ? g : best),
    undefined,
  )
  // Sum VRAM across all GPUs: a multi-GPU box (e.g. 2× RTX 5060 Ti 16GB) pools
  // its VRAM for inference, so the fit budget is the total, not the largest card.
  const vramMb = info.gpus.reduce((sum, g) => sum + g.vramMb, 0)
  return {
    platform: process.platform,
    arch,
    gpuVendor,
    hasGpu,
    vramMb,
    gpuName: headline?.name,
  }
}

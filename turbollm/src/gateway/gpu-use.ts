// The cards' current use for a pool-slot load's placement (ModelRouter.placeOnFreeVram, scalability review 4.7).
import type { Engine } from '../config/config'
import { numbersCardsAsListed } from '../engines/card-numbering'
import { readGpuVramPerCardMb } from '../bench/gpu-vram'
import { getSysInfo, type SysInfo } from '../sysinfo/sysinfo'

/** Each card's current VRAM use (MB, in sysinfo's order) beside the hardware it was read for. */
export interface GpuUse { sys: SysInfo; usedMb: number[] }

/** Longest a load waits for the cards' use (nvidia-smi / rocm-smi each allow 8 s): past it the load goes ahead as it
 *  did before the reading existed. */
const GPU_USE_READ_TIMEOUT_MS = 3000

/** How long a reading is reused. Loads queue under the swap lock and each would otherwise run nvidia-smi; a card's use
 *  moves by a model load (seconds to minutes), and the load that just finished asks for a fresh reading. */
const GPU_USE_CACHE_MS = 2000

interface GpuUseDeps {
  sys: () => SysInfo
  readCards: (sys: SysInfo) => Promise<number[] | null>
  env: NodeJS.ProcessEnv
  now: () => number
}

/** A reader of the cards' use for `engine`: null where the reading cannot place a load. Placement names a card by
 *  `--main-gpu N`, and the readers list cards in PCI order, so it is trusted only where the engine numbers them alike
 *  (numbersCardsAsListed: one card model, a CUDA/ROCm build, no device-selection variable); on any other box nothing is
 *  read. Also null: no GPU, a reader that fails or is silent past the timeout. `fresh` skips the cached reading. Never
 *  throws. Deps are a parameter only so a test can fake the box and the clock. */
export function createGpuUseReader(deps: Partial<GpuUseDeps> = {}): (engine: Engine, buildRoot: string, fresh?: boolean) => Promise<GpuUse | null> {
  const { sys: getSys, readCards, env, now }: GpuUseDeps = { sys: getSysInfo, readCards: readGpuVramPerCardMb, env: process.env, now: Date.now, ...deps }
  let cached: { at: number; use: GpuUse | null } | undefined
  return async (engine, buildRoot, fresh = false) => {
    const sys = getSys()
    if (sys.gpus.length === 0 || !numbersCardsAsListed(sys, engine, env, buildRoot)) return null
    if (!fresh && cached && now() - cached.at < GPU_USE_CACHE_MS) return cached.use
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), GPU_USE_READ_TIMEOUT_MS); timer.unref() })
    try {
      const usedMb = await Promise.race([readCards(sys).catch(() => null), timeout])
      const use = usedMb ? { sys, usedMb } : null
      cached = { at: now(), use }
      return use
    } finally {
      clearTimeout(timer)
    }
  }
}

export const readGpuUse = createGpuUseReader()

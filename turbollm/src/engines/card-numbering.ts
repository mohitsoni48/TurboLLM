// Whether an engine's device numbers are the readers' card numbers (nvidia-smi, rocm-smi, sysinfo). Shared by the
// benchmark (which card a single-GPU load grew) and the gateway (placing a default profile on the card with room).
import type { Engine } from '../config/config'
import type { SysInfo } from '../sysinfo/sysinfo'
import { isEngineInBuildDir } from './build-runner'
import { backendIdFromBinPath } from './update'

/** The variables that renumber the cards a CUDA or ROCm engine sees, which nvidia-smi and rocm-smi ignore (HIP takes
 *  GPU_DEVICE_ORDINAL as well). */
const DEVICE_SELECTION_VARS = ['CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'GPU_DEVICE_ORDINAL']

/** Whether the engine's `--main-gpu N` is card N of the readers' lists (nvidia-smi's and rocm-smi's, in PCI bus
 *  order, as sysinfo's). A CUDA build numbers the fastest card first (CUDA_DEVICE_ORDER's default, FASTEST_FIRST), so
 *  on a box of two models its card 0 can be the listing's card 1; a Vulkan build numbers them in the Vulkan loader's
 *  order, which puts the GPU driving the display first (Mesa's device-select layer, Windows' adapter order) even among
 *  cards of one model; and the variables above renumber them. Card N of the listing was then another card than the
 *  engine's, and its reading too low, so card N is read as the engine's only where the two orders are very unlikely
 *  to differ: a CUDA or ROCm build on cards all of one model (FASTEST_FIRST leaves the order of equal cards
 *  unspecified, PCI order in practice), with none of those variables set. Elsewhere the card a load grows is taken
 *  as its own (BenchRunner.readLoadVram). The build is known by an official install's directory, or as one
 *  TurboLLM compiled, which is CUDA: inside `buildRoot`, the folder its builds go to (`<data dir>/engines/build`, as
 *  build-runner.ts places them), and with the source it was built from, not a release install there. A sourceRepo
 *  alone proves nothing: any engine can be given one (registry.setSource), and an `engines/build` folder of another
 *  project is not TurboLLM's. */
export function numbersCardsAsListed(
  sys: SysInfo, engine: Pick<Engine, 'binPath' | 'sourceRepo' | 'release'> | undefined, env: NodeJS.ProcessEnv, buildRoot: string | undefined,
): boolean {
  const [first] = sys.gpus
  if (sys.gpus.some((g) => g.name !== first.name || g.vramMb !== first.vramMb)) return false
  if (DEVICE_SELECTION_VARS.some((v) => env[v] !== undefined)) return false
  const builtHere = !!buildRoot && !!engine?.sourceRepo && !engine.release && isEngineInBuildDir(engine.binPath, buildRoot)
  const backend = backendIdFromBinPath(engine?.binPath ?? '') || (builtHere ? 'cuda' : '')
  return backend === 'cuda' || backend === 'rocm'
}

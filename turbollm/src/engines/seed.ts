// Auto-provision a default engine on first run (ADR-024 + ADR-025). Detects the
// GPU vendor, downloads the fastest llama.cpp backend it supports, and registers
// it — trying the recommended backend, then Vulkan, then CPU if one won't probe.
// No-ops if any engine is already configured. Never throws.
import type { Registry } from './registry'
import type { ProvisionState } from './provision-state'
import { getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { LLAMA_BUILD, fallbackChain, provisionBackend, recommendBackendId, type BackendId, type ProvisionProgress } from './download'

const VALID_BACKENDS: BackendId[] = ['cuda', 'rocm', 'sycl', 'vulkan', 'metal', 'cpu']

export async function seedDefaultEngines(
  registry: Registry,
  enginesRoot: string,
  provision: ProvisionState,
): Promise<void> {
  if (registry.list().engines.length > 0) return

  const tag = LLAMA_BUILD
  const sys = getSysInfo()
  const vendor = primaryVendor(sys)
  const hasGpu = sys.gpus.length > 0

  // Escape hatch for environments where live GPU detection can't see the real
  // target hardware — the main case is pre-baking a Docker image at build time
  // (deploy/runpod/Dockerfile): `docker build` never has GPU passthrough, so
  // detection always reports "no GPU" and would otherwise always pre-bake the
  // CPU backend even for an image explicitly built for an NVIDIA GPU box.
  const forced = process.env.TURBOLLM_SEED_BACKEND as BackendId | undefined

  let chain
  try {
    const recommended = forced && VALID_BACKENDS.includes(forced) ? forced : recommendBackendId(vendor, hasGpu, tag)
    chain = fallbackChain(recommended, tag)
    if (forced) {
      console.log(`seed: TURBOLLM_SEED_BACKEND=${forced} → backend ${recommended} (skipping live GPU detection)`)
    } else {
      console.log(`seed: detected GPU vendor=${vendor} (${sys.gpus.map((g) => g.name).join(', ') || 'none'}) → backend ${recommended}`)
    }
  } catch (e) {
    console.warn(`seed: ${e instanceof Error ? e.message : e}`)
    return
  }

  const onProgress = (id: string) => (p: ProvisionProgress) => {
    provision.progress(p.phase, p.pct, p.part, p.parts)
    const partTag = (p.parts ?? 1) > 1 ? ` (part ${p.part}/${p.parts})` : ''
    if (p.phase === 'downloading' && p.pct >= 0) {
      process.stdout.write(`\rseed: downloading ${id} engine${partTag} ${Math.round(p.pct * 100)}%   `)
    } else if (p.phase === 'extracting') {
      process.stdout.write(`\rseed: extracting ${id} engine${partTag}…            `)
    }
  }

  for (const backend of chain) {
    try {
      provision.start(backend.id)
      const binPath = await provisionBackend(enginesRoot, backend, tag, onProgress(backend.id))
      process.stdout.write('\n')
      // registry.add() probes the binary; a GPU build with no runtime throws here.
      await registry.add(`llama.cpp ${tag} (${backend.id})`, binPath)
      provision.done()
      console.log(`seeded default engine: llama.cpp ${tag} (${backend.id})`)
      return
    } catch (e) {
      process.stdout.write('\n')
      console.warn(`seed: ${backend.id} engine unavailable (${e instanceof Error ? e.message : e})`)
      // try next backend in the fallback chain
    }
  }
  provision.fail('Could not download a default engine. Check your connection or add one manually.')
  console.warn('seed: could not provision a default engine — add one manually in Settings.')
}

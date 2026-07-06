// Engine grouping for the "Running now" hero dropdown (ADR-091). After updating
// llama.cpp (e.g. b9608 → b9736) the registry holds TWO entries, so the dropdown
// would show two near-identical "llama.cpp … (cuda)" rows. We instead group the
// registry into LOGICAL engines (one row each) and, when a logical engine has more
// than one installed variant, surface a second "version" dropdown to pick the build.
//
// Pure + framework-free so it is unit-testable on its own (imported by EnginesScreen).
import type { Engine } from './types'

/** Official llama.cpp builds auto-downloaded by TurboLLM live in
 *  `<config>/engines/llama.cpp-<tag>-<backend>/`. Matches EnginesScreen.isOfficialLlama. */
export function isOfficialLlama(binPath: string): boolean {
  return /[\\/]engines[\\/]llama\.cpp-/.test(binPath)
}

/** A logical-engine grouping key. Engines that share a key collapse into one row.
 *  Each official llama.cpp BACKEND is its own engine (`'official-llama-<backend>'`, e.g.
 *  cuda/rocm) so the "Running now" dropdown lists them individually — the user switches
 *  among "llama.cpp (CUDA)", "llama.cpp (ROCm)", TurboQuant, … from there. Multiple builds
 *  of the SAME backend (after an update) still collapse into that backend's group. Pip
 *  engines share their kind; TurboQuant builds share `'turboquant'`; everything else is a
 *  distinct user-added engine (`'user:'+id`). */
export function engineGroupKey(e: Engine): string {
  if (isOfficialLlama(e.binPath)) {
    const backend = parseLlamaBuild(e.binPath)?.backend
    return backend ? `official-llama-${backend}` : 'official-llama'
  }
  if (e.kind === 'koboldcpp' || e.kind === 'mlx' || e.kind === 'rapid-mlx' || e.kind === 'vllm') return e.kind
  if (/[\\/]engines[\\/]turboquant[\\/]/.test(e.binPath)) return 'turboquant'
  return `user:${e.id}`
}

const GROUP_LABEL: Record<string, string> = {
  'official-llama': 'llama.cpp',
  koboldcpp: 'KoboldCpp',
  mlx: 'MLX',
  'rapid-mlx': 'Rapid-MLX',
  vllm: 'vLLM',
  turboquant: 'TurboQuant',
}

/** Display label for a logical-engine group. Per-backend llama.cpp groups read as
 *  "llama.cpp (CUDA)"; user-added engines fall back to the engine's own name. */
export function groupLabel(key: string, members: Engine[]): string {
  if (key.startsWith('official-llama-')) {
    const backend = key.slice('official-llama-'.length)
    return `llama.cpp (${BACKEND_LABEL[backend] ?? backend.toUpperCase()})`
  }
  return GROUP_LABEL[key] ?? members[0]?.name ?? key
}

const BACKEND_LABEL: Record<string, string> = {
  cuda: 'CUDA',
  rocm: 'ROCm',
  sycl: 'SYCL',
  vulkan: 'Vulkan',
  metal: 'Metal',
  cpu: 'CPU',
}

/** Parse the build tag + GPU backend from an official llama.cpp binPath, e.g.
 *  `…/engines/llama.cpp-b9736-cuda/…` → `{ tag: 'b9736', backend: 'cuda' }`. Null
 *  when the path isn't an official-build layout (forks, pip engines, …). */
export function parseLlamaBuild(binPath: string): { tag: string; backend: string } | null {
  const m = binPath.match(/llama\.cpp-([^/\\]+)-(cuda|rocm|sycl|vulkan|metal|cpu)/)
  if (!m) return null
  return { tag: m[1], backend: m[2] }
}

/** llama.cpp build number parsed from a tag like `b9736` → 9736. null when the tag
 *  carries no `b<digits>` (used to pick the "latest" member of a group). */
export function llamaBuildNumber(tag: string | undefined | null): number | null {
  if (!tag) return null
  const m = tag.match(/b(\d+)/)
  return m ? Number(m[1]) : null
}

/** Human variant label for ONE member of a group. Official builds read as
 *  `"b9736 · CUDA"`; other groups fall back to the engine's version (or name). */
export function variantLabel(e: Engine): string {
  const build = parseLlamaBuild(e.binPath)
  if (build) {
    const backend = BACKEND_LABEL[build.backend] ?? build.backend.toUpperCase()
    return `${build.tag} · ${backend}`
  }
  return e.version || e.name
}

/** A logical engine: one dropdown row collapsing 1+ registry members. */
export interface EngineGroup {
  key: string
  label: string
  members: Engine[]
  /** The member with the highest llama.cpp build number, when any tag parses; else
   *  null (the "latest" badge only renders when this is set). */
  latestId: string | null
}

/** The engine id within a group that is the newest build, or null when none of the
 *  members carry a parseable build number (e.g. pip/user engines). */
export function latestMemberId(members: Engine[]): string | null {
  let bestId: string | null = null
  let bestNum = -Infinity
  for (const e of members) {
    const build = parseLlamaBuild(e.binPath)
    const num = llamaBuildNumber(build?.tag)
    if (num != null && num > bestNum) {
      bestNum = num
      bestId = e.id
    }
  }
  return bestId
}

/** Group a flat registry list into logical engines, preserving first-seen order. */
export function groupEngines(engines: Engine[]): EngineGroup[] {
  const order: string[] = []
  const byKey = new Map<string, Engine[]>()
  for (const e of engines) {
    const key = engineGroupKey(e)
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = []
      byKey.set(key, bucket)
      order.push(key)
    }
    bucket.push(e)
  }
  return order.map((key) => {
    const members = byKey.get(key)!
    // Newest build first (e.g. b9754 before b9744) so the version dropdown reads latest→oldest;
    // members without a parseable build number keep their relative order at the end.
    const sorted = [...members].sort((a, b) => {
      const na = llamaBuildNumber(parseLlamaBuild(a.binPath)?.tag)
      const nb = llamaBuildNumber(parseLlamaBuild(b.binPath)?.tag)
      return (nb ?? -1) - (na ?? -1)
    })
    return { key, label: groupLabel(key, sorted), members: sorted, latestId: latestMemberId(sorted) }
  })
}

/** The member of a group to activate when the user picks the group: the currently-
 *  active member if it's in this group, else the latest build, else the first member. */
export function memberToActivate(group: EngineGroup, activeId: string | null): Engine | undefined {
  const active = group.members.find((e) => e.id === activeId)
  if (active) return active
  if (group.latestId) {
    const latest = group.members.find((e) => e.id === group.latestId)
    if (latest) return latest
  }
  return group.members[0]
}

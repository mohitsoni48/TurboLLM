import type { CatalogEngine } from './types'

const OFFICIAL_LLAMA_IDS = ['llama.cpp', 'llama.cpp-cuda-linux', 'llama.cpp-android-source', 'llama.cpp-source']

/** Default engine name for a fresh build-from-source run. Official llama.cpp repos get the
 *  `Llama-<Branch>` convention; forks get `<EngineName>-<Branch>`. A blank branch adds no suffix. */
export function defaultBuildName(catalog: Pick<CatalogEngine, 'id' | 'name'> | undefined, branch: string): string {
  const suffix = branch.trim()
  const base = OFFICIAL_LLAMA_IDS.includes(catalog?.id ?? '') ? 'Llama' : (catalog?.name ?? 'engine')
  return suffix ? `${base}-${suffix}` : base
}

/** A blank branch means "the repo's own default", which the user should see spelled out. */
export const branchLabel = (branch: string): string => branch || '(repo default)'

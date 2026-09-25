// What to download from a Laya repo. A Laya checkpoint keeps its encoder config and tokenizer in subfolders, which
// the root-only safetensors file list never reaches, and it has no config.json, so it is no checkpoint to
// findCheckpoints either. The English checkpoint at the root and the multilingual one in multilingual/ are what
// the Laya engine routes between; typed-decisions is fine-tuned for four fixed workflows and is never chosen
// automatically, so it is not downloaded.
import { toRepoFile } from './checkpoints'
import type { HfRepoFile, RawTreeEntry } from './hf'

const CHECKPOINT_DIRS = ['', 'multilingual/']
const CHECKPOINT_FILES = ['rl_agent_config.json', 'model.safetensors']
const CHECKPOINT_FOLDERS = ['encoder/', 'tokenizer/']

/** A Laya repo has the decision-head config and the weights at its root. */
export function isLayaRepo(tree: readonly RawTreeEntry[]): boolean {
  const rootFiles = new Set(tree.filter((e) => e.type === 'file').map((e) => e.path))
  return CHECKPOINT_FILES.every((name) => rootFiles.has(name))
}

/** Every file of the root and multilingual checkpoints, nested paths kept, sorted by path. */
export function layaRepoFiles(tree: readonly RawTreeEntry[], fileUrl: (path: string) => string): HfRepoFile[] {
  return tree
    .filter((e) => e.type === 'file' && CHECKPOINT_DIRS.some((dir) => isCheckpointFile(e.path, dir)))
    .map((e) => toRepoFile(e.path, e, fileUrl))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function isCheckpointFile(path: string, dir: string): boolean {
  if (!path.startsWith(dir)) return false
  const rest = path.slice(dir.length)
  return CHECKPOINT_FILES.includes(rest) || CHECKPOINT_FOLDERS.some((folder) => rest.startsWith(folder) && !rest.slice(folder.length).includes('/'))
}

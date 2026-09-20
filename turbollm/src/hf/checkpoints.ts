// Which directories of a safetensors repo are downloadable models (ADR-434 (h)). A repo with
// exactly one checkpoint behaves exactly as today; a repo like OpenJev, which keeps each
// checkpoint in its own folder, gets one row per folder instead of a dead Download button.
import { dirname } from 'node:path'
import type { HfRepoFile, RawTreeEntry } from './hf'
import type { ProvenanceEntry } from '../downloads/downloads'
import type { ModelEntry } from '../models/scanner'

/** A downloadable model directory in an HF repo. */
export interface HfCheckpoint {
  /** Repo-relative directory, POSIX '/'; '' = the repo root. */
  dir: string
  /** Last segment of `dir`, or the repo's own name for the root. */
  name: string
  /** Sum of this directory's own .safetensors files. */
  sizeBytes: number
  /** This directory's OWN component files (non-recursive): .safetensors/.json/.jinja, mapped
   *  exactly like the root file list in `getRepo`. */
  files: HfRepoFile[]
  /** From this checkpoint's own config.json via detectJev(); null when not Jev or unreadable. */
  jev: { architecture: string; verified: boolean } | null
}

/** How many checkpoint config.json files one repo view may fetch. A repo of training
 *  checkpoints can hold hundreds; the rows past this simply carry no Jev badge. */
export const MAX_CHECKPOINT_CONFIG_FETCHES = 16

const COMPONENT_RE = /\.(safetensors|json|jinja)$/i
const WEIGHTS_RE = /\.safetensors$/i
const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json', 'tokenizer.model']

/** Pure. A checkpoint is a directory holding config.json + at least one .safetensors of its
 *  own. The root qualifies on exactly that; a NESTED directory must also hold a tokenizer file,
 *  which is the scanner's own model-directory test — so a diffusers repo's unet/ or vae/ is
 *  never offered as a checkpoint the library would then refuse to list. */
export function findCheckpoints(
  repo: string,
  tree: RawTreeEntry[],
  fileUrl: (path: string) => string,
): Omit<HfCheckpoint, 'jev'>[] {
  const byDir = filesByDirectory(tree)
  return [...byDir.entries()]
    .filter(([dir, paths]) => isCheckpointDir(dir, paths))
    .sort(([a], [b]) => compareDirs(a, b))
    .map(([dir, paths]) => describeCheckpoint(repo, dir, paths, tree, fileUrl))
}

function filesByDirectory(tree: RawTreeEntry[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>()
  for (const entry of tree) {
    if (entry.type !== 'file') continue
    const dir = dirOf(entry.path)
    const paths = byDir.get(dir)
    if (paths) paths.push(entry.path)
    else byDir.set(dir, [entry.path])
  }
  return byDir
}

function isCheckpointDir(dir: string, paths: string[]): boolean {
  const names = paths.map(baseOf)
  if (!names.includes('config.json')) return false
  if (!names.some((name) => WEIGHTS_RE.test(name))) return false
  return dir === '' || names.some((name) => TOKENIZER_FILES.includes(name))
}

function describeCheckpoint(
  repo: string,
  dir: string,
  paths: string[],
  tree: RawTreeEntry[],
  fileUrl: (path: string) => string,
): Omit<HfCheckpoint, 'jev'> {
  const components = paths.filter((path) => COMPONENT_RE.test(path))
  const files = components.map((path) => toRepoFile(path, entryFor(tree, path), fileUrl))
  return {
    dir,
    name: dir === '' ? baseOf(repo) : baseOf(dir),
    sizeBytes: files.filter((f) => WEIGHTS_RE.test(f.name)).reduce((sum, f) => sum + f.sizeBytes, 0),
    files,
  }
}

/** The same mapping `getRepo`'s root list uses, so a single-checkpoint repo is byte-identical
 *  to today: `name` is the full repo path, which is what makes the resolve URL right. */
function toRepoFile(path: string, entry: RawTreeEntry | undefined, fileUrl: (path: string) => string): HfRepoFile {
  return {
    name: path,
    quant: 'mlx',
    sizeBytes: entry?.lfs?.size ?? entry?.size ?? 0,
    parts: 1,
    mmproj: false,
    safetensors: true,
    sha256: entry?.lfs?.oid,
    url: fileUrl(path),
  }
}

function entryFor(tree: RawTreeEntry[], path: string): RawTreeEntry | undefined {
  return tree.find((e) => e.type === 'file' && e.path === path)
}

/** Root first, then by directory in code-point order. */
function compareDirs(a: string, b: string): number {
  if (a === b) return 0
  if (a === '') return -1
  if (b === '') return 1
  return a < b ? -1 : 1
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function baseOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/** Is this checkpoint already on disk, and which local model is it? Provenance `filename` is a
 *  basename, so two checkpoints' identical `model.safetensors` are indistinguishable by name:
 *  the match is by weight sha256 first, then by the download's own destination path. */
export function annotateCheckpoint(
  repo: string,
  cp: CheckpointPlacement,
  provenance: ProvenanceEntry[],
  models: ModelEntry[],
): { downloaded: boolean; localKey: string | null } {
  const download = downloadOf(repo, cp, provenance)
  const local = download ? models.find((m) => m.path === dirname(download.dest)) : undefined
  return { downloaded: !!local, localKey: local?.key ?? null }
}

/** What `annotateCheckpoint` needs of a checkpoint: where it lives and what it ships. */
type CheckpointPlacement = Pick<HfCheckpoint, 'dir' | 'files'>

function downloadOf(repo: string, cp: CheckpointPlacement, provenance: ProvenanceEntry[]): ProvenanceEntry | undefined {
  const weightShas = new Set(cp.files.filter((f) => WEIGHTS_RE.test(f.name)).map((f) => f.sha256))
  return provenance.find((p) => !!p.sha256 && weightShas.has(p.sha256))
    ?? provenance.find((p) => p.repo === repo && landedInCheckpoint(repo, cp, p.dest))
}

/** The repo's own name anchors the tail — the same anchor the download subdir uses. Without it
 *  the ROOT checkpoint (dir '') would match every subfolder download of the repo. */
function landedInCheckpoint(repo: string, cp: CheckpointPlacement, dest: string): boolean {
  const destSegments = dest.replace(/\\/g, '/').split('/').filter(Boolean)
  const dirSegments = cp.dir ? cp.dir.split('/') : []
  return cp.files.some((f) => endsWith(destSegments, [baseOf(repo), ...dirSegments, baseOf(f.name)]))
}

function endsWith(segments: string[], tail: string[]): boolean {
  if (tail.length > segments.length) return false
  const from = segments.length - tail.length
  return tail.every((segment, i) => segments[from + i] === segment)
}

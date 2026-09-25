// Laya models in the library. A Laya checkpoint is not an HF transformers folder: it has no config.json at its
// root, only the decision head's rl_agent_config.json, one model.safetensors, and encoder/ and tokenizer/ folders.
// The convaiinnovations/laya repo bundles the English checkpoint at its root and the multilingual one in
// multilingual/, and laya's Router sends each request to the checkpoint that can read it — so one library model
// is the whole bundle, and the Laya engine serves every checkpoint the folder holds.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ModelEntry } from './scanner'

/** Present only for a Laya model — absent = not a Laya model. */
export interface LayaInfo {
  /** The checkpoints the folder holds, by laya's own names: english, multilingual, typed-decisions. */
  checkpoints: string[]
}

interface LayaConfig {
  encoder?: unknown
  max_len?: unknown
}

const SUBFOLDER_CHECKPOINTS = ['multilingual', 'typed-decisions']
const CONFIG = 'rl_agent_config.json'
const WEIGHTS = 'model.safetensors'

/** A directory holds a Laya checkpoint when it has the decision-head config, the weights, and the encoder and
 *  tokenizer folders laya loads them with. */
export function isLayaModelDir(names: readonly string[]): boolean {
  const lower = new Set(names.map((name) => name.toLowerCase()))
  return [CONFIG, WEIGHTS, 'encoder', 'tokenizer'].every((name) => lower.has(name))
}

/** The library entry for a Laya folder. Its format is 'mlx' (a safetensors folder, deleted as a directory) and
 *  `laya` is what marks it: compat.ts gives it to the Laya engine and to no other. */
export function layaEntryFor(dir: string): ModelEntry {
  const root = readConfig(dir)
  const rootCheckpoint = typeof root.config.encoder === 'string' && /mmbert/i.test(root.config.encoder)
    ? 'multilingual'
    : 'english'
  const subfolders = SUBFOLDER_CHECKPOINTS.filter(
    (name) => name !== rootCheckpoint && existsSync(join(dir, name, CONFIG)),
  )
  const weights = [dir, ...subfolders.map((name) => join(dir, name))].map(weightsOf)
  const sizeBytes = weights.reduce((sum, w) => sum + w.size, 0)
  const mtimeMs = Math.max(0, ...weights.map((w) => w.mtimeMs))
  const name = basename(dir).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
  return {
    key: `${name.toLowerCase()}|laya|${sizeBytes}`,
    name,
    path: dir,
    dir,
    format: 'mlx',
    sizeBytes,
    sizeLabel: '',
    arch: 'laya',
    quant: 'fp16',
    nativeCtx: typeof root.config.max_len === 'number' ? root.config.max_len : 0,
    blockCount: 0,
    headCountKv: 0,
    headDim: 0,
    moe: false,
    expertCount: 0,
    nextnLayers: 0,
    vision: false,
    audio: false,
    mmprojPath: null,
    mmprojSizeBytes: 0,
    hasChatTemplate: false,
    reasoningEffort: false,
    embedding: false,
    laya: { checkpoints: [rootCheckpoint, ...subfolders] },
    incomplete: weights.some((w) => w.size === 0),
    parseError: root.error,
    loaded: false,
    hasProfile: false,
    benchTps: null,
    mtime: new Date(mtimeMs || Date.now()).toISOString(),
  }
}

function readConfig(dir: string): { config: LayaConfig; error: string | null } {
  try {
    const raw = readFileSync(join(dir, CONFIG), 'utf8').replace(/^﻿/, '')
    return { config: JSON.parse(raw) as LayaConfig, error: null }
  } catch (e) {
    return { config: {}, error: `Could not read ${CONFIG}: ${(e as Error).message}` }
  }
}

function weightsOf(checkpointDir: string): { size: number; mtimeMs: number } {
  try {
    const st = lstatSync(join(checkpointDir, WEIGHTS))
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { size: 0, mtimeMs: 0 }
  }
}

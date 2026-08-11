// HuggingFace hub cache location (ADR-092). On first run, when the user has no
// model directories configured, the daemon seeds this dir as the primary so any
// models already pulled by `huggingface-cli`/`transformers`/`hf_hub_download`
// show up immediately. Resolution mirrors the huggingface_hub library:
//   HUGGINGFACE_HUB_CACHE  → used directly (the explicit hub-cache override)
//   HF_HOME                → join(HF_HOME, 'hub')
//   else                   → ~/.cache/huggingface/hub
// Pure-ish: reads env + home only, never touches the filesystem. Injectable for
// tests.
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConfigStore } from '../config/config'
import type { Scanner } from './scanner'

export interface HfCacheEnv {
  HUGGINGFACE_HUB_CACHE?: string
  HF_HOME?: string
}

/** Resolve the HuggingFace hub cache directory. Env + home are injectable so the
 *  resolution order is unit-testable without mutating process state. Never throws. */
export function hfHubCacheDir(env: HfCacheEnv = process.env, home: string = homedir()): string {
  const explicit = env.HUGGINGFACE_HUB_CACHE
  if (explicit && explicit.trim()) return explicit
  const hfHome = env.HF_HOME
  if (hfHome && hfHome.trim()) return join(hfHome, 'hub')
  return join(home, '.cache', 'huggingface', 'hub')
}

/** Which directory `seedDefaultModelDir` should adopt, and why — kept pure and
 *  separate from the side-effecting parts (fs writes, config mutation, rescan)
 *  so the decision itself is unit-testable without a real ConfigStore/Scanner.
 *
 *  Found live in an isolated onboarding test: a genuinely fresh machine with no
 *  prior `huggingface-cli`/`transformers` use has no HF hub cache to adopt
 *  either — ADR-092's original logic left `modelDirs` empty forever in that
 *  case, so the very first download attempt failed immediately with "Add a
 *  model folder in Settings before downloading," on a screen that has no
 *  Settings link. `dataDir/models` (an existing HF cache is still preferred,
 *  in case one exists to recover) is the fallback so downloads always have
 *  somewhere to land. */
export function resolveDefaultModelDir(
  hfCacheExists: boolean,
  hfCacheDir: string,
  dataDir: string,
): { dir: string; reason: 'hf-cache' | 'fresh-install' } {
  if (hfCacheExists) return { dir: hfCacheDir, reason: 'hf-cache' }
  return { dir: join(dataDir, 'models'), reason: 'fresh-install' }
}

/** First-run seed (ADR-092, extended): when no model directories are configured,
 *  adopt the HF hub cache if one already exists (pre-existing HF models show up
 *  immediately — the original ADR-092 behaviour), else create and adopt
 *  `<dataDir>/models` so a genuinely fresh install still has somewhere for its
 *  first download to land. One-time only — never overrides a user who already
 *  has dirs. Triggers a background rescan either way. Never throws (best-effort). */
export function seedDefaultModelDir(store: ConfigStore, scanner: Scanner): void {
  try {
    if (store.snapshot().modelDirs.length > 0) return

    const hfCacheDir = hfHubCacheDir()
    const { dir, reason } = resolveDefaultModelDir(existsSync(hfCacheDir), hfCacheDir, store.dir())

    if (reason === 'fresh-install') mkdirSync(dir, { recursive: true })

    store.update((c) => {
      c.modelDirs = [dir]
      c.primaryModelDir = dir
    })

    console.log(
      reason === 'hf-cache'
        ? `seed: adopted HuggingFace hub cache as the default model folder (${dir})`
        : `seed: created a default model folder (${dir}) — no existing HuggingFace cache found`,
    )
    void scanner.rescan()
  } catch {
    /* best-effort — never block startup over the model-dir seed */
  }
}

// Rollback-safe update application (ADR-085, Phase 6, Layer 2). One orchestrator that
// updates an engine to the real latest upstream, dispatched by its update source:
//   - official llama.cpp  → download the latest tag into a NEW tag-keyed dir, probe it,
//                           and only on success register + activate it and GC the old dir;
//                           on any failure the old install is left untouched (rollback).
//   - TurboQuant fork     → re-provision the fork's latest GitHub release (replace dir).
//   - vLLM / MLX / Rapid-MLX (pip) → `uv pip install -U/--upgrade` into the existing venv.
//
// Shared by the HTTP update endpoints AND the auto-update scheduler so both take the
// exact same honest, rollback-safe path. Keeps the pure decision logic (update.ts)
// separate from this I/O-heavy orchestration.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import type { Manager } from './manager'
import type { ProvisionState } from './provision-state'
import type { Registry } from './registry'
import {
  backendDefAt,
  backendDir,
  latestReleaseTag,
  provisionBackend,
  provisionTurboquant,
} from './download'
import { ensureMlxEnv } from './mlx'
import { ensureRapidMlxEnv } from './rapid-mlx'
import { ensureVllmEnv } from './vllm'
import { ensureKoboldcpp, koboldcppDir } from './koboldcpp'
import { ensureLlamafile, llamafileDir } from './llamafile'
import { primaryVendor } from '../sysinfo/sysinfo'
import { backendIdFromBinPath, tagFromManagedBinPath } from './update'

export interface UpdateApplyDeps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  provision: ProvisionState
}

const OFFICIAL_LLAMA_REPO = 'ggml-org/llama.cpp'
const isManagedLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)
const isTurboquant = (binPath: string) => /[\\/]engines[\\/]turboquant[\\/]/.test(binPath)

/** Apply a rollback-safe update for one engine. Throws on failure (callers surface it);
 *  on the llama.cpp path the existing install is guaranteed untouched when it throws. */
export async function applyEngineUpdate(d: UpdateApplyDeps, engine: Engine, signal?: AbortSignal): Promise<void> {
  const root = join(d.store.dir(), 'engines')
  if (engine.kind === 'mlx') return applyPipUpdate(d, 'mlx', engine, root)
  if (engine.kind === 'rapid-mlx') return applyPipUpdate(d, 'rapid-mlx', engine, root)
  if (engine.kind === 'vllm') return applyPipUpdate(d, 'vllm', engine, root)
  if (engine.kind === 'koboldcpp') return applyKoboldcppUpdate(d, engine, root, signal)
  if (engine.kind === 'llamafile') return applyLlamafileUpdate(d, engine, root, signal)
  if (engine.kind === 'llama-server') {
    if (isManagedLlama(engine.binPath)) return applyLlamaCppUpdate(d, engine, root, signal)
    if (isTurboquant(engine.binPath)) return applyForkUpdate(d, engine, root, signal)
  }
  throw new Error('This engine has no automatic update source.')
}

/** Official llama.cpp: download the real latest tag into its own dir, probe, then swap
 *  + GC the old. The old dir is only deleted AFTER the new one probes successfully. */
async function applyLlamaCppUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  const backendId = backendIdFromBinPath(engine.binPath)
  if (!backendId) throw new Error('Could not determine the GPU backend of this build.')
  const installedTag = tagFromManagedBinPath(engine.binPath)
  const latestTag = await latestReleaseTag(OFFICIAL_LLAMA_REPO, signal)
  if (!latestTag) throw new Error('GitHub did not report a latest build.')
  if (installedTag && installedTag === latestTag) return // already latest — nothing to do
  const newDef = backendDefAt(backendId, latestTag)
  if (!newDef) throw new Error('No upstream build of this backend for your platform.')

  d.provision.start(backendId)
  try {
    const newBin = await provisionBackend(
      root, newDef, latestTag,
      (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
      signal,
    )
    let newEng = d.registry.list().engines.find((e) => e.binPath === newBin)
    if (!newEng) newEng = (await d.registry.add(`llama.cpp ${latestTag} (${backendId})`, newBin)).engine
    // Stop the running engine only if it's the OLD build of this backend.
    const oldEng = d.registry.list().engines.find((e) => e.binPath === engine.binPath)
    if (oldEng && d.registry.active()?.id === oldEng.id) await d.manager.stopAndWait()
    d.registry.activate(newEng.id)
    if (oldEng && oldEng.id !== newEng.id) {
      try { d.registry.remove(oldEng.id) } catch { /* already gone */ }
    }
    if (installedTag && installedTag !== latestTag) {
      rmSync(backendDir(root, backendId, installedTag), { recursive: true, force: true })
    }
    d.provision.done()
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') d.provision.done()
    else d.provision.fail(`Could not update llama.cpp (${backendId}) — your existing build is unchanged: ${msg(e)}`)
    throw e
  }
}

/** TurboQuant fork: remove the install dir + re-provision the fork's latest release. */
async function applyForkUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  d.provision.start('turboquant')
  try {
    const oldEng = d.registry.list().engines.find((e) => e.binPath === engine.binPath)
    if (oldEng && d.registry.active()?.id === oldEng.id) await d.manager.stopAndWait()
    const tqDir = join(root, 'turboquant')
    rmSync(tqDir, { recursive: true, force: true })
    const bin = await provisionTurboquant(
      root, 'AtomicBot-ai/atomic-llama-cpp-turboquant',
      (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
      signal,
    )
    let eng = d.registry.list().engines.find((e) => e.binPath === bin)
    if (!eng) eng = (await d.registry.add('TurboQuant', bin)).engine
    d.registry.activate(eng.id)
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not update TurboQuant: ${msg(e)}`)
    throw e
  }
}

/** KoboldCpp: remove the install dir + re-download the latest release binary. Mirrors
 *  the fork path (single dir, replaced wholesale). */
async function applyKoboldcppUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  d.provision.start('koboldcpp')
  try {
    if (d.registry.active()?.id === engine.id) await d.manager.stopAndWait()
    rmSync(koboldcppDir(root), { recursive: true, force: true })
    const hasNvidia = primaryVendor() === 'nvidia'
    const rt = await ensureKoboldcpp(root, hasNvidia, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), signal)
    const eng = d.registry.addKoboldcpp(`KoboldCpp (${rt.version})`, rt.binPath, rt.version)
    d.registry.activate(eng.id)
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not update KoboldCpp: ${msg(e)}`)
    throw e
  }
}

/** llamafile: remove the install dir + re-download the latest portable binary. */
async function applyLlamafileUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  d.provision.start('llamafile')
  try {
    if (d.registry.active()?.id === engine.id) await d.manager.stopAndWait()
    rmSync(llamafileDir(root), { recursive: true, force: true })
    const rt = await ensureLlamafile(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), signal)
    const eng = d.registry.addLlamafile(`llamafile (${rt.version})`, rt.binPath, rt.version)
    d.registry.activate(eng.id)
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not update llamafile: ${msg(e)}`)
    throw e
  }
}

const PIP_ENGINE_LABEL: Record<'mlx' | 'rapid-mlx' | 'vllm', string> = { mlx: 'MLX', 'rapid-mlx': 'Rapid-MLX', vllm: 'vLLM' }

/** vLLM / MLX / Rapid-MLX: upgrade the package in place (uv pip install -U/--upgrade). */
async function applyPipUpdate(d: UpdateApplyDeps, kind: 'mlx' | 'rapid-mlx' | 'vllm', engine: Engine, root: string): Promise<void> {
  d.provision.start(kind)
  try {
    if (d.registry.active()?.id === engine.id) await d.manager.stopAndWait()
    if (kind === 'mlx') {
      const rt = await ensureMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addMlx(`MLX (${rt.version})`, rt.python, rt.version)
      d.registry.activate(eng.id)
    } else if (kind === 'rapid-mlx') {
      const rt = await ensureRapidMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addRapidMlx(`Rapid-MLX (${rt.version})`, rt.bin, rt.version)
      d.registry.activate(eng.id)
    } else {
      const rt = await ensureVllmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addVllm(`vLLM (${rt.version})`, rt.python, rt.version)
      d.registry.activate(eng.id)
    }
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not update ${PIP_ENGINE_LABEL[kind]}: ${msg(e)}`)
    throw e
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

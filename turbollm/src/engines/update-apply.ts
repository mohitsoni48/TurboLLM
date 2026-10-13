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
import { basename, join } from 'node:path'
import { sourceBuildDirOf } from './build-runner'
import type { ConfigStore, Engine } from '../config/config'
import type { Manager } from './manager'
import type { ProvisionState } from './provision-state'
import type { Registry } from './registry'
import type { ModelRouter } from '../gateway/model-router'
import {
  backendDefAt,
  backendDir,
  provisionBackend,
  provisionTurboquant,
} from './download'
import { ensureMlxEnv } from './mlx'
import { ensureRapidMlxEnv } from './rapid-mlx'
import { ensureMlxVlmEnv } from './mlx-vlm'
import { ensureVllmEnv } from './vllm'
import { ensureLitertLmEnv } from './litert-lm'
import { ensureKoboldcpp, koboldcppDir } from './koboldcpp'
import { ensureLlamafile, llamafileDir } from './llamafile'
import { primaryVendor } from '../sysinfo/sysinfo'
import { stopEngineUsers } from './serving'
import { backendIdFromBinPath, tagFromManagedBinPath, latestTagForInstalled, type UpdateChecker } from './update'
import type { ProbeResult } from './probe'
import { newestMatchingRelease } from './release-assets'
import {
  installReleaseAsset,
  releaseInstallDirName,
  type ReleaseInstallResult,
  type ReleaseProvenance,
} from './release-install'

export interface UpdateApplyDeps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  provision: ProvisionState
  trigger?: 'auto_update' | 'user_update'
  /** Test seams, read only by the release branch. */
  fetchImpl?: typeof fetch
  probeFn?: (bin: string) => Promise<ProbeResult>
  /** Reason the engine-work slot is taken, or null. Read only by the release branch. */
  workBusy?: () => string | null
  /** Cached update statuses; a finished release update drops its engine's entry. */
  updates?: UpdateChecker
  /** Optional: when present, pool slots running on the engine being updated are stopped too. */
  modelRouter?: Pick<ModelRouter, 'stopPoolSlotsOnEngine' | 'poolSlotsOnEngine'>
}

/** What the swap guard reads: who is running, and which engine is active. */
export type SwapGuardDeps = Pick<UpdateApplyDeps, 'registry' | 'manager' | 'modelRouter'>

const OFFICIAL_LLAMA_REPO = 'ggml-org/llama.cpp'
const isManagedLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)
const isTurboquant = (binPath: string) => /[\\/]engines[\\/]turboquant[\\/]/.test(binPath)

/** Apply a rollback-safe update for one engine. Throws on failure (callers surface it);
 *  on the llama.cpp path the existing install is guaranteed untouched when it throws. */
export async function applyEngineUpdate(d: UpdateApplyDeps, engine: Engine, signal?: AbortSignal): Promise<void> {
  const root = join(d.store.dir(), 'engines')
  if (engine.release) return applyReleaseUpdate(d, engine, engine.release, root, signal)
  if (engine.kind === 'mlx') return applyPipUpdate(d, 'mlx', engine, root)
  if (engine.kind === 'rapid-mlx') return applyPipUpdate(d, 'rapid-mlx', engine, root)
  if (engine.kind === 'mlx-vlm') return applyPipUpdate(d, 'mlx-vlm', engine, root)
  if (engine.kind === 'vllm') return applyPipUpdate(d, 'vllm', engine, root)
  if (engine.kind === 'litert-lm') return applyPipUpdate(d, 'litert-lm', engine, root)
  if (engine.kind === 'koboldcpp') return applyKoboldcppUpdate(d, engine, root, signal)
  if (engine.kind === 'llamafile') return applyLlamafileUpdate(d, engine, root, signal)
  if (engine.kind === 'llama-server') {
    if (isManagedLlama(engine.binPath)) return applyLlamaCppUpdate(d, engine, root, signal)
    if (isTurboquant(engine.binPath)) return applyForkUpdate(d, engine, root, signal)
  }
  throw new Error('This engine has no automatic update source.')
}

/** Release engine (ADR-453): install the newest build of the same variant into the same slug.
 *  The old dir is replaced only after the new one probes, so a failure leaves it untouched. */
async function applyReleaseUpdate(
  d: UpdateApplyDeps, engine: Engine, installed: ReleaseProvenance, root: string, signal?: AbortSignal,
): Promise<void> {
  if (d.workBusy?.()) return // another engine job owns the slot; the next scheduler tick retries
  const poolBlock = poolSlotBlockReason(d, engine)
  if (poolBlock) throw new Error(poolBlock)
  const newer = await newestMatchingRelease(installed, signal, d.fetchImpl)
  if (!newer || newer.tag === installed.tag) return

  d.provision.start('github-release', d.trigger ?? 'auto_update')
  try {
    if (d.registry.active()?.id === engine.id) await d.manager.stopAndWait()
    const result = await installReleaseAsset(
      root,
      { repo: installed.repo, tag: newer.tag, asset: newer.asset },
      {
        probeFn: d.probeFn,
        fetchImpl: d.fetchImpl,
        signal,
        slug: installedSlug(engine, installed, root),
        blockSwap: () => releaseSwapBlockReason(d, engine),
        onProgress: (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
      },
    )
    if (!result.found) throw new Error('the newer release has no server binary for this build')
    recordReleaseUpdate(d.registry, d.updates, engine.id, result)
    d.provision.done()
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') d.provision.done()
    else d.provision.fail(`Could not update ${engine.name} — your existing build is unchanged: ${msg(e)}`)
    throw e
  }
}

/** The dir the engine actually lives in. After a classification-fallback update the recorded
 *  assetKey no longer names the original dir, so the slug is read from the path, not rebuilt. */
function installedSlug(engine: Engine, installed: ReleaseProvenance, root: string): string {
  const dir = sourceBuildDirOf(engine.binPath, root)
  return dir ? basename(dir) : releaseInstallDirName(installed)
}

/** Apply a finished release install to an existing engine: keep its id, record the new
 *  provenance, and drop its cached update status so the UI stops offering the update. */
export function recordReleaseUpdate(
  registry: Registry,
  updates: UpdateChecker | undefined,
  engineId: string,
  result: Extract<ReleaseInstallResult, { found: true }>,
): void {
  registry.refresh(engineId, { version: result.version, capabilities: result.capabilities }, result.binPath)
  registry.setRelease(engineId, result.provenance)
  updates?.forget(engineId)
}

/** Why replacing the engine's build folder must wait, or null. Refuses rather than stopping a model the user is
 *  using (ADR-453): the primary slot and every extra pool slot count. Re-run at the swap, since the engine may
 *  have been started during the download. */
export function releaseSwapBlockReason(d: SwapGuardDeps, engine: Pick<Engine, 'id' | 'name'>): string | null {
  return primarySlotBlockReason(d, engine) ?? poolSlotBlockReason(d, engine)
}

function primarySlotBlockReason(d: SwapGuardDeps, engine: Pick<Engine, 'id' | 'name'>): string | null {
  const state = d.manager.status().state
  const running = state === 'running' || state === 'starting' || state === 'stopping'
  if (!running || d.registry.active()?.id !== engine.id) return null
  return stopBeforeReplacingMessage(engine)
}

function poolSlotBlockReason(d: SwapGuardDeps, engine: Pick<Engine, 'id' | 'name'>): string | null {
  return d.modelRouter?.poolSlotsOnEngine(engine.id) ? stopBeforeReplacingMessage(engine) : null
}

function stopBeforeReplacingMessage(engine: Pick<Engine, 'name'>): string {
  return `Stop "${engine.name}" before replacing its files — its build folder is being replaced.`
}

/** Official llama.cpp: download the real latest tag into its own dir, probe, then swap
 *  + GC the old. The old dir is only deleted AFTER the new one probes successfully. */
async function applyLlamaCppUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  const backendId = backendIdFromBinPath(engine.binPath)
  if (!backendId) throw new Error('Could not determine the GPU backend of this build.')
  const installedTag = tagFromManagedBinPath(engine.binPath)
  // Resolve through the SHARED resolver, in the installed tag's own format. Asking for
  // `releases/latest` here returned llama.cpp's semver release (`v0.4.0`), which carries no
  // per-backend assets — so the download 404'd on an update the checker had correctly offered.
  const latestTag = await latestTagForInstalled(OFFICIAL_LLAMA_REPO, installedTag, signal)
  if (!latestTag) throw new Error('GitHub did not report a latest build.')
  if (installedTag && installedTag === latestTag) return // already latest — nothing to do
  const newDef = backendDefAt(backendId, latestTag)
  if (!newDef) throw new Error('No upstream build of this backend for your platform.')

  d.provision.start(backendId, 'auto_update')
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
    if (oldEng) await stopEngineUsers(d, oldEng.id)
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

/** TurboQuant fork: re-provision the fork's newest release, replacing the install dir. */
async function applyForkUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  d.provision.start('turboquant', 'auto_update')
  try {
    const oldEng = d.registry.list().engines.find((e) => e.binPath === engine.binPath)
    if (oldEng) await stopEngineUsers(d, oldEng.id)
    // `force` re-installs over the existing build. The deletes live inside provisionTurboquant,
    // AFTER its release lookup: removing the install first (as this did) meant a failed or
    // offline lookup left the user with no engine at all.
    const bin = await provisionTurboquant(
      root, 'AtomicBot-ai/atomic-llama-cpp-turboquant',
      (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
      signal, undefined, true,
    )
    const eng = await d.registry.addOrReprobe('TurboQuant', bin)
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
  d.provision.start('koboldcpp', 'auto_update')
  try {
    await stopEngineUsers(d, engine.id)
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
  d.provision.start('llamafile', 'auto_update')
  try {
    await stopEngineUsers(d, engine.id)
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

type PipEngineKind = 'mlx' | 'rapid-mlx' | 'mlx-vlm' | 'vllm' | 'litert-lm'

const PIP_ENGINE_LABEL: Record<PipEngineKind, string> =
  { mlx: 'MLX', 'rapid-mlx': 'Rapid-MLX', 'mlx-vlm': 'MLX-VLM', vllm: 'vLLM', 'litert-lm': 'LiteRT-LM' }

/** vLLM / MLX / Rapid-MLX / MLX-VLM / LiteRT-LM: upgrade the package in place (uv pip install -U/--upgrade). */
async function applyPipUpdate(d: UpdateApplyDeps, kind: PipEngineKind, engine: Engine, root: string): Promise<void> {
  d.provision.start(kind, 'auto_update')
  // LiteRT-LM serves .litertlm models without being active (engineForModel), and activating it sends every GGUF to
  // it, so an update re-activates it only when it was the active engine already.
  const wasActive = d.registry.active()?.id === engine.id
  try {
    await stopEngineUsers(d, engine.id)
    if (kind === 'mlx') {
      const rt = await ensureMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addMlx(`MLX (${rt.version})`, rt.python, rt.version)
      d.registry.activate(eng.id)
    } else if (kind === 'rapid-mlx') {
      const rt = await ensureRapidMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addRapidMlx(`Rapid-MLX (${rt.version})`, rt.bin, rt.version)
      d.registry.activate(eng.id)
    } else if (kind === 'mlx-vlm') {
      const rt = await ensureMlxVlmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addMlxVlm(`MLX-VLM (${rt.version})`, rt.python, rt.version)
      d.registry.activate(eng.id)
    } else if (kind === 'litert-lm') {
      const rt = await ensureLitertLmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addLitertLm(`LiteRT-LM (${rt.version})`, rt.python, rt.version)
      if (wasActive) d.registry.activate(eng.id)
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

// Engine registry (A1, spec 03 §2). Pure config state; "in use" guards are
// enforced by the API layer using the Manager's live state.
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ConfigStore, CustomEngineSource, Engine, FlagInfo, UpdatePolicy, ValueError, findEngine } from '../config/config'
import { probe } from './probe'
import { normRepoUrl } from './build-runner'

/** Auto-provisioned official builds live under `<dataDir>/engines/llama.cpp-…/`.
 *  User forks are arbitrary paths and are never auto-removed. */
const isManagedBuild = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

export class NotFoundError extends Error {
  constructor() {
    super('engine_not_found')
    this.name = 'NotFoundError'
  }
}

/** Thrown by add()/addMlx() when another engine already uses the given name
 *  (case-insensitive, trimmed). Mapped to a 400 `name_already_taken` (spec 03 §2). */
export class NameTakenError extends Error {
  constructor() {
    super('Name already in use — choose a different name.')
    this.name = 'NameTakenError'
  }
}

/** add() returns the saved engine plus a non-blocking warning when the probe ran
 *  but could not extract a version (`probe_no_version`, spec 03 §2/§9). The engine
 *  is still saved; the UI surfaces the warning. */
export interface AddResult {
  engine: Engine
  warning?: 'no_version'
}

export class Registry {
  constructor(private store: ConfigStore) {}

  list(): { engines: Engine[]; activeEngineId: string } {
    const c = this.store.snapshot()
    return { engines: c.engines, activeEngineId: c.activeEngineId }
  }

  get(id: string): Engine | undefined {
    return findEngine(this.store.snapshot().engines, id)
  }

  active(): Engine | undefined {
    const c = this.store.snapshot()
    return c.activeEngineId ? findEngine(c.engines, c.activeEngineId) : undefined
  }

  async add(
    name: string,
    binPath: string,
    source?: { sourceRepo?: string; sourceBranch?: string; sourceCommit?: string; sourcePatchUrl?: string },
  ): Promise<AddResult> {
    const finalName = name.trim() || 'llama-server'
    this.assertNameFree(finalName)
    const pr = await probe(binPath)
    const sourceRepo = source?.sourceRepo?.trim() || undefined
    const sourceBranch = source?.sourceBranch?.trim() || undefined
    const sourceCommit = source?.sourceCommit?.trim() || undefined
    const sourcePatchUrl = source?.sourcePatchUrl?.trim() || undefined
    const eng: Engine = {
      id: randomUUID(),
      name: finalName,
      binPath,
      kind: 'llama-server',
      version: pr.version,
      capabilities: pr.capabilities,
      addedAt: new Date().toISOString(),
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(sourcePatchUrl ? { sourcePatchUrl } : {}),
    }
    this.store.update((c) => {
      // Re-check under the store lock — the name could have been taken between the
      // pre-probe check and now (a probe can take up to 10s).
      if (this.nameClash(c.engines, finalName)) throw new NameTakenError()
      c.engines.push(eng)
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return { engine: eng, warning: pr.version === 'unknown' ? 'no_version' : undefined }
  }

  /** True if any registered engine already uses `name` (case-insensitive, trimmed). */
  private nameClash(engines: Engine[], name: string): boolean {
    const n = name.trim().toLowerCase()
    return engines.some((e) => e.name.trim().toLowerCase() === n)
  }

  private assertNameFree(name: string): void {
    if (this.nameClash(this.store.snapshot().engines, name)) throw new NameTakenError()
  }

  /** Register an MLX engine (kind='mlx'). No llama-server probe — the binPath is
   *  a venv python, not a llama-server, so capabilities/flags don't apply. */
  addMlx(name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'MLX',
      binPath,
      kind: 'mlx',
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      // Replace an existing MLX engine at the same path rather than duplicating.
      const existing = c.engines.find((e) => e.kind === 'mlx' && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  /** Register a Rapid-MLX engine (kind='rapid-mlx'). Like addMlx, the binPath is a venv-
   *  installed binary (its `rapid-mlx` console script), so llama.cpp capabilities/flags
   *  don't apply. */
  addRapidMlx(name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'Rapid-MLX',
      binPath,
      kind: 'rapid-mlx',
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      // Replace an existing Rapid-MLX engine at the same path rather than duplicating.
      const existing = c.engines.find((e) => e.kind === 'rapid-mlx' && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  /** Register a vLLM engine (kind='vllm'). Like addMlx, the binPath is a venv
   *  python (not a llama-server), so llama.cpp capabilities/flags don't apply. */
  addVllm(name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'vLLM',
      binPath,
      kind: 'vllm',
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      // Replace an existing vLLM engine at the same path rather than duplicating.
      const existing = c.engines.find((e) => e.kind === 'vllm' && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  /** Register an SGLang engine (kind='sglang'). Like addVllm, the binPath is a
   *  venv python (not a llama-server), so llama.cpp capabilities/flags don't apply. */
  addSglang(name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'SGLang',
      binPath,
      kind: 'sglang',
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      const existing = c.engines.find((e) => e.kind === 'sglang' && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  /** Register a KoboldCpp engine (kind='koboldcpp'). binPath is the single KoboldCpp
   *  binary, not a llama-server, so llama.cpp capabilities/flags don't apply (it uses
   *  its own CLI flag names — see koboldcppProfileToArgs). */
  addKoboldcpp(name: string, binPath: string, version: string): Engine {
    return this.addSingleBinary('koboldcpp', name || 'KoboldCpp', binPath, version)
  }

  /** Register a llamafile engine (kind='llamafile'). binPath is the single llamafile
   *  executable; it runs as llama.cpp's server (launched with --server --no-webui) and
   *  accepts the standard llama.cpp profile flags. */
  addLlamafile(name: string, binPath: string, version: string): Engine {
    return this.addSingleBinary('llamafile', name || 'llamafile', binPath, version)
  }

  /** Shared registration for a single-binary, non-llama-server engine kind (koboldcpp,
   *  llamafile). Mirrors addMlx/addVllm: no llama-server probe, empty capabilities, and
   *  replace-in-place when the same path is re-registered. */
  private addSingleBinary(kind: string, name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || kind,
      binPath,
      kind,
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      const existing = c.engines.find((e) => e.kind === kind && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  rename(id: string, name: string): Engine {
    let out: Engine | undefined
    this.store.update((c) => {
      const e = findEngine(c.engines, id)
      if (!e) throw new NotFoundError()
      const n = name.trim()
      if (!n) throw new ValueError('name', 'name cannot be empty')
      e.name = n
      out = structuredClone(e)
    })
    return out!
  }

  /** Attach (or clear) the source-repo provenance on an existing engine (ADR-088).
   *  A user can point an already-added build at the GitHub repo it was built from so
   *  TurboLLM can detect "newer source available → rebuild". Pass a defined field to
   *  set it (trimmed); an empty string clears it; an undefined field leaves it as-is. */
  setSource(id: string, source: { sourceRepo?: string; sourceBranch?: string }): Engine {
    let out: Engine | undefined
    this.store.update((c) => {
      const e = findEngine(c.engines, id)
      if (!e) throw new NotFoundError()
      if (source.sourceRepo !== undefined) {
        const v = source.sourceRepo.trim()
        if (v) e.sourceRepo = v
        else delete e.sourceRepo
      }
      if (source.sourceBranch !== undefined) {
        const v = source.sourceBranch.trim()
        if (v) e.sourceBranch = v
        else delete e.sourceBranch
      }
      out = structuredClone(e)
    })
    return out!
  }

  remove(id: string): void {
    this.store.update((c) => {
      const i = c.engines.findIndex((e) => e.id === id)
      if (i < 0) throw new NotFoundError()
      c.engines.splice(i, 1)
      if (c.activeEngineId === id) c.activeEngineId = c.engines[0]?.id ?? ''
    })
  }

  /** Record (or refresh) a custom engine's identity so it survives a later Disable —
   *  see {@link CustomEngineSource}. Idempotent: a second call for the same identity
   *  (customSourceKey) overwrites in place rather than accumulating duplicates. */
  recordCustomSource(entry: Omit<CustomEngineSource, 'addedAt'>): void {
    this.store.update((c) => {
      const key = customSourceKey(entry)
      const record: CustomEngineSource = { ...entry, addedAt: new Date().toISOString() }
      const i = c.customEngineSources.findIndex((s) => customSourceKey(s) === key)
      if (i >= 0) c.customEngineSources[i] = record
      else c.customEngineSources.push(record)
    })
  }

  customSources(): CustomEngineSource[] {
    return this.store.snapshot().customEngineSources
  }

  /** Drop a custom engine's remembered identity — called on an explicit purge/delete
   *  (never on a plain Disable, which is exactly what this record is meant to survive). */
  forgetCustomSource(key: string): void {
    this.store.update((c) => {
      c.customEngineSources = c.customEngineSources.filter((s) => customSourceKey(s) !== key)
    })
  }

  activate(id: string): void {
    this.store.update((c) => {
      if (!findEngine(c.engines, id)) throw new NotFoundError()
      c.activeEngineId = id
    })
  }

  /** Set an engine's per-engine auto-update policy (ADR-085). Returns the updated engine. */
  setUpdatePolicy(id: string, policy: UpdatePolicy): Engine {
    let out: Engine | undefined
    this.store.update((c) => {
      const e = findEngine(c.engines, id)
      if (!e) throw new NotFoundError()
      e.updatePolicy = policy
      out = structuredClone(e)
    })
    return out!
  }

  async reprobe(id: string): Promise<Engine> {
    const e = this.get(id)
    if (!e) throw new NotFoundError()
    const pr = await probe(e.binPath)
    let out: Engine | undefined
    this.store.update((c) => {
      const ce = findEngine(c.engines, id)
      if (!ce) throw new NotFoundError()
      ce.version = pr.version
      ce.capabilities = pr.capabilities
      out = structuredClone(ce)
    })
    return out!
  }

  /** Drop registry entries for managed official builds whose binary no longer
   *  exists — e.g. a duplicate left dangling after the data dir moved (ADR-030),
   *  or a backend folder the user deleted by hand. User forks are left untouched
   *  (their binary may be temporarily unavailable). Returns the count removed. */
  pruneDeadManagedBuilds(): number {
    let removed = 0
    for (const e of this.list().engines) {
      if (isManagedBuild(e.binPath) && !existsSync(e.binPath)) {
        try {
          this.remove(e.id)
          removed++
        } catch {
          /* ignore */
        }
      }
    }
    return removed
  }

  /** Best-effort fill version/capabilities for engines with none (migrated), and
   *  refresh engines probed by an older daemon that predates a capability field —
   *  e.g. one with `--spec-type` but no captured `spec-type:<value>` entries, so
   *  NextN/MTP gating has the data it needs without a manual re-probe. */
  async ensureProbed(): Promise<void> {
    for (const e of this.list().engines) {
      // Only 'llama-server'-kind engines go through probe.ts's --help scrape at all
      // (mlx/rapid-mlx/vllm/sglang register with a hand-written, permanently-flagInfo-less
      // capabilities literal — see addMlx/addRapidMlx/addVllm/addSglang in api/routes.ts).
      // Without this guard, Case 3 below would mark those engines stale on every startup and
      // reprobe() would run --version/--help against a non-llama-server binary (e.g. a Python
      // venv interpreter for mlx/vllm), which succeeds and silently overwrites that engine's
      // version/capabilities with garbage instead of failing loudly.
      if (e.kind !== 'llama-server') continue
      if (e.version && !isStaleCapabilities(e.capabilities.flags, e.capabilities.flagInfo)) continue
      try {
        await this.reprobe(e.id)
      } catch {
        /* leave as-is; user can re-probe manually */
      }
    }
  }
}

/** PURE: stable identity key for a custom engine source — sourceRepo+branch+commit when
 *  git-built (a rebuild lands at a different binPath each time, so binPath alone can't be the
 *  key), else the binPath itself (a plain "point at a binary" add has nothing else to key by).
 *  Shared between {@link Registry.recordCustomSource}/{@link Registry.forgetCustomSource} and
 *  a live {@link Engine} so the two can be cross-referenced (same shape: sourceRepo?/
 *  sourceBranch?/sourceCommit?/binPath). */
export function customSourceKey(s: { sourceRepo?: string; sourceBranch?: string; sourceCommit?: string; binPath: string }): string {
  if (!s.sourceRepo) return s.binPath
  return `${normRepoUrl(s.sourceRepo)}#${(s.sourceBranch ?? '').trim().toLowerCase()}#${(s.sourceCommit ?? '').trim().toLowerCase()}`
}

/** True when a saved `capabilities.flags` list was captured by a daemon predating a
 *  fix to how flags are read out of `--help` output, so a stale-but-installed engine
 *  keeps failing the same way after an app upgrade until someone happens to hit
 *  "re-probe" by hand. Checked at every startup (ensureProbed) so the fix in probe.ts
 *  actually reaches engines that were added before it existed — installing a new
 *  TurboLLM build alone does NOT retroactively fix already-cached capability data. */
export function isStaleCapabilities(flags: string[], flagInfo: FlagInfo[] | undefined): boolean {
  // Case 1 (pre-existing): `--spec-type` was captured but its accepted enum values
  // (`spec-type:<value>`) weren't — an older probe that predates that extraction.
  if (flags.includes('--spec-type') && !flags.some((f) => f.startsWith('spec-type:'))) return true
  // Case 2 (GitHub #43): llama.cpp removed --draft-max/--draft-min/--draft/--draft-n/
  // --draft-n-min, but --help still NAMES them inside a "this argument has been
  // removed" notice. A probe from before that fix (see extractFlags in probe.ts)
  // misread the mention as support and cached these as real flags — profileToArgs
  // then passes them straight through and the engine exits immediately on launch.
  // A fresh probe of a genuinely-old llama.cpp that still supports them for real is
  // an idempotent no-op here (the flags stay present either way), so this is safe
  // to check unconditionally.
  if (['--draft-max', '--draft-min', '--draft', '--draft-n', '--draft-n-min'].some((f) => flags.includes(f))) return true
  // Case 3 (spec 22, ADR-328): a probe from before `flagInfo` existed carries no
  // structured per-flag metadata at all — reprobe once to backfill it, so the generic
  // KV-type detection (kvTypes) reaches already-registered engines without a manual
  // re-add. (flagInfo itself is reserved for the Advanced Parameters UI, not currently
  // rendered — see config.ts's Capabilities.flagInfo doc comment.) `[]` (probed the new
  // way, nothing extra to report) is NOT stale; only `undefined` (never probed) is.
  if (flagInfo === undefined) return true
  return false
}

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Cpu,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react'
import {
  useBackendInstall,
  useBuild,
  useEngineBackends,
  useEngineCatalog,
  useEngineMutations,
  useEngineRecommendation,
  useEngineUpdates,
  useEngines,
  useStatus,
  useSysInfo,
  useUpdatePolicyMutation,
} from '../lib/queries'
import { ApiError } from '../lib/api'
import { primaryVendorSummary } from '../lib/vram'
import type {
  CatalogEngine,
  Engine,
  EngineBackends,
  EngineFit,
  EngineRecommendationResult,
  EngineUpdateStatus,
  EnginesList,
  UpdatePolicy,
} from '../lib/types'
import { useUiStore } from '../stores/ui'
import { ScreenHeader, InlineError } from '../components/common'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { toast } from '../components/ui/sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import { AddEngineDialog } from './engines/AddEngineDialog'
import { BuildGuideDialog } from './engines/BuildGuideDialog'
import { EngineStatusHeader } from './engines/EngineStatusHeader'
import { EngineLogPanel } from './engines/EngineLogPanel'
import { LlamaCppBackendRows } from './engines/ManagedEngines'
import {
  groupEngines,
  memberToActivate,
  variantLabel,
  type EngineGroup,
} from '../lib/engine-groups'

const ISSUE_URL =
  'https://github.com/mohitsoni48/TurboLLM/issues/new?template=engine-request.yml'

/** Auto-downloaded official llama.cpp builds live in
 *  `<config>/engines/llama.cpp-<tag>-<backend>/`; everything else is a user fork. */
const isOfficialLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

/** Map a registered engine to its catalog id ('llama.cpp' | 'turboquant' | 'mlx' | 'vllm').
 *  Used to line a running engine up against the recommendation (catalog ids). */
function catalogIdFor(e: Engine): string {
  if (e.kind === 'mlx') return 'mlx'
  if (e.kind === 'vllm') return 'vllm'
  if (e.kind === 'koboldcpp') return 'koboldcpp'
  if (e.kind === 'llamafile') return 'llamafile'
  if (/[\\/]engines[\\/]turboquant[\\/]/.test(e.binPath)) return 'turboquant'
  return 'llama.cpp'
}

/** Human build label for a running engine, e.g. "llama.cpp · CUDA". Derives the GPU
 *  backend from the registered name for official builds; falls back to the kind. */
function buildContextFor(e: Engine, backends: EngineBackends | undefined): string {
  if (e.kind === 'mlx') return 'MLX · Apple Metal'
  if (e.kind === 'vllm') return 'vLLM'
  if (e.kind === 'koboldcpp') return 'KoboldCpp'
  if (e.kind === 'llamafile') return 'llamafile'
  if (isOfficialLlama(e.binPath)) {
    // The active official backend (cuda/metal/…) carries a friendly label.
    const active = backends?.backends.find((b) => b.active)
    return active ? `llama.cpp · ${active.label}` : 'llama.cpp'
  }
  return e.name
}

/**
 * Engines screen (engine overhaul, Phase 2). Three calm zones:
 *  1. Status hero — detected hardware + a "Running now" engine dropdown.
 *  2. Install & manage — one unified catalog driven by the hardware recommendation.
 *  3. Advanced (collapsed) — the GPU build picker + official backend management.
 */
export function EnginesScreen() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const recQ = useEngineRecommendation(provisioning)
  const backendsQ = useEngineBackends(provisioning)
  const logPanelOpen = useUiStore((s) => s.logPanelOpen)
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen)

  const list = enginesQ.data
  const activeId = list?.activeEngineId ?? ''
  const activeEngine = list?.engines.find((e) => e.id === activeId) ?? null

  return (
    <div className="w-full px-6 py-6">
      <ScreenHeader
        title="Engines"
        description="Switch the running engine up top. Install and manage engines below."
        actions={<AddEngineDialog />}
      />

      <div className="flex flex-col gap-5">
        {/* Zone 1 — Status hero */}
        <StatusHero
          rec={recQ.data}
          list={list}
          backends={backendsQ.data}
          activeEngine={activeEngine}
        />

        {/* Running-engine status + live log (kept below the hero). */}
        {activeEngine && (
          <EngineStatusHeader status={status} activeEngineName={activeEngine.name} />
        )}

        {/* Zone 2 — Unified install & manage catalog */}
        {enginesQ.isError ? (
          <InlineError
            message={enginesQ.error instanceof ApiError ? enginesQ.error.message : 'Could not load engines.'}
            onRetry={() => void enginesQ.refetch()}
          />
        ) : (
          <InstallManageCatalog
            rec={recQ.data}
            isLoading={recQ.isLoading}
            activeCatalogId={activeEngine ? catalogIdFor(activeEngine) : null}
            provisioning={provisioning}
          />
        )}

        {/* Other installed llama.cpp builds — separate, below all engines (newest-first). */}
        <OtherLlamaBuildsSection />

        {/* Live engine log */}
        {activeEngine && <EngineLogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />}
      </div>
    </div>
  )
}

// ─── Zone 1 — Status hero ─────────────────────────────────────────────────────

function StatusHero({
  rec,
  list,
  backends,
  activeEngine,
}: {
  rec: EngineRecommendationResult | undefined
  list: EnginesList | undefined
  backends: EngineBackends | undefined
  activeEngine: Engine | null
}) {
  const mut = useEngineMutations()
  const { data: sys } = useSysInfo()
  const { data: updates } = useEngineUpdates()
  const { data: status } = useStatus()
  const build = useBuild()
  const [rebuildOpen, setRebuildOpen] = useState(false)

  // Pull the newly-built engine into the lists whenever ANY in-app build settles — even if
  // the build dialog that started it was closed mid-build (ADR-100) — and surface a global
  // success/error toast so the user always gets confirmation the engine was added. Watches
  // the active→settled transition on the status poll's `engineBuild` so it fires exactly once.
  const wasBuilding = useRef(false)
  const eb = status?.engineBuild
  const buildActive = !!eb?.active
  useEffect(() => {
    if (wasBuilding.current && !buildActive && eb) {
      build.refresh()
      // The CUDA-download step also uses engineBuild; only celebrate an actual engine build.
      if (eb.phase === 'done' && eb.engine && eb.engine !== 'CUDA Toolkit') {
        toast.success(`${eb.engine} built and added — it's now your active engine.`)
      } else if (eb.phase === 'error' && eb.error && eb.engine !== 'CUDA Toolkit') {
        toast.error(eb.error)
      }
    }
    wasBuilding.current = buildActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildActive])

  // Rebuild chip: only when the active source-built engine actually has a NEWER commit.
  // `rebuild` just flags "updates via rebuild" (always true for source engines); the
  // availability signal is `hasUpdate` (built commit ≠ repo HEAD).
  const upd = activeEngine ? updates?.updates[activeEngine.id] : undefined
  const showRebuildChip = !!upd?.rebuild && !!upd?.hasUpdate && !!activeEngine?.sourceRepo

  // Hardware line — prefer the recommendation's hardware (already primary-vendor-summed
  // across all GPUs); before it resolves (or if it errors — that query never retries),
  // fall back to the same sum computed from raw sysinfo, NOT sys.gpus[0]. A single card's
  // number here is exactly the multi-GPU bug users have reported ("shows 8gb, only 1 GPU").
  const hw = rec?.hardware
  const sysFallback = primaryVendorSummary(sys?.gpus ?? [])
  const gpuName = hw?.gpuName ?? sysFallback.gpuName
  const vramMb = hw?.vramMb ?? sysFallback.vramMb
  const osName = hw ? platformName(hw.platform) : sys?.os.split('/')[0] ? platformName(sys.os.split('/')[0]) : ''
  const hwLine = [
    gpuName ?? 'CPU-only',
    vramMb > 0 ? `${(vramMb / 1024).toFixed(0)} GB` : null,
    osName || null,
  ]
    .filter(Boolean)
    .join(' · ')

  // Installed engines = everything in the registry (each is a runnable engine).
  const installed = list?.engines ?? []
  // Group into LOGICAL engines (ADR-091): one row per engine, with per-build variants
  // collapsed underneath. Avoids two near-identical "llama.cpp (cuda)" rows after an update.
  const groups = useMemo(() => groupEngines(installed), [installed])
  const activeGroup = activeEngine
    ? groups.find((g) => g.members.some((m) => m.id === activeEngine.id)) ?? null
    : null
  const activeBuild = activeEngine ? buildContextFor(activeEngine, backends) : null

  // Does the running engine match the hardware recommendation?
  const recEngineId = rec?.recommendation.recommended?.engineId
  const activeMatchesRec =
    !!activeEngine && !!recEngineId && catalogIdFor(activeEngine) === recEngineId

  const busy = mut.activate.isPending

  const activate = (id: string) => {
    if (id === activeEngine?.id) return
    mut.activate.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not switch engine.'),
    })
  }

  // Selecting a logical engine activates its currently-active member if present, else
  // its latest build / first member (ADR-091).
  const selectGroup = (g: EngineGroup) => {
    const target = memberToActivate(g, activeEngine?.id ?? null)
    if (target) activate(target.id)
  }

  return (
    <div
      className="rounded-lg border border-border bg-panel p-4"
      style={{ background: 'color-mix(in srgb, var(--ok) 5%, var(--panel))' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <Cpu size={13} className="shrink-0" style={{ color: 'var(--ok)' }} />
            Your hardware
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-ink">{hwLine || 'Detecting…'}</div>
        </div>

        <div className="flex flex-col items-start gap-1 md:items-end">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Running now</span>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy || groups.length === 0}
                className="flex h-9 min-w-[220px] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
              >
                <span className="flex h-2 w-2 shrink-0 rounded-full" style={{ background: activeEngine ? 'var(--ok)' : 'var(--faint)' }} />
                <span className="flex-1 truncate text-left">
                  {activeGroup?.label ?? (groups.length ? 'No engine active' : 'No engine installed')}
                </span>
                <ChevronDown size={14} className="shrink-0 text-muted" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[280px]">
                <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                  Installed engines
                </div>
                {groups.length === 0 && (
                  <div className="px-2 py-1.5 text-[12px] text-muted">Install an engine below to get started.</div>
                )}
                {groups.map((g) => {
                  // Source-built engines (ADR-088): surface a notify-only "rebuild" hint when
                  // ANY member has a newer commit on its source repo. Badge only (we can't recompile).
                  const rebuild = g.members.some(
                    (m) => !!updates?.updates[m.id]?.rebuild && !!updates?.updates[m.id]?.hasUpdate,
                  )
                  const isActiveGroup = g.key === activeGroup?.key
                  return (
                    <DropdownMenuItem key={g.key} onSelect={() => selectGroup(g)} className="flex items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {isActiveGroup && <Check size={14} className="text-accent" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">{g.label}</span>
                      {g.members.length > 1 && (
                        <span className="shrink-0 text-[11px] text-faint">{g.members.length} builds</span>
                      )}
                      {rebuild && (
                        <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent)' }}>
                          rebuild
                        </span>
                      )}
                      {isActiveGroup && <span className="shrink-0 text-[11px] text-accent">active</span>}
                    </DropdownMenuItem>
                  )
                })}
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[11px] text-faint">Install more engines below ↓</div>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Version/build picker — only when the active engine has more than one
                installed variant (ADR-091). Single-variant engines keep the clean one-line look. */}
            {activeGroup && activeGroup.members.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy}
                  className="flex h-9 min-w-[160px] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
                >
                  <Layers size={14} className="shrink-0 text-accent" />
                  <span className="flex-1 truncate text-left">
                    {activeEngine ? variantLabel(activeEngine) : 'Choose a build'}
                  </span>
                  <ChevronDown size={14} className="shrink-0 text-muted" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[260px]">
                  <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                    Version
                  </div>
                  {activeGroup.members.map((m) => (
                    <DropdownMenuItem key={m.id} onSelect={() => activate(m.id)} className="flex items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {m.id === activeEngine?.id && <Check size={14} className="text-accent" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">{variantLabel(m)}</span>
                      {m.id === activeGroup.latestId && (
                        <span className="shrink-0 text-[11px]" style={{ color: 'var(--ok)' }}>
                          latest
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {activeBuild && <span className="text-[11px] text-muted">{activeBuild}</span>}
          {activeMatchesRec && (
            <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--ok)' }}>
              <Sparkles size={11} /> recommended for your hardware
            </span>
          )}
          {showRebuildChip && (
            <button
              type="button"
              onClick={() => setRebuildOpen(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
              style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
            >
              <Wrench size={11} className="shrink-0" />
              Rebuild available
              {upd?.installed && upd?.latest ? ` · ${upd.installed} → ${upd.latest}` : ''}
            </button>
          )}
        </div>
      </div>

      {showRebuildChip && activeEngine?.sourceRepo && (
        <BuildGuideDialog
          open={rebuildOpen}
          onOpenChange={setRebuildOpen}
          repoUrl={activeEngine.sourceRepo}
          branch={activeEngine.sourceBranch}
          engineName={activeEngine.name}
          mode="rebuild"
        />
      )}
    </div>
  )
}

// ─── Zone 2 — Unified install & manage catalog ────────────────────────────────

function InstallManageCatalog({
  rec,
  isLoading,
  activeCatalogId,
  provisioning,
}: {
  rec: EngineRecommendationResult | undefined
  isLoading: boolean
  activeCatalogId: string | null
  provisioning: boolean
}) {
  const catalogQ = useEngineCatalog(provisioning)
  const { data: registry } = useEngines()
  const { data: updates } = useEngineUpdates(provisioning)
  const install = useBackendInstall()
  const engineMut = useEngineMutations()
  const policyMut = useUpdatePolicyMutation()
  const [deleteTarget, setDeleteTarget] = useState<{ e: CatalogEngine; registryId: string } | null>(null)

  // Disk/registry install state lives in the catalog endpoint; the fit/badge
  // ordering lives in the recommendation. Join them by id.
  const catalogById = useMemo(() => {
    const m = new Map<string, CatalogEngine>()
    for (const e of catalogQ.data?.engines ?? []) m.set(e.id, e)
    return m
  }, [catalogQ.data])

  if (isLoading || !rec) {
    return (
      <section className="flex flex-col gap-2">
        <SectionLabel>Install &amp; manage</SectionLabel>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
    )
  }

  const anyPending =
    provisioning ||
    install.vllm.isPending ||
    install.mlx.isPending ||
    install.turboquant.isPending ||
    install.koboldcpp.isPending ||
    install.llamafile.isPending ||
    install.updateVllm.isPending ||
    install.updateMlx.isPending ||
    install.updateTurboquant.isPending ||
    install.updateKoboldcpp.isPending ||
    install.updateLlamafile.isPending ||
    engineMut.remove.isPending ||
    engineMut.purge.isPending

  // ── lifecycle (mirrors ManagedEngines.DiscoverEngines) ──
  const installFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.vllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.mlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.turboquant
    if (e.installEndpoint === '/api/v1/engines/koboldcpp') return install.koboldcpp
    if (e.installEndpoint === '/api/v1/engines/llamafile') return install.llamafile
    return null
  }
  const updateFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.updateVllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.updateMlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.updateTurboquant
    if (e.installEndpoint === '/api/v1/engines/koboldcpp') return install.updateKoboldcpp
    if (e.installEndpoint === '/api/v1/engines/llamafile') return install.updateLlamafile
    return null
  }
  const registryEngineId = (e: CatalogEngine): string | undefined => {
    const eng = registry?.engines ?? []
    // Source-built engines (ADR-100): the backend already matched the registry entry by repo.
    if (e.sourceEngineId) return e.sourceEngineId
    if (e.provision === 'pip') return eng.find((x) => x.kind === e.kind)?.id
    if (e.id === 'turboquant') return eng.find((x) => /[\\/]engines[\\/]turboquant[\\/]/.test(x.binPath))?.id
    if (e.id === 'koboldcpp' || e.id === 'llamafile') return eng.find((x) => x.kind === e.kind)?.id
    return undefined
  }
  const doInstall = (e: CatalogEngine) => {
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not install ${e.name}.`),
    })
  }
  const doEnable = (e: CatalogEngine) => {
    // Source-built engine that was disabled (registry entry removed, build output still on
    // disk): re-register the built binary rather than the prebuilt-install path (ADR-100).
    if (e.sourceBuilt && e.sourceBinPath) {
      engineMut.add.mutate(
        { binPath: e.sourceBinPath, name: e.name, sourceRepo: e.homepage, sourceBranch: e.sourceBranch || undefined },
        {
          onSuccess: () => toast.success(`${e.name} enabled`),
          onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not enable ${e.name}.`),
        },
      )
      return
    }
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`${e.name} enabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not enable ${e.name}.`),
    })
  }
  const doDisable = (e: CatalogEngine) => {
    const id = registryEngineId(e)
    if (!id) { toast.error(`Could not find the installed ${e.name} engine.`); return }
    engineMut.remove.mutate(id, {
      onSuccess: () => toast.success(`${e.name} disabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not disable ${e.name}.`),
    })
  }
  const doUpdate = (e: CatalogEngine) => {
    const m = updateFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`Updating ${e.name} to the latest release…`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not update ${e.name}.`),
    })
  }
  const setPolicy = (e: CatalogEngine, policy: UpdatePolicy) => {
    const id = registryEngineId(e)
    if (!id) { toast.error(`Could not find the installed ${e.name} engine.`); return }
    policyMut.mutate(
      { id, policy },
      { onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change auto-update.') },
    )
  }
  const requestDelete = (e: CatalogEngine) => {
    const registryId = registryEngineId(e)
    if (!registryId) { toast.error(`Could not find the installed ${e.name} engine to delete.`); return }
    setDeleteTarget({ e, registryId })
  }
  const doDelete = () => {
    if (!deleteTarget) return
    engineMut.purge.mutate(deleteTarget.registryId, {
      onSuccess: () => {
        toast.success(`${deleteTarget.e.name} deleted`)
        setDeleteTarget(null)
      },
      onError: (err) => {
        setDeleteTarget(null)
        toast.error(err instanceof ApiError ? err.message : `Could not delete ${deleteTarget.e.name}.`)
      },
    })
  }

  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Install &amp; manage</SectionLabel>

      {rec.recommendation.fits
        .filter((fit) => {
          // Hide engines not supported on this OS — except vLLM, which we keep visible
          // (greyed, "Linux only") as the advertised power-user option (user request).
          const c = catalogById.get(fit.engine.id)
          return fit.engine.id === 'vllm' || !c || c.supportedHere !== false
        })
        .map((fit) => {
        // llama.cpp is the built-in default: its GPU builds are managed inline here (no
        // separate "Advanced" section), so it gets a dedicated row, not the generic one.
        if (fit.engine.id === 'llama.cpp') {
          // llama.cpp = the recommended backend (e.g. CUDA), as its own manage-only row.
          // The other backends live in the "Other llama.cpp builds" section below all engines.
          return <LlamaCppBackendRows key={fit.engine.id} filter="recommended" />
        }
        const regId = registryEngineId(catalogById.get(fit.engine.id) ?? fit.engine as CatalogEngine)
        return (
        <CatalogFitRow
          key={fit.engine.id}
          fit={fit}
          catalog={catalogById.get(fit.engine.id)}
          isActive={activeCatalogId === fit.engine.id}
          anyPending={anyPending}
          provisioning={provisioning}
          updateStatus={regId ? updates?.updates[regId] : undefined}
          policy={(regId ? updates?.policies[regId] : undefined) ?? 'notify'}
          installFor={installFor}
          onInstall={doInstall}
          onEnable={doEnable}
          onDisable={doDisable}
          onUpdate={doUpdate}
          onDelete={requestDelete}
          onSetPolicy={setPolicy}
        />
        )
      })}

      {/* Add your own engine — first-class item in this zone. */}
      <div className="flex items-center gap-3 rounded-[var(--radius)] border border-dashed border-border-strong bg-panel p-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Add your own engine</div>
          <div className="mt-0.5 text-[12px] text-muted">
            Point TurboLLM at any llama-server compatible binary — mainline llama.cpp or a community fork.
          </div>
        </div>
        <div className="shrink-0">
          <AddEngineDialog />
        </div>
      </div>

      {/* Quiet "register it" link at the very bottom. */}
      <a
        href={ISSUE_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 self-start text-[12px] text-muted hover:text-ink"
      >
        Don&apos;t see your engine? Register it <ExternalLink size={11} />
      </a>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.e.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Files for this engine are removed from disk. Your models are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} disabled={engineMut.purge.isPending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** One unified catalog row driven by the engine fit + its catalog install state. */
function CatalogFitRow({
  fit,
  catalog,
  isActive,
  anyPending,
  provisioning,
  updateStatus,
  policy,
  installFor,
  onInstall,
  onEnable,
  onDisable,
  onUpdate,
  onDelete,
  onSetPolicy,
}: {
  fit: EngineFit
  catalog: CatalogEngine | undefined
  isActive: boolean
  anyPending: boolean
  provisioning: boolean
  updateStatus: EngineUpdateStatus | undefined
  policy: UpdatePolicy
  installFor: (e: CatalogEngine) => { isPending: boolean } | null
  onInstall: (e: CatalogEngine) => void
  onEnable: (e: CatalogEngine) => void
  onDisable: (e: CatalogEngine) => void
  onUpdate: (e: CatalogEngine) => void
  onDelete: (e: CatalogEngine) => void
  onSetPolicy: (e: CatalogEngine, policy: UpdatePolicy) => void
}) {
  const e = fit.engine
  const [guideOpen, setGuideOpen] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const isLlama = e.id === 'llama.cpp'
  const sourceBuilt = !!catalog?.sourceBuilt
  const incompatible = fit.compatible.length === 0
  // Compatible here, but no prebuilt for this OS (e.g. ik_llama everywhere, TurboQuant
  // on Windows/Linux) → "build from source → Add your own" instead of a dead Install.
  const buildYourself = !incompatible && fit.compatible.every((v) => !v.hasPrebuilt)
  const experimental = e.support === 'experimental'
  const isInstalled = !!catalog?.installed
  const isEnabled = !!catalog?.enabled
  const isDisabled = isInstalled && !isEnabled

  return (
    <div
      className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-panel p-4"
      style={incompatible ? { opacity: 0.65 } : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-ink">{e.name}</span>

          {/* Fit badge: recommended → accent; active → Active (--ok); else Installed. */}
          {fit.recommended ? (
            <Badge variant="accent">
              <Sparkles size={10} /> Recommended for you
            </Badge>
          ) : isActive ? (
            <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--ok)' }}>
              <Check size={11} /> Active
            </span>
          ) : isEnabled ? (
            <span className="flex items-center gap-1 text-[11px] font-medium text-muted">
              <Check size={11} /> Installed
            </span>
          ) : null}

          {experimental && <Badge variant="mono">experimental</Badge>}
          {e.id === 'vllm' && <Badge variant="mono">For power users</Badge>}
          {isDisabled && <Badge variant="mono">Disabled</Badge>}
          {isEnabled && updateStatus?.hasUpdate && !updateStatus?.rebuild && (
            <Badge variant="accent">Update available</Badge>
          )}
          {incompatible && fit.incompatibleReason && (
            <Badge variant="mono">{fit.incompatibleReason}</Badge>
          )}

          {catalog && (
            <a
              href={catalog.homepage}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-0.5 text-[11px] text-muted hover:text-ink"
              title={catalog.homepage}
            >
              <ExternalLink size={10} /> docs
            </a>
          )}
        </div>

        <div className="mt-0.5 text-[12px] text-muted">{e.description}</div>
        {isLlama && (
          <div className="mt-1 text-[11px] text-faint">
            Pick a specific GPU build in Advanced below.
          </div>
        )}
        {/* Honest per-engine update status (ADR-085) for enabled non-llama engines.
            Never claims "up to date" without a real upstream check. */}
        {!isLlama && isEnabled && (
          <div className="mt-1">
            <CatalogUpdateStatusLine st={updateStatus} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {isLlama ? (
          // llama.cpp is the built-in default — its builds are managed in Zone 3.
          <span className="text-[12px] text-faint">built-in</span>
        ) : !catalog ? null : isInstalled ? (
          <>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${e.name}`}
              disabled={anyPending}
              className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {sourceBuilt ? (
                // Source-built engines update by RECOMPILING at the latest commit (ADR-088/100),
                // not by downloading a prebuilt. `rebuild` flags a newer commit on the source repo.
                <DropdownMenuItem onSelect={() => setRebuildOpen(true)} disabled={anyPending}>
                  <RefreshCw size={14} /> {updateStatus?.hasUpdate ? 'Rebuild (new commit)' : 'Rebuild'}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onUpdate(catalog)} disabled={provisioning}>
                  <Download size={14} /> {updateStatus?.hasUpdate ? 'Update now' : 'Update'}
                </DropdownMenuItem>
              )}
              {isEnabled ? (
                <DropdownMenuItem onSelect={() => onDisable(catalog)}>Disable</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onEnable(catalog)}>Enable</DropdownMenuItem>
              )}
              {isEnabled && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                    Auto-update
                  </div>
                  {(['off', 'notify', 'auto'] as UpdatePolicy[]).map((p) => (
                    <DropdownMenuItem
                      key={p}
                      onSelect={() => onSetPolicy(catalog, p)}
                      className="flex items-center gap-2"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {policy === p && <Check size={13} className="text-accent" />}
                      </span>
                      {AUTO_UPDATE_LABEL[p]}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => onDelete(catalog)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Rebuild: recompile the source-built engine at the latest commit (ADR-088/100). */}
          {sourceBuilt && catalog && (
            <BuildGuideDialog
              open={rebuildOpen}
              onOpenChange={setRebuildOpen}
              repoUrl={catalog.homepage}
              branch={catalog.sourceBranch || undefined}
              engineName={e.name}
              mode="rebuild"
            />
          )}
          </>
        ) : buildYourself ? (
          // Build-it-yourself fork — compatible here but no prebuilt for this OS
          // (ik_llama everywhere; TurboQuant on Windows/Linux). Open the guided build
          // flow (ADR-089): prereq check + exact commands + hand-off to "Add your own
          // engine" with the repo prefilled. The repo link stays reachable inside it.
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGuideOpen(true)}
              title="No prebuilt binary — build it from source with a guided walkthrough."
            >
              Build from source
            </Button>
            <BuildGuideDialog
              open={guideOpen}
              onOpenChange={setGuideOpen}
              repoUrl={catalog.homepage}
              engineName={e.name}
            />
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={anyPending || incompatible || catalog.comingSoon || !installFor(catalog)}
            onClick={() => onInstall(catalog)}
            title={
              catalog.comingSoon
                ? 'Not yet available'
                : incompatible
                  ? fit.incompatibleReason ?? 'Not supported on this hardware'
                  : `Install ${e.name}`
            }
          >
            {installFor(catalog)?.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            {catalog.comingSoon ? 'Coming soon' : 'Install'}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── "Other llama.cpp" section — the non-recommended backends, below all engines ──────

/** A section BELOW all engines listing the OTHER official llama.cpp backends (ROCm, CPU,
 *  Vulkan, SYCL — everything except the GPU-recommended one, which lives in "Install &
 *  manage"). Manage-only (download / update / delete); switching the active engine is done
 *  from the top "Running now" dropdown, not here. */
function OtherLlamaBuildsSection() {
  // Collapsed by default — these are the non-recommended backends, secondary to the catalog.
  const [open, setOpen] = useState(false)
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronDown
          size={14}
          className="shrink-0 text-muted transition-transform"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
        <SectionLabel>Other llama.cpp builds</SectionLabel>
        <span className="text-[11px] text-faint">ROCm · CPU · Vulkan · SYCL</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-muted">
            The other GPU/CPU backends for llama.cpp. Download one, then switch to it from the engine
            dropdown up top. The recommended backend is in “Install &amp; manage”.
          </p>
          <LlamaCppBackendRows filter="others" />
        </div>
      )}
    </section>
  )
}


// ─── shared helpers ───────────────────────────────────────────────────────────

const AUTO_UPDATE_LABEL: Record<UpdatePolicy, string> = { off: 'Off', notify: 'Notify', auto: 'Auto' }

/** Compact relative-time for the last update check ("just now", "3h ago", "2d ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Honest one-line update status for a catalog row (ADR-085). Never claims "up to date"
 *  without a real upstream check; offline/uncheckable says so explicitly. */
function CatalogUpdateStatusLine({ st, repoUrl }: { st: EngineUpdateStatus | undefined; repoUrl?: string }) {
  if (!st) return null
  if (st.error === 'offline') {
    return <span className="text-[11px] text-faint">Couldn&apos;t check for updates (offline)</span>
  }
  if (st.error === 'no_source' || !st.comparable) {
    return <span className="text-[11px] text-faint">Update status unavailable</span>
  }
  // Source-built engines (ADR-088): notify-only — we can't recompile, so link the repo
  // instead of offering a one-click update.
  if (st.rebuild && st.hasUpdate) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
        Newer source available · rebuild{' '}
        {repoUrl && (
          <a href={repoUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
            (open repo)
          </a>
        )}
      </span>
    )
  }
  if (st.hasUpdate && st.latest) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
        Update available · {st.installed || '?'} → {st.latest}
      </span>
    )
  }
  return (
    <span className="text-[11px] text-faint">
      Up to date · {st.latest ?? st.installed}
      {st.checkedAt ? ` · checked ${relativeTime(st.checkedAt)}` : ''}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-faint">{children}</p>
}

const PLATFORM_DISPLAY: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}
function platformName(p: string): string {
  return PLATFORM_DISPLAY[p] ?? p
}

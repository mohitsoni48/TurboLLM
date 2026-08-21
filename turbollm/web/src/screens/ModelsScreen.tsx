import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  CircleSlash,
  Download,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  PackageSearch,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { ApiError, deleteModel, track } from '../lib/api'
import { queryKeys, useModelActions, useModelDirs, useModelMutations, useModels, useStatus } from '../lib/queries'
import { useOnboardingState } from '../lib/onboarding-queries'
import { usePinnedModels } from '../lib/usePinnedModels'
import type { ModelEntry } from '../lib/types'
import { cn } from '../lib/utils'
import { useIsDesktop } from '../lib/useIsDesktop'
import { EmptyState, InlineError, ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { toast } from '../components/ui/sonner'
import { mergeFleet, fleetMachines, type FleetMachine, type FleetOrigin, type FleetRow } from '../lib/fleet'
import {
  ALL_MACHINES,
  filterByMachine,
  machineOptions,
  remoteModel,
  remoteModelMatches,
  sourcesByLink,
  type FleetModel,
  type MachineOption,
} from '../lib/fleet-sources'
import { useLinks, useRemoteModels, useRemoteModelActions } from '../lib/link-queries'
import type { LinkSummary } from '../lib/link-api'
import { MachineFilter, MachineNotes, OriginBadge } from '../components/fleet'
import { RemoteModelRow } from './models/RemoteModelRow'
import { ModelDetailDialog } from './models/ModelDetailDialog'
import { DiscoverTab } from './models/DiscoverTab'
import { HfRepoDialog } from './models/HfRepoDialog'
import { FsBrowser } from './engines/FsBrowser'

type Filter = 'all' | 'vision' | 'moe' | 'nextn' | 'embedding'
type Tab = 'library' | 'discover'

/** A model name shared by 2+ quant variants renders as one row with a quant dropdown;
 *  a single-variant name is a plain row (spec 04 §2 / spec 11 §5). */
type Group = { name: string; variants: ModelEntry[] }

/** One row of the merged library. A LOCAL row is a whole quant `Group` (the existing
 *  behaviour — several quants of one model collapse into a single row with a dropdown); a
 *  REMOTE row is a single model.
 *
 *  Quants are deliberately NOT collapsed across machines. Two machines holding the same
 *  Q4_K_M are two different things you can do — load it here, or load it there — and folding
 *  them into one row would make the fleet's whole point invisible. */
type LibRow = { kind: 'local'; group: Group } | { kind: 'remote'; model: FleetModel }

/** Shared grid template so the column header and every row line up exactly. */
const ROW_GRID: CSSProperties = { gridTemplateColumns: 'minmax(0,1fr) 104px 64px 52px 78px 148px' }

function groupModels(models: ModelEntry[], isPinned: (key: string) => boolean): Group[] {
  const byName = new Map<string, ModelEntry[]>()
  for (const m of models) {
    const k = m.name.toLowerCase()
    ;(byName.get(k) ?? byName.set(k, []).get(k)!).push(m)
  }
  const order: string[] = []
  const seen = new Set<string>()
  for (const m of models) {
    const k = m.name.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      order.push(k)
    }
  }
  const groups = order.map((k) => ({ name: byName.get(k)![0].name, variants: byName.get(k)! }))
  // Pinned models float to the top; a group is pinned when any variant is pinned.
  const isGroupPinned = (g: Group) => g.variants.some((v) => isPinned(v.key))
  return [...groups.filter(isGroupPinned), ...groups.filter((g) => !isGroupPinned(g))]
}

export function ModelsScreen() {
  const navigate = useNavigate()
  // Onboarding's Discover handoff (Pro, "pick a different model", "nothing fits this
  // machine") sends the user here mid-wizard. App.tsx's own resume-poller only catches
  // a download's downloading→done transition — found live by adversarial QA: a user who
  // just browses without downloading, cancels, or hits a download error is left here with
  // no onboarding chrome at all (no "X of 7", no way back except typing /onboarding by
  // hand), while onboarding.status stays 'pending' server-side. This banner is the general
  // fallback that covers every one of those paths, not just the one App.tsx already
  // handles: it shows whenever onboarding is still genuinely unfinished, however the user
  // got here.
  const onboardingQ = useOnboardingState()
  const stillOnboarding =
    onboardingQ.data !== undefined &&
    onboardingQ.data.status === 'pending' &&
    !onboardingQ.data.everLoadedModel
  const modelsQ = useModels()
  const dirsQ = useModelDirs()
  const mut = useModelMutations()
  const actions = useModelActions()
  const del = useDeleteModel()
  const { data: status } = useStatus()
  const { isPinned, togglePinned } = usePinnedModels()
  const linksQ = useLinks()
  const remoteModelsQ = useRemoteModels()
  const remoteActions = useRemoteModelActions()

  // A load isn't instant: POST /load returns 202, then the engine spends seconds in
  // `starting` before `running`. Keep the Load buttons busy across that whole window.
  const engineState = status?.engine.state
  const loadBusy = actions.load.isPending || engineState === 'starting' || engineState === 'stopping'
  const loadingKey = actions.load.isPending
    ? actions.load.variables?.key
    : engineState === 'starting'
      ? status?.model?.key
      : undefined

  // Reads the `tab` query param on mount so links like `/models?tab=discover`
  // (onboarding's Pro Discover handoff and its "pick a different model"
  // escape hatches) actually land on Discover, not the default Library.
  // Found by adversarial QA: the URL correctly changed to
  // `?tab=discover`, but `useState<Tab>('library')` never read it, so
  // Library stayed the rendered tab regardless. One-time read on mount, not
  // a synced-forever URL state — matches this component's existing pattern
  // of `onDiscover` calling `setTab('discover')` as a plain internal
  // transition, not a URL-driven one.
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'discover' ? 'discover' : 'library')
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ModelEntry | null>(null)
  // "Find other quants": jump to the source repo when known, else Discover by name.
  const [discoverRepo, setDiscoverRepo] = useState<string | null>(null)
  const [presetSearch, setPresetSearch] = useState('')
  // Which machine's rows to show. Defaults to everything: a fleet list that opened filtered
  // would hide the very machines the feature exists to surface.
  const [machineFilter, setMachineFilter] = useState<string>(ALL_MACHINES)
  /** Remote action failures, keyed `<linkId>:<modelKey>` so two failing rows show two
   *  different reasons rather than one shared banner. */
  const [remoteFailures, setRemoteFailures] = useState<Record<string, unknown>>({})
  const onDiscover = (m: ModelEntry) => {
    if (m.sourceRepo) {
      setDiscoverRepo(m.sourceRepo)
    } else {
      setPresetSearch(m.name)
      setTab('discover')
    }
  }

  const scanning = modelsQ.data?.scanning ?? false
  const models = modelsQ.data?.models ?? []
  const dirs = dirsQ.data?.dirs ?? []
  const primaryDir = dirsQ.data?.primaryDir ?? ''
  const incompatibleCount = models.filter((m) => !m.compatibleWithActiveEngine).length

  // Facet-aware filter chips: only offer a facet that at least one model actually has.
  const facetCounts = useMemo(
    () => ({
      vision: models.filter((m) => m.vision).length,
      moe: models.filter((m) => m.moe).length,
      nextn: models.filter((m) => (m.nextnLayers ?? 0) > 0).length,
      embedding: models.filter((m) => m.embedding).length,
    }),
    [models],
  )

  const q = search.trim().toLowerCase()
  const filtered = models.filter((m) => {
    if (!showIncompatible && !m.compatibleWithActiveEngine) return false
    if (q && !m.name.toLowerCase().includes(q)) return false
    if (filter === 'vision') return m.vision
    if (filter === 'moe') return m.moe
    if (filter === 'nextn') return (m.nextnLayers ?? 0) > 0
    if (filter === 'embedding') return m.embedding
    return true
  })
  const groups = groupModels(filtered, isPinned)

  // ── Turbo Link: the rest of the fleet ────────────────────────────────────────
  // Both reads are host-gated and soft (`retry: false` + `?? []`), so a browser off-box —
  // or a daemon too old to know the routes — sees exactly the pre-Turbo-Link screen rather
  // than an error banner.
  const links: LinkSummary[] = linksQ.data ?? []
  const remoteSources = sourcesByLink(links, remoteModelsQ.data ?? [], (r) => r.linkId).map((s) => ({
    link: s.link,
    rows: s.rows.map((r) => remoteModel(r.model)).filter((m) => remoteModelMatches(m, { q, facet: filter })),
  }))
  // The merge itself: local rows first, then each machine's block, order fully determined by
  // the helper. Nothing here sorts.
  const fleetRows = mergeFleet<LibRow>(
    groups.map((g) => ({ kind: 'local' as const, group: g })),
    remoteSources.map((s) => ({
      link: s.link,
      rows: s.rows.map((m) => ({ kind: 'remote' as const, model: m })),
    })),
  )
  const visibleRows = filterByMachine(fleetRows, machineFilter)
  // Machine headers come from the UNFILTERED sources, so selecting "All machines" still
  // explains an offline machine that contributed nothing.
  const machines = fleetMachines(remoteSources)
  const machineOpts = machineOptions(links)

  const linkFor = (linkId: string) => links.find((l) => l.id === linkId)

  const onRemoteLoad = (linkId: string, modelKey: string) => {
    track('models', 'load_remote_model')
    remoteActions.load.mutate({ linkId, modelKey }, {
      onError: (e) => setRemoteFailures((f) => ({ ...f, [`${linkId}:${modelKey}`]: e })),
      onSuccess: () => setRemoteFailures((f) => {
        const n = { ...f }; delete n[`${linkId}:${modelKey}`]; return n
      }),
    })
  }
  const onRemoteUnload = (linkId: string, modelKey: string) => {
    track('models', 'unload_remote_model')
    remoteActions.unload.mutate({ linkId }, {
      onError: (e) => setRemoteFailures((f) => ({ ...f, [`${linkId}:${modelKey}`]: e })),
      onSuccess: () => setRemoteFailures((f) => {
        const n = { ...f }; delete n[`${linkId}:${modelKey}`]; return n
      }),
    })
  }

  const onConfirmDelete = () => {
    const m = confirmDelete
    if (!m) return
    track('models', 'delete_model')
    del.mutate(m.key, {
      onSuccess: () => {
        toast.success(`Deleted ${m.name}`)
        setConfirmDelete(null)
      },
      onError: (e) => {
        toast.error(e instanceof ApiError ? e.message : 'Could not delete model files.')
        setConfirmDelete(null)
      },
    })
  }

  return (
    <div
      className={
        tab === 'discover'
          ? 'flex h-full w-full flex-col overflow-hidden px-4 py-6 md:px-6'
          : 'h-full w-full overflow-y-auto px-4 py-6 md:px-6'
      }
    >
      <ScreenHeader
        title="Models"
        description={
          tab === 'library'
            ? 'GGUF models discovered in your folders — reuse what you already have, no re-downloading.'
            : 'Find and download GGUF models from Hugging Face, or import any direct .gguf URL.'
        }
      />

      {stillOnboarding && (
        <button
          type="button"
          onClick={() => { track('onboarding', 'resume_onboarding'); navigate('/onboarding') }}
          className="mb-5 flex w-full items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-left transition-colors hover:bg-accent/10"
        >
          <span className="text-sm text-ink">
            <span className="font-medium">Setup isn't finished yet</span> — pick or download a
            model here, then jump back to finish getting started.
          </span>
          <span className="flex flex-shrink-0 items-center gap-1 text-sm font-medium text-accent">
            Resume setup <ArrowRight size={14} />
          </span>
        </button>
      )}

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {(['library', 'discover'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { track('models', 'switch_models_tab'); setTab(t) }}
            className="-mb-px border-b-2 px-3 py-2 text-[13px] font-medium capitalize transition-colors"
            style={{
              borderColor: tab === t ? 'var(--accent)' : 'transparent',
              color: tab === t ? 'var(--ink)' : 'var(--muted)',
            }}
          >
            {t === 'library' ? `Library${models.length ? ` (${models.length})` : ''}` : 'Discover'}
          </button>
        ))}
      </div>

      {tab === 'discover' ? (
        <div className="min-h-0 flex-1">
          <DiscoverTab presetQuery={presetSearch} />
        </div>
      ) : (
        <LibraryTab
          modelsQ={modelsQ}
          actions={actions}
          loadBusy={loadBusy}
          loadingKey={loadingKey}
          dirs={dirs}
          scanning={scanning}
          models={models}
          search={search}
          setSearch={setSearch}
          filter={filter}
          setFilter={setFilter}
          facetCounts={facetCounts}
          incompatibleCount={incompatibleCount}
          showIncompatible={showIncompatible}
          setShowIncompatible={setShowIncompatible}
          rescan={() => mut.rescan.mutate()}
          openFolders={() => setFoldersOpen(true)}
          rows={visibleRows}
          machines={machines}
          machineOpts={machineOpts}
          machineFilter={machineFilter}
          setMachineFilter={setMachineFilter}
          linkFor={linkFor}
          onRemoteLoad={onRemoteLoad}
          onRemoteUnload={onRemoteUnload}
          remoteBusy={remoteActions.load.isPending || remoteActions.unload.isPending}
          remoteFailures={remoteFailures}
          setOpenKey={setOpenKey}
          setConfirmDelete={setConfirmDelete}
          onDiscover={onDiscover}
          isPinned={isPinned}
          togglePinned={togglePinned}
        />
      )}

      <ModelFoldersDialog
        open={foldersOpen}
        onOpenChange={setFoldersOpen}
        dirs={dirs}
        primaryDir={primaryDir}
        mut={mut}
      />
      <ModelDetailDialog
        modelKey={openKey}
        onClose={() => setOpenKey(null)}
        onViewRepo={(repo) => {
          setOpenKey(null)
          setDiscoverRepo(repo)
        }}
      />
      <HfRepoDialog
        repo={discoverRepo}
        onClose={() => setDiscoverRepo(null)}
        onSearch={(term) => {
          setDiscoverRepo(null)
          setPresetSearch(term)
          setTab('discover')
        }}
      />
      <DeleteModelDialog
        model={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={onConfirmDelete}
        deleting={del.isPending}
      />
    </div>
  )
}

function LibraryTab({
  modelsQ,
  actions,
  loadBusy,
  loadingKey,
  dirs,
  scanning,
  models,
  search,
  setSearch,
  filter,
  setFilter,
  facetCounts,
  incompatibleCount,
  showIncompatible,
  setShowIncompatible,
  rescan,
  openFolders,
  rows,
  machines,
  machineOpts,
  machineFilter,
  setMachineFilter,
  linkFor,
  onRemoteLoad,
  onRemoteUnload,
  remoteBusy,
  remoteFailures,
  setOpenKey,
  setConfirmDelete,
  onDiscover,
  isPinned,
  togglePinned,
}: {
  modelsQ: ReturnType<typeof useModels>
  actions: ReturnType<typeof useModelActions>
  loadBusy: boolean
  loadingKey: string | undefined
  dirs: string[]
  scanning: boolean
  models: ModelEntry[]
  search: string
  setSearch: (s: string) => void
  filter: Filter
  setFilter: (f: Filter) => void
  facetCounts: { vision: number; moe: number; nextn: number; embedding: number }
  incompatibleCount: number
  showIncompatible: boolean
  setShowIncompatible: (v: boolean) => void
  rescan: () => void
  openFolders: () => void
  rows: FleetRow<LibRow>[]
  machines: FleetMachine[]
  machineOpts: MachineOption[]
  machineFilter: string
  setMachineFilter: (id: string) => void
  linkFor: (linkId: string) => LinkSummary | undefined
  onRemoteLoad: (linkId: string, modelKey: string) => void
  onRemoteUnload: (linkId: string, modelKey: string) => void
  remoteBusy: boolean
  remoteFailures: Record<string, unknown>
  setOpenKey: (k: string | null) => void
  setConfirmDelete: (m: ModelEntry | null) => void
  onDiscover: (m: ModelEntry) => void
  isPinned: (key: string) => boolean
  togglePinned: (key: string) => void
}) {
  const facets = (
    [
      { id: 'vision', label: 'Vision', count: facetCounts.vision },
      { id: 'moe', label: 'MoE', count: facetCounts.moe },
      { id: 'nextn', label: 'NextN', count: facetCounts.nextn },
      { id: 'embedding', label: 'Embed', count: facetCounts.embedding },
    ] as { id: Filter; label: string; count: number }[]
  ).filter((f) => f.count > 0)

  const hasModels = models.length > 0
  // Below md the wide six-column table would push its Load button ~350px off-screen,
  // so each model renders as a stacked card instead. Desktop keeps the aligned table.
  const isDesktop = useIsDesktop()
  const hasLinks = machineOpts.length > 2
  const trackFilter = (f: Filter) => { track('models', 'filter_models'); setFilter(f) }
  const trackOpenFolders = () => { track('models', 'open_model_folders'); openFolders() }
  const trackRescan = () => { track('models', 'rescan_models'); rescan() }

  return (
    <>
      {/* Toolbar: search · facet-aware filters · folders · rescan */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {hasModels && (
          <div className="relative min-w-[160px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models"
              className="w-full pl-8 text-[13px]"
              aria-label="Search models"
            />
          </div>
        )}
        {hasModels && (
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip active={filter === 'all'} onClick={() => trackFilter('all')}>
              All {models.length}
            </FilterChip>
            {facets.map((f) => (
              <FilterChip key={f.id} active={filter === f.id} onClick={() => trackFilter(f.id)}>
                {f.label} {f.count}
              </FilterChip>
            ))}
          </div>
        )}
        {/* Renders nothing at all when this install has no links. */}
        <MachineFilter
          options={machineOpts}
          value={machineFilter}
          onChange={(id) => { track('models', 'filter_models_by_machine'); setMachineFilter(id) }}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={trackOpenFolders}>
            <FolderPlus size={14} />
            Folders{dirs.length ? ` · ${dirs.length}` : ''}
          </Button>
          <Button variant="outline" size="sm" onClick={trackRescan} disabled={scanning}>
            <RefreshCw size={14} className={scanning ? 'tllm-pulse' : ''} />
            {scanning ? 'Scanning…' : 'Rescan'}
          </Button>
        </div>
      </div>

      {incompatibleCount > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-panel px-4 py-2.5 text-[12px]">
          <span className="text-muted">
            {showIncompatible
              ? `Showing all models. ${incompatibleCount} can't load on the active engine.`
              : `${incompatibleCount} ${incompatibleCount === 1 ? 'model is' : 'models are'} hidden — the active engine can't load ${incompatibleCount === 1 ? 'it' : 'them'}.`}
          </span>
          <button
            type="button"
            onClick={() => { track('models', 'toggle_incompatible_models'); setShowIncompatible(!showIncompatible) }}
            className="shrink-0 font-medium text-accent hover:underline"
          >
            {showIncompatible ? 'Show compatible only' : 'Show all'}
          </button>
        </div>
      )}

      {/* A linked machine that contributed no rows still says why. */}
      <MachineNotes machines={machines} />

      {modelsQ.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-lg" />
          ))}
        </div>
      ) : modelsQ.isError ? (
        <InlineError message="Could not load models." onRetry={() => modelsQ.refetch()} screen="models" />
      ) : models.length === 0 && rows.length === 0 ? (
        // Guarded on the WHOLE fleet, not just this machine. Keyed on `models.length`
        // alone, a machine with no local GGUFs but a linked machine full of them showed
        // "No GGUF models found in your folders" and rendered no rows at all — the remote
        // half was fetched, merged, and then thrown away by an empty state that predated it.
        <EmptyState
          icon={<Boxes size={24} />}
          message={
            dirs.length === 0
              ? 'No model folders yet. Add a folder to discover the GGUF models you already have.'
              : scanning
                ? 'Scanning your folders…'
                : 'No GGUF models found in your folders.'
          }
          action={
            dirs.length === 0 ? (
              <Button size="sm" onClick={trackOpenFolders}>
                <FolderPlus size={14} /> Add a folder
              </Button>
            ) : undefined
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Search size={24} />} message="No models match your search or filter." />
      ) : (
        <div className="overflow-x-auto">
          <div className={cn('overflow-hidden rounded-xl border border-border bg-panel', isDesktop && 'min-w-[720px]')}>
            {/* Column header — desktop table only; the mobile card list needs none. */}
            {isDesktop && (
              <div
                className="grid items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted"
                style={ROW_GRID}
              >
                <div>Model</div>
                <div className="text-right">Quant</div>
                <div className="text-right">Size</div>
                <div className="text-right">Ctx</div>
                <div className="text-right">Speed</div>
                <div />
              </div>
            )}
            {/* One list, in the order `mergeFleet` returned: this machine's rows first,
                then each linked machine's block. The component only picks which row
                renderer to use — it never decides the order or the membership. */}
            {rows.map((r) => {
              if (r.row.kind === 'local') {
                return (
                  <ModelRow
                    key={`local:${r.row.group.name.toLowerCase()}`}
                    group={r.row.group}
                    origin={r.origin}
                    showOrigin={hasLinks}
                    layout={isDesktop ? 'row' : 'card'}
                    onLoad={(key) => actions.load.mutate({ key })}
                    onEject={() => actions.eject.mutate()}
                    onTune={(key) => setOpenKey(key)}
                    onDelete={(m) => setConfirmDelete(m)}
                    onDiscover={onDiscover}
                    busy={loadBusy}
                    loadingKey={loadingKey}
                    ejecting={actions.eject.isPending}
                    isPinned={isPinned}
                    togglePinned={togglePinned}
                  />
                )
              }
              // A remote ROW always carries a remote ORIGIN — `mergeFleet` pairs them — but
              // the two are separate unions, so this narrows rather than casting.
              if (r.origin.kind !== 'remote') return null
              const { linkId } = r.origin
              const { model } = r.row
              return (
                <RemoteModelRow
                  key={`${linkId}:${model.key}`}
                  model={model}
                  origin={r.origin}
                  link={linkFor(linkId)}
                  layout={isDesktop ? 'row' : 'card'}
                  rowGrid={ROW_GRID}
                  onLoad={() => onRemoteLoad(linkId, model.key)}
                  onUnload={() => onRemoteUnload(linkId, model.key)}
                  busy={remoteBusy}
                  failure={remoteFailures[`${linkId}:${model.key}`]}
                />
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

function useDeleteModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (key: string) => deleteModel(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.models })
      void qc.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

/** One row per model name. Multiple quants collapse into a single row with a quant
 *  dropdown; the selected quant drives Size / Ctx / Speed / Load and the row actions. */
function ModelRow({
  group,
  origin,
  showOrigin,
  layout = 'row',
  onLoad,
  onEject,
  onTune,
  onDelete,
  onDiscover,
  busy,
  loadingKey,
  ejecting,
  isPinned,
  togglePinned,
}: {
  group: Group
  /** Which machine this row came from. Always `local` here — the remote half is
   *  `RemoteModelRow` — but it is threaded through so the origin column is rendered by the
   *  same `OriginBadge` on both sides rather than hard-coded text on one. */
  origin: FleetOrigin
  /** Only shown once this install actually has links; a single-machine library has no
   *  origin to disambiguate. */
  showOrigin: boolean
  /** 'row' = the aligned desktop table row; 'card' = the mobile stacked card. */
  layout?: 'row' | 'card'
  onLoad: (key: string) => void
  onEject: () => void
  onTune: (key: string) => void
  onDelete: (m: ModelEntry) => void
  onDiscover: (m: ModelEntry) => void
  busy: boolean
  loadingKey: string | undefined
  ejecting: boolean
  isPinned: (key: string) => boolean
  togglePinned: (key: string) => void
}) {
  const variants = group.variants
  const multi = variants.length > 1
  // Default the selected quant to the loaded variant, else the first. Falls back to the
  // first if the selected key disappears (e.g. that quant was just deleted).
  const [selKey, setSelKey] = useState(() => (variants.find((v) => v.loaded) ?? variants[0]).key)
  const m = variants.find((v) => v.key === selKey) ?? variants[0]

  const loaded = m.loaded
  const pinned = isPinned(m.key)
  const loadable = !m.incomplete && !m.parseError
  const compatible = m.compatibleWithActiveEngine !== false
  const needsEngine = m.format === 'gguf' ? 'llama.cpp' : 'MLX or vLLM'
  // GGUF models fall back to llama.cpp's built-in per-architecture chat template when the
  // file has none; MLX-format models have no such fallback (mlx-lm/Rapid-MLX read the
  // template directly), so a missing one is a real, user-visible dead end at chat time —
  // surfaced here instead of a first-message 400. Only checked once the model is otherwise
  // loadable/compatible; an incomplete or engine-mismatched model has a more pressing problem.
  const noChatTemplate = m.format === 'mlx' && !m.hasChatTemplate
  const problem = m.incomplete
    ? 'missing parts'
    : m.parseError
      ? 'unreadable'
      : !compatible
        ? `needs ${needsEngine}`
        : noChatTemplate
          ? 'no chat template'
          : null
  const loadingThis = loadingKey === m.key
  // Order matters: only the first 2 render on the card row (space-constrained), so the
  // rarer, more decision-relevant capabilities (NextN, Embed) go first — otherwise a model
  // that's ALSO Vision+MoE (common for the bigger models that carry a NextN head) always had
  // its NextN tag silently crowded out despite the NextN filter/count already finding it.
  const caps = [
    (m.nextnLayers ?? 0) > 0 && 'NextN',
    m.embedding && 'Embed',
    m.vision && 'Vision',
    m.audio && 'Audio',
    m.moe && 'MoE',
  ].filter(Boolean) as string[]

  const loadedBg = loaded ? { background: 'color-mix(in srgb, var(--ok) 6%, transparent)' } : undefined

  // ── Shared cells (rendered once; only one layout branch below uses them) ──────
  const nameBlock = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {pinned && <Star size={13} className="shrink-0 fill-current text-accent" />}
        {loaded && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--ok)' }} />}
        {problem && <AlertTriangle size={13} className="shrink-0" style={{ color: m.parseError ? 'var(--err)' : 'var(--warn)' }} />}
        <span className="truncate text-[14px] font-medium text-ink">{group.name}</span>
        {caps.slice(0, 2).map((c) => (
          <CapChip key={c}>{c}</CapChip>
        ))}
        {m.hasProfile && <CapChip>tuned</CapChip>}
        {problem && (
          <span
            className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            style={{
              color: m.parseError ? 'var(--err)' : 'var(--warn)',
              background: `color-mix(in srgb, ${m.parseError ? 'var(--err)' : 'var(--warn)'} 14%, transparent)`,
            }}
          >
            {problem}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 truncate text-[12px] text-muted">
        {showOrigin && <OriginBadge origin={origin} />}
        <span className="truncate">
          {m.arch}
          {m.dir ? ` · ${m.dir}` : ''}
          {loaded ? ' · running' : ''}
        </span>
      </div>
    </div>
  )

  const quantEl = multi ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Choose quant"
        className="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-[13px] text-ink transition-colors hover:border-[color:var(--accent)]"
      >
        {m.quant}
        <ChevronDown size={13} className="text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
          {variants.length} quants
        </div>
        {variants.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => { track('models', 'select_model_quant'); setSelKey(v.key) }} className="flex items-center gap-2">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {v.key === m.key && <Check size={14} className="text-accent" />}
            </span>
            <span className="flex-1 font-mono text-[13px] text-ink">{v.quant}</span>
            {v.loaded && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>loaded</span>}
            <span className="text-[11px] text-muted">{fmtSize(v.sizeBytes)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <span className="font-mono text-[13px] text-muted">{m.quant}</span>
  )

  const actionButtons = (
    <>
      {loaded ? (
        <Button size="sm" onClick={() => { track('models', 'eject_model'); onEject() }} disabled={ejecting} title="Eject model (stop the engine)">
          <CircleSlash size={14} />
          Eject
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => { track('models', 'load_model'); onLoad(m.key) }}
          disabled={!loadable || !compatible || busy}
          title={
            !loadable
              ? 'Model is incomplete or unreadable'
              : !compatible
                ? `The active engine can't load this model — switch to ${needsEngine}`
                : ''
          }
        >
          {loadingThis ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
          {loadingThis ? 'Loading…' : 'Load'}
        </Button>
      )}
      <button
        type="button"
        onClick={() => { track('models', 'open_model_load_settings'); onTune(m.key) }}
        disabled={!loadable}
        aria-label="Load settings"
        title="Load settings"
        className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40"
      >
        <SlidersHorizontal size={15} />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Model actions"
          className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-ink"
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { track('models', 'pin_model'); togglePinned(m.key) }}>
            <Star size={14} /> {pinned ? 'Unpin' : 'Pin to top'}
          </DropdownMenuItem>
          {m.incomplete && (
            <DropdownMenuItem onSelect={() => { track('models', 'find_model_quants'); onDiscover(m) }}>
              <Download size={14} /> Re-download missing parts…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => { track('models', 'find_model_quants'); onDiscover(m) }}>
            <PackageSearch size={14} /> Find other quants…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            disabled={m.loaded}
            onSelect={() => onDelete(m)}
            title={m.loaded ? 'Eject the model before deleting' : undefined}
          >
            <Trash2 size={14} /> Delete file…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  // Mobile: a stacked card — name, a compact meta line, then the actions row — so the
  // Load button stays on-screen instead of scrolled ~350px right in the wide table.
  if (layout === 'card') {
    return (
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0" style={loadedBg}>
        {nameBlock}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
          {quantEl}
          <span className="tabular-nums">{fmtSize(m.sizeBytes)}</span>
          <span className="tabular-nums">{m.nativeCtx ? fmtCtx(m.nativeCtx) : '—'}</span>
          <TpsStat m={m} />
        </div>
        <div className="flex items-center gap-1.5">{actionButtons}</div>
      </div>
    )
  }

  // Desktop: the aligned six-column table row (unchanged).
  return (
    <div
      className="grid items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
      style={{ ...ROW_GRID, ...(loadedBg ?? {}) }}
    >
      {nameBlock}
      <div className="flex justify-end">{quantEl}</div>
      <div className="text-right text-[13px] tabular-nums text-muted">{fmtSize(m.sizeBytes)}</div>
      <div className="text-right text-[13px] tabular-nums text-muted">{m.nativeCtx ? fmtCtx(m.nativeCtx) : '—'}</div>
      <div className="text-right">
        <TpsStat m={m} />
      </div>
      <div className="flex items-center justify-end gap-1.5">{actionButtons}</div>
    </div>
  )
}

/** Folder-management dialog: the scan folders + a real folder picker (any drive),
 *  replacing the old paste-an-absolute-path panel that sat above the model list. */
function ModelFoldersDialog({
  open,
  onOpenChange,
  dirs,
  primaryDir,
  mut,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dirs: string[]
  primaryDir: string
  mut: ReturnType<typeof useModelMutations>
}) {
  const [browse, setBrowse] = useState(false)
  const addError = mut.addDir.error instanceof ApiError ? mut.addDir.error.message : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Model folders</DialogTitle>
          <DialogDescription>
            TurboLLM scans these folders for GGUF models. Downloads and imports land in the primary folder.
          </DialogDescription>
        </DialogHeader>

        {dirs.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {dirs.map((d) => {
              const isPrimary = d === primaryDir
              return (
                <div key={d} className="group/dir flex items-center gap-2 rounded-md border border-border bg-panel-2 px-2.5 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-muted" title={d}>{d}</span>
                  {isPrimary ? (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                      style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 12%, transparent)' }}
                    >
                      Primary
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { track('models', 'set_primary_model_dir'); mut.setPrimaryDir.mutate(d) }}
                      disabled={mut.setPrimaryDir.isPending}
                      title="Downloads and imports will land in this folder"
                      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:text-ink"
                    >
                      <Star size={12} /> Set primary
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    onClick={() => { track('models', 'remove_model_dir'); mut.removeDir.mutate(d) }}
                    className="shrink-0 rounded p-1 text-muted transition-colors hover:text-ink"
                  >
                    <X size={14} />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div>
          <Button size="sm" variant="outline" onClick={() => { track('models', 'browse_model_dir'); setBrowse(true) }} disabled={mut.addDir.isPending}>
            <FolderPlus size={14} /> Add folder…
          </Button>
          {addError && <p className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>{addError}</p>}
        </div>

        <FsBrowser
          open={browse}
          mode="folder"
          title="Choose a model folder"
          description="Open the folder that holds your GGUF models — on any drive — then click Select this folder."
          onOpenChange={setBrowse}
          onSelect={(p) => {
            track('models', 'add_model_dir')
            setBrowse(false)
            mut.addDir.mutate(p)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Confirm dialog for deleting a model's file(s). Split GGUFs list every part that
 *  will be removed; a loaded model shows a blocked explanation instead. */
function DeleteModelDialog({
  model,
  onCancel,
  onConfirm,
  deleting,
}: {
  model: ModelEntry | null
  onCancel: () => void
  onConfirm: () => void
  deleting: boolean
}) {
  const open = model !== null
  const paths = model ? partPaths(model) : []
  const blocked = !!model?.loaded
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{blocked ? 'Model is loaded' : 'Delete model files?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? 'This model is currently loaded in the running engine. Eject it first, then delete.'
              : paths.length > 1
                ? `This is a split model — all ${paths.length} part files will be permanently deleted from disk. This cannot be undone.`
                : 'This file will be permanently deleted from disk. This cannot be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!blocked && paths.length > 0 && (
          <div className="max-h-40 overflow-auto rounded-md border border-border bg-panel-2 p-2">
            {paths.map((p) => (
              <div key={p} className="truncate font-mono text-[12px] text-muted">
                {p}
              </div>
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {!blocked && (
            <AlertDialogAction onClick={onConfirm} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Presentational list of the file paths a delete will remove (split-GGUF aware). */
function partPaths(m: ModelEntry): string[] {
  const sep = m.path.includes('\\') ? '\\' : '/'
  const file = m.path.slice(m.path.lastIndexOf(sep) + 1)
  const match = file.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i)
  if (!match) return [m.path]
  const dir = m.path.slice(0, m.path.lastIndexOf(sep))
  const prefix = match[1]
  const total = Number(match[3])
  const parts: string[] = []
  for (let i = 1; i <= total; i++) {
    const n = String(i).padStart(5, '0')
    const t = String(total).padStart(5, '0')
    parts.push(`${dir}${sep}${prefix}-${n}-of-${t}.gguf`)
  }
  return parts
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-3 py-1 text-[12px] font-medium transition-colors"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  )
}

/** Quiet capability chip (vision / MoE / embed / NextN / tuned) — muted, never loud;
 *  only problems get a warning color. */
function CapChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
      {children}
    </span>
  )
}

/** Tiered tokens/sec (spec 04 §5): live (loaded & generating → pulsing green) >
 *  last session > benchmark > "—". Tooltip names the source. */
function TpsStat({ m }: { m: ModelEntry }) {
  if (m.liveTps != null) {
    return (
      <span className="inline-flex items-center gap-1 text-[13px] font-medium tabular-nums" style={{ color: 'var(--ok)' }} title="Live tokens/sec (loaded now)">
        <span className="tllm-pulse h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ok)' }} />
        {Math.round(m.liveTps)} t/s
      </span>
    )
  }
  if (m.lastTps != null) {
    return (
      <span className="text-[13px] tabular-nums text-ink" title="Last-session tokens/sec">
        {Math.round(m.lastTps)} t/s
      </span>
    )
  }
  if (m.benchTps != null) {
    return (
      <span className="text-[13px] tabular-nums text-muted" title="Benchmark tokens/sec">
        {Math.round(m.benchTps)} t/s
      </span>
    )
  }
  return <span className="text-[13px] text-muted">—</span>
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}
function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}

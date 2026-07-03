import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Boxes, ChevronRight, CircleSlash, Download, Loader2, MoreHorizontal, PackageSearch, RefreshCw, SlidersHorizontal, Star, Trash2, Zap } from 'lucide-react'
import { ApiError, deleteModel } from '../lib/api'
import { queryKeys, useModelActions, useModelDirs, useModelMutations, useModels, useStatus } from '../lib/queries'
import { usePinnedModels } from '../lib/usePinnedModels'
import type { ModelEntry } from '../lib/types'
import { EmptyState, InlineError, ScreenHeader } from '../components/common'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
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
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { toast } from '../components/ui/sonner'
import { ModelDetailDialog } from './models/ModelDetailDialog'
import { DiscoverTab } from './models/DiscoverTab'
import { HfRepoDialog } from './models/HfRepoDialog'
import { ModelDirs } from './models/ModelDirs'

type Filter = 'all' | 'vision' | 'moe' | 'nextn' | 'embedding'
type Tab = 'library' | 'discover'

/** A model name shared by 2+ quant variants becomes a collapsible group; a name
 *  with a single variant stays a flat row (spec 04 §2 / spec 11 §5). */
type Group = { name: string; variants: ModelEntry[] }

function groupModels(models: ModelEntry[], isPinned: (key: string) => boolean): Group[] {
  const byName = new Map<string, ModelEntry[]>()
  for (const m of models) {
    const k = m.name.toLowerCase()
    ;(byName.get(k) ?? byName.set(k, []).get(k)!).push(m)
  }
  // Preserve the incoming (loaded-first, name-asc) order by first appearance.
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
  // Pinned/favourited models float to the top; a group is pinned when any of its
  // variants is pinned. Stable partition keeps the existing order within each half.
  const isGroupPinned = (g: Group) => g.variants.some((v) => isPinned(v.key))
  return [...groups.filter(isGroupPinned), ...groups.filter((g) => !isGroupPinned(g))]
}

export function ModelsScreen() {
  const modelsQ = useModels()
  const dirsQ = useModelDirs()
  const mut = useModelMutations()
  const actions = useModelActions()
  const del = useDeleteModel()
  const { data: status } = useStatus()
  const { isPinned, togglePinned } = usePinnedModels()

  // A load isn't instant: POST /load returns 202, then the engine spends seconds in
  // `starting` before the model is `running`. Keep the Load buttons in a busy/loading
  // state across that whole window — not just while the mutation POST is in flight —
  // so the button never looks idle while a model is actually coming up.
  const engineState = status?.engine.state
  const loadBusy = actions.load.isPending || engineState === 'starting' || engineState === 'stopping'
  // The specific model coming up: the mutation's own key while the POST is in flight,
  // then the engine's reported loading model once it's `starting`.
  const loadingKey = actions.load.isPending
    ? actions.load.variables?.key
    : engineState === 'starting'
      ? status?.model?.key
      : undefined
  const [tab, setTab] = useState<Tab>('library')
  const [filter, setFilter] = useState<Filter>('all')
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ModelEntry | null>(null)
  // "Find other quants" for a library model (re-download / pick a different quant):
  // jump straight to its source repo when known (provenance), else open Discover
  // pre-searched by model name (imported files have no recorded repo).
  const [discoverRepo, setDiscoverRepo] = useState<string | null>(null)
  const [presetSearch, setPresetSearch] = useState('')
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
  // Models the active engine can't load (ADR-044): GGUFs under MLX/vLLM, or
  // safetensors under llama.cpp. Hidden by default; "Show all" reveals them.
  const incompatibleCount = models.filter((m) => !m.compatibleWithActiveEngine).length
  const filtered = models.filter((m) => {
    if (!showIncompatible && !m.compatibleWithActiveEngine) return false
    if (filter === 'all') return true
    if (filter === 'vision') return m.vision
    if (filter === 'moe') return m.moe
    if (filter === 'nextn') return (m.nextnLayers ?? 0) > 0
    if (filter === 'embedding') return m.embedding
    return true
  })
  const groups = groupModels(filtered, isPinned)

  const onConfirmDelete = () => {
    const m = confirmDelete
    if (!m) return
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
          ? 'flex h-full w-full flex-col overflow-hidden px-6 py-6'
          : 'h-full w-full overflow-y-auto px-6 py-6'
      }
    >
      <ScreenHeader
        title="Models"
        description={
          tab === 'library'
            ? 'GGUF models discovered in your folders — reuse what you already have, no re-downloading.'
            : 'Find and download GGUF models from Hugging Face, or import any direct .gguf URL.'
        }
        actions={
          tab === 'library' ? (
            <Button variant="outline" size="sm" onClick={() => mut.rescan.mutate()} disabled={scanning}>
              <RefreshCw size={14} className={scanning ? 'tllm-pulse' : ''} />
              {scanning ? 'Scanning…' : 'Rescan'}
            </Button>
          ) : undefined
        }
      />

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {(['library', 'discover'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
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

      {tab === 'library' && incompatibleCount > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-panel px-4 py-2.5 text-[12px]">
          <span className="text-muted">
            {showIncompatible
              ? `Showing all models. ${incompatibleCount} can't load on the active engine.`
              : `${incompatibleCount} ${incompatibleCount === 1 ? 'model is' : 'models are'} hidden — the active engine can't load ${incompatibleCount === 1 ? 'it' : 'them'}.`}
          </span>
          <button
            type="button"
            onClick={() => setShowIncompatible((v) => !v)}
            className="shrink-0 font-medium text-accent hover:underline"
          >
            {showIncompatible ? 'Show compatible only' : 'Show all'}
          </button>
        </div>
      )}

      {tab === 'discover' ? (
        <div className="min-h-0 flex-1">
          <DiscoverTab presetQuery={presetSearch} />
        </div>
      ) : (
        <LibraryTab
          modelsQ={modelsQ}
          mut={mut}
          actions={actions}
          loadBusy={loadBusy}
          loadingKey={loadingKey}
          dirs={dirs}
          primaryDir={primaryDir}
          scanning={scanning}
          models={models}
          filter={filter}
          setFilter={setFilter}
          groups={groups}
          setOpenKey={setOpenKey}
          setConfirmDelete={setConfirmDelete}
          onDiscover={onDiscover}
          isPinned={isPinned}
          togglePinned={togglePinned}
        />
      )}

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

/** The existing local-library view, unchanged in behavior — extracted so the Models
 *  screen can switch between Library and Discover tabs (spec 10 §2). */
function LibraryTab({
  modelsQ,
  mut,
  actions,
  loadBusy,
  loadingKey,
  dirs,
  primaryDir,
  scanning,
  models,
  filter,
  setFilter,
  groups,
  setOpenKey,
  setConfirmDelete,
  onDiscover,
  isPinned,
  togglePinned,
}: {
  modelsQ: ReturnType<typeof useModels>
  mut: ReturnType<typeof useModelMutations>
  actions: ReturnType<typeof useModelActions>
  loadBusy: boolean
  loadingKey: string | undefined
  dirs: string[]
  primaryDir: string
  scanning: boolean
  models: ModelEntry[]
  filter: Filter
  setFilter: (f: Filter) => void
  groups: Group[]
  setOpenKey: (k: string | null) => void
  setConfirmDelete: (m: ModelEntry | null) => void
  onDiscover: (m: ModelEntry) => void
  isPinned: (key: string) => boolean
  togglePinned: (key: string) => void
}) {
  return (
    <>
      <ModelDirs dirs={dirs} primaryDir={primaryDir} mut={mut} />

      {models.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          {(['all', 'vision', 'moe', 'nextn', 'embedding'] as Filter[]).map((f) => (
            <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? `All ${models.length}` : f === 'vision' ? 'Vision' : f === 'moe' ? 'MoE' : f === 'nextn' ? 'NextN' : 'Embed'}
            </FilterChip>
          ))}
        </div>
      )}

      {modelsQ.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-lg" />
          ))}
        </div>
      ) : modelsQ.isError ? (
        <InlineError message="Could not load models." onRetry={() => modelsQ.refetch()} />
      ) : models.length === 0 ? (
        <EmptyState
          icon={<Boxes size={24} />}
          message={
            dirs.length === 0
              ? 'No model folders yet. Add a folder above to discover the GGUF models you already have.'
              : scanning
                ? 'Scanning your folders…'
                : 'No GGUF models found in your folders.'
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) =>
            g.variants.length === 1 ? (
              <ModelRow
                key={g.variants[0].key}
                m={g.variants[0]}
                onLoad={() => actions.load.mutate({ key: g.variants[0].key })}
                onEject={() => actions.eject.mutate()}
                onTune={() => setOpenKey(g.variants[0].key)}
                onDelete={() => setConfirmDelete(g.variants[0])}
                onDiscover={() => onDiscover(g.variants[0])}
                busy={loadBusy}
                loadingThis={loadingKey === g.variants[0].key}
                ejecting={actions.eject.isPending}
                pinned={isPinned(g.variants[0].key)}
                onTogglePin={() => togglePinned(g.variants[0].key)}
              />
            ) : (
              <ModelGroupRow
                key={g.name.toLowerCase()}
                group={g}
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
            ),
          )}
        </div>
      )}
    </>
  )
}

/** Inline delete-model mutation. Self-contained here (queries.ts is owned by a
 *  concurrent change) — invalidates the models + status queries on success so the
 *  list reflects the removed files. */
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

function ModelGroupRow({
  group,
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
  const [open, setOpen] = useState(false)
  const anyLoaded = group.variants.some((v) => v.loaded)
  const anyPinned = group.variants.some((v) => isPinned(v.key))
  return (
    <div className="rounded-lg border border-border bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-ink">{group.name}</span>
            {anyPinned && <Star size={13} className="shrink-0 fill-current text-accent" />}
            {anyLoaded && <Tag tone="ok">loaded</Tag>}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {group.variants.length} variants
            {group.variants[0].arch ? ` · ${group.variants[0].arch}` : ''}
          </div>
        </div>
        <Badge variant="mono">{group.variants.length} quants</Badge>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 pb-3 pt-2">
          {group.variants.map((m) => (
            <ModelRow
              key={m.key}
              m={m}
              child
              onLoad={() => onLoad(m.key)}
              onEject={onEject}
              onTune={() => onTune(m.key)}
              onDelete={() => onDelete(m)}
              onDiscover={() => onDiscover(m)}
              busy={busy}
              loadingThis={loadingKey === m.key}
              ejecting={ejecting}
              pinned={isPinned(m.key)}
              onTogglePin={() => togglePinned(m.key)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ModelRow({
  m,
  child,
  onLoad,
  onEject,
  onTune,
  onDelete,
  onDiscover,
  busy,
  loadingThis,
  ejecting,
  pinned,
  onTogglePin,
}: {
  m: ModelEntry
  child?: boolean
  onLoad: () => void
  onEject: () => void
  onTune: () => void
  onDelete: () => void
  onDiscover: () => void
  /** Any load/engine transition is in progress — disable the Load buttons. */
  busy: boolean
  /** This specific model is the one currently coming up — show the spinner here. */
  loadingThis: boolean
  ejecting: boolean
  /** This model is pinned/favourited — floats to the top of the list. */
  pinned: boolean
  onTogglePin: () => void
}) {
  const loadable = !m.incomplete && !m.parseError
  // Engine compatibility (ADR-044): shown in the "All" view via "Show all". An incompatible
  // model can't be loaded by the active engine, so badge which engine it needs and block Load.
  const compatible = m.compatibleWithActiveEngine !== false
  const needsEngine = m.format === 'gguf' ? 'llama.cpp' : 'MLX or vLLM'
  // Built-in NextN / multi-token-prediction head, read from GGUF metadata
  // (`nextn_predict_layers`) — not guessed from the arch/name. Gemma-4 MTP needs a
  // separate head file, so it isn't a list badge; it's offered in the tune dialog.
  const modelHasNextn = (m.nextnLayers ?? 0) > 0
  return (
    <div
      className={
        child
          ? 'group flex flex-col gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3'
          : 'group flex flex-col gap-2 rounded-lg border border-border bg-panel px-4 py-3 sm:flex-row sm:items-center sm:gap-3'
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 break-words font-medium text-ink sm:truncate">{child ? m.quant : m.name}</span>
          {m.loaded && <Tag tone="ok">loaded</Tag>}
          {m.vision && <Tag>vision</Tag>}
          {m.embedding && <Tag>embed</Tag>}
          {m.moe && <Tag>MoE</Tag>}
          {modelHasNextn && <Tag tone="spec">NextN</Tag>}
          {m.hasProfile && <Tag>tuned</Tag>}
          {m.incomplete && <Tag tone="warn">missing parts</Tag>}
          {m.parseError && <Tag tone="err">unreadable</Tag>}
          {!compatible && <Tag tone="warn">needs {needsEngine}</Tag>}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted">
          {m.arch}
          {m.dir ? ` · ${m.dir}` : ''}
        </div>
      </div>
      {/* Stats + actions wrap to a second row on mobile so the name above keeps the
          full width and no longer gets crushed; inline on >= sm. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:gap-3">
        {!child && <Badge variant="mono">{m.quant}</Badge>}
        <Stat>{fmtSize(m.sizeBytes)}</Stat>
        <Stat>{m.nativeCtx ? `${fmtCtx(m.nativeCtx)} ctx` : '—'}</Stat>
        <TpsStat m={m} />
        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={pinned ? 'Unpin model' : 'Pin model to top'}
            aria-pressed={pinned}
            title={pinned ? 'Unpin' : 'Pin to top'}
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-panel-2 ${pinned ? 'text-accent' : 'text-muted hover:text-ink'}`}
          >
            <Star size={15} className={pinned ? 'fill-current' : ''} />
          </button>
          <Button
            size="sm"
            onClick={onLoad}
            disabled={!loadable || !compatible || busy}
            title={!loadable ? 'Model is incomplete or unreadable' : !compatible ? `The active engine can't load this model — switch to ${needsEngine}` : ''}
          >
            {loadingThis ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {loadingThis ? 'Loading…' : m.loaded ? 'Reload' : 'Load'}
          </Button>
          {m.incomplete && (
            <Button size="sm" variant="outline" onClick={onDiscover} title="Download the missing shard files">
              <Download size={14} />
              Re-download
            </Button>
          )}
          {m.loaded && (
            <Button size="sm" variant="outline" onClick={onEject} disabled={ejecting} title="Eject model (stop the engine)">
              <CircleSlash size={14} />
              Eject
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onTune} disabled={!loadable} title="Load settings">
            <SlidersHorizontal size={14} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Model actions"
              className="grid h-8 w-8 place-items-center rounded-md text-muted opacity-100 transition-opacity hover:bg-panel-2 hover:text-ink focus:opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onDiscover}>
                <PackageSearch size={14} /> Find other quants…
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                disabled={m.loaded}
                onSelect={onDelete}
                title={m.loaded ? 'Eject the model before deleting' : undefined}
              >
                <Trash2 size={14} /> Delete file…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
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

/** Presentational list of the file paths a delete will remove. The entry only
 *  carries the first shard path; for a split GGUF we synthesize the sibling part
 *  names from the `-NNNNN-of-MMMMM.gguf` pattern so the user sees what's affected.
 *  The backend is authoritative about what actually gets unlinked. */
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

function Tag({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'err' | 'spec' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : tone === 'spec' ? 'var(--accent)' : 'var(--muted)'
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {children}
    </span>
  )
}

function Stat({ children }: { children: ReactNode }) {
  return <div className="w-[72px] text-right text-[13px] text-muted">{children}</div>
}

/** Tiered tokens/sec for a model row (spec 04 §5 / 11 §5). Priority:
 *  live (currently loaded & generating → pulsing green) > last session > benchmark
 *  > "—". The tooltip names the source so live and historical figures don't read as
 *  the same thing. */
function TpsStat({ m }: { m: ModelEntry }) {
  if (m.liveTps != null) {
    return (
      <div className="w-[72px] text-right text-[13px]" title="Live tokens/sec (loaded now)">
        <span className="tllm-pulse inline-flex items-center gap-1 font-medium" style={{ color: 'var(--ok)' }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ok)' }} />
          {Math.round(m.liveTps)} t/s
        </span>
      </div>
    )
  }
  if (m.lastTps != null) {
    return (
      <div className="w-[72px] text-right text-[13px] text-ink" title="Last-session tokens/sec">
        {Math.round(m.lastTps)} t/s
      </div>
    )
  }
  if (m.benchTps != null) {
    return (
      <div className="w-[72px] text-right text-[13px] text-muted" title="Benchmark tokens/sec">
        {Math.round(m.benchTps)} t/s
      </div>
    )
  }
  return <Stat>—</Stat>
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}
function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}

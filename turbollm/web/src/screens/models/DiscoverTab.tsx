// Discover tab (spec 10 §2, §7 rewrite, §8). A persistent split-pane: a searchable,
// sortable list on the left (browsing HF live — the equivalent of
// huggingface.co/models?library=<engine-adapted>&sort=<sort> — when no query is typed,
// a debounced HF search once you type) and a permanent detail pane on the right showing
// whatever's selected — no dialog/modal in between. Clicking a row just swaps what the
// right pane shows. Offline/HF-unreachable errors render a friendly card in the list
// instead of results. The library/format filter (gguf/mlx/none) adapts to the active
// engine server-side (src/hf/hf.ts) — never hardcoded here.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { Link2, Lock, Search } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useHfSearch } from '../../lib/queries'
import type { HfSearchItem, HfSortOption } from '../../lib/types'
import { EmptyState, InlineError } from '../../components/common'
import { Input } from '../../components/ui/input'
import { Skeleton } from '../../components/ui/skeleton'
import { DownloadsPanel } from './DownloadsPanel'
import { HfRepoContent } from './HfRepoDialog'
import { ImportUrlDialog } from './ImportUrlDialog'

const SORT_LABEL: Record<HfSortOption, string> = {
  'best-match': 'Best match',
  trending: 'Trending',
  downloads: 'Most downloads',
  likes: 'Most likes',
  modified: 'Recently updated',
  created: 'Newest',
}

// List/detail split width — persisted like ModelDetailDialog's config-panel width, but
// as a plain in-flow flex-basis (not a CSS var pinned against the app shell), since this
// resizes two siblings on the same page rather than a docked panel.
const LIST_WIDTH_KEY = 'tllm-discover-list-w'
const LIST_MIN_W = 260
/** Largest the list may grow: leave the detail pane at least 420px. */
function listMaxW(): number {
  return Math.max(LIST_MIN_W, Math.min(560, window.innerWidth - 420))
}
function readSavedListWidth(): number {
  try {
    const n = parseInt(localStorage.getItem(LIST_WIDTH_KEY) ?? '', 10)
    return Number.isFinite(n) ? n : 340
  } catch {
    return 340
  }
}

export function DiscoverTab({ presetQuery = '' }: { presetQuery?: string }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<HfSortOption>('trending')
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [listWidth, setListWidth] = useState(() => Math.min(Math.max(readSavedListWidth(), LIST_MIN_W), listMaxW()))

  // Seed the search when arriving from a library model's "Find other quants" with
  // no known source repo (imported file). Keyed on presetQuery so re-clicking the
  // same model re-applies it.
  useEffect(() => {
    if (presetQuery) setQuery(presetQuery)
  }, [presetQuery])

  // Debounce the search input 400ms before it hits the network (spec 10 §2).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 400)
    return () => clearTimeout(t)
  }, [query])

  const searching = debounced.length > 0
  // "Best match" (HF's own relevance ranking) only means anything for a text query —
  // browsing falls back to 'trending' server-side anyway. Derived rather than synced via
  // an effect that mutates `sort` itself: that would fire an extra, redundant fetch on
  // every searching->not-searching transition (browseModels already treats 'best-match' as
  // 'trending' server-side, so the state-mutation's own refetch just re-requests the same
  // results a second time). This way `sort` still remembers the user's real pick — clearing
  // the query and typing again immediately shows "Best match" selected, not reset to
  // "Trending" — while the query and the <select> both use the effective value.
  const effectiveSort: HfSortOption = !searching && sort === 'best-match' ? 'trending' : sort

  const searchQ = useHfSearch(debounced, effectiveSort)
  const unreachable = searchQ.error instanceof ApiError && searchQ.error.code === 'hf_unreachable'
  const results = searchQ.data?.results ?? []
  const sortOptions: HfSortOption[] = searching
    ? ['best-match', 'trending', 'downloads', 'likes', 'modified', 'created']
    : ['trending', 'downloads', 'likes', 'modified', 'created']

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DownloadsPanel />

      <div className="mt-3 flex min-h-0 flex-1">
        {/* Left: search + sort + scrollable list */}
        <div ref={listRef} className="flex shrink-0 flex-col gap-2 pr-3" style={{ width: listWidth }}>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models by name or author…"
                className="pl-9"
              />
            </div>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              title="Import from URL"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent p-2 text-ink transition-colors hover:bg-panel-2"
            >
              <Link2 size={15} />
            </button>
          </div>

          <select
            value={effectiveSort}
            onChange={(e) => setSort(e.target.value as HfSortOption)}
            className="self-end rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-ink outline-none"
          >
            {sortOptions.map((s) => (
              <option key={s} value={s}>{SORT_LABEL[s]}</option>
            ))}
          </select>

          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {searchQ.isLoading ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[54px] w-full shrink-0 rounded-lg" />)
            ) : unreachable ? (
              <InlineError
                message="Hugging Face is unreachable — check your connection."
                onRetry={() => searchQ.refetch()}
              />
            ) : searchQ.isError ? (
              <InlineError
                message={searchQ.error instanceof ApiError ? searchQ.error.message : 'Search failed.'}
                onRetry={() => searchQ.refetch()}
              />
            ) : results.length === 0 ? (
              <EmptyState
                icon={<Search size={24} />}
                message={searching ? `No models found for “${debounced}”.` : 'No models found.'}
              />
            ) : (
              results.map((r) => (
                <ResultListRow
                  key={r.repo}
                  item={r}
                  selected={selectedRepo === r.repo}
                  onSelect={() => setSelectedRepo(r.repo)}
                />
              ))
            )}
          </div>
        </div>

        <SplitResizeHandle listRef={listRef} onCommit={setListWidth} />

        {/* Right: permanent detail pane — no dialog, just swaps content on selection */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-panel p-5">
          {selectedRepo ? (
            <HfRepoContent
              repo={selectedRepo}
              onClose={() => setSelectedRepo(null)}
              onSearch={(term) => {
                setSelectedRepo(null)
                setQuery(term)
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <EmptyState icon={<Search size={24} />} message="Select a model on the left to see details." />
            </div>
          )}
        </div>
      </div>

      <ImportUrlDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onOpenRepo={(repo) => {
          setSelectedRepo(repo)
          setImportOpen(false)
        }}
      />
    </div>
  )
}

/** Thin drag handle between the list and detail pane; resizes the list column live via
 *  direct style mutation (same pattern as ModelDetailDialog's ConfigResizeHandle — avoids
 *  a React re-render per pointer-move pixel), then commits + persists the final width on
 *  release. */
function SplitResizeHandle({
  listRef,
  onCommit,
}: {
  listRef: RefObject<HTMLDivElement | null>
  onCommit: (w: number) => void
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = listRef.current?.getBoundingClientRect().width ?? readSavedListWidth()
    document.documentElement.classList.add('tllm-resizing')
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), LIST_MIN_W), listMaxW())
      if (listRef.current) listRef.current.style.width = `${Math.round(w)}px`
    }
    const onUp = () => {
      document.documentElement.classList.remove('tllm-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const w = listRef.current?.getBoundingClientRect().width
      if (w) {
        const rounded = Math.round(w)
        onCommit(rounded)
        try {
          localStorage.setItem(LIST_WIDTH_KEY, String(rounded))
        } catch {
          /* ignore quota / disabled storage */
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      className="tllm-split-resizer"
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize model list"
    />
  )
}

/** Shared visual shell for a left-list row: monogram avatar, selection highlight,
 *  a title line (with gated lock + in-library chip), and a secondary line below. */
function ListRow({
  repo,
  title,
  secondary,
  gated,
  inLibrary,
  selected,
  onSelect,
}: {
  repo: string
  title: string
  secondary: string
  gated?: boolean
  inLibrary?: ReactNode
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex shrink-0 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors"
      style={{
        borderColor: selected ? 'var(--accent)' : 'transparent',
        background: selected ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--panel-2)' }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
    >
      <Avatar seed={repo} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {gated && <Lock size={12} style={{ color: 'var(--warn)' }} className="shrink-0" />}
          <span className="truncate text-[13px] font-medium text-ink">{title}</span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted">{secondary}</p>
        {inLibrary && <div className="mt-1">{inLibrary}</div>}
      </div>
    </button>
  )
}

function ResultListRow({
  item,
  selected,
  onSelect,
}: {
  item: HfSearchItem
  selected: boolean
  onSelect: () => void
}) {
  const secondary = `${fmtCount(item.downloads)} downloads · ${fmtCount(item.likes)} likes${item.updatedAt ? ` · updated ${fmtDate(item.updatedAt)}` : ''}`
  return (
    <ListRow
      repo={item.repo}
      title={item.repo}
      secondary={secondary}
      gated={item.gated}
      inLibrary={item.localCount > 0 ? <InLibraryChip count={item.localCount} /> : undefined}
      selected={selected}
      onSelect={onSelect}
    />
  )
}

/** Colored-initial monogram in lieu of a real per-author brand logo (HF authors
 *  don't carry one) — same hashed-color convention used for MCP catalog entries. */
function Avatar({ seed }: { seed: string }) {
  const palette = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#d97706', '#059669', '#0891b2']
  let h = 0
  // codePointAt, not charCodeAt: for-of already yields full Unicode codepoints (correctly
  // handling surrogate pairs), so charCodeAt(0) would silently read only the first UTF-16
  // unit of an astral-plane character (e.g. an emoji in an author name).
  for (const c of seed) h = (h * 31 + (c.codePointAt(0) ?? 0)) & 0x7fffffff
  const color = palette[h % palette.length]
  const author = seed.includes('/') ? seed.split('/')[0] : seed
  const letter = (author[0] ?? '?').toUpperCase()
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-white"
      style={{ background: color }}
    >
      {letter}
    </div>
  )
}

/** Green "in library" chip (spec 10 §2): "↓ N in library". */
function InLibraryChip({ count }: { count: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}
    >
      {`↓ ${count} in library`}
    </span>
  )
}

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

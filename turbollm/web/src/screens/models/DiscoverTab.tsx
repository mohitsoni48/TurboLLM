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
import { ApiError, track } from '../../lib/api'
import { useHfSearch, useSysInfo } from '../../lib/queries'
import type { HfSearchItem, HfSortOption } from '../../lib/types'
import { fitBudgetMb, repoFitsHardware } from '../../lib/vram'
import { requiredMb } from '../../lib/onboarding-pick'
import { isAndroidOs } from '../../lib/platform'
import { EmptyState, InlineError } from '../../components/common'
import { Input } from '../../components/ui/input'
import { Sheet, SheetContent } from '../../components/ui/sheet'
import { Skeleton } from '../../components/ui/skeleton'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { DownloadsPanel } from './DownloadsPanel'
import { HfRepoContent } from './HfRepoDialog'
import { ImportUrlDialog } from './ImportUrlDialog'

// Curated Android picks, pinned above the live list. Exists because the fits-my-hardware
// filter's honest answer for most of what HF trending returns today is 'unknown' (ADR-402):
// codename-branded frontier releases carry no "<N>B" token, so hiding them routinely leaves
// the filtered browse view empty. These give an Android user something concrete to tap into
// in that exact common case, and stay pinned above the live list even when it isn't empty —
// good starting points regardless of what's trending this week.
//
// Each carries its real Q4_K_M byte size (not guessed — read off the live HF tree API on
// 2026-09-06, same as onboarding-pick.ts's SMALL_DEVICE_LADDER) so the SET itself can be
// filtered by `requiredMb` against the viewer's actual budget below. A curated list that
// ignored the device's own memory would be the exact bug ADR-402 just fixed, one level up:
// recommending something that provably cannot load. Deliberately a separate list from
// SMALL_DEVICE_LADDER (which shares two entries with an earlier version of this one) — that
// module picks exactly ONE model to open onboarding with; this is a browsable set, a
// different job, and keeping them decoupled means changing one doesn't reshuffle the other.
//
// Chosen from real HF search data (author=unsloth/bartowski/lmstudio-community, filter=gguf,
// sort=downloads), not just recalled: every entry here is both genuinely popular AND launched
// within the last ~6 months of this list's verification date, spanning 0.8B-4B and three
// different base-model families so it isn't a Qwen monoculture.
const ANDROID_CURATED_PICKS: { repo: string; bytes: number; note: string }[] = [
  { repo: 'bartowski/Qwen_Qwen3.5-0.8B-GGUF', bytes: 579_615_840, note: 'Fastest — fits even the tightest phones' },
  { repo: 'bartowski/Qwen_Qwen3.5-2B-GGUF', bytes: 1_396_198_496, note: 'Still light, noticeably more capable' },
  { repo: 'lmstudio-community/Ministral-3-3B-Instruct-2512-GGUF', bytes: 2_146_498_240, note: "Mistral's small model — a solid all-rounder" },
  { repo: 'unsloth/Qwen3.5-4B-GGUF', bytes: 2_740_937_888, note: "One of 2026's most-downloaded small models" },
  { repo: 'bartowski/Fara1.5-4B-GGUF', bytes: 2_884_850_784, note: 'One of the newest small models available' },
  { repo: 'unsloth/gemma-4-E2B-it-GGUF', bytes: 3_106_738_272, note: 'Most capable pick that still fits most phones' },
]
const ANDROID_CURATED_REPOS = new Set(ANDROID_CURATED_PICKS.map((p) => p.repo))

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
  // Below md the split-pane stacks (list over detail); the fixed list width + resize
  // handle only apply on desktop.
  const isDesktop = useIsDesktop()

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
  const allResults = searchQ.data?.results ?? []
  const sortOptions: HfSortOption[] = searching
    ? ['best-match', 'trending', 'downloads', 'likes', 'modified', 'created']
    : ['trending', 'downloads', 'likes', 'modified', 'created']

  // Fits-my-hardware filter (anticipated by ADR-338 Decision 6b's "Discover seeded with a
  // fits-your-hardware filter"). Default ON only on the Android app: a phone genuinely
  // cannot run most of what HF's trending page returns, so an unfiltered list there is
  // mostly a list of downloads that will fail. On desktop it defaults OFF — downloading a
  // model for later, for a second machine, or to sit behind a Turbo Link is normal, and
  // pre-hiding results the user asked HF for would be presumptuous.
  //
  // `null` = untouched, so the platform default applies until the user overrides it; once
  // they do, their choice sticks for the session rather than being re-derived per render.
  const sys = useSysInfo().data
  const budgetMb = sys ? fitBudgetMb(sys) : 0
  const [fitsOnlyOverride, setFitsOnlyOverride] = useState<boolean | null>(null)
  // No budget = no honest verdict (sysinfo still loading, or it failed — that query never
  // retries). Hide the control entirely rather than show a checkbox that filters nothing.
  const canFilterByFit = budgetMb > 0
  const fitsOnly = canFilterByFit && (fitsOnlyOverride ?? !!sys?.os.startsWith('android'))
  // repoFitsHardware — see its own doc comment for why 'unknown' must be hidden, not shown.
  const fitFiltered = fitsOnly ? allResults.filter((r) => repoFitsHardware(r.repo, budgetMb)) : allResults
  const hiddenByFit = allResults.length - fitFiltered.length

  // Curated picks pin to the top of the list on Android, browsing only (not mid-search — once
  // the user has typed a name they want THAT search's results, not a fixed banner mixed in).
  // See ANDROID_CURATED_PICKS's own comment for why this exists. Excluded from the live list
  // below so a repo that happens to also be trending never renders twice on screen.
  const showCurated = !searching && isAndroidOs(sys?.os ?? '')
  // Same requiredMb the onboarding fallback ladder uses: a curated list that recommended
  // something the viewer's own device can't hold would be the exact bug ADR-402 just fixed,
  // one level up. `budgetMb > 0` is already guaranteed by canFilterByFit/showCurated's own
  // isAndroidOs check needing real sysinfo, but stated explicitly here since this filter's
  // correctness — unlike fitsOnly's — isn't optional on whether the checkbox is ticked.
  const curatedPicks = showCurated ? ANDROID_CURATED_PICKS.filter((p) => requiredMb(p.bytes) <= budgetMb) : []
  const results = showCurated ? fitFiltered.filter((r) => !ANDROID_CURATED_REPOS.has(r.repo)) : fitFiltered

  return (
    <div className="flex flex-col md:h-full md:min-h-0">
      <DownloadsPanel />

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-0">
        {/* Left: search + sort + list. Below md this is one naturally-flowing block (the
            page itself scrolls, via Shell's bounded `<main>`) — no internal max-height or
            scroller of its own, which used to clip the list mid-row and force a second,
            cramped scroll just to reach the detail pane below it. At md+ it goes back to
            ADR-143's fixed-height split-pane, where the list genuinely needs its own
            scrollbar since it sits beside (not above) the detail pane. */}
        <div ref={listRef} className="flex min-h-0 flex-col gap-2 md:max-h-none md:shrink-0 md:pr-3" style={isDesktop ? { width: listWidth } : undefined}>
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
              onClick={() => { track('models', 'open_import_url_dialog'); setImportOpen(true) }}
              title="Import from URL"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent p-2 text-ink transition-colors hover:bg-panel-2"
            >
              <Link2 size={15} />
            </button>
          </div>

          {/* flex-wrap, not overflow-x-auto: at the Android WebView's 360px viewport the
              filter and the sort dropdown stack instead of hiding one behind a scrollbar
              nobody discovers — the same "hidden scroll is undiscoverable" finding that made
              ADR-074 keep the config dialog's scrollbar visible. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            {canFilterByFit && (
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={fitsOnly}
                  onChange={(e) => setFitsOnlyOverride(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                Fits my hardware
                {/* The count is what keeps the filter honest: a short list on a phone
                    otherwise reads as "HF returned almost nothing", not "we hid 18". */}
                {fitsOnly && hiddenByFit > 0 && <span className="text-faint">· {hiddenByFit} hidden</span>}
              </label>
            )}
            <select
              value={effectiveSort}
              onChange={(e) => setSort(e.target.value as HfSortOption)}
              className="ml-auto rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-ink outline-none"
            >
              {sortOptions.map((s) => (
                <option key={s} value={s}>{SORT_LABEL[s]}</option>
              ))}
            </select>
          </div>

          {curatedPicks.length > 0 && (
            <div className="flex shrink-0 flex-col gap-1 border-b border-border pb-2">
              <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                Good picks for this device
              </div>
              {curatedPicks.map((p) => (
                <ListRow
                  key={p.repo}
                  repo={p.repo}
                  title={p.repo}
                  secondary={p.note}
                  selected={selectedRepo === p.repo}
                  onSelect={() => setSelectedRepo(p.repo)}
                />
              ))}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-1 md:overflow-y-auto">
            {searchQ.isLoading ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[54px] w-full shrink-0 rounded-lg" />)
            ) : unreachable ? (
              <InlineError
                message="Hugging Face is unreachable — check your connection."
                onRetry={() => searchQ.refetch()}
                screen="models"
              />
            ) : searchQ.isError ? (
              <InlineError
                message={searchQ.error instanceof ApiError ? searchQ.error.message : 'Search failed.'}
                onRetry={() => searchQ.refetch()}
                screen="models"
              />
            ) : results.length === 0 ? (
              // Distinguish "HF had nothing" from "we hid everything HF had" — otherwise the
              // Android default-on filter looks like a broken search.
              <EmptyState
                icon={<Search size={24} />}
                message={
                  hiddenByFit > 0
                    ? `None of the ${hiddenByFit} results fit this machine's memory. Untick “Fits my hardware” to see them.`
                    : searching
                      ? `No models found for “${debounced}”.`
                      : 'No models found.'
                }
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

        {isDesktop && <SplitResizeHandle listRef={listRef} onCommit={setListWidth} />}

        {/* Right: permanent detail pane — no dialog, just swaps content on selection.
            Desktop-only (ADR-143's always-visible split-pane); below md the detail
            instead opens in the full-screen Sheet further down. */}
        {isDesktop && (
          <div className="min-h-0 flex-1 md:overflow-y-auto rounded-lg border border-border bg-panel p-5">
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
                <EmptyState icon={<Search size={24} />} message="Select a model to see its details." />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Below md: the detail pane opens as a full-screen Sheet instead of sitting in the
          page's normal flow — a dedicated "page" with its own close (X), rather than
          burying the content further down the same scroll. Never open at md+ (isDesktop
          gates it), where the inline pane above is already always visible. */}
      <Sheet open={!isDesktop && !!selectedRepo} onOpenChange={(o) => !o && setSelectedRepo(null)} modal={false}>
        <SheetContent
          className="overflow-y-auto p-5"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          {selectedRepo && (
            <HfRepoContent
              repo={selectedRepo}
              onClose={() => setSelectedRepo(null)}
              onSearch={(term) => {
                setSelectedRepo(null)
                setQuery(term)
              }}
            />
          )}
        </SheetContent>
      </Sheet>

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
      onClick={() => { track('models', 'select_discover_result'); onSelect() }}
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

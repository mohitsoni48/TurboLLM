// HF repo detail dialog (spec 10 §3–4). Given a repo id, fetch the file list +
// gated/license metadata, present a single-select quant dropdown (each option:
// quant · size · fit dot · "Downloaded" tag), a live VRAM verdict line, and a
// primary action that is "Download" (enqueue) for a remote quant or "Load" for a
// quant already in the local library. Gated repos with no token show guidance and
// disable downloading.
//
// The actual content is `HfRepoContent` — Sheet-free, so DiscoverTab's split-pane
// layout can render it inline as the permanent right column. `HfRepoDialog` just
// wraps it in the Sheet chrome for the one other call site (ModelsScreen's Library
// tab "View HF page" hand-off), which has no split-pane of its own.

import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { ChevronDown, Download, ExternalLink, Lock, Zap } from 'lucide-react'
import { ApiError, track } from '../../lib/api'
import { useDownloadMutations, useHfRepo, useModelActions, useStatus, useSysInfo } from '../../lib/queries'
import type { FitVerdict, HfRepoFile } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import { Sheet, SheetContent } from '../../components/ui/sheet'
import { toast } from '../../components/ui/sonner'

/** Per-quant VRAM fit estimate. We only know the file size here (no GGUF block/head
 *  metadata), so this is a coarse weights-plus-overhead heuristic vs total VRAM —
 *  deliberately conservative. Unknown VRAM → 'unknown' (neutral styling, spec 10 §3). */
function fileFit(sizeBytes: number, vramMb: number | undefined): FitVerdict {
  if (!vramMb) return 'unknown'
  const sizeMb = sizeBytes / 1e6
  // Reserve headroom for KV cache + runtime (~15% of file + 1GB baseline).
  const estMb = sizeMb * 1.15 + 1000
  const pct = estMb / vramMb
  if (pct <= 0.8) return 'fits'
  if (pct <= 0.95) return 'tight'
  return 'overflow'
}

const FIT_COLOR: Record<FitVerdict, string> = {
  fits: 'var(--ok)',
  tight: 'var(--warn)',
  overflow: 'var(--err)',
  cpu: 'var(--muted)',
  unknown: 'var(--faint)',
}

const FIT_LABEL: Record<FitVerdict, string> = {
  fits: 'Fits comfortably on your GPU.',
  tight: 'Tight fit — may slow under desktop load.',
  overflow: 'Larger than your VRAM — will spill to system RAM.',
  cpu: 'CPU-only — no GPU detected.',
  unknown: 'Fit unknown — GPU VRAM not detected.',
}

export function HfRepoDialog({
  repo,
  onClose,
  onSearch,
}: {
  repo: string | null
  onClose: () => void
  /** Fallback when the repo isn't found (e.g. an inferred id that doesn't match HF):
   *  switch to a Hugging Face search for the given term. */
  onSearch?: (term: string) => void
}) {
  // Side panel, not a modal (spec 00 §9): pad the app shell so content resizes
  // instead of being covered, same convention as ModelDetailDialog.
  useEffect(() => {
    if (!repo) return
    document.documentElement.classList.add('tllm-config-open')
    return () => document.documentElement.classList.remove('tllm-config-open')
  }, [repo])

  return (
    <Sheet open={!!repo} onOpenChange={(o) => !o && onClose()} modal={false}>
      <SheetContent
        className="overflow-y-auto p-5"
        // Push panel, not a modal: keep it open while the user browses behind it.
        // Close is via the ✕, Esc, or the buttons below.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <HfRepoContent repo={repo} onClose={onClose} onSearch={onSearch} />
      </SheetContent>
    </Sheet>
  )
}

/** The repo detail body: header + quant picker + VRAM verdict + gated guidance +
 *  primary action + rendered README. No Sheet/Dialog chrome of its own — usable
 *  standalone inside any container (a Sheet, per `HfRepoDialog` above, or a plain
 *  `<div>` column, per DiscoverTab's split-pane right side). */
export function HfRepoContent({
  repo,
  onClose,
  onSearch,
}: {
  repo: string | null
  onClose: () => void
  onSearch?: (term: string) => void
}) {
  const detailQ = useHfRepo(repo)
  const sysQ = useSysInfo()
  const dlMut = useDownloadMutations()
  const actions = useModelActions()

  const statusQ = useStatus()
  const engineKind = statusQ.data?.engine.kind ?? ''
  const detail = detailQ.data
  const vramMb = sysQ.data?.gpus?.[0]?.vramMb
  const isSafetensors = !!detail?.safetensors
  const [selected, setSelected] = useState<string>('')

  // Pre-select the recommended quant: largest that fits; prefer K-quants over IQ at
  // an equal size class (spec 10 §3). When NOTHING fits (e.g. a huge MoE model on modest
  // VRAM — the pool falls back to every gguf), prefer the SMALLEST file instead: sorting
  // "largest first" in that fallback used to default to the biggest/unquantized file
  // (a 1.5TB BF16 for GLM-5.2-GGUF), the least viable option, not the most. Re-runs when
  // the file list changes.
  useEffect(() => {
    if (!detail) return
    const ggufs = detail.files.filter((f) => !f.mmproj)
    if (ggufs.length === 0) return
    const fits = ggufs.filter((f) => fileFit(f.sizeBytes, vramMb) === 'fits')
    const pool = fits.length > 0 ? fits : ggufs
    const sizeDir = fits.length > 0 ? 1 : -1
    const best = [...pool].sort((a, b) => {
      if (b.sizeBytes !== a.sizeBytes) return (b.sizeBytes - a.sizeBytes) * sizeDir
      const aK = /q\d_k/i.test(a.quant) ? 0 : 1
      const bK = /q\d_k/i.test(b.quant) ? 0 : 1
      return aK - bK
    })[0]
    setSelected(best.name)
  }, [detail, vramMb])

  // Quant options sorted by size (smallest → largest) so the listing reads in a
  // sensible progression instead of alphabetically by filename.
  const ggufFiles = useMemo(
    () => (detail ? detail.files.filter((f) => !f.mmproj).sort((a, b) => a.sizeBytes - b.sizeBytes) : []),
    [detail],
  )
  const selectedFile = ggufFiles.find((f) => f.name === selected) ?? null
  const selectedIsLocal = !!selectedFile?.downloaded

  const fit = selectedFile ? fileFit(selectedFile.sizeBytes, vramMb) : 'unknown'
  const gated = detail?.gated ?? false
  // Gated repos require the user to accept the license + configure an HF token in
  // Settings → Models (spec 10 §4). The token state isn't exposed to this screen, so
  // gated repos route through the guided flow and disable the in-dialog download; the
  // enqueue endpoint is authoritative and returns 401/403 if the token is missing.
  const blockedByGate = gated

  const enqueueError = dlMut.enqueue.error instanceof ApiError ? dlMut.enqueue.error.message : null

  const onDownload = () => {
    if (!detail || !selectedFile) return
    dlMut.enqueue.mutate(
      { repo: detail.repo, rfilename: selectedFile.name, size: selectedFile.sizeBytes, sha256: selectedFile.sha256 },
      {
        // Stays open (both the Sheet and DiscoverTab's split-pane are "push panel, keep
        // it open while browsing" per this file's own convention above) — closing here
        // used to kick the user out of DiscoverTab's permanent detail pane on every
        // download, and out of the Sheet before they could pick another quant to queue.
        onSuccess: () => { toast.success(`Downloading ${selectedFile.name}`) },
      },
    )
  }

  // Safetensors repos (MLX / vLLM) download all component files into a subdirectory.
  const onDownloadSafetensors = () => {
    if (!detail?.safetensors || !detail.files.length) return
    const subdir = detail.repo.split('/').pop() ?? detail.repo
    let queued = 0
    for (const f of detail.files) {
      dlMut.enqueue.mutate({ repo: detail.repo, rfilename: f.name, size: f.sizeBytes, sha256: f.sha256, subdir })
      queued++
    }
    toast.success(`Queued ${queued} files for ${subdir}`)
    onClose()
  }

  const onLoad = () => {
    const key = selectedFile?.localKey
    if (!key) return
    actions.load.mutate(
      { key },
      {
        onSuccess: () => {
          toast.success(`Loading ${selectedFile?.quant ?? 'model'}`)
          onClose()
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.'),
      },
    )
  }

  return (
    <>
      {/* Plain elements, not Sheet's Title/Description (Radix Dialog primitives tied to
          a Dialog.Root context) — this content renders both inside a Sheet (HfRepoDialog)
          and bare, with no dialog ancestor at all (DiscoverTab's split-pane right column). */}
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="flex items-center gap-1.5 pr-6 text-[16px] font-semibold tracking-[-0.01em] text-ink">
          {gated && <Lock size={14} className="shrink-0" style={{ color: 'var(--warn)' }} />}
          <span className="truncate">{repo}</span>
        </h2>
        <p className="text-[13px] text-muted">
          {detail
            ? `${detail.downloads.toLocaleString()} downloads · ${detail.likes.toLocaleString()} likes${detail.license ? ` · ${detail.license}` : ''}`
            : 'Loading repo…'}
        </p>
      </div>

      {detailQ.isLoading ? (
        <div className="py-10 text-center text-[13px] text-muted">Loading repo…</div>
      ) : detailQ.isError ? (
        <UnreachableOrError
          error={detailQ.error}
          onRetry={() => detailQ.refetch()}
          onSearch={onSearch ? () => onSearch(repoSearchTerm(repo)) : undefined}
        />
      ) : isSafetensors ? (
        <MlxRepoBody
          detail={detail}
          vramMb={vramMb}
          engineKind={engineKind}
          onDownload={onDownloadSafetensors}
          isPending={dlMut.enqueue.isPending}
        />
      ) : !detail || ggufFiles.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-muted">No GGUF files found in this repo.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Quant selector */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
              Quant
              {detail.verifying && (
                <span className="text-[11px] font-normal text-faint">· checking your library…</span>
              )}
            </label>
            <QuantDropdown files={ggufFiles} selected={selected} onSelect={setSelected} vramMb={vramMb} />
          </div>

          {/* VRAM verdict line */}
          {selectedFile && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12px]">
              <FitDot fit={fit} size={10} />
              <span className="text-muted">
                {FIT_LABEL[fit]}
                {vramMb ? ` (${(selectedFile.sizeBytes / 1e9).toFixed(1)} GB file · ${(vramMb / 1024).toFixed(0)} GB VRAM)` : ''}
              </span>
            </div>
          )}

          {/* Gated guidance */}
          {blockedByGate && (
            <div className="rounded-md border px-3 py-2.5 text-[12px]" style={{ borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)' }}>
              <p className="text-ink">This is a gated model.</p>
              <p className="mt-1 text-muted">
                Accept the license on{' '}
                <a href={`https://huggingface.co/${detail.repo}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline" style={{ color: 'var(--accent)' }}>
                  huggingface.co <ExternalLink size={11} />
                </a>
                , then add a Hugging Face token in Settings → Models.
              </p>
            </div>
          )}

          {enqueueError && <p className="text-[12px]" style={{ color: 'var(--err)' }}>{enqueueError}</p>}

          {/* Primary action */}
          <div className="flex items-center gap-2">
            {selectedIsLocal && selectedFile?.localKey ? (
              <Button className="flex-1" onClick={() => { track('models', 'load_hf_quant'); onLoad() }} disabled={actions.load.isPending}>
                <Zap size={14} />
                Load
              </Button>
            ) : (
              <Button
                className="flex-1"
                onClick={() => { track('models', 'download_hf_quant'); onDownload() }}
                disabled={blockedByGate || dlMut.enqueue.isPending || !selectedFile}
              >
                <Download size={14} />
                {dlMut.enqueue.isPending ? 'Adding…' : selectedIsLocal ? 'Re-download' : 'Download'}
              </Button>
            )}
          </div>

          {/* README — rendered markdown, not raw text */}
          {detail.card && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">README</p>
              <div className="rounded-md border border-border bg-panel-2 px-3 py-2.5">
                <ModelCard text={detail.card} />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** A small colored dot indicating VRAM fit — green/yellow/red (fits/tight/overflow),
 *  neutral otherwise. Used both standalone (VRAM verdict line) and inside the quant
 *  dropdown so every option's fit is visible without opening it further. */
function FitDot({ fit, size = 8 }: { fit: FitVerdict; size?: number }) {
  return (
    <span
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, background: FIT_COLOR[fit] }}
      title={FIT_LABEL[fit]}
    />
  )
}

/** Quant picker replacing a native `<select>`: a native `<option>` can't render a
 *  colored dot, and the fit signal (green/yellow/red) is the whole point here — so
 *  this is a real listbox (Radix DropdownMenu) instead. */
function QuantDropdown({
  files,
  selected,
  onSelect,
  vramMb,
}: {
  files: HfRepoFile[]
  selected: string
  onSelect: (name: string) => void
  vramMb: number | undefined
}) {
  const selectedFile = files.find((f) => f.name === selected) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 py-2 text-left text-[13px] text-ink outline-none transition-colors hover:bg-panel-2"
      >
        {selectedFile ? (
          <span className="flex min-w-0 items-center gap-2">
            <FitDot fit={fileFit(selectedFile.sizeBytes, vramMb)} />
            <span className="truncate">
              {selectedFile.quant} · {fmtSize(selectedFile.sizeBytes)}
              {selectedFile.parts > 1 ? ` · ${selectedFile.parts} parts` : ''}
              {selectedFile.downloaded ? ' · Downloaded' : ''}
            </span>
          </span>
        ) : (
          <span className="text-faint">Select a quant…</span>
        )}
        <ChevronDown size={14} className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        {files.map((f) => (
          <DropdownMenuItem key={f.name} onSelect={() => { track('models', 'select_hf_quant'); onSelect(f.name) }} className="justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <FitDot fit={fileFit(f.sizeBytes, vramMb)} />
              <span className="truncate">
                {f.quant} · {fmtSize(f.sizeBytes)}
                {f.parts > 1 ? ` · ${f.parts} parts` : ''}
              </span>
            </span>
            {f.downloaded && (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 15%, transparent)' }}>
                Downloaded
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Rendered model card (README). A deliberately plain markdown renderer — no
 *  streaming/artifact handling (that's chat-specific, MessageBubble's Markdown) —
 *  just GFM + safe external links + basic table/code styling for a static preview. */
// Model cards frequently wrap layout (logo rows, badge banners) in raw HTML — react-
// markdown escapes raw HTML as literal text by default (a safe default, since a README
// is untrusted content from an arbitrary HF author). `rehype-raw` parses it into real
// nodes; `rehype-sanitize` then strips anything dangerous (script/iframe/on*handlers/
// javascript: links, etc.) using the same default schema GitHub's own README rendering
// sanitizes with. `style` is added to that schema so it survives sanitize at all, but
// (unlike GitHub, which strips `style` outright) an UNFILTERED style value would let an
// untrusted author inject `position:fixed` clickjacking overlays or `background:url()`
// tracking beacons — so `rehypeSafeStyle` below runs straight after sanitize and narrows
// whatever style text survives down to a safe, layout-only property allowlist.
const CARD_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'style'],
  },
}

/** CSS properties safe to keep in a `style` attribute after sanitize — layout-only, no
 *  positioning/paint/network surface. Runs on the raw string (hast keeps `style` as a
 *  string, not parsed) so no new CSS-parser dependency is needed. */
const SAFE_STYLE_PROPS = new Set([
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items',
  'gap', 'row-gap', 'column-gap',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'text-align', 'vertical-align', 'white-space',
  'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
  'border-radius',
])

/** Rehype plugin: filters every element's `style` attribute down to {@link SAFE_STYLE_PROPS},
 *  dropping any declaration not on the allowlist (position, background*, content, etc.).
 *  Runs AFTER rehype-sanitize in the pipeline — sanitize only allowlists the `style`
 *  *attribute* (tag/attribute-level), it has no notion of individual CSS properties, so
 *  this is the thing that actually keeps an untrusted style value safe. No unist-util-visit
 *  dependency — hast trees are small enough here for a plain recursive walk. */
function rehypeSafeStyle() {
  return (tree: { type: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
    const walk = (node: typeof tree) => {
      if (node.type === 'element' && typeof node.properties?.style === 'string') {
        const filtered = node.properties.style
          .split(';')
          .map((decl) => decl.trim())
          .filter(Boolean)
          .filter((decl) => SAFE_STYLE_PROPS.has(decl.split(':')[0]?.trim().toLowerCase() ?? ''))
          .join('; ')
        if (filtered) node.properties.style = filtered
        else delete node.properties.style
      }
      for (const child of node.children ?? []) walk(child as typeof tree)
    }
    walk(tree)
  }
}

function ModelCard({ text }: { text: string }) {
  return (
    // Text set close to normal reading size (not the app's usual compact 12px UI text):
    // these images carry ABSOLUTE pixel dimensions the author set assuming a normal
    // article context (HF's own model page — a wide column at ~16px body text), so
    // shrinking just the text while leaving images at their authored size is what made
    // images look oversized. Scaling the text back up (rather than capping images down)
    // keeps the proportions the author actually intended; `max-w-full` on images still
    // shrinks them if the panel itself is narrower than an image, same as any embedded
    // external content.
    <div className="flex flex-col gap-2 text-[14px] leading-relaxed text-muted [&_h1]:mt-1 [&_h2]:mt-3 [&_h3]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, CARD_SANITIZE_SCHEMA], rehypeSafeStyle]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">{children}</a>
          ),
          img: ({ src, alt, width, height }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={typeof src === 'string' ? src : undefined}
              alt={alt ?? ''}
              width={width}
              height={height}
              className="max-w-full rounded-md"
            />
          ),
          h1: ({ children }) => <h3 className="text-[16px] font-semibold text-ink">{children}</h3>,
          h2: ({ children }) => <h4 className="text-[15px] font-semibold text-ink">{children}</h4>,
          h3: ({ children }) => <h5 className="text-[14px] font-semibold text-ink">{children}</h5>,
          code: ({ className, children }) =>
            className ? (
              <code className="block overflow-x-auto rounded bg-bg p-2 font-mono text-[13px] leading-relaxed">{children}</code>
            ) : (
              <code className="break-all rounded bg-bg px-1 py-0.5 font-mono text-[13px]">{children}</code>
            ),
          table: ({ children }) => <div className="my-1 overflow-x-auto"><table className="w-full border-collapse text-[13.5px]">{children}</table></div>,
          th: ({ children }) => <th className="border border-border bg-bg px-2 py-1 text-left font-semibold text-ink">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** Body shown for safetensors repos (MLX / vLLM) — no quant selection, whole-directory download. */
function MlxRepoBody({
  detail,
  vramMb,
  engineKind,
  onDownload,
  isPending,
}: {
  detail: { files: { sizeBytes: number }[]; gated: boolean }
  vramMb: number | undefined
  engineKind: string
  onDownload: () => void
  isPending: boolean
}) {
  const totalBytes = detail.files.reduce((s, f) => s + f.sizeBytes, 0)
  const fit = fileFit(totalBytes, vramMb)
  const isMlxFamily = engineKind === 'mlx' || engineKind === 'rapid-mlx' || engineKind === 'mlx-vlm'
  const description = isMlxFamily
    ? 'MLX model — runs on Apple Silicon via MLX. Downloads as a directory of safetensors weights.'
    : engineKind === 'vllm'
      ? 'HuggingFace model — runs via vLLM. Downloads as a directory of safetensors weights.'
      : 'Safetensors model — downloads as a directory of weight files.'
  const btnLabel = isMlxFamily ? 'Download MLX model' : 'Download model'
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
        {description}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12px]">
        <FitDot fit={fit} size={10} />
        <span className="text-muted">
          {FIT_LABEL[fit]}
          {vramMb ? ` (${(totalBytes / 1e9).toFixed(1)} GB total · ${(vramMb / 1024).toFixed(0)} GB VRAM)` : `${(totalBytes / 1e9).toFixed(1)} GB total`}
        </span>
      </div>

      <Button className="w-full" onClick={() => { track('models', 'download_hf_model'); onDownload() }} disabled={detail.gated || isPending}>
        <Download size={14} />
        {isPending ? 'Queuing…' : btnLabel}
      </Button>
    </div>
  )
}

/** Distinct copy per failure mode: a genuinely unreachable HF gets the offline line;
 *  a not-found repo (commonly an inferred id whose folder name doesn't match HF)
 *  explains that and offers a search instead of a dead-end Retry. */
function UnreachableOrError({ error, onRetry, onSearch }: { error: unknown; onRetry: () => void; onSearch?: () => void }) {
  const code = error instanceof ApiError ? error.code : ''
  const notFound = code === 'hf_not_found'
  const unreachable = code === 'hf_unreachable'
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="max-w-sm text-[13px] text-muted">
        {notFound
          ? "We couldn't find this exact model on Hugging Face — the local folder name may not match its repo. Try searching for it instead."
          : unreachable
            ? 'Hugging Face is unreachable — check your connection.'
            : error instanceof ApiError
              ? error.message
              : 'Could not load this repo.'}
      </p>
      <div className="flex items-center gap-2">
        {notFound && onSearch && (
          <Button size="sm" onClick={() => { track('models', 'search_hf_from_error'); onSearch() }}>Search Hugging Face</Button>
        )}
        <Button size="sm" variant="outline" onClick={() => { track('models', 'retry_hf_repo_load'); onRetry() }}>Retry</Button>
      </div>
    </div>
  )
}

/** Derive a search term from a repo id: drop the owner, strip a -GGUF suffix, and
 *  turn separators into spaces (e.g. "unsloth/Gemma-4-E4B-GGUF" → "Gemma 4 E4B"). */
function repoSearchTerm(repo: string | null): string {
  if (!repo) return ''
  const name = repo.split('/').pop() ?? repo
  return name.replace(/[-_]?gguf$/i, '').replace(/[-_]+/g, ' ').trim()
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}

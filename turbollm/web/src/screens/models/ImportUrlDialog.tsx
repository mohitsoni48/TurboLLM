// Import-from-URL dialog (spec 10 §8). A URL field with a live filename preview;
// client-side validation that the URL looks like a direct .gguf or an HF resolve
// blob URL; on submit it enqueues a raw-URL download via useDownloadMutations and
// closes — the item then appears in the DownloadsPanel.

import { useEffect, useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { ApiError, track } from '../../lib/api'
import { useDownloadMutations } from '../../lib/queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'

/** First path segment reserved by HF for non-model routes — never a repo owner. Keeps
 *  a datasets/spaces/browse URL from being mistaken for an `owner/repo` model repo. */
const HF_RESERVED_PREFIX = new Set([
  'datasets', 'spaces', 'models', 'organizations', 'settings', 'collections', 'blog', 'docs', 'join', 'login', 'pricing',
])

/** Recognise an HF *repo* landing/tree URL (not a single-file link) and return its
 *  `owner/repo`, else null. A repo has many quants, so pasting one can't download a
 *  file directly — the dialog routes it to the repo's quant picker instead. */
function parseHfRepoUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.hostname !== 'huggingface.co') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  // A file link (resolve/blob) is handled by the .gguf path, not here.
  if (parts.includes('resolve') || parts.includes('blob')) return null
  const [owner, repo, third] = parts
  if (HF_RESERVED_PREFIX.has(owner.toLowerCase())) return null
  // owner/repo, optionally followed by /tree/<rev>/… — anything else isn't a repo root.
  if (parts.length === 2 || third === 'tree') return `${owner}/${repo}`
  return null
}

/** True when the URL is a plausible GGUF download target (spec 10 §8 step 2):
 *  path ends in `.gguf` OR matches an HF resolve blob URL. */
function isValidGgufUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const path = u.pathname.toLowerCase()
  if (path.endsWith('.gguf')) return true
  // HF blob URL: huggingface.co/<repo>/resolve/<rev>/<file>.gguf
  return /huggingface\.co\/.*\/resolve\/.*\.gguf$/i.test(`${u.host}${u.pathname}`)
}

/** Derived filename from the URL path (spec 10 §8: filename preview). */
function deriveFilename(raw: string): string {
  try {
    const u = new URL(raw)
    const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return ''
  }
}

/** Convert non-standard HF URL forms to a direct https resolve URL.
 *  Handles hf://owner/repo/file.gguf, ?show_file_info=file.gguf page URLs,
 *  and /blob/ viewer URLs (rewrites to /resolve/ direct-download).
 *  All other URLs are returned unchanged. */
function normalizeHfUrl(raw: string): string {
  try {
    if (raw.startsWith('hf://')) {
      const parts = raw.slice(5).split('/')
      if (parts.length >= 3 && parts[parts.length - 1].toLowerCase().endsWith('.gguf')) {
        const [owner, repo, ...rest] = parts
        return `https://huggingface.co/${owner}/${repo}/resolve/main/${rest.join('/')}`
      }
    }
    const u = new URL(raw)
    if (u.hostname === 'huggingface.co') {
      const file = u.searchParams.get('show_file_info')
      if (file && file.toLowerCase().endsWith('.gguf')) {
        return `https://huggingface.co${u.pathname}/resolve/main/${file}`
      }
      u.pathname = u.pathname.replace(/\/blob\//, '/resolve/')
      return u.toString()
    }
  } catch { /* ignore */ }
  return raw
}

export function ImportUrlDialog({
  open,
  onClose,
  onOpenRepo,
}: {
  open: boolean
  onClose: () => void
  /** Called when the pasted URL is a repo (many quants) rather than a single file —
   *  routes to the repo's quant picker instead of a direct download. */
  onOpenRepo?: (repo: string) => void
}) {
  const mut = useDownloadMutations()
  const [url, setUrl] = useState('')

  const trimmed = url.trim()
  const normalized = useMemo(() => normalizeHfUrl(trimmed), [trimmed])
  const wasNormalized = normalized !== trimmed
  const filename = useMemo(() => deriveFilename(normalized), [normalized])
  // A repo URL (owner/repo, no file) can't download directly — it holds many quants —
  // so it's routed to the quant picker. A direct .gguf/resolve URL downloads as before.
  const repoTarget = useMemo(() => parseHfRepoUrl(normalized), [normalized])
  const validFile = trimmed.length > 0 && isValidGgufUrl(normalized)
  const valid = validFile || !!repoTarget
  const showInvalid = trimmed.length > 0 && !valid

  const enqueueErr = mut.enqueue.error instanceof ApiError ? mut.enqueue.error : null
  const enqueueError = enqueueErr?.message ?? null
  const noModelDir = enqueueErr?.code === 'no_model_dir'

  const close = () => {
    setUrl('')
    mut.enqueue.reset()
    onClose()
  }

  const submit = () => {
    track('models', 'import_model_url')
    if (repoTarget) {
      onOpenRepo?.(repoTarget)
      close()
      return
    }
    if (!validFile) return
    mut.enqueue.mutate(
      { url: normalized },
      {
        onSuccess: () => close(),
      },
    )
  }

  // Side panel, not a modal (spec 00 §9): pad the app shell so content resizes
  // instead of being covered, same convention as ModelDetailDialog.
  useEffect(() => {
    if (!open) return
    document.documentElement.classList.add('tllm-config-open')
    return () => document.documentElement.classList.remove('tllm-config-open')
  }, [open])

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()} modal={false}>
      <SheetContent
        className="overflow-y-auto p-5"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>Import from URL</SheetTitle>
          <SheetDescription>
            Paste a <span className="font-mono">.gguf</span> link (any HTTPS host) or a Hugging Face model page — a repo
            link opens its quant list to pick from.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="https://huggingface.co/owner/repo  ·  or …/resolve/main/model.Q4_K_M.gguf"
            className="font-mono text-[12px]"
          />

          {repoTarget ? (
            <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-[12px]">
              <span className="text-muted">Model repo </span>
              <span className="font-mono text-ink">{repoTarget}</span>
              <p className="mt-1 text-faint">Opens its quant list so you can pick which one to download.</p>
            </div>
          ) : (
            filename && valid && (
              <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-[12px]">
                <span className="text-muted">Will save as </span>
                <span className="font-mono text-ink">{filename}</span>
                {wasNormalized && (
                  <p className="mt-1 text-faint">URL converted to a direct download link.</p>
                )}
              </div>
            )
          )}

          {showInvalid && (
            <p className="text-[12px]" style={{ color: 'var(--err)' }}>
              Enter a Hugging Face model link, or an http(s) link ending in <span className="font-mono">.gguf</span>.
            </p>
          )}

          {enqueueError && (
            <p className="text-[12px]" style={{ color: 'var(--err)' }}>{enqueueError}</p>
          )}
          {noModelDir && (
            <p className="text-[12px] text-muted">
              → Open <span className="font-medium text-ink">Settings → Model folders</span> to add a folder, then try again.
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => { track('models', 'close_import_url_dialog'); close() }}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || mut.enqueue.isPending}>
            <Link2 size={14} />
            {mut.enqueue.isPending ? 'Adding…' : repoTarget ? 'Open' : 'Import'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

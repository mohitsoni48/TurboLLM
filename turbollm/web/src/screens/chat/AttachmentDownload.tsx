// A file a run_python call made for the user to download (GitHub #52): a CSV, JSON, text or Python file. The daemon
// keeps it in the attachment store and serves it only as a download (chat-routes.ts). The page fetches it with its own
// auth headers, as AttachmentImage does, and hands the bytes to the browser to save under the name the code gave it.
import { useState } from 'react'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { authHeaders } from '../../lib/api'
import type { ToolOutput } from '../../lib/chat-types'
import { toast } from '../../components/ui/sonner'

const REF_PREFIX = 'attachment:'

/** A size as people read it: 512 B, 3.4 KB, 12 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Fetches the stored file and saves it through a temporary link. */
async function saveFile(output: ToolOutput): Promise<void> {
  const id = encodeURIComponent(output.file.slice(REF_PREFIX.length))
  const res = await fetch(`/api/v1/attachments/${id}?name=${encodeURIComponent(output.name)}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`status ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = output.name
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    // After the click has handed the blob to the browser's download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export function AttachmentDownload({ output }: { output: ToolOutput }) {
  const [saving, setSaving] = useState(false)
  const download = () => {
    if (saving) return
    setSaving(true)
    saveFile(output)
      .catch(() => toast.error(`Could not download ${output.name}. It may have been removed with an older message.`))
      .finally(() => setSaving(false))
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1">
      <button
        type="button"
        onClick={download}
        disabled={saving}
        title={`Download ${output.name}`}
        className="flex min-w-0 max-w-xs items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-panel-2 disabled:opacity-60"
      >
        {saving ? <Loader2 size={13} className="shrink-0 animate-spin text-muted" /> : <Download size={13} className="shrink-0 text-muted" />}
        <span className="min-w-0 truncate font-mono">{output.name}</span>
        <span className="shrink-0 text-[11px] text-faint">{fileSize(output.size)}</span>
      </button>
      {output.formulaCells && (
        <p className="flex max-w-xs items-start gap-1.5 text-[11px] leading-snug text-warning">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          <span>Some cells start with = + - or @. A spreadsheet may run them as formulas.</span>
        </p>
      )}
    </div>
  )
}

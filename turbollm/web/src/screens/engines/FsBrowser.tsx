import { useEffect, useState } from 'react'
import { ArrowUp, Check, File as FileIcon, Folder, RotateCw } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useFsBrowse } from '../../lib/queries'
import { truncateMiddle } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { InlineError } from '../../components/common'

/** In-app filesystem browser (spec 03 §9). Navigates directories under the
 *  daemon's home dir. In `file` mode (default) folder rows descend and file rows
 *  select; in `folder` mode folder rows still descend, but a "Select this folder"
 *  action picks the current directory (engine overhaul, Phase 3 — the guided scan
 *  takes a folder). Starts at the home dir (null path → server default). Server
 *  enforces the home-confinement; this is purely a navigator. */
export function FsBrowser({
  open,
  onOpenChange,
  onSelect,
  mode = 'file',
  title,
  description,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  /** 'file' = click a file to pick; 'folder' = pick the current dir; 'any' = either. */
  mode?: 'file' | 'folder' | 'any'
  title?: string
  description?: string
}) {
  // null = the daemon's home dir (server default); a string = an explicit dir.
  const [path, setPath] = useState<string | null>(null)
  const { data, isFetching, error, refetch } = useFsBrowse(path, open)

  // Reset to the home dir each time the browser is reopened.
  useEffect(() => {
    if (open) setPath(null)
  }, [open])

  const choose = (p: string) => {
    onSelect(p)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? (mode === 'folder' ? 'Choose engine folder' : 'Browse for binary')}</DialogTitle>
          <DialogDescription>
            {description ? description : mode === 'folder' ? (
              <>
                Open the folder that contains your engine build, then click{' '}
                <span className="font-medium text-ink">Select this folder</span>. We&apos;ll scan it
                for <code className="font-mono">llama-server</code>. Limited to your home directory.
              </>
            ) : (
              <>
                Navigate to the compiled <code className="font-mono">llama-server</code> executable
                and click it to select. Limited to your home directory.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="iconSm"
            onClick={() => data?.parent != null && setPath(data.parent)}
            disabled={!data || data.parent == null || isFetching}
            aria-label="Up one folder"
          >
            <ArrowUp size={16} />
          </Button>
          <div
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-muted"
            title={data?.path ?? ''}
          >
            {data?.path ?? '…'}
          </div>
          <Button
            variant="outline"
            size="iconSm"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="Refresh"
          >
            <RotateCw size={16} className={isFetching ? 'animate-spin' : undefined} />
          </Button>
        </div>

        {error ? (
          <InlineError
            message={error instanceof ApiError ? error.message : 'Could not read that folder.'}
            onRetry={() => void refetch()}
            className="mt-3"
          />
        ) : (
          <ul className="mt-3 max-h-[320px] overflow-y-auto rounded-md border border-border">
            {data && data.entries.length === 0 && (
              <li className="px-3 py-6 text-center text-[13px] text-muted">This folder is empty.</li>
            )}
            {data?.entries.map((e) => {
              // In folder mode files are inert (greyed) — only the "Select this folder"
              // action picks a target. In file mode files select, folders descend.
              const inert = mode === 'folder' && !e.isDir
              return (
                <li key={e.path}>
                  <button
                    type="button"
                    disabled={inert}
                    onClick={() => (e.isDir ? setPath(e.path) : choose(e.path))}
                    className={
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink ' +
                      (inert ? 'cursor-default text-faint' : 'hover:bg-panel-2')
                    }
                  >
                    {e.isDir ? (
                      <Folder size={16} className="shrink-0 text-muted" />
                    ) : (
                      <FileIcon size={16} className={inert ? 'shrink-0 text-faint' : 'shrink-0 text-muted'} />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono">{truncateMiddle(e.name, 48)}</span>
                    {mode !== 'folder' && !e.isDir && <span className="shrink-0 text-[11px] text-muted">Select</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {mode !== 'file' && (
            <Button onClick={() => data?.path && choose(data.path)} disabled={!data?.path || isFetching}>
              <Check size={16} /> Select this folder
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { Check, ExternalLink, GitBranch, UploadCloud } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'
import { useCodeSessionCompareUrl, useCodeSessionGitStatus, useCommitCodeSessionGit, usePushCodeSessionGit } from '../../lib/code-queries'
import { ApiError, track } from '../../lib/api'
import type { PushGitReason, PushGitResult } from '../../lib/code-types'

/** Every rejection reason `pushGitBranch` (git-actions.ts) can return, mapped to a clear,
 *  specific sentence — never a generic "push failed" for an expected case. `push_failed` has no
 *  entry: it's a genuinely unexpected git error, so the route's own message (real git stderr,
 *  already specific) is shown as-is rather than replaced with something vaguer. */
const PUSH_REJECTION_MESSAGE: Partial<Record<PushGitReason, string>> = {
  diverged: 'Push rejected: your branch has diverged from the remote. Pull or rebase first — nothing is ever force-pushed automatically.',
  no_remote: 'This repo has no remote configured — add one (e.g. `git remote add origin <url>`) before pushing.',
  detached_head: 'Can\'t push from a detached HEAD — check out a branch first.',
  not_a_repo: 'This folder isn\'t a git repository.',
}

function pushErrorMessage(result: Extract<PushGitResult, { ok: false }>): string {
  return PUSH_REJECTION_MESSAGE[result.reason] ?? result.message
}

/** Session header's "Git" action — status, commit (all changes or a selection), push, and a
 *  "Create PR" link once a compare URL is resolvable (Phase 3, ADR-259). Read-then-act: status
 *  (and any existing compare URL) is fetched fresh every time the dialog opens rather than
 *  assumed, so it never shows stale state from a previous open. */
export function CodeGitDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const statusQ = useCodeSessionGitStatus(sessionId, open)
  const status = statusQ.data?.status
  const compareUrlQ = useCodeSessionCompareUrl(sessionId, open && !!status && !status.detached && !!status.branch)
  const commitMut = useCommitCodeSessionGit()
  const pushMut = usePushCodeSessionGit()

  const [message, setMessage] = useState('')
  // Paths the user has manually UNCHECKED — empty means "commit everything" (the default), which
  // maps to omitting `files` entirely so the backend's own "stage all" path is used rather than
  // enumerating every path back at it.
  const [deselected, setDeselected] = useState<Set<string>>(new Set())
  const [pushResult, setPushResult] = useState<PushGitResult | null>(null)

  // Reset per-open, local UI-only state — a stale commit message or selection from a previous
  // open (possibly of a DIFFERENT session, if the dialog is ever reused) must never survive.
  useEffect(() => {
    if (open) { setMessage(''); setDeselected(new Set()); setPushResult(null) }
  }, [open, sessionId])

  const files = status?.files ?? []
  const toggleFile = (path: string) => {
    setDeselected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const selectedCount = files.length - deselected.size
  const allSelected = deselected.size === 0

  const handleCommit = () => {
    track('code', 'commit_code_git')
    const trimmed = message.trim()
    if (!trimmed) { toast.error('A commit message is required.'); return }
    const filesArg = allSelected ? undefined : files.map((f) => f.path).filter((p) => !deselected.has(p))
    commitMut.mutate(
      { sessionId, message: trimmed, files: filesArg },
      {
        onSuccess: (r) => {
          toast.success(`Committed ${r.filesCommitted} file${r.filesCommitted === 1 ? '' : 's'}.`)
          setMessage('')
          setDeselected(new Set())
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Commit failed.'),
      },
    )
  }

  const handlePush = () => {
    track('code', 'push_code_git')
    setPushResult(null)
    pushMut.mutate(sessionId, {
      onSuccess: (r) => {
        setPushResult(r)
        if (r.ok) toast.success(`Pushed to ${r.remote}/${r.branch}.`)
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Push failed.'),
    })
  }

  // A PR link is offered from whichever is freshest: a push made in THIS dialog session wins
  // (it's the most current possible signal), otherwise fall back to the standalone lookup (a
  // branch pushed by an earlier session/turn).
  const compareUrl = (pushResult?.ok ? pushResult.compareUrl : undefined) ?? compareUrlQ.data?.compareUrl ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={16} className="text-muted" /> Git
          </DialogTitle>
          <DialogDescription>
            {status?.branch ? `On ${status.branch}${status.detached ? ' (detached)' : ''}` : 'Commit and push changes for this session.'}
          </DialogDescription>
        </DialogHeader>

        {statusQ.isLoading && <p className="py-6 text-center text-[13px] text-muted">Checking git status…</p>}

        {!statusQ.isLoading && status && !status.isRepo && (
          <p className="py-6 text-center text-[13px] text-muted">This session's folder isn't a git repository.</p>
        )}

        {!statusQ.isLoading && status?.isRepo && (
          <div className="flex flex-col gap-4">
            {files.length === 0 ? (
              <p className="rounded-md border border-border bg-panel-2 px-3 py-2 text-[13px] text-muted">
                Working tree is clean — nothing to commit.
              </p>
            ) : (
              <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5">
                {files.map((f) => {
                  const checked = !deselected.has(f.path)
                  return (
                    <label
                      key={f.path}
                      className="flex cursor-pointer select-none items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-panel-2"
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => toggleFile(f.path)}
                      />
                      <span
                        className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors"
                        style={checked ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--border-strong)' }}
                        aria-hidden
                      >
                        {checked && <Check size={9} strokeWidth={3.5} style={{ color: 'var(--on-accent)' }} />}
                      </span>
                      <span className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[10px] text-muted">{f.code.trim() || '?'}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{f.path}</span>
                    </label>
                  )
                })}
              </div>
            )}

            {files.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Commit message"
                  rows={2}
                  className="w-full resize-none rounded-md border border-border bg-panel px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:border-accent"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-faint">{selectedCount} of {files.length} file{files.length === 1 ? '' : 's'} selected</span>
                  <Button
                    size="sm"
                    onClick={handleCommit}
                    disabled={commitMut.isPending || selectedCount === 0 || !message.trim()}
                  >
                    {commitMut.isPending ? 'Committing…' : 'Commit'}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-muted">
                  {!status.hasRemote
                    ? 'No remote configured'
                    : status.ahead > 0
                      ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'} ahead of ${status.hasUpstream ? 'origin' : '(not yet pushed)'}`
                      : status.hasUpstream ? 'Up to date with origin' : 'Not yet pushed'}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePush}
                  disabled={pushMut.isPending || !status.hasRemote || status.detached}
                >
                  <UploadCloud size={13} /> {pushMut.isPending ? 'Pushing…' : 'Push'}
                </Button>
              </div>
              {pushResult && !pushResult.ok && (
                <p
                  className="rounded-md border px-2.5 py-1.5 text-[12px]"
                  style={{ borderColor: 'var(--err)', background: 'color-mix(in srgb, var(--err) 8%, transparent)', color: 'var(--err)' }}
                >
                  {pushErrorMessage(pushResult)}
                </p>
              )}
              {compareUrl && (
                <a
                  href={compareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn('inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-accent hover:underline')}
                >
                  Create PR <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { track('code', 'close_code_git_dialog'); onOpenChange(false) }}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

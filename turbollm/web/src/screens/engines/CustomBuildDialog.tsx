import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog'
import { BuildGuideDialog } from './BuildGuideDialog'

/** "Add via git repo" (Release 4, ADR-183/184): type an arbitrary git repo URL — plus an
 *  optional branch (any branch, including `main`) — and hand off to {@link BuildGuideDialog}.
 *  That dialog already accepts any `repoUrl`/`branch` (ADR-089/100); every existing call site
 *  just happened to hardcode a catalog entry's URL. This is the missing UI wiring only — no
 *  new backend pipeline, same `POST /api/v1/build/run` every catalog build already uses. */
export function CustomBuildDialog() {
  const [formOpen, setFormOpen] = useState(false)
  const [buildOpen, setBuildOpen] = useState(false)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')

  const canContinue = name.trim().length > 0 && /^https?:\/\/\S+/.test(repoUrl.trim())

  const reset = () => {
    setName('')
    setRepoUrl('')
    setBranch('')
  }

  return (
    <>
      <Dialog open={formOpen} onOpenChange={(o) => { setFormOpen(o); if (!o) reset() }}>
        <DialogTrigger asChild>
          <Button variant="outline">
            <GitBranch size={16} /> Add via git repo
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Build an engine from a git repo</DialogTitle>
            <DialogDescription>
              Any llama.cpp-compatible fork. Pick the branch to build — including{' '}
              <code className="font-mono">main</code> — and TurboLLM clones + compiles it for you.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My llama.cpp fork" autoFocus />
              <span className="text-[12px] text-muted">Any label you choose — shown in the engine list.</span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Git repo URL</span>
              <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Branch (optional)</span>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
              <span className="text-[12px] text-muted">Leave blank to build the repo&apos;s own default branch.</span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={() => { setFormOpen(false); setBuildOpen(true) }} disabled={!canContinue}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {buildOpen && (
        <BuildGuideDialog
          open={buildOpen}
          onOpenChange={(o) => {
            setBuildOpen(o)
            if (!o) reset()
          }}
          repoUrl={repoUrl.trim()}
          branch={branch.trim() || undefined}
          engineName={name.trim()}
        />
      )}
    </>
  )
}

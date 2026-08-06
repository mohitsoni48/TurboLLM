import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, CheckCircle2, FolderOpen, Loader2, Plus, SearchX } from 'lucide-react'
import { ApiError, track } from '../../lib/api'
import { useEngineMutations, useEngineScan } from '../../lib/queries'
import type { EngineScanResult } from '../../lib/types'
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
import { InlineError } from '../../components/common'
import { toast } from '../../components/ui/sonner'
import { FsBrowser } from './FsBrowser'

type Step = 'choose' | 'scanning' | 'confirm' | 'notfound'

/** Guided "Add your own engine" flow (engine overhaul, Phase 3). A 2-step journey:
 *  (1) pick a FOLDER (or the binary directly), we scan it for the server binary;
 *  (2) confirm the auto-detected version + a pre-filled name, then Add. Graceful
 *  fallback when nothing is found. Registration still goes through POST
 *  /api/v1/engines; scan is read-only. Same exported name + trigger as before — the
 *  EnginesScreen call sites are unchanged.
 *
 *  ADR-089 (guided build hand-off): callers can drive the dialog in CONTROLLED mode
 *  (`open` + `onOpenChange`) and prefill the source-repo via `defaultSourceRepo` so the
 *  build guide can hand off with the repo already filled. A custom `trigger` replaces the
 *  default "Add engine" button; pass `trigger={null}` for a controlled, trigger-less dialog.
 *  Uncontrolled self-triggered usage (no `open`) is unchanged. */
export function AddEngineDialog({
  open: controlledOpen,
  onOpenChange,
  defaultSourceRepo,
  trigger,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultSourceRepo?: string
  trigger?: ReactNode
} = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = (o: boolean) => {
    if (!isControlled) setUncontrolledOpen(o)
    onOpenChange?.(o)
  }
  const [step, setStep] = useState<Step>('choose')
  const [browse, setBrowse] = useState<null | 'folder' | 'file'>(null)
  // Confirm-step state, set from a successful scan.
  const [binPath, setBinPath] = useState('')
  const [version, setVersion] = useState('')
  const [name, setName] = useState('')
  // Optional source-repo URL (ADR-088): the GitHub repo this build came from. Lets
  // TurboLLM detect "newer source available → rebuild" by comparing commits.
  const [sourceRepo, setSourceRepo] = useState('')
  // Spec 03 §2: name_already_taken renders under the Name field; every other code
  // (scan/probe) renders as a top-level inline error on the active step.
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { add } = useEngineMutations()
  const scan = useEngineScan()

  // ADR-089: when opened with a prefilled source repo (the build-guide hand-off), seed
  // the field so the rebuild-tracking provenance is attached without re-typing it.
  useEffect(() => {
    if (open && defaultSourceRepo) setSourceRepo(defaultSourceRepo)
  }, [open, defaultSourceRepo])

  const reset = () => {
    setStep('choose')
    setBrowse(null)
    setBinPath('')
    setVersion('')
    setName('')
    setSourceRepo('')
    setNameError(null)
    setError(null)
  }

  // Run the read-only scan on the chosen path, then route to confirm / notfound.
  // A ProbeError (wrong-OS / timeout) comes back as an ApiError → inline on choose.
  const runScan = (path: string) => {
    setError(null)
    setNameError(null)
    setStep('scanning')
    scan.mutate(path, {
      onSuccess: (res: EngineScanResult) => {
        if (!res.found) {
          setStep('notfound')
          return
        }
        setBinPath(res.binPath)
        setVersion(res.version)
        setName(res.suggestedName)
        setStep('confirm')
      },
      onError: (e) => {
        setError(e instanceof ApiError ? e.message : 'Could not scan that location.')
        setStep('choose')
      },
    })
  }

  const submit = () => {
    setNameError(null)
    setError(null)
    const repo = sourceRepo.trim()
    add.mutate(
      { name: name.trim(), binPath, ...(repo ? { sourceRepo: repo } : {}) },
      {
        onSuccess: (eng) => {
          // probe_no_version (spec 03 §2): saved but version unknown — non-blocking warning.
          if (eng.warning === 'no_version') {
            toast.warning('Engine added, but its version could not be detected.')
          } else {
            toast.success('Engine added')
          }
          setOpen(false)
          reset()
        },
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : ''
          const msg = e instanceof ApiError ? e.message : 'Could not add engine.'
          if (code === 'name_already_taken') setNameError(msg)
          else setError(msg)
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o: boolean) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      {trigger !== undefined ? (
        trigger !== null && <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <Button>
            <Plus size={16} /> Add engine
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        {step === 'choose' && (
          <>
            <DialogHeader>
              <DialogTitle>Add your own engine</DialogTitle>
              <DialogDescription>
                Bring any llama.cpp-compatible build or community fork. Pick the folder it lives
                in and we&apos;ll find the server binary for you.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <Button onClick={() => { track('engines', 'browse_new_engine_folder'); setBrowse('folder') }} className="w-full">
                <FolderOpen size={16} /> Choose folder…
              </Button>
              <button
                type="button"
                onClick={() => { track('engines', 'browse_new_engine_binary'); setBrowse('file') }}
                className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
              >
                or pick the binary directly
              </button>
              <p className="text-[12px] text-faint">
                Works with: ik_llama.cpp · TurboQuant · llama.cpp builds · any fork
              </p>
              {error && <InlineError message={error} />}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { track('engines', 'cancel_add_engine'); setOpen(false) }}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'scanning' && (
          <>
            <DialogHeader>
              <DialogTitle>Add your own engine</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
              <Loader2 size={18} className="shrink-0 animate-spin text-ink" />
              Looking for the server binary…
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle>Confirm engine</DialogTitle>
              <DialogDescription>Review what we found, then add it.</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-panel p-3 text-[13px] text-ink">
                <CheckCircle2 size={16} className="shrink-0" style={{ color: 'var(--ok)' }} />
                <span>
                  Found <code className="font-mono">llama-server</code>
                  {version && version.toLowerCase() !== 'unknown' ? (
                    <>
                      {' · '}
                      <span className="text-muted">{version}</span>
                    </>
                  ) : null}
                </span>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                <span className="text-[12px] text-muted">Any label you choose — shown in the engine list.</span>
                {nameError && <InlineError message={nameError} />}
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink">Binary</span>
                <div
                  className="truncate rounded-md border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-muted"
                  title={binPath}
                >
                  {binPath}
                </div>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink">Source repo URL (optional)</span>
                <Input
                  value={sourceRepo}
                  onChange={(e) => setSourceRepo(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                />
                <span className="text-[12px] text-muted">
                  Paste the GitHub repo you built this from — lets TurboLLM tell you when a newer build is available.
                </span>
              </label>

              {error && <InlineError message={error} />}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { track('engines', 'back_to_add_engine_choose'); setStep('choose') }} disabled={add.isPending}>
                <ArrowLeft size={16} /> Back
              </Button>
              <Button onClick={() => { track('engines', 'submit_new_engine'); submit() }} disabled={name.trim().length === 0 || add.isPending}>
                {add.isPending ? 'Adding…' : 'Add engine'}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'notfound' && (
          <>
            <DialogHeader>
              <DialogTitle>No engine found</DialogTitle>
            </DialogHeader>
            <div className="flex items-start gap-2.5 rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
              <SearchX size={18} className="mt-0.5 shrink-0 text-faint" />
              <span>
                We couldn&apos;t find <code className="font-mono">llama-server</code> in that folder. Pick the
                folder that contains it, or select the binary directly.
              </span>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { track('engines', 'back_to_add_engine_choose'); setStep('choose') }}>
                <ArrowLeft size={16} /> Back
              </Button>
              <Button onClick={() => { track('engines', 'browse_new_engine_binary'); setBrowse('file') }}>Pick the binary directly</Button>
            </DialogFooter>
          </>
        )}

        {/* Shared picker — folder or file mode, drives the scan on select. */}
        <FsBrowser
          open={browse !== null}
          mode={browse === 'file' ? 'file' : 'folder'}
          onOpenChange={(o) => {
            if (!o) setBrowse(null)
          }}
          onSelect={(p) => {
            track('engines', 'select_new_engine_path')
            setBrowse(null)
            runScan(p)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

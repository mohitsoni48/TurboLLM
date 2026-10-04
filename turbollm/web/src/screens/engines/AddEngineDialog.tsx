import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, FileArchive, FolderOpen, Loader2, Plus, SearchX } from 'lucide-react'
import { ApiError, deleteEngineZipInstall, track } from '../../lib/api'
import { useEngineMutations, useEngineScan, useEngineZipUpload } from '../../lib/queries'
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
 *  (1) pick a FOLDER (or the binary directly), upload a .zip, or browse — we scan for the
 *  server binary; (2) confirm the auto-detected version + a pre-filled name, then Add.
 *  Graceful fallback when nothing is found. Registration still goes through POST
 *  /api/v1/engines; scan is read-only. Same exported name + trigger as before — the
 *  EnginesScreen call sites are unchanged.
 *
 *  The .zip source has one extra outcome: a same-named re-upload replaces an engine this
 *  flow installed earlier, and the daemon answers `updated` instead — the confirm step
 *  becomes an "Engine updated" summary with nothing left to Add.
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
  // Which source the in-flight scan came from — only varies the scanning/not-found copy;
  // the confirm step is identical (both paths end in an absolute binPath to register).
  const [scanSource, setScanSource] = useState<'path' | 'zip'>('path')
  const [zipName, setZipName] = useState('')
  const zipInput = useRef<HTMLInputElement>(null)
  // Confirm-step state, set from a successful scan. `updated` is set when the upload
  // replaced an engine that already lived in that build folder — the daemon refreshed its
  // registration in place, so there is nothing left to Add; `zipWarning` carries a
  // non-blocking install caveat (a CUDA build without its cudart runtime).
  const [binPath, setBinPath] = useState('')
  const [version, setVersion] = useState('')
  const [name, setName] = useState('')
  const [updated, setUpdated] = useState<{ id: string; name: string } | null>(null)
  const [zipWarning, setZipWarning] = useState<string | null>(null)
  // Epoch guard: reset() bumps it, so a scan/upload result that lands AFTER the dialog was
  // dismissed (an upload can outlive the dialog by minutes) is dropped instead of dragging
  // the reset dialog back to the confirm step on a stale upload.
  const flow = useRef(0)
  // The binPath of a zip upload that extracted but hasn't been registered yet — GC'd
  // (best-effort, server-side marker-verified) when the dialog is dismissed or a new
  // upload starts, so an abandoned build doesn't sit on disk forever.
  const pendingZipBin = useRef<string | null>(null)
  // Optional source-repo URL (ADR-088): the GitHub repo this build came from. Lets
  // TurboLLM detect "newer source available → rebuild" by comparing commits.
  const [sourceRepo, setSourceRepo] = useState('')
  // Spec 03 §2: name_already_taken renders under the Name field; every other code
  // (scan/probe) renders as a top-level inline error on the active step.
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { add } = useEngineMutations()
  const scan = useEngineScan()
  const zipUpload = useEngineZipUpload()

  // ADR-089: when opened with a prefilled source repo (the build-guide hand-off), seed
  // the field so the rebuild-tracking provenance is attached without re-typing it.
  useEffect(() => {
    if (open && defaultSourceRepo) setSourceRepo(defaultSourceRepo)
  }, [open, defaultSourceRepo])

  const reset = () => {
    flow.current++ // in-flight scan/upload results are now stale
    gcPendingZip()
    setStep('choose')
    setBrowse(null)
    setScanSource('path')
    setZipName('')
    setBinPath('')
    setVersion('')
    setName('')
    setUpdated(null)
    setZipWarning(null)
    setSourceRepo('')
    setNameError(null)
    setError(null)
  }

  // Best-effort removal of an extracted-but-never-registered zip install; the daemon also
  // GCs abandoned ones on the next upload, this just does it promptly.
  const gcPendingZip = () => {
    const bin = pendingZipBin.current
    pendingZipBin.current = null
    if (bin) void deleteEngineZipInstall(bin).catch(() => {})
  }

  // Route a scan result (folder scan or zip upload — same response shape) to confirm /
  // notfound. The zip name rides along only for the in-progress copy.
  const applyScanResult = (res: EngineScanResult) => {
    if (!res.found) {
      setStep('notfound')
      return
    }
    setBinPath(res.binPath)
    setVersion(res.version)
    setName(res.suggestedName)
    setUpdated(res.updated ?? null)
    setZipWarning(res.warning?.message ?? null)
    // An updated engine is already registered server-side — nothing left to clean up if
    // the dialog is dismissed from here.
    pendingZipBin.current = res.updated ? null : res.binPath
    setStep('confirm')
  }

  // Run the read-only scan on the chosen path, then route to confirm / notfound.
  // A ProbeError (wrong-OS / timeout) comes back as an ApiError → inline on choose.
  const runScan = (path: string) => {
    setError(null)
    setNameError(null)
    setScanSource('path')
    setStep('scanning')
    const token = ++flow.current
    scan.mutate(path, {
      onSuccess: (res) => { if (flow.current === token) applyScanResult(res) },
      onError: (e) => {
        if (flow.current !== token) return
        setError(e instanceof ApiError ? e.message : 'Could not scan that location.')
        setStep('choose')
      },
    })
  }

  // Upload a .zip build (the third source): the daemon searches it at any depth for the
  // server binary + this platform's libs, extracts into its own engines storage, and
  // probes — same response contract as the folder scan, so the steps from here on are
  // shared. Clears the input's value so picking the same file again re-fires onChange.
  const runZipUpload = (file: File) => {
    setError(null)
    setNameError(null)
    setScanSource('zip')
    setZipName(file.name)
    setStep('scanning')
    const token = ++flow.current
    gcPendingZip() // a fresh upload supersedes any unconfirmed one
    zipUpload.mutate(file, {
      onSuccess: (res) => { if (flow.current === token) applyScanResult(res) },
      onError: (e) => {
        if (flow.current !== token) return
        setError(e instanceof ApiError ? e.message : 'Could not read that zip.')
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
          // Registered — the install is now owned by the engine; reset must not GC it.
          pendingZipBin.current = null
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
                in, or upload its .zip, and we&apos;ll find the server binary for you.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <Button onClick={() => { track('engines', 'browse_new_engine_folder'); setBrowse('folder') }} className="w-full">
                <FolderOpen size={16} /> Choose folder…
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={zipUpload.isPending}
                onClick={() => zipInput.current?.click()}
              >
                <FileArchive size={16} /> Upload a .zip…
              </Button>
              <input
                ref={zipInput}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  track('engines', 'upload_new_engine_zip')
                  runZipUpload(f)
                }}
              />
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
              {error && <InlineError message={error} screen="engines" />}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { track('engines', 'cancel_add_engine'); setOpen(false); reset() }}>
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
              {scanSource === 'zip'
                ? `Uploading & extracting ${zipName}…`
                : 'Looking for the server binary…'}
            </div>
          </>
        )}

        {step === 'confirm' && updated && (
          <>
            <DialogHeader>
              <DialogTitle>Engine updated</DialogTitle>
              <DialogDescription>
                The uploaded build replaced <span className="font-medium text-ink">{updated.name}</span> in place — its files
                and registration now run the new binary.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-panel p-3 text-[13px] text-ink">
                <CheckCircle2 size={16} className="shrink-0" style={{ color: 'var(--ok)' }} />
                <span>
                  <span className="font-medium">{updated.name}</span>
                  {version && version.toLowerCase() !== 'unknown' ? (
                    <>
                      {' · '}
                      <span className="text-muted">{version}</span>
                    </>
                  ) : null}
                </span>
              </div>

              {zipWarning && (
                <div className="flex items-start gap-2.5 rounded-lg border p-3 text-[13px]" style={{ borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)' }}>
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
                  <span style={{ color: 'var(--warn)' }}>{zipWarning}</span>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { track('engines', 'back_to_add_engine_choose'); setStep('choose') }}>
                <ArrowLeft size={16} /> Back
              </Button>
              <Button onClick={() => { track('engines', 'done_zip_engine_update'); setOpen(false); reset() }}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'confirm' && !updated && (
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
                {nameError && <InlineError message={nameError} screen="engines" />}
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

              {zipWarning && (
                <div className="flex items-start gap-2.5 rounded-lg border p-3 text-[13px]" style={{ borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)' }}>
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
                  <span style={{ color: 'var(--warn)' }}>{zipWarning}</span>
                </div>
              )}

              {error && <InlineError message={error} screen="engines" />}
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
              {scanSource === 'zip' ? (
                <span>
                  We couldn&apos;t find <code className="font-mono">llama-server</code> for this
                  platform in <span className="font-mono">{zipName}</span>. Make sure the zip
                  contains a build for the OS TurboLLM is running on, then try again.
                </span>
              ) : (
                <span>
                  We couldn&apos;t find <code className="font-mono">llama-server</code> in that
                  folder. Pick the folder that contains it, or select the binary directly.
                </span>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { track('engines', 'back_to_add_engine_choose'); setStep('choose') }}>
                <ArrowLeft size={16} /> Back
              </Button>
              {scanSource === 'path' && (
                <Button onClick={() => { track('engines', 'browse_new_engine_binary'); setBrowse('file') }}>
                  Pick the binary directly
                </Button>
              )}
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

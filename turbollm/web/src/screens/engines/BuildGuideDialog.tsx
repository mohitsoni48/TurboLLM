import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Hammer,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
  X,
  XCircle,
} from 'lucide-react'
import { track } from '../../lib/api'
import { useBuild, useBuildPrereqs, useSettings, useStatus, useSysInfo } from '../../lib/queries'
import type { BuildPrereqTool, EngineBuild } from '../../lib/types'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { AddEngineDialog } from './AddEngineDialog'

// Mirrors build-prereqs.ts's CMAKE_CONFIGURE_ARGS / CMAKE_CONFIGURE_ARGS_MACOS /
// CUDA_RUNTIME_DLL_PREFIXES / CUDA_RUNTIME_SO_PREFIXES — kept in lockstep by hand (the web
// bundle can't import Node backend code). `-allow-unsupported-compiler` works around nvcc's
// hardcoded host-compiler allowlist (a new VS/GCC release routinely ships before NVIDIA
// updates it); the runtime DLLs/libs aren't bundled by the build itself, so without copying
// them the produced engine silently falls back to CPU. Metal needs neither — it's a system
// framework via the Xcode toolchain, nothing to bundle.
const CMAKE_CONFIGURE_ARGS = ['-DGGML_CUDA=ON', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler']
const CMAKE_CONFIGURE_ARGS_MACOS = ['-DGGML_METAL=ON', '-DCMAKE_BUILD_TYPE=Release']
const CUDA_RUNTIME_DLL_PREFIXES = ['cudart64_', 'cublas64_', 'cublaslt64_', 'nvrtc64_', 'nvrtc-builtins64_', 'nvjitlink_']
const CUDA_RUNTIME_SO_PREFIXES = ['libcudart.so', 'libcublas.so', 'libcublasLt.so', 'libnvrtc.so', 'libnvrtc-builtins.so', 'libnvJitLink.so']

/** The exact build command list for a repo on `os` (mirrors the backend's PURE
 *  `buildCommands` in src/engines/build-prereqs.ts — kept in lockstep so the manual path
 *  matches what the 1-click build runs). */
function buildCommands(repoUrl: string, branch: string | undefined, os: 'windows' | 'linux' | 'macos' | 'other'): string[] {
  const b = (branch ?? '').trim()
  const clone = b
    ? `git clone --branch ${b} --depth 1 ${repoUrl} turbo-build`
    : `git clone --depth 1 ${repoUrl} turbo-build`
  if (os === 'macos') {
    return [
      clone,
      'cd turbo-build',
      `cmake -B build ${CMAKE_CONFIGURE_ARGS_MACOS.join(' ')}`,
      'cmake --build build -j --target llama-server',
      '# Built binary: build/bin/llama-server — add it via "Add your own engine".',
    ]
  }
  const configure = `cmake -B build ${CMAKE_CONFIGURE_ARGS.join(' ')}`
  if (os === 'linux') {
    const libGlobs = ['lib64', 'lib', 'targets/x86_64-linux/lib']
      .flatMap((dir) => CUDA_RUNTIME_SO_PREFIXES.map((p) => `$CUDA_ROOT/${dir}/${p}*`))
      .join(' ')
    return [
      clone,
      'cd turbo-build',
      configure,
      'cmake --build build -j --target llama-server',
      'CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"',
      `cp ${libGlobs} build/bin/ 2>/dev/null`,
      '# Built binary + its CUDA runtime libs: build/bin/llama-server — add it via "Add your own engine".',
    ]
  }
  const dllGlobs = ['bin', 'bin\\x64']
    .flatMap((dir) => CUDA_RUNTIME_DLL_PREFIXES.map((p) => `"%CUDA_PATH%\\${dir}\\${p}*.dll"`))
    .join(' ')
  return [
    clone,
    'cd turbo-build',
    configure,
    'cmake --build build --config Release -j --target llama-server',
    `for %f in (${dllGlobs}) do copy /y "%f" "build\\bin\\Release\\" >nul 2>&1`,
    '# Built binary + its CUDA runtime DLLs: build\\bin\\Release\\llama-server.exe — add it via "Add your own engine".',
  ]
}

const PHASE_LABEL: Record<EngineBuild['phase'], string> = {
  provisioning: 'Downloading CUDA Toolkit…',
  preparing: 'Preparing…',
  cloning: 'Cloning the repository…',
  configuring: 'Configuring (cmake)…',
  compiling: 'Compiling llama-server… this can take several minutes',
  registering: 'Registering the built engine…',
  done: 'Built and registered ✓',
  error: 'Build failed',
}

/** Compile-from-source dialog (ADR-089 + ADR-100, Linux + macOS ports). On Windows/Linux
 *  (+ CUDA) or macOS (+ Metal): a prereq checklist, an editable "Build environment" (PATH dirs
 *  so a conda-env / custom CUDA Toolkit is found — unused on macOS, which needs no GPU toolkit),
 *  a 1-click "Build it for me" that clones + compiles + registers in-app with live progress,
 *  and the manual command path as a fallback. */
export function BuildGuideDialog({
  open,
  onOpenChange,
  repoUrl,
  engineName,
  branch,
  commit,
  patchUrl,
  patchSha256,
  mode = 'build',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoUrl: string
  engineName: string
  branch?: string
  /** Pin the build to an exact commit (a catalog entry's `sourceCommit`) — undefined for the
   *  usual branch-tip build. Required when a `patchUrl` must apply against a known commit. */
  commit?: string
  /** A pinned, checksum-verified patch to apply on top of `commit` before compiling (a catalog
   *  entry's `patchUrl`/`patchSha256`). Both undefined for every non-patched entry, so their
   *  request shape is unchanged. */
  patchUrl?: string
  patchSha256?: string
  /** 'rebuild' relabels the action for the ADR-088 "newer source" chip. */
  mode?: 'build' | 'rebuild'
}) {
  // Only probe the toolchain while the dialog is open.
  const prereqsQ = useBuildPrereqs(open)
  const settings = useSettings()
  const statusQ = useStatus()
  const build = useBuild()
  const [copied, setCopied] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // What the user last kicked off, so we can tell a CUDA download / prereq install apart from a
  // build (all stream through engineBuild + end at phase 'done', but only a build shows the
  // success screen — the other two just re-probe the prereqs).
  const [intent, setIntent] = useState<'build' | 'cuda' | 'install' | null>(null)
  // A rejection BEFORE the server ever calls d.build.start() (403 not-local-to-host, 409
  // already-running, a 400 validation failure) never touches engineBuild at all — it stays at
  // its untouched default (active:false, phase:'preparing'), which the effect below can never
  // see as an error since engineBuild.phase never becomes 'error'. Without this, the mutation's
  // own rejection was silently dropped and the dialog was stuck showing "Preparing" forever.
  const [mutationError, setMutationError] = useState<string | null>(null)

  // Build-environment editor draft (null until edited → show the saved dirs).
  const savedDirs = settings.query.data?.build.toolchainDirs ?? []
  const [draftDirs, setDraftDirs] = useState<string[] | null>(null)
  const dirs = draftDirs ?? savedDirs

  const os = prereqsQ.data?.os ?? 'windows'
  const commands = buildCommands(repoUrl, branch, os)
  const commandText = commands.join('\n')

  const supported = prereqsQ.data?.supported ?? null
  const tools = prereqsQ.data?.tools ?? []
  const missingRequired = tools.filter((t) => (t.id === 'git' || t.id === 'cmake' || t.id === 'cuda') && !t.found)

  const engineBuild = statusQ.data?.engineBuild
  const buildActive = !!engineBuild?.active
  const provisionActive = !!statusQ.data?.engineProvision?.active
  const showProgress = intent !== null || buildActive
  const cudaMissing = tools.some((t) => t.id === 'cuda' && !t.found)
  const canBuild = supported === true && missingRequired.length === 0 && !buildActive && !provisionActive

  // When the step we kicked off settles: a finished CUDA download → re-probe so CUDA flips to
  // ✓ and the build enables (and hide the progress); a finished build → pull the new engine
  // into the lists. A CUDA *error* stays visible so the user sees why it failed.
  useEffect(() => {
    if (!intent || !engineBuild || engineBuild.active) return
    if (engineBuild.phase === 'done') {
      if (intent === 'cuda' || intent === 'install') {
        void prereqsQ.refetch()
        void settings.query.refetch()
        setIntent(null)
      } else {
        build.refresh()
      }
    } else if (engineBuild.phase === 'error' && intent === 'build') {
      build.refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, engineBuild?.active, engineBuild?.phase])

  // Auto-scroll the log to the newest line.
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [engineBuild?.log])

  const copy = () => {
    void navigator.clipboard.writeText(commandText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const recheck = async () => {
    // Persist the edited dirs (filtering blanks), then re-probe with the new PATH.
    await settings.save.mutateAsync({ build: { toolchainDirs: dirs.map((d) => d.trim()).filter(Boolean) } })
    setDraftDirs(null)
    void prereqsQ.refetch()
  }

  const onMutationError = (e: unknown) => {
    setIntent(null)
    setMutationError(e instanceof Error ? e.message : String(e))
  }

  const startBuild = () => {
    setMutationError(null)
    setIntent('build')
    // commit/patchUrl/patchSha256 are only defined for a catalog entry that pins them (e.g.
    // solar-open2); undefined for every other entry, so their request shape is unchanged.
    build.start.mutate({ repoUrl, branch, commit, patchUrl, patchSha256, name: engineName }, { onError: onMutationError })
  }

  const downloadCuda = () => {
    setMutationError(null)
    setIntent('cuda')
    build.cuda.mutate(undefined, { onError: onMutationError })
  }

  // Install a missing prereq ON THE DAEMON MACHINE with its own package manager. This is the
  // only path that works headlessly (Docker / a remote Linux server): the row's install LINK
  // opens a website in whatever browser is showing this UI, which may not be the host at all.
  const installPrereq = (tool: 'git' | 'cmake' | 'cuda' | 'gcc') => {
    setMutationError(null)
    setIntent('install')
    build.installPrereq.mutate(tool, { onError: onMutationError })
  }

  const actionLabel = mode === 'rebuild' ? 'Rebuild now' : 'Build it for me'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'rebuild' ? 'Rebuild' : 'Build'} {engineName} from source
          </DialogTitle>
          <DialogDescription>
            {mode === 'rebuild'
              ? 'A newer commit is available — recompile from source and replace the binary.'
              : 'No prebuilt binary for your system — compile it here, or build it yourself and add it.'}
          </DialogDescription>
        </DialogHeader>

        {prereqsQ.isLoading ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
            <Loader2 size={18} className="shrink-0 animate-spin text-ink" />
            Checking your build tools…
          </div>
        ) : supported === false ? (
          // Unrecognized OS: point at the repo + upstream build docs.
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
              In-app build isn&apos;t available on this system yet. Clone the repo and follow its
              upstream build instructions, then add the resulting{' '}
              <code className="font-mono">llama-server</code> binary via “Add your own engine”.
            </div>
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 self-start text-[13px] text-accent hover:underline"
            >
              Open {engineName} repo + build docs <ExternalLink size={13} />
            </a>
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {/* Prereq checklist */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Build prerequisites</p>
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3">
                {tools.map((t) => (
                  <PrereqRow
                    key={t.id}
                    tool={t}
                    // CUDA can be auto-downloaded (ADR-101), but only on Windows so far.
                    onDownload={t.id === 'cuda' && !t.found && !showProgress && os === 'windows' ? downloadCuda : undefined}
                    // Everything else missing that the host's package manager can install runs
                    // ON THE HOST — the only option that works when the UI is open on another
                    // machine (headless server / Docker).
                    onInstall={
                      !t.found && !showProgress && (t.installCommands?.length ?? 0) > 0 && t.id !== 'msvc'
                        ? () => installPrereq(t.id as 'git' | 'cmake' | 'cuda' | 'gcc')
                        : undefined
                    }
                    packageManager={prereqsQ.data?.packageManager ?? null}
                  />
                ))}
              </div>
              {cudaMissing && !showProgress && (
                <p className="text-[11px] text-faint">
                  {os === 'windows' ? (
                    <>
                      No CUDA Toolkit found. <span className="text-muted">Download CUDA</span> grabs NVIDIA’s
                      official build components (~0.5&nbsp;GB) automatically — no installer needed.
                    </>
                  ) : (
                    'No CUDA Toolkit found. Install it via your distro’s package manager or NVIDIA’s installer, then re-check.'
                  )}
                </p>
              )}
            </div>

            {/* Build environment (PATH override) — ADR-100 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Build environment</p>
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
                <p className="text-[12px] text-muted">
                  {os === 'macos' ? (
                    <>
                      If your compiler or CMake lives in a custom location (not on the system PATH),
                      add that folder — e.g. a Homebrew <code className="font-mono">bin</code> dir. Then re-check.
                    </>
                  ) : (
                    <>
                      If your CUDA Toolkit or compiler lives in a conda env or a custom location (not on the
                      system PATH), add that folder — e.g. the env’s <code className="font-mono">bin</code> — so
                      TurboLLM finds <code className="font-mono">nvcc</code>. Then re-check.
                    </>
                  )}
                </p>
                {dirs.map((dir, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      value={dir}
                      onChange={(e) => {
                        const next = [...dirs]
                        next[i] = e.target.value
                        setDraftDirs(next)
                      }}
                      placeholder="C:\\Users\\you\\miniconda3\\envs\\cuda\\Library\\bin"
                      className="min-w-0 flex-1 rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => { track('engines', 'remove_build_search_dir'); setDraftDirs(dirs.filter((_, j) => j !== i)) }}
                      className="shrink-0 rounded-md p-1 text-faint hover:text-ink"
                      aria-label="Remove folder"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => { track('engines', 'add_build_search_dir'); setDraftDirs([...dirs, '']) }}
                    className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
                  >
                    <Plus size={13} /> Add folder
                  </button>
                  <button
                    type="button"
                    onClick={() => { track('engines', 'recheck_build_prereqs'); void recheck() }}
                    disabled={settings.save.isPending || prereqsQ.isFetching}
                    className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline disabled:opacity-50"
                  >
                    {settings.save.isPending || prereqsQ.isFetching ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    Re-check
                  </button>
                </div>
              </div>
            </div>

            {/* Live build progress (ADR-100) */}
            {showProgress && engineBuild && (
              <BuildProgress
                build={engineBuild}
                kind={intent === 'cuda' ? 'cuda' : intent === 'install' ? 'install' : 'build'}
                logRef={logRef}
                onCancel={() => build.cancel.mutate()}
                onClose={() => onOpenChange(false)}
              />
            )}

            {/* The request itself was rejected before any server-side build state ever
                existed (403/409/400) — engineBuild never moves, so BuildProgress above never
                shows this. Same visual treatment as its own error state. */}
            {mutationError && (
              <div className="flex items-center gap-2 rounded-lg border p-3 text-[13px]" style={{ borderColor: 'color-mix(in srgb, var(--err) 40%, var(--border))', background: 'color-mix(in srgb, var(--err) 8%, transparent)' }}>
                <XCircle size={15} className="shrink-0" style={{ color: 'var(--err)' }} />
                <span style={{ color: 'var(--err)' }}>{mutationError}</span>
              </div>
            )}

            {/* Manual build commands (fallback / transparency) */}
            <details className="group">
              <summary className="cursor-pointer list-none text-[11px] font-medium uppercase tracking-wide text-faint hover:text-muted">
                Or build it yourself (manual commands)
              </summary>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-faint">
                    {os === 'linux' ? 'Linux + CUDA' : os === 'macos' ? 'macOS + Metal' : 'Windows + CUDA'}
                  </p>
                  <button
                    type="button"
                    onClick={() => { track('engines', 'copy_build_commands'); copy() }}
                    className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
                  >
                    {copied ? <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-border bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-ink">
                  {commandText}
                </pre>
              </div>
            </details>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => { track('engines', 'close_build_guide'); onOpenChange(false) }}>
            Close
          </Button>
          {supported !== false && (
            <>
              <Button variant="outline" onClick={() => { track('engines', 'open_manual_build_handoff'); setAddOpen(true) }} disabled={prereqsQ.isLoading || buildActive}>
                I&apos;ve built it
              </Button>
              <Button onClick={() => { track('engines', 'start_engine_build'); startBuild() }} disabled={!canBuild}>
                <Hammer size={15} className="mr-1.5" />
                {buildActive ? 'Building…' : actionLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Hand-off: open Add-engine with the source repo prefilled (ADR-088 tracking). */}
      <AddEngineDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        defaultSourceRepo={repoUrl}
        trigger={null}
      />
    </Dialog>
  )
}

/** Live phase + scrolling log while a build runs, with a Cancel while active. On success it
 *  becomes a celebratory "engine ready" screen; on failure it shows the error + log. */
function BuildProgress({
  build,
  kind,
  logRef,
  onCancel,
  onClose,
}: {
  build: EngineBuild
  /** 'build' shows the celebratory engine-ready screen on success; 'cuda' (a toolkit
   *  download) and 'install' (a package-manager prereq install) just stream progress — their
   *  completion is handled by re-probing prereqs. */
  kind: 'build' | 'cuda' | 'install'
  logRef: React.RefObject<HTMLPreElement | null>
  onCancel: () => void
  onClose: () => void
}) {
  const isError = build.phase === 'error'
  const isDone = build.phase === 'done'
  const accent = isError ? 'var(--err)' : isDone ? 'var(--ok)' : 'var(--accent)'
  // Windows/Linux CUDA builds still physically bundle the CUDA runtime (build-runner.ts's
  // runBuild() copies the DLLs/libs post-build); only macOS (Metal, a system framework) has
  // nothing to bundle. Success copy must reflect that, not claim the same thing for all three.
  const { data: sysInfo } = useSysInfo()
  const bundlesCudaRuntime = sysInfo?.os === 'windows' || sysInfo?.os === 'linux'

  // Success screen — distinct, celebratory; the engine is built + active. Only for a build;
  // a finished CUDA download is dismissed by the parent (which re-probes prereqs).
  if (isDone && kind === 'build') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border p-5 text-center" style={{ borderColor: 'color-mix(in srgb, var(--ok) 40%, var(--border))', background: 'color-mix(in srgb, var(--ok) 8%, transparent)' }}>
        <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'color-mix(in srgb, var(--ok) 18%, transparent)' }}>
          <CheckCircle2 size={28} style={{ color: 'var(--ok)' }} />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-semibold text-ink">Engine ready 🎉</p>
          <p className="text-[13px] text-muted">
            <span className="font-medium text-ink">{build.engine}</span> was built from source
            {bundlesCudaRuntime ? ', bundled with its CUDA runtime,' : ''} and set as your active
            engine. Load a model to start using it.
          </p>
        </div>
        <details className="w-full">
          <summary className="cursor-pointer list-none text-[11px] uppercase tracking-wide text-faint hover:text-muted">
            Build log
          </summary>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border bg-panel-2 p-2 text-left font-mono text-[11px] leading-relaxed text-muted">
            {build.log.join('\n')}
          </pre>
        </details>
        <Button onClick={() => { track('engines', 'dismiss_build_success'); onClose() }} className="mt-1">Done</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
      <div className="flex items-center gap-2 text-[13px]">
        {build.active ? (
          <Loader2 size={15} className="shrink-0 animate-spin" style={{ color: accent }} />
        ) : isError ? (
          <XCircle size={15} className="shrink-0" style={{ color: accent }} />
        ) : (
          <CheckCircle2 size={15} className="shrink-0" style={{ color: accent }} />
        )}
        {/* A prereq install reuses the 'provisioning' phase, whose default label is the CUDA
            download — say what's actually happening instead. */}
        <span className="text-ink">
          {kind === 'install' && build.phase === 'provisioning'
            ? `Installing ${build.engine} with your package manager…`
            : PHASE_LABEL[build.phase]}
        </span>
        {build.active && (
          <button type="button" onClick={() => { track('engines', 'cancel_engine_build'); onCancel() }} className="ml-auto text-[12px] text-faint hover:text-ink">
            Cancel
          </button>
        )}
      </div>
      {isError && build.error && <p className="text-[12px]" style={{ color: accent }}>{build.error}</p>}
      {build.log.length > 0 && (
        <pre
          ref={logRef}
          className="max-h-40 overflow-auto rounded-md border border-border bg-panel-2 p-2 font-mono text-[11px] leading-relaxed text-muted"
        >
          {build.log.join('\n')}
        </pre>
      )}
    </div>
  )
}

/** One prereq row: ✓ found (with version) or ✗ missing. A missing tool offers an install
 *  link; CUDA additionally offers a one-click auto-download (`onDownload`, ADR-101), and any
 *  tool the host's package manager can install offers `onInstall`, which runs that install ON
 *  THE DAEMON MACHINE. The link is kept as a fallback but is no longer the only option — on a
 *  headless self-hosted box it opens a page in the operator's browser and installs nothing on
 *  the server. The exact commands are shown in the button's tooltip, so nothing runs unseen. */
function PrereqRow({
  tool,
  onDownload,
  onInstall,
  packageManager,
}: {
  tool: BuildPrereqTool
  onDownload?: () => void
  onInstall?: () => void
  packageManager?: string | null
}) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      {tool.found ? (
        <CheckCircle2 size={15} className="shrink-0" style={{ color: 'var(--ok)' }} />
      ) : (
        <XCircle size={15} className="shrink-0 text-faint" />
      )}
      <span className="text-ink">{tool.name}</span>
      {tool.found && tool.version && <span className="text-[12px] text-muted">{tool.version}</span>}
      {!tool.found && (
        <span className="ml-auto inline-flex items-center gap-3">
          {onDownload && (
            <button
              type="button"
              onClick={() => { track('engines', 'download_cuda_toolkit'); onDownload() }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors hover:opacity-80"
              style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
            >
              <Download size={12} /> Download CUDA
            </button>
          )}
          {onInstall && (
            <button
              type="button"
              onClick={() => { track('engines', 'install_build_prereq'); onInstall() }}
              title={(tool.installCommands ?? []).map((argv) => argv.join(' ')).join('\n')}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors hover:opacity-80"
              style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
            >
              <Terminal size={12} /> Install{packageManager ? ` (${packageManager})` : ''}
            </button>
          )}
          <a
            href={tool.installUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
          >
            {onDownload || onInstall ? 'or install manually' : 'Install'} <ExternalLink size={11} />
          </a>
        </span>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeft, Download, Loader2, X } from 'lucide-react'
import { ApiError, discardReleaseInstall, getReleaseInstall, track } from '../../lib/api'
import { queryKeys, useReleaseAssets, useReleaseInstall, useStatus } from '../../lib/queries'
import type { EngineScanResult, RankedReleaseAsset, ReleaseAssetListing, ReleaseInstallPlan } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { fmtSize } from '../models/HfRepoDialog'

type Step = 'repo' | 'assets' | 'installing'
type PanelError = { code: string; message: string }

const LOST_INSTALL_MESSAGE = 'The install was interrupted. Start again.'

/** Third source of the Add-engine dialog (issue #276): install a prebuilt engine from a
 *  GitHub release. repo (type it or tap a known fork) -> assets (ranked for this machine)
 *  -> installing (live progress, Cancel). The finished install is handed to `onReady` in
 *  the same shape the folder scan and zip upload use, so the dialog's confirm step is shared.
 *  Nothing is fetched from GitHub until the user acts (ADR-396: GitHub quota).
 *
 *  The install is the daemon's job, not this panel's: it runs on when the dialog is dismissed,
 *  the app navigates away or the page is reloaded or closed, and only a Cancel stops it (this
 *  panel's, or the engine provision banner's). So on mount the panel asks the daemon for its job
 *  first: a running one shows its progress (and Cancel), and a finished one nobody added yet is
 *  offered for Add. */
export function ReleaseSourcePanel({
  initialRepo,
  knownRepos,
  onReady,
  onCancel,
  onOfferSuperseded,
}: {
  initialRepo?: string
  knownRepos: { name: string; repo: string }[]
  onReady: (res: EngineScanResult) => void
  onCancel: () => void
  /** The finished install offered on opening (see `waiting`), passed over for another install. */
  onOfferSuperseded?: (res: EngineScanResult) => void
}) {
  // Opening with a repo (from a card's "Install prebuilt") is itself the explicit user action.
  const [step, setStep] = useState<Step>(initialRepo ? 'assets' : 'repo')
  const [repoInput, setRepoInput] = useState(initialRepo ?? '')
  const [submittedRepo, setSubmittedRepo] = useState(initialRepo ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  const [confirmingIncompatible, setConfirmingIncompatible] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)

  // The daemon's job as it stands when the panel opens (see the component's doc), read once and
  // before anything else, so a running job shows its progress instead of the repo or builds step,
  // whose Install would only be refused while it runs. Opened with no repo of its own, the panel
  // fetches no release list for that install; opened from a card, it fetches that card's list
  // meanwhile, which Cancel lands on. A failed read (an older daemon, a device the host gate
  // refuses) just starts the panel as before.
  const [checkingJob, setCheckingJob] = useState(true)
  // A finished install nobody added: its dialog was dismissed while it ran, or its page was
  // reloaded or closed while it ran or on its confirm step (dismissing the confirm step itself
  // discards the build, AddEngineDialog's reset). Offered for Add until another install starts,
  // which hands it to the dialog (onOfferSuperseded).
  const [waiting, setWaiting] = useState<EngineScanResult | null>(null)

  const listing = useReleaseAssets(submittedRepo, step !== 'repo' && !checkingJob)
  const { start, job } = useReleaseInstall(step === 'installing' || checkingJob)
  const qc = useQueryClient()

  // The plan of the install shown, for Cancel's discard check (abortInstall).
  const installPlan = useRef<ReleaseInstallPlan | null>(null)
  // Leaving the panel stops nothing (only Cancel does): this only keeps a start request answered
  // after the panel is gone from updating it. Re-cleared on every mount so StrictMode's dev
  // mount -> cleanup -> mount cannot leave it true.
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])

  useEffect(() => {
    if (!checkingJob) return
    if (job.isError) {
      setCheckingJob(false)
      return
    }
    const view = job.data
    if (!view) return
    setCheckingJob(false)
    if (view.state === 'running') {
      // Cancel aborts it as it would this panel's own install. With no repo of its own (opened
      // from the source list, not a card) the panel then offers that install's repo to look up,
      // rather than fetching its release list unasked.
      installPlan.current = view.plan ?? null
      if (view.plan && !submittedRepo) setRepoInput(view.plan.repo)
      setStep('installing')
    } else if (view.state === 'ready' && view.result?.found) {
      setWaiting(view.result)
    }
    // An `updated`, `error` or `idle` job is not picked up: an update has nothing to Add (the engine
    // list shows it), and a failure is reported on the engine provision banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the mount read only
  }, [checkingJob, job.data, job.isError])

  const leaveInstalling = () => {
    setStep(submittedRepo ? 'assets' : 'repo')
  }

  useEffect(() => {
    if (step !== 'installing' || !job.data) return
    const view = job.data
    if (view.state === 'ready' || view.state === 'updated') {
      if (!view.result) {
        setError({ code: 'no_result', message: 'The install finished without a result.' })
        leaveInstalling()
        return
      }
      if (view.state === 'updated') {
        // A registered engine was refreshed in place with no Add to follow (as a zip re-upload's
        // `updated`): refetch what shows its version and tag.
        void qc.invalidateQueries({ queryKey: queryKeys.engines })
        void qc.invalidateQueries({ queryKey: queryKeys.engineCatalog })
        void qc.invalidateQueries({ queryKey: queryKeys.status })
      }
      onReady(view.result.found && view.updated ? { ...view.result, updated: view.updated } : view.result)
    } else if (view.state === 'error') {
      setError(view.error ?? { code: 'unknown', message: 'The install failed.' })
      leaveInstalling()
    } else if (view.state === 'idle') {
      // Only a successful idle answer counts as lost: the job slot lives in the daemon's memory.
      setError({ code: 'interrupted', message: LOST_INSTALL_MESSAGE })
      leaveInstalling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the polled view only
  }, [job.data, step])

  const data = listing.data
  const chosen = data && !data.noCompatible ? selected ?? data.assets.find((a) => a.recommended)?.name ?? null : null
  const chosenAsset = data?.assets.find((a) => a.name === chosen)

  const submitRepo = () => {
    const repo = repoInput.trim()
    if (!repo) return
    setError(null)
    setSelected(null)
    setShowOthers(false)
    setSubmittedRepo(repo)
    setStep('assets')
  }

  const select = (name: string) => {
    setSelected(name)
    setConfirmingIncompatible(false)
  }

  const install = () => {
    if (!data || !chosenAsset) return
    if (!chosenAsset.compatible && !confirmingIncompatible) {
      setConfirmingIncompatible(true)
      return
    }
    setError(null)
    track('engines', 'install_release_asset')
    const plan = { repo: data.repo, tag: data.tag, asset: chosenAsset.name }
    // mutateAsync, not per-call mutate callbacks: TanStack skips those once the panel unmounts. A
    // dialog dismissed before the 202 leaves the install running, as one dismissed after it does:
    // only Cancel stops it, and the panel opened next shows it.
    void start.mutateAsync(plan).then(
      () => {
        // The job now holds this install, not the finished one that was offered, so nothing could
        // reach that build again: it stayed on disk until the daemon's GC. The dialog takes it as
        // its unconfirmed install, which this install's result supersedes (unless it lands in the
        // same folder) and dismissing the dialog discards. Before the unmounted check: the dialog
        // outlives this panel.
        if (waiting?.found) onOfferSuperseded?.(waiting)
        if (unmounted.current) return
        installPlan.current = plan
        setWaiting(null)
        setStep('installing')
      },
      (e: unknown) => {
        if (!unmounted.current) setError(toPanelError(e, 'Could not start the install.'))
      },
    )
  }

  const cancelInstall = () => {
    leaveInstalling()
    abortInstall(installPlan.current)
  }

  if (step === 'installing') {
    return (
      <div className="flex flex-col gap-3">
        <InstallProgress />
        <div className="flex justify-end">
          <Button variant="outline" onClick={cancelInstall}>
            <X size={16} /> Cancel
          </Button>
        </div>
      </div>
    )
  }

  const waitingOffer = waiting?.found && !start.isPending ? <WaitingInstall result={waiting} onAdd={() => onReady(waiting)} /> : null

  if (step === 'repo') {
    return (
      <div className="flex flex-col gap-3">
        {waitingOffer}
        {/* A picked-up install (see checkingJob) that failed, opened with no repo of its own. */}
        {error && <ErrorLine error={error} />}
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink">GitHub repository</span>
          <Input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitRepo() }}
            placeholder="owner/repo or https://github.com/owner/repo"
            autoFocus
          />
        </label>
        {knownRepos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {knownRepos.map((k) => (
              <Button key={k.repo} variant="outline" size="sm" onClick={() => setRepoInput(k.repo)}>
                {k.name}
              </Button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={submitRepo} disabled={repoInput.trim().length === 0}>Find builds</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {waitingOffer}
      {(checkingJob || listing.isLoading) && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
          <Loader2 size={18} className="shrink-0 animate-spin text-ink" />
          Looking up the newest release…
        </div>
      )}
      {listing.error && !data && <ErrorLine error={toPanelError(listing.error, 'Could not look up that release.')} />}
      {error && <ErrorLine error={error} />}
      {data && (
        <AssetList
          data={data}
          chosen={chosen}
          showOthers={showOthers}
          onToggleOthers={() => setShowOthers((v) => !v)}
          onSelect={select}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { setError(null); setStep('repo') }} disabled={start.isPending}>
          <ArrowLeft size={16} /> Back
        </Button>
        {data && (
          <Button onClick={install} disabled={!chosenAsset || data.noCompatible || start.isPending}>
            {confirmingIncompatible ? 'Install anyway' : 'Install'}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Cancel: abort this panel's install job, then discard its build if the job had already finished. A job that ended
 *  after the last poll never reached the dialog's confirm step (whose dismissal discards the build), and the abort does
 *  nothing to a finished job: the build would stay on disk until the daemon's GC, a day later at the earliest. Only a
 *  `ready` result of this same plan is discarded (`updated` replaced a registered engine's build in place). Leaving the
 *  panel any other way calls nothing: the install is the daemon's, and the panel opened next picks it up. */
function abortInstall(plan: ReleaseInstallPlan | null): void {
  void discardReleaseInstall()
    .then(() => getReleaseInstall())
    .then((view) => {
      if (view.state !== 'ready' || !view.result?.found || !plan) return
      if (view.plan?.tag !== plan.tag || view.plan.asset !== plan.asset) return
      return discardReleaseInstall(view.result.binPath)
    })
    .catch(() => {})
}

function toPanelError(e: unknown, fallback: string): PanelError {
  return e instanceof ApiError ? { code: e.code, message: e.message } : { code: 'unknown', message: fallback }
}

/** An inline error; a GitHub rate limit also points at the token setting (same copy as the
 *  engine branch selector). */
function ErrorLine({ error }: { error: PanelError }) {
  return (
    <div className="text-[13px]" style={{ color: 'var(--err)' }}>
      <p>{error.message}</p>
      {error.code === 'github_rate_limited' && (
        <Link to="/settings" className="underline underline-offset-2">
          Open Settings → GitHub
        </Link>
      )}
    </div>
  )
}

function totalBytes(a: RankedReleaseAsset): number {
  return (a.size ?? 0) + a.companions.reduce((sum, c) => sum + (c.size ?? 0), 0)
}

function companionLabel(name: string, size: number | null): string {
  const what = name.toLowerCase().startsWith('cudart') ? 'CUDA runtime' : name
  return size == null ? `+ ${what}` : `+ ${what}, ${fmtSize(size)}`
}

function AssetList({
  data,
  chosen,
  showOthers,
  onToggleOthers,
  onSelect,
}: {
  data: ReleaseAssetListing
  chosen: string | null
  showOthers: boolean
  onToggleOthers: () => void
  onSelect: (name: string) => void
}) {
  if (data.noCompatible) return <NoCompatibleList assets={data.assets} />
  const compatible = data.assets.filter((a) => a.compatible)
  const others = data.assets.filter((a) => !a.compatible)
  const total = data.assets.find((a) => a.name === chosen)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted">
        {data.fellBack
          ? `Newest release with a build for your system: ${data.tag}`
          : `Newest release: ${data.tag}`}
      </p>
      {compatible.map((a) => (
        <AssetRow key={a.name} asset={a} checked={a.name === chosen} onSelect={onSelect} />
      ))}
      {others.length > 0 && (
        <button
          type="button"
          onClick={onToggleOthers}
          className="self-start text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          {showOthers ? 'Hide other builds' : `Show ${others.length} other builds`}
        </button>
      )}
      {showOthers && others.map((a) => (
        <AssetRow key={a.name} asset={a} checked={a.name === chosen} onSelect={onSelect} />
      ))}
      {total && totalBytes(total) > 0 && (
        <p className="text-[12px] text-muted">Total download: {fmtSize(totalBytes(total))}</p>
      )}
    </div>
  )
}

function NoCompatibleList({ assets }: { assets: RankedReleaseAsset[] }) {
  if (assets.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--warn)' }}>
        This release has no installable builds.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px]" style={{ color: 'var(--warn)' }}>
        No build matches this machine. Here is what the release offers:
      </p>
      {assets.map((a) => (
        <AssetRow key={a.name} asset={a} checked={false} disabled onSelect={() => {}} />
      ))}
    </div>
  )
}

function AssetRow({
  asset,
  checked,
  disabled = false,
  onSelect,
}: {
  asset: RankedReleaseAsset
  checked: boolean
  disabled?: boolean
  onSelect: (name: string) => void
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-panel p-3 text-[13px] text-ink"
      style={checked ? { borderColor: 'var(--accent)' } : undefined}
    >
      <input
        type="radio"
        name="release-asset"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(asset.name)}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-[12px]">{asset.name}</span>
          {asset.recommended && (
            <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[11px] text-ink">Recommended</span>
          )}
        </span>
        {asset.size != null && <span className="text-[12px] text-muted">{fmtSize(asset.size)}</span>}
        {asset.companions.map((c) => (
          <span key={c.name} className="text-[12px] text-muted">{companionLabel(c.name, c.size)}</span>
        ))}
        {asset.reason && <span className="text-[12px]" style={{ color: 'var(--warn)' }}>{asset.reason}</span>}
      </span>
    </label>
  )
}

/** A finished install that nobody added yet (see `waiting`). Add hands it to the dialog's
 *  confirm step, where dismissing the dialog discards it as for any install. */
function WaitingInstall({ result, onAdd }: { result: Extract<EngineScanResult, { found: true }>; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-3 text-[13px] text-ink">
      <span className="min-w-0 flex-1">{result.suggestedName} finished installing and has not been added yet.</span>
      <Button size="sm" onClick={onAdd}>Add it</Button>
    </div>
  )
}

/** Live download/extract progress, read from the same status feed the provision banner uses. */
function InstallProgress() {
  const p = useStatus().data?.engineProvision
  const pct = p && p.pct >= 0 ? Math.round(p.pct * 100) : null
  const part = p?.parts && p.parts > 1 ? ` · part ${p.part}/${p.parts}` : ''
  const label = p?.phase === 'extracting' ? 'Installing…' : 'Downloading…'
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="flex items-center gap-2 text-[13px] text-ink">
        <Download size={14} className="text-accent" />
        <span className="flex-1">{label + part}</span>
        {pct != null && <span className="tabular-nums text-muted">{pct}%</span>}
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: pct != null ? `${pct}%` : '100%', background: 'var(--accent)', opacity: pct == null ? 0.5 : 1 }}
        />
      </div>
    </div>
  )
}

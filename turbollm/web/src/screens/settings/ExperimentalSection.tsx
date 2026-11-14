import { FlaskConical, Rocket, Brain, AlarmClock, Network, Globe, Terminal } from 'lucide-react'
import { useSandboxRuntime, useSandboxRuntimeActions, useSettings, useSysInfo } from '../../lib/queries'
import { ApiError, type SandboxRuntimeState } from '../../lib/api'
import { isAndroidOs } from '../../lib/platform'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'

/** One experimental-feature row: icon, name, description, and a single checkbox. Matches
 *  MemorySection's own row styling so this reads as one consistent list, even though Memory
 *  keeps its own separate collapsible below (its facts-list detail doesn't fit this shape). */
function FeatureRow({
  icon: Icon, title, description, checked, onChange, disabled,
}: {
  icon: React.ElementType
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon size={15} className="mt-0.5 shrink-0 text-accent" />
        <div>
          <div className="text-[14px] font-medium text-ink">{title}</div>
          <div className="text-[12px] text-muted">{description}</div>
        </div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-60"
      />
    </label>
  )
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

/** The Python sandbox's runtime under its switch (GitHub #52): nothing downloads until the user presses Download,
 *  and the runtime stays when the switch goes off (Remove frees the disk). The daemon checks every file against a
 *  SHA-256 shipped in TurboLLM itself. */
function SandboxRuntimePanel({ state }: { state: SandboxRuntimeState }) {
  const actions = useSandboxRuntimeActions()
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not change the sandbox runtime.')
  const { job, installed } = state
  if (!state.supported) return <p className="pb-3 pl-6 text-[12px] text-muted">There is no sandbox runtime for this machine yet.</p>
  if (job.state === 'running') {
    const pct = state.downloadBytes ? Math.min(100, Math.round((job.doneBytes / state.downloadBytes) * 100)) : 0
    return (
      <div className="flex flex-col gap-2 pb-3 pl-6 text-[12px] text-muted">
        <div>Downloading the sandbox runtime… {mb(job.doneBytes)} of {mb(state.downloadBytes)}</div>
        <div className="h-2 overflow-hidden rounded-full border border-border bg-bg" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div><Button size="sm" variant="outline" onClick={() => actions.cancel.mutate(undefined, { onError: fail })}>Cancel</Button></div>
      </div>
    )
  }
  if (installed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 pl-6 text-[12px] text-muted">
        <span>Ready: Deno {installed.deno} and Python (Pyodide {installed.pyodide}), about {mb(state.diskBytes)} on disk. Works offline.</span>
        <Button size="sm" variant="outline" disabled={actions.remove.isPending} onClick={() => actions.remove.mutate(undefined, { onError: fail })}>Remove</Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 pb-3 pl-6 text-[12px] text-muted">
      {job.state === 'error' && job.error && job.error.code !== 'cancelled' && <div className="text-err">{job.error.message}</div>}
      <div>
        Downloads about {mb(state.downloadBytes)} once (Deno and Python with pandas, numpy, matplotlib, Pillow, sympy and their
        dependencies), about {mb(state.diskBytes)} on disk. Every file is checked against a SHA-256 shipped inside TurboLLM.
      </div>
      <div>
        <Button size="sm" disabled={actions.install.isPending} onClick={() => actions.install.mutate(undefined, { onError: fail })}>
          {job.state === 'error' && job.error?.code !== 'cancelled' ? 'Try again' : 'Download'}
        </Button>
      </div>
    </div>
  )
}

/** The sandbox row: hidden on Android (no Deno build there) and until the platform is known, so it never flashes on. */
function SandboxRow({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  const os = useSysInfo().data?.os
  const runtime = useSandboxRuntime(checked && os !== undefined && !isAndroidOs(os))
  if (os === undefined || isAndroidOs(os)) return null
  return (
    <div className="border-b border-border last:border-b-0">
      <FeatureRow
        icon={Terminal}
        title="Python sandbox"
        description="Lets chat run Python it writes, with no network and no access to your files, and hand back charts and files. You approve every run. Desktop only."
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      {checked && runtime.data && <SandboxRuntimePanel state={runtime.data} />}
    </div>
  )
}

/** Experimental features (2026-07-14, preparing for wider distribution): still-in-progress
 *  capabilities, off by default for new/distributed installs, turned on individually here.
 *  Both are simple master on/off rows in this ONE list — Memory's own richer settings
 *  (the "remember facts about you" toggle + facts list) stay in their ORIGINAL location,
 *  Settings → General's MemorySection, and only render there when this row is checked. This is
 *  a correction of an earlier version that moved MemorySection's whole UI into this tab — the
 *  founder was explicit that Memory's settings belong where they've always been, gated on
 *  visibility (and, on the backend, on actually running) by this checkbox alone, not relocated.
 *  Code used to be a third row here — removed when it graduated to generally available
 *  (ADR-280), rather than staying an opt-in toggle.
 *
 *  Turbo Link (ADR-376) joined 2026-08-21 for a different reason from its neighbours: it is
 *  not half-built, it is UNVERIFIED. It is complete and green, but every test it has ever
 *  passed ran against this one machine, and it is a feature whose entire purpose is a second
 *  one. Its row's copy says so plainly rather than selling it — someone turning this on is
 *  volunteering to be the first real two-machine test, and should know that. The daemon
 *  enforces the same flag on its own side (link/gate.ts): off means the host façade refuses
 *  inbound links, the poll loop stops, and remote models leave every list — while the user's
 *  saved links and granted tokens stay in config, untouched, for when it goes back on. */
export function ExperimentalSection() {
  const { query: settingsQ, save } = useSettings()
  const experimental = settingsQ.data?.experimental ?? { memory: false, cloudDeploy: false, routines: false, turboLink: false, remoteAccess: false, sandbox: false }
  const busy = save.isPending

  const setFlag = (key: 'memory' | 'cloudDeploy' | 'routines' | 'turboLink' | 'remoteAccess' | 'sandbox', value: boolean) => {
    save.mutate(
      { experimental: { [key]: value } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update experimental setting.') },
    )
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-1 flex items-center gap-2">
        <FlaskConical size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Experimental</h2>
        <Badge variant="accent" className="normal-case tracking-normal">Opt-in</Badge>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Still-in-progress features, off by default. Turn on what you want to try — nothing here is required
        for the rest of TurboLLM to work.
      </p>
      <FeatureRow
        icon={Brain}
        title="Memory"
        description="Silently remembers durable facts from your chats. Its settings live in General — this only controls whether that section is unlocked and actually runs."
        checked={experimental.memory}
        onChange={(v) => setFlag('memory', v)}
        disabled={busy}
      />
      <FeatureRow
        icon={Rocket}
        title="Cloud Launch (RunPod)"
        description="One-click deploy-link support for running TurboLLM on a rented RunPod GPU. Earliest-stage of the three — turning this on does not yet unlock a built UI."
        checked={experimental.cloudDeploy}
        onChange={(v) => setFlag('cloudDeploy', v)}
        disabled={busy}
      />
      <FeatureRow
        icon={AlarmClock}
        title="Routines"
        description="Scheduled tasks that fire automatically with no one present — chat or Code agents on a timer. Unlocks the Routines tab in Workspace and lets chat/Code create one when on."
        checked={experimental.routines}
        onChange={(v) => setFlag('routines', v)}
        disabled={busy}
      />
      {/* Remote access (ADR-422): the CHANGELOG/README point users here to switch it on, and
          without this row the flag could only be set by hand-editing config.json. Same
          two-layer shape as Turbo Link — the settings live in Network & sharing. */}
      <FeatureRow
        icon={Globe}
        title="Remote access"
        description="Share this machine over Cloudflare, Tailscale, ngrok or your own tunnel, with a scoped access token. Its settings live in Network & sharing. Not yet verified against real provider accounts."
        checked={experimental.remoteAccess}
        onChange={(v) => setFlag('remoteAccess', v)}
        disabled={busy}
      />
      {/* Python sandbox (GitHub #52): before Turbo Link, which the section's tests treat as the last checkbox. */}
      <SandboxRow checked={experimental.sandbox} onChange={(v) => setFlag('sandbox', v)} disabled={busy} />
      <FeatureRow
        icon={Network}
        title="Turbo Link"
        description="Use models running on your other machines from this one. Built and tested, but never yet run against a real second machine — expect rough edges. Turning it off leaves your linked machines saved, ready for when you turn it back on."
        checked={experimental.turboLink}
        onChange={(v) => setFlag('turboLink', v)}
        disabled={busy}
      />
    </section>
  )
}

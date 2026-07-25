import { FlaskConical, Rocket, Brain } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { ApiError } from '../../lib/api'
import { Badge } from '../../components/ui/badge'
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

/** Experimental features (2026-07-14, preparing for wider distribution): still-in-progress
 *  capabilities, off by default for new/distributed installs, turned on individually here.
 *  Both are simple master on/off rows in this ONE list — Memory's own richer settings
 *  (the "remember facts about you" toggle + facts list) stay in their ORIGINAL location,
 *  Settings → General's MemorySection, and only render there when this row is checked. This is
 *  a correction of an earlier version that moved MemorySection's whole UI into this tab — the
 *  founder was explicit that Memory's settings belong where they've always been, gated on
 *  visibility (and, on the backend, on actually running) by this checkbox alone, not relocated.
 *  Code used to be a third row here — removed when it graduated to generally available
 *  (ADR-280), rather than staying an opt-in toggle. */
export function ExperimentalSection() {
  const { query: settingsQ, save } = useSettings()
  const experimental = settingsQ.data?.experimental ?? { memory: false, cloudDeploy: false }
  const busy = save.isPending

  const setFlag = (key: 'memory' | 'cloudDeploy', value: boolean) => {
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
    </section>
  )
}

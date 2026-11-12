// Settings → System → Data retention (daemon chat/retention.ts): a daily sweep folds old raw gateway usage into
// daily totals and prunes each routine's oldest runs. Each control saves on its own, like the Experimental rows,
// so a patch carries only the member just edited. The daemon only lets the host change these (a remote caller's
// save answers api_key_required, which opens the key prompt), so the page needs no remote-only variant.
import { useEffect, useState } from 'react'
import { useSettings } from '../../lib/queries'
import { ApiError, type DaemonSettings } from '../../lib/api'
import { toast } from '../../components/ui/sonner'

type Retention = DaemonSettings['retention']
type LimitField = 'apiUsageRawDays' | 'routineRunsKept'

/** Mirrors the daemon's RETENTION_BOUNDS (src/config/config-bounds.ts): same range, same refusal text. */
const LIMITS: Record<LimitField, { min: number; max: number; message: string }> = {
  apiUsageRawDays: { min: 31, max: 3650, message: 'retention.apiUsageRawDays must be a whole number of days, 31–3650.' },
  routineRunsKept: { min: 10, max: 100_000, message: 'retention.routineRunsKept must be a whole number, 10–100000.' },
}

/** The whole number `text` spells within `field`'s range, or null. */
function parseLimit(field: LimitField, text: string): number | null {
  const { min, max } = LIMITS[field]
  const n = Number(text)
  return text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null
}

function LimitRow({
  field, label, value, disabled, onCommit,
}: {
  field: LimitField
  label: string
  value: number
  disabled: boolean
  onCommit: (n: number) => void
}) {
  const { min, max, message } = LIMITS[field]
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setDraft(String(value)); setInvalid(false) }, [value])

  const commit = () => {
    const n = parseLimit(field, draft)
    setInvalid(n === null)
    if (n !== null && n !== value) onCommit(n)
  }

  return (
    <div className="flex flex-col gap-1 py-2">
      <label className="flex items-center justify-between gap-3">
        <span className="text-[14px] text-ink">
          {label} <span className="text-[12px] text-faint">{`${min}–${max}`}</span>
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
          className="w-28 rounded-md border border-border bg-panel-2 px-2 py-1 text-right text-[13px] tabular-nums text-ink disabled:opacity-60"
        />
      </label>
      {invalid && <p role="alert" className="text-[12px] text-err">{message}</p>}
    </div>
  )
}

export function RetentionSection() {
  const { query: settingsQ, save } = useSettings()
  const retention = settingsQ.data?.retention
  if (!retention) return null

  const patch = (change: Partial<Retention>) => {
    save.mutate(
      { retention: change },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update data retention.') },
    )
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Data retention</h2>
      <p className="mb-3 text-[12px] text-muted">
        Folds old API usage into daily totals (dashboards keep their totals) and deletes each routine&apos;s oldest
        runs with the chat or Code session they made. Memory, other chats and audit logs are never touched.
      </p>

      <label className="flex cursor-pointer items-center justify-between gap-3 py-2">
        <span className="text-[14px] font-medium text-ink">Clean up automatically, daily</span>
        <input
          type="checkbox"
          checked={retention.enabled}
          disabled={save.isPending}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-60"
        />
      </label>
      <LimitRow field="apiUsageRawDays" label="Keep raw API usage for (days)" value={retention.apiUsageRawDays} disabled={!retention.enabled} onCommit={(n) => patch({ apiUsageRawDays: n })} />
      <LimitRow field="routineRunsKept" label="Keep runs per routine" value={retention.routineRunsKept} disabled={!retention.enabled} onCommit={(n) => patch({ routineRunsKept: n })} />
    </section>
  )
}

import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { CopyButton } from '../../components/ui/copy-button'
import { getRequestDetail } from '../../lib/api'
import { cn } from '../../lib/utils'
import type { RequestLogEntry } from '../../lib/types'

type Tab = 'params' | 'request' | 'response'

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Best-effort pretty-print of a captured body: it's usually JSON (a `JSON.stringify`d request
 *  or `{ content: "..." }` response), but reformat only when it parses — a body that fails to
 *  parse (raw text, or a shape we didn't anticipate) is shown exactly as captured rather than
 *  silently mangled. */
function prettyBody(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** The row-click detail drawer for one request-log entry (issue #211 follow-up) — Params /
 *  Request / Response, each pretty-printed with its own copy button. Fetches the full entry
 *  WITH bodies on open (`getRequestDetail`) rather than relying on the row's own object: the
 *  list/stream never carry bodies (routes.ts withholds them by default), so this is the one
 *  place in the UI that actually asks for them. */
export function RequestDetail({
  entry,
  onClose,
  captureBodies,
}: {
  entry: RequestLogEntry | null
  onClose: () => void
  captureBodies: boolean
}) {
  const [detail, setDetail] = useState<RequestLogEntry | null>(null)
  const [tab, setTab] = useState<Tab>('params')

  useEffect(() => {
    if (!entry) {
      setDetail(null)
      return
    }
    setTab('params')
    let cancelled = false
    void getRequestDetail(entry.id)
      .then((res) => { if (!cancelled) setDetail(res.entry) })
      .catch(() => { if (!cancelled) setDetail(entry) }) // fall back to the row's own (bodyless) copy
    return () => { cancelled = true }
  }, [entry])

  const shown = detail ?? entry

  return (
    <Sheet open={!!entry} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="flex w-full flex-col overflow-hidden sm:w-[520px]">
        <SheetHeader>
          <SheetTitle>{shown?.modelKey ?? 'Request'}</SheetTitle>
        </SheetHeader>

        {shown && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex shrink-0 items-center gap-1 border-b border-border">
              {(['params', 'request', 'response'] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className="-mb-px border-b-2 px-3 py-2 text-[13px] font-medium capitalize transition-colors"
                  style={{
                    borderColor: tab === t ? 'var(--accent)' : 'transparent',
                    color: tab === t ? 'var(--ink)' : 'var(--muted)',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {tab === 'params' && (
                <div className="flex flex-col gap-3 pb-4">
                  <DetailRow label="Source" value={shown.source} />
                  <DetailRow label="Harness" value={shown.harness ?? '—'} />
                  <DetailRow label="Model" value={shown.modelKey ?? '—'} />
                  <DetailRow label="Status" value={shown.status !== null ? String(shown.status) : 'pending'} />
                  {shown.error && <DetailRow label="Error" value={`${shown.error.code}: ${shown.error.message}`} />}
                  <DetailRow label="Streamed" value={shown.stream ? 'yes' : 'no'} />
                  <DetailRow label="Duration" value={shown.timings.durationMs !== null ? `${shown.timings.durationMs}ms` : '—'} />
                  <DetailRow label="TTFT" value={shown.timings.ttftMs !== null ? `${shown.timings.ttftMs}ms` : '—'} />
                  <DetailRow label="Tokens" value={`${shown.tokens.prompt} prompt → ${shown.tokens.completion} completion`} />
                  <DetailRow
                    label="Speed"
                    value={
                      shown.tokens.promptTps !== null || shown.tokens.genTps !== null
                        ? `${shown.tokens.promptTps?.toFixed(1) ?? '—'} tok/s prompt · ${shown.tokens.genTps?.toFixed(1) ?? '—'} tok/s gen`
                        : '—'
                    }
                  />
                  <DetailRow label="Finish reason" value={shown.finishReason ?? '—'} />
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-faint">
                      Sampling params
                      <CopyButton text={prettyJson(shown.params)} size={13} screen="monitor" />
                    </div>
                    <pre className="overflow-auto rounded-md border border-border bg-panel-2 p-3 font-mono text-[12px] leading-[1.5]">
                      {Object.keys(shown.params).length ? prettyJson(shown.params) : '(none sent)'}
                    </pre>
                  </div>
                </div>
              )}

              {(tab === 'request' || tab === 'response') && (
                <BodyPane
                  text={tab === 'request' ? shown.bodies?.request : shown.bodies?.response}
                  captureBodies={captureBodies}
                />
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-ink" title={value}>{value}</span>
    </div>
  )
}

function BodyPane({ text, captureBodies }: { text: string | undefined; captureBodies: boolean }) {
  if (!captureBodies) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-[12px] text-faint">
        "Log prompts and responses" is off — turn it on in this panel's gear menu (or Settings →
        Privacy &amp; telemetry) to capture body text for future requests. Metadata above is
        always captured regardless.
      </div>
    )
  }
  if (!text) {
    return <div className="p-4 text-[12px] text-faint">No body captured for this request.</div>
  }
  const pretty = prettyBody(text)
  return (
    <div>
      <div className="mb-1 flex justify-end">
        <CopyButton text={text} size={13} screen="monitor" />
      </div>
      <pre className={cn('overflow-auto rounded-md border border-border bg-panel-2 p-3 font-mono text-[12px] leading-[1.5]')}>
        {pretty}
      </pre>
    </div>
  )
}

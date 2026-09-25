// One System One run, two ways to read it (ADR-439): the response as it arrived, and the request
// that produced it as a command to paste. The command is built by `buildCurl`, which never puts
// the stored key in it: this is the view people screenshot.
import { useState } from 'react'
import { CopyButton } from '../../components/ui/copy-button'
import { buildCurl } from '../../lib/jev-api'
import type { SystemOneRequest, SystemOneResponse } from '../../lib/systemone-types'

export interface SystemOneRun {
  request: SystemOneRequest
  response: SystemOneResponse
  ms: number
}

const VIEWS = ['response', 'curl'] as const

type View = (typeof VIEWS)[number]

const VIEW_LABEL: Record<View, string> = { response: 'Response', curl: 'curl' }

const preCls = 'overflow-x-auto whitespace-pre rounded-md bg-panel-2 p-3 font-mono text-[12px] text-ink'

export function ResponsePanel({ run, origin }: { run: SystemOneRun | null; origin: string }) {
  const [view, setView] = useState<View>('response')

  return (
    <div className="flex flex-col gap-2">
      <ViewToggle view={view} onView={setView} />
      {run ? <RunView run={run} view={view} origin={origin} /> : <p className="text-[13px] text-muted">Run to see the response and the request as curl.</p>}
      {run && <p className="text-[12px] text-muted">{footerOf(run)}</p>}
    </div>
  )
}

function ViewToggle({ view, onView }: { view: View; onView: (next: View) => void }) {
  return (
    <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label="Response view">
      {VIEWS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={view === candidate}
          onClick={() => onView(candidate)}
          className={`rounded px-3 py-1 text-[13px] font-medium transition-colors ${
            view === candidate ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink'
          }`}
        >
          {VIEW_LABEL[candidate]}
        </button>
      ))}
    </div>
  )
}

function RunView({ run, view, origin }: { run: SystemOneRun; view: View; origin: string }) {
  if (view === 'curl') return <CurlView request={run.request} origin={origin} />
  return <pre className={preCls}>{JSON.stringify(run.response, null, 2)}</pre>
}

function CurlView({ request, origin }: { request: SystemOneRequest; origin: string }) {
  const command = buildCurl(origin, 'systemone', request)
  return (
    <div className="relative">
      <pre className={preCls}>{command}</pre>
      <CopyButton
        text={command}
        screen="workspace"
        action="jev_copy_request"
        className="absolute right-2 top-2"
      />
    </div>
  )
}

/** How long the run took and how much went in: the two numbers the playground exists to show.
 *  A Laya response also carries `routing` (which of its own checkpoints actually answered, and
 *  why) — worth naming here since it's the one line every run already reads; a plain Jev
 *  response carries no `routing` and this stays exactly as it always has. */
function footerOf(run: SystemOneRun): string {
  const base = `${run.ms} ms · ${run.response.usage.input_tokens} input tokens`
  const routing = run.response.routing
  return routing ? `${base} · answered by the ${routing.model} checkpoint` : base
}

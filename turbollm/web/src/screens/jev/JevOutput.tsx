// One run, three ways to read it (ADR-434 (c)): the rendered answer, the raw response, and the
// request as a command to paste. The API view is the one people screenshot, so it is built by
// `buildCurl`, which never puts the stored key in it.
import { CopyButton } from '../../components/ui/copy-button'
import { track } from '../../lib/api'
import { buildCurl } from '../../lib/jev-api'
import { CheckResults } from './CheckResults'
import { ChooseResults } from './ChooseResults'
import type { JevRun } from './jev-run'

export type JevView = 'results' | 'json' | 'api'

const VIEW_LABEL: Record<JevView, string> = { results: 'Results', json: 'JSON', api: 'API' }

const VIEW_ACTION: Record<JevView, string> = {
  results: 'jev_view_results',
  json: 'jev_view_json',
  api: 'jev_view_api',
}

const preCls = 'overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-panel-2 p-3 font-mono text-[12px] text-ink'

export function JevOutput({
  run,
  view,
  onView,
  origin,
}: {
  run: JevRun | null
  view: JevView
  onView: (v: JevView) => void
  origin: string
}) {
  function pickView(next: JevView) {
    track('workspace', VIEW_ACTION[next])
    onView(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label="Output view">
        {(Object.keys(VIEW_LABEL) as JevView[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={view === candidate}
            onClick={() => pickView(candidate)}
            className={`rounded px-3 py-1 text-[13px] font-medium transition-colors ${
              view === candidate ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink'
            }`}
          >
            {VIEW_LABEL[candidate]}
          </button>
        ))}
      </div>

      {run ? <RunView run={run} view={view} origin={origin} /> : <p className="text-[13px] text-muted">Run to see results.</p>}
      {run && <p className="text-[12px] text-muted">{summarise(run)}</p>}
    </div>
  )
}

function RunView({ run, view, origin }: { run: JevRun; view: JevView; origin: string }) {
  if (view === 'json') return <pre className={preCls}>{JSON.stringify(run.response, null, 2)}</pre>
  if (view === 'api') return <ApiView run={run} origin={origin} />
  if (run.endpoint === 'classify') return <CheckResults response={run.response} />
  return <ChooseResults response={run.response} />
}

function ApiView({ run, origin }: { run: JevRun; origin: string }) {
  const command = buildCurl(origin, run.endpoint, run.request)
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

/** How much was weighed, and how long it took — the two numbers the playground exists to show. */
function summarise(run: JevRun): string {
  if (run.endpoint === 'classify') return `${run.request.hypotheses.length} pairs in ${run.ms} ms`
  return `${run.request.documents.length} options in ${run.ms} ms`
}

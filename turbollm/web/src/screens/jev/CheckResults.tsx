// One row per hypothesis, with the model's own three probabilities (ADR-434 (c)).
//
// Nothing here sorts, rounds into a different number, or maps a label to a friendlier word:
// the gateway already emits the classes in the model's `id2label` order, and a view that
// re-ordered them would quietly contradict the JSON view beside it.
import type { ClassifyResponse, JevLabel } from '../../lib/types'

type CheckResult = ClassifyResponse['results'][number]

const CHIP_TONE: Record<JevLabel, string> = {
  entailment: 'bg-ok/12 text-ok',
  contradiction: 'bg-err/12 text-err',
  neutral: 'bg-panel-2 text-muted',
}

const BAR_TONE: Record<JevLabel, string> = {
  entailment: 'bg-ok',
  contradiction: 'bg-err',
  neutral: 'bg-muted',
}

export function CheckResults({ response }: { response: ClassifyResponse }) {
  const best = bestMatchIndex(response.results)

  return (
    <ul className="flex flex-col">
      {response.results.map((result, i) => (
        <li key={i} className="flex flex-col gap-1.5 border-t border-border py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14px] text-ink">{result.hypothesis}</span>
            <span className="flex shrink-0 gap-1.5">
              {i === best && <Chip className="bg-accent/12 text-accent">best match</Chip>}
              <Chip className={CHIP_TONE[result.label]}>{result.label}</Chip>
            </span>
          </div>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {labelsOf(result).map((label) => (
              <ProbabilityBar key={label} label={label} value={result.probs[label]} />
            ))}
          </dl>
        </li>
      ))}
    </ul>
  )
}

function ProbabilityBar({ label, value }: { label: JevLabel; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[12px] text-muted">
        <dt>{label}</dt>
        <dd>{value.toFixed(3)}</dd>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
        <span className={`block h-full ${BAR_TONE[label]}`} style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  )
}

function Chip({ className, children }: { className: string; children: string }) {
  return <span className={`rounded-md px-2 py-0.5 text-[12px] leading-5 ${className}`}>{children}</span>
}

/** The model's own class order, as the gateway serialised it — never a hardcoded triple. */
function labelsOf(result: CheckResult): JevLabel[] {
  return Object.keys(result.probs) as JevLabel[]
}

/** -1 when there is nothing to compare: crowning the only hypothesis says nothing. */
function bestMatchIndex(results: CheckResult[]): number {
  if (results.length < 2) return -1
  let best = 0
  results.forEach((result, i) => {
    if (result.probs.entailment > results[best].probs.entailment) best = i
  })
  return best
}

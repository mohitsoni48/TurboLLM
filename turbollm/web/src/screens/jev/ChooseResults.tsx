// The options, ranked (ADR-434 (c)).
//
// The gateway sorts by relevance and this view numbers what it receives, position by position.
// Re-sorting here would be a second opinion the JSON view beside it does not share.
import type { JevLabel, RerankResponse } from '../../lib/types'

const CHIP_TONE: Record<JevLabel, string> = {
  entailment: 'bg-ok/12 text-ok',
  contradiction: 'bg-err/12 text-err',
  neutral: 'bg-panel-2 text-muted',
}

export function ChooseResults({ response }: { response: RerankResponse }) {
  return (
    <ol className="flex flex-col">
      {response.results.map((result, i) => (
        <li key={result.index} className="flex items-center gap-3 border-t border-border py-2">
          <span className="w-5 shrink-0 text-[12px] text-muted">{i + 1}</span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[14px] text-ink">{result.document.text}</span>
            {i === 0 && <Chip className="bg-accent/12 text-accent">best</Chip>}
          </span>
          <span className="w-[110px] shrink-0">
            <span className="block text-right text-[12px] text-muted">{result.relevance_score.toFixed(3)}</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-panel-2">
              <span className="block h-full bg-ok" style={{ width: `${Math.round(result.relevance_score * 100)}%` }} />
            </span>
          </span>
          <Chip className={`shrink-0 ${CHIP_TONE[result.label]}`}>{result.label}</Chip>
        </li>
      ))}
    </ol>
  )
}

function Chip({ className, children }: { className: string; children: string }) {
  return <span className={`rounded-md px-2 py-0.5 text-[12px] leading-5 ${className}`}>{children}</span>
}

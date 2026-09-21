// The answers column (ADR-439). The previous answers stay on screen while a new run is in
// flight, because a blank column would lose the thing being compared. The honest label under the
// list is there in every state: it says these are entailment scores, not a calibrated decision
// model, in the product and not only in the docs.
import { AnswerCard } from './AnswerCard'
import { cn } from '../../lib/utils'
import type { Answer } from '../../lib/systemone-types'

const EMPTY_HINT = 'Run, or press ⌘/Ctrl+Enter.'
const HONEST_LABEL = "These are the model's NLI entailment scores, normalised — not a calibrated decision model."
const HOW_IT_WORKS_LABEL = 'How it works →'
const HOW_IT_WORKS_URL = 'https://turbollm.dev/docs/jev#systemone'

export function AnswerList({ answers, stale }: { answers: Record<string, Answer> | null; stale: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div aria-busy={stale} className={cn('flex flex-col gap-3', stale && 'opacity-60')}>
        {answers ? <Cards answers={answers} /> : <p className="text-[13px] text-muted">{EMPTY_HINT}</p>}
      </div>
      <HonestLabel />
    </div>
  )
}

function Cards({ answers }: { answers: Record<string, Answer> }) {
  return (
    <>
      {Object.entries(answers).map(([id, answer]) => (
        <AnswerCard key={id} id={id} answer={answer} />
      ))}
    </>
  )
}

function HonestLabel() {
  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted">
      <p>{HONEST_LABEL}</p>
      <a href={HOW_IT_WORKS_URL} target="_blank" rel="noreferrer" className="w-fit text-accent hover:underline">
        {HOW_IT_WORKS_LABEL}
      </a>
    </div>
  )
}

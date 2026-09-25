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
// A Laya model is a calibrated decision model, so the NLI label would be wrong about it; its model card's own
// caveat is the honest line instead (ADR-443).
const LAYA_LABEL = "These are Laya's own probabilities. Its model card says they ship over-confident, so check them on your own data."
const LAYA_URL = 'https://huggingface.co/convaiinnovations/laya'

export function AnswerList({ answers, stale, laya = false }: { answers: Record<string, Answer> | null; stale: boolean; laya?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div aria-busy={stale} className={cn('flex flex-col gap-3', stale && 'opacity-60')}>
        {answers ? <Cards answers={answers} /> : <p className="text-[13px] text-muted">{EMPTY_HINT}</p>}
      </div>
      <HonestLabel laya={laya} />
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

function HonestLabel({ laya }: { laya: boolean }) {
  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted">
      <p>{laya ? LAYA_LABEL : HONEST_LABEL}</p>
      <a href={laya ? LAYA_URL : HOW_IT_WORKS_URL} target="_blank" rel="noreferrer" className="w-fit text-accent hover:underline">
        {HOW_IT_WORKS_LABEL}
      </a>
    </div>
  )
}

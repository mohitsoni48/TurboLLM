// One question's answer, in the shape of its type (ADR-439). The numbers are shown as the model
// gave them, and a score's levels stay in level order: the scale is ordinal, so re-sorting it
// by probability would destroy its meaning.
//
// The response is JSON from the network, so nothing here trusts its shape: a missing or
// malformed field shows a dash rather than throwing, because the app has no error boundary and a
// throw while rendering would blank the whole screen. Every string is a React text child, so
// markup in an id, an option or a legend text is shown as text.
import type { Answer } from '../../lib/systemone-types'

type NoulAnswer = Extract<Answer, { type: 'noul' }>
type ChoiceAnswer = Extract<Answer, { type: 'choice' }>
type ScoreAnswer = Extract<Answer, { type: 'score' }>

const MISSING_VALUE = '—'

export function AnswerCard({ id, answer, laya = false }: { id: string; answer: Answer; laya?: boolean }) {
  return (
    <div
      role="group"
      aria-label={`${id} — ${typeOf(answer)}`}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3 [overflow-wrap:anywhere]"
    >
      <AnswerBody answer={answer} laya={laya} />
    </div>
  )
}

function AnswerBody({ answer, laya }: { answer: Answer; laya: boolean }) {
  switch (answer?.type) {
    case 'noul':
      return <NoulBody answer={answer} laya={laya} />
    case 'choice':
      return <ChoiceBody answer={answer} />
    case 'score':
      return <ScoreBody answer={answer} />
    default:
      return <p className="text-[13px] text-muted">This answer is not in a shape the playground can show.</p>
  }
}

/** A Jev yes/no answer is the model's entailment score; a Laya one is its own probability of yes (ADR-443). */
function NoulBody({ answer, laya }: { answer: NoulAnswer; laya: boolean }) {
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-[20px] font-medium text-ink">{fixed(answer.noul, 3)}</span>
        <span className="text-[12px] text-muted">{laya ? 'probability of yes' : 'entailment probability'}</span>
      </div>
      <Bar probability={answer.noul} />
    </>
  )
}

function ChoiceBody({ answer }: { answer: ChoiceAnswer }) {
  const options = optionsByProbability(answer.probabilities)
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[16px] font-medium text-ink">{textOf(answer.choice)}</span>
        <Confidence value={answer.confidence} />
      </div>
      <ul className="flex flex-col gap-1.5">
        {options.map(([option, probability]) => (
          <Row key={option} text={`${option} · ${fixed(probability, 2)}`} probability={probability} />
        ))}
      </ul>
    </>
  )
}

function ScoreBody({ answer }: { answer: ScoreAnswer }) {
  const levels = levelsInOrder(answer.legend)
  const probabilities = recordOf(answer.probabilities)
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[20px] font-medium text-ink">{fixed(answer.score, 2)}</span>
        {levels.length > 0 && <span className="text-[12px] text-muted">{`0–${levels.length - 1}`}</span>}
        <Confidence value={answer.confidence} />
      </div>
      <ul className="flex flex-col gap-1.5">
        {levels.map(([index, meaning]) => (
          <Row
            key={index}
            text={`${index} · ${textOf(meaning)} · ${fixed(probabilities[index], 2)}`}
            probability={probabilities[index]}
          />
        ))}
      </ul>
    </>
  )
}

function Row({ text, probability }: { text: string; probability: unknown }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="text-[13px] text-ink">{text}</span>
      <Bar probability={probability} />
    </li>
  )
}

function Confidence({ value }: { value: unknown }) {
  return <span className="text-[12px] text-muted">{`confidence ${fixed(value, 2)}`}</span>
}

function Bar({ probability }: { probability: unknown }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
      <span
        className="block h-full bg-accent"
        style={{ width: `${Math.round(clamp01(probability) * 1000) / 10}%` }}
      />
    </div>
  )
}

function typeOf(answer: Answer): string {
  const type: unknown = answer?.type
  return typeof type === 'string' ? type : 'unknown'
}

/** Most probable first; options that tie keep the order the response gave them. */
function optionsByProbability(probabilities: unknown): Array<[string, unknown]> {
  return Object.entries(recordOf(probabilities)).sort(([, a], [, b]) => clamp01(b) - clamp01(a))
}

function levelsInOrder(legend: unknown): Array<[string, unknown]> {
  return Object.entries(recordOf(legend)).sort(([a], [b]) => Number(a) - Number(b))
}

function recordOf(value: unknown): Record<string, unknown> {
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  return isPlainObject ? (value as Record<string, unknown>) : {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function fixed(value: unknown, digits: number): string {
  const number = finiteNumber(value)
  return number === null ? MISSING_VALUE : number.toFixed(digits)
}

function clamp01(value: unknown): number {
  const number = finiteNumber(value)
  return number === null ? 0 : Math.min(1, Math.max(0, number))
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : MISSING_VALUE
}

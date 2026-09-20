// The Check editor (ADR-434 (c)): a premise, and the hypotheses the model weighs against it.
//
// Fully controlled and free of opinions — no validation (jev-run.ts), no keyboard shortcut
// (the screen listens window-wide so Ctrl+Enter works from anywhere), no request.
import { useId } from 'react'
import { Play, Plus, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { track } from '../../lib/api'
import { MAX_JEV_INPUTS } from '../../lib/jev-api'
import type { CheckDraft } from './jev-run'

const inputCls =
  'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-50'
const labelCls = 'text-[12px] font-medium text-muted'

export function CheckPanel({
  value,
  onChange,
  onRun,
  running,
}: {
  value: CheckDraft
  onChange: (v: CheckDraft) => void
  onRun: () => void
  running: boolean
}) {
  const premiseId = useId()

  function addHypothesis() {
    track('workspace', 'jev_add_hypothesis')
    onChange({ ...value, hypotheses: [...value.hypotheses, ''] })
  }

  function removeHypothesis(at: number) {
    track('workspace', 'jev_remove_hypothesis')
    onChange({ ...value, hypotheses: value.hypotheses.filter((_, i) => i !== at) })
  }

  function rewriteHypothesis(at: number, text: string) {
    onChange({ ...value, hypotheses: value.hypotheses.map((h, i) => (i === at ? text : h)) })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className={labelCls} htmlFor={premiseId}>Premise</label>
        <textarea
          id={premiseId}
          rows={2}
          disabled={running}
          className={`${inputCls} resize-y`}
          value={value.premise}
          onChange={(e) => onChange({ ...value, premise: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>Hypotheses</span>
        {value.hypotheses.map((hypothesis, i) => (
          // The rows carry no identity of their own — a hypothesis is just text, and two of
          // them may legitimately read the same — so the position IS the key.
          <div key={i} className="flex items-center gap-2">
            <input
              className={inputCls}
              placeholder="A hypothesis to check"
              disabled={running}
              value={hypothesis}
              onChange={(e) => rewriteHypothesis(i, e.target.value)}
            />
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="Remove"
              disabled={value.hypotheses.length < 2}
              onClick={() => removeHypothesis(i)}
            >
              <X size={14} />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={value.hypotheses.length >= MAX_JEV_INPUTS}
          onClick={addHypothesis}
        >
          <Plus size={14} /> Add hypothesis
        </Button>
      </div>

      <Button size="sm" className="w-fit" disabled={running} onClick={onRun}>
        <Play size={14} /> Run
        <span aria-hidden className="text-[11px] opacity-70">Ctrl+Enter</span>
      </Button>
    </div>
  )
}

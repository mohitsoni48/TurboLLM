// The Choose editor (ADR-434 (c)): a question, and the options the model ranks by entailment.
//
// Deliberately a twin of CheckPanel rather than a shared generic editor: the two speak
// different domain words (premise/hypothesis vs question/option), track different actions and
// feed different endpoints, and folding them together would hide all three behind props.
import { useId } from 'react'
import { Play, Plus, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { track } from '../../lib/api'
import { MAX_JEV_INPUTS } from '../../lib/jev-api'
import type { ChooseDraft } from './jev-run'

const inputCls =
  'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint disabled:opacity-50'
const labelCls = 'text-[12px] font-medium text-muted'

export function ChoosePanel({
  value,
  onChange,
  onRun,
  running,
}: {
  value: ChooseDraft
  onChange: (v: ChooseDraft) => void
  onRun: () => void
  running: boolean
}) {
  const questionId = useId()

  function addOption() {
    track('workspace', 'jev_add_option')
    onChange({ ...value, options: [...value.options, ''] })
  }

  function removeOption(at: number) {
    track('workspace', 'jev_remove_option')
    onChange({ ...value, options: value.options.filter((_, i) => i !== at) })
  }

  function rewriteOption(at: number, text: string) {
    onChange({ ...value, options: value.options.map((o, i) => (i === at ? text : o)) })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className={labelCls} htmlFor={questionId}>Question</label>
        <input
          id={questionId}
          disabled={running}
          className={inputCls}
          value={value.question}
          onChange={(e) => onChange({ ...value, question: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>Options</span>
        {value.options.map((option, i) => (
          // Position is the identity: two options may legitimately read the same.
          <div key={i} className="flex items-center gap-2">
            <input
              className={inputCls}
              placeholder="An option"
              disabled={running}
              value={option}
              onChange={(e) => rewriteOption(i, e.target.value)}
            />
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="Remove"
              disabled={value.options.length < 2}
              onClick={() => removeOption(i)}
            >
              <X size={14} />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={value.options.length >= MAX_JEV_INPUTS}
          onClick={addOption}
        >
          <Plus size={14} /> Add option
        </Button>
      </div>

      <Button size="sm" className="w-fit" disabled={running} onClick={onRun}>
        <Play size={14} /> Run
        <span aria-hidden className="text-[11px] opacity-70">Ctrl+Enter</span>
      </Button>
    </div>
  )
}

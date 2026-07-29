// TerminalToolbar — composer-parity chrome for terminal-agent sessions (pi/claude/opencode).
//
// A terminal-agent session has no text to compose (the terminal itself owns keyboard input,
// TerminalView.tsx), so the full CodeComposer (textarea, send/stop, slash commands, @-mentions,
// "Add context") doesn't apply. But the founder was explicit: switching to an external CLI must
// not mean losing the composer's model picker / context ring / thinking budget / stats footer —
// those keep working, just without a message to send alongside them. This renders the SAME
// sub-components CodeComposer's toolbar row does (ModelLoadMenu, ContextUsageRing,
// ThinkingBudgetSlider) plus the same stats-footer formatting (fmtCompactTokens/
// thinkingCompactLabel, exported from CodeComposer.tsx) — literally shared chrome, not a
// lookalike — in the exact same screen position (bottom of CodeSessionScreen) a chat session's
// composer occupies, so switching agents changes what's ABOVE this row, never this row itself.
import { ContextUsageRing } from './ContextUsageRing'
import { ModelLoadMenu } from '../../components/ModelLoadMenu'
import { ThinkingBudgetSlider } from '../../components/ThinkingBudgetSlider'
import { fmtCompactTokens, thinkingCompactLabel } from './CodeComposer'
import type { ModelEntry } from '../../lib/types'

export interface TerminalToolbarProps {
  models: ModelEntry[]
  loadedKey: string | null
  loadedName: string | null
  modelPending: boolean
  ejecting: boolean
  onLoadModel: (key: string) => void
  onEjectModel: () => void
  onModelSettings?: (key: string) => void

  ctxUsed: number
  ctxMax: number

  thinkingBudget: number
  onThinkingBudgetChange: (v: number) => void

  /** Most recent completed gateway turn for this session (last-usage polling,
   *  CodeSessionScreen) — undefined renders no token segment, same rule CodeComposer's
   *  own footer already follows rather than showing a misleading 0/0. */
  lastPromptTokens?: number
  lastGenTokens?: number
  lastPromptTps?: number
  lastGenTps?: number
}

export function TerminalToolbar({
  models, loadedKey, loadedName, modelPending, ejecting, onLoadModel, onEjectModel, onModelSettings,
  ctxUsed, ctxMax, thinkingBudget, onThinkingBudgetChange,
  lastPromptTokens, lastGenTokens, lastPromptTps, lastGenTps,
}: TerminalToolbarProps) {
  return (
    <div className="border-t border-border px-3 pb-3 pt-2 md:px-8 md:pb-5">
      <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-panel px-2.5 py-2">
        <div className="flex-1" />
        <ContextUsageRing used={ctxUsed} max={ctxMax} />
        <ThinkingBudgetSlider value={thinkingBudget} onChange={onThinkingBudgetChange} />
        <ModelLoadMenu
          models={models}
          loadedKey={loadedKey}
          loadedName={loadedName}
          pending={modelPending}
          ejecting={ejecting}
          onLoad={onLoadModel}
          onEject={onEjectModel}
          onSettings={onModelSettings}
          align="end"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px] text-faint">
        <span className="inline-flex shrink-0 items-center gap-2 font-mono tabular-nums">
          <span title={thinkingCompactLabel(thinkingBudget)}>{thinkingCompactLabel(thinkingBudget)}</span>
          {ctxMax > 0 && (
            <span title={`Context: ${ctxUsed.toLocaleString()} / ${ctxMax.toLocaleString()} tokens`}>
              {Math.round(Math.min(1, ctxUsed / ctxMax) * 100)}%/{fmtCompactTokens(ctxMax)}
            </span>
          )}
          {lastPromptTokens !== undefined && lastGenTokens !== undefined && (
            <span title={`Last turn: ${lastPromptTokens.toLocaleString()} prompt` +
              (lastPromptTps !== undefined ? ` (${lastPromptTps.toFixed(0)} tok/s prefill)` : '') +
              `, ${lastGenTokens.toLocaleString()} generated` +
              (lastGenTps !== undefined ? ` (${lastGenTps.toFixed(1)} tok/s)` : '')}>
              &uarr;{fmtCompactTokens(lastPromptTokens)} &darr;{fmtCompactTokens(lastGenTokens)}
              {lastGenTps !== undefined && ` · ${lastGenTps.toFixed(1)} t/s`}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

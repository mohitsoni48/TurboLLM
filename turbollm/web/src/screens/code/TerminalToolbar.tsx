// TerminalToolbar — composer-parity chrome for terminal-agent sessions (pi/claude/opencode).
//
// A terminal-agent session has no text to compose (the terminal itself owns keyboard input,
// TerminalView.tsx), so the full CodeComposer (textarea, send/stop, slash commands, @-mentions,
// "Add context") doesn't apply. But the founder was explicit: switching to an external CLI must
// not mean losing the composer's model picker / context ring / thinking budget / stats footer —
// those keep working, just without a message to send alongside them. This renders the SAME
// sub-components CodeComposer's toolbar row does (ModelLoadMenu, ContextUsageRing,
// ThinkingBudgetSlider) and the SAME footer component (CodeStatsFooter) — literally shared
// chrome, not a lookalike — in the exact same screen position (bottom of CodeSessionScreen) a
// chat session's composer occupies, so switching agents changes what's ABOVE this row, never
// this row itself.
//
// Two things this row does NOT inherit from the composer, because the CLI variant genuinely
// differs (2026-07-29, founder: "should suit both cli and native code"):
//   - The composer's left side holds the mode picker and "Add context"; neither exists here, so
//     that space used to be a literal empty `flex-1` spacer. It now names the CLI actually
//     driving the session — which is otherwise nowhere in the UI at all (the header shows title/
//     repo/branch/diff, and `codeAgent` appears in no other component), so this is new
//     information, not a repeat of something already on screen (ADR-262's one-place rule).
//   - The footer's hint slot carries the terminal's own affordance instead of the composer's
//     keybinds. Ctrl+D (or Cmd+D) is a REAL handler in TerminalView.tsx and it navigates away
//     without killing the PTY — the daemon keeps the session's terminal alive and reattaches on
//     return — so both halves of the hint are literally true.
import { TerminalSquare } from 'lucide-react'
import { ContextUsageRing } from './ContextUsageRing'
import { ModelLoadMenu } from '../../components/ModelLoadMenu'
import { ThinkingBudgetSlider } from '../../components/ThinkingBudgetSlider'
import { CodeStatsFooter } from './CodeStatsFooter'
import type { ModelEntry } from '../../lib/types'

export interface TerminalToolbarProps {
  /** The CLI driving this session (`session.codeAgent` — 'claude', 'pi', 'opencode'). */
  agent: string

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
  agent, models, loadedKey, loadedName, modelPending, ejecting, onLoadModel, onEjectModel, onModelSettings,
  ctxUsed, ctxMax, thinkingBudget, onThinkingBudgetChange,
  lastPromptTokens, lastGenTokens, lastPromptTps, lastGenTps,
}: TerminalToolbarProps) {
  return (
    <div className="border-t border-border px-3 pb-3 pt-2 md:px-8 md:pb-5">
      <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-panel px-2.5 py-2">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 px-1 text-[12px] text-muted"
          title={`This session runs the ${agent} CLI in the terminal above`}
        >
          <TerminalSquare size={14} className="shrink-0 text-faint" />
          <span className="font-mono">{agent}</span>
        </span>
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
          screen="code"
        />
      </div>
      <CodeStatsFooter
        thinkingBudget={thinkingBudget}
        ctxUsed={ctxUsed}
        ctxMax={ctxMax}
        lastPromptTokens={lastPromptTokens}
        lastGenTokens={lastGenTokens}
        lastPromptTps={lastPromptTps}
        lastGenTps={lastGenTps}
        hint="Ctrl+D to leave · the agent keeps running"
      />
    </div>
  )
}

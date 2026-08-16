import { Fragment, type ReactNode } from 'react'
import { folderName } from '../../lib/utils'
import { reasoningEffortLabel, type ReasoningEffort } from '../../components/ReasoningEffortSelect'

// ── Code stats footer ────────────────────────────────────────────────────────
//
// The ONE stats/hint strip under Code's bottom chrome, rendered by both session kinds:
// CodeComposer.tsx (a turbollm chat session) and TerminalToolbar.tsx (a terminal-agent session
// driving an external CLI). ADR-284 shipped the terminal variant by hand-copying the composer's
// footer JSX — two copies of the same markup is exactly the drift ADR-262's "one place" rule
// exists to prevent, and it means any legibility fix has to be made twice or it isn't made at
// all. This is that one place; the callers pass data and their own hint, nothing else.
//
// Founder feedback (2026-07-29, live screenshot of a `claude` session): the previous rendering
//
//     Think: 3.0k 15%/200.7k ↑36.6k ↓36 · 2.0 t/s
//
// "still looks like a bug". It was five unrelated numbers run together in one faint monospace
// string at a single visual weight, with `15%/200.7k` in particular reading as a broken template
// (a percentage divided by a token count — a slash between two things that can't be divided).
// The DATA was right; the presentation had no labels, no grouping, and no contrast between a
// label and its value. Every number ADR-262's audit put here is still here — nothing added,
// nothing removed, so that audit still holds — only how it reads changed:
//
//   - every number is a `label + value` pair, so nothing is ever an unlabeled digit
//   - labels stay `text-faint`; values step up to `text-ink`. That's the only real contrast step
//     the palette offers here — `--muted` and `--faint` are within a couple of percent of each
//     other in BOTH themes (check index.css), so a muted-vs-faint "hierarchy" would have been
//     invisible, which is how the old line ended up flat in the first place.
//   - groups are separated by a dimmed `·` instead of running together on plain whitespace
//   - `15%/200.7k` becomes `15%` + `of 200.7k`, and `t/s` becomes `tok/s` — the same unit label
//     Chat's own stats row already uses (MessageBubble.tsx), not a Code-only abbreviation
//
// Density is preserved on purpose (11px, mono numerals, one line at a normal width): ADR-252/262's
// dense terminal FEEL is the point, and this is a legibility pass, not a redesign. `flex-wrap`
// (not the toolbar row's `overflow-x-auto`) keeps it wrapping rather than clipping on a phone.

/** Compact token count — same k/M convention as ContextUsageRing's own fmtTokens, kept in step
 *  with it deliberately so the ring's Sheet and this footer never disagree about a number. */
export function fmtCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** The thinking budget as the footer's VALUE only ("3.0k" / "Off" / "Unlimited") — its "Think"
 *  label is a separate element so it can be dimmed. Off/Unlimited match ThinkingBudgetSlider's
 *  own formatBudget wording exactly, so the footer and the control it reports on can't drift. */
export function thinkingValue(budget: number): string {
  if (budget < 0) return 'Unlimited'
  if (budget === 0) return 'Off'
  return fmtCompactTokens(budget)
}

function thinkingTitle(budget: number): string {
  if (budget < 0) return 'Thinking budget: unlimited — no cap is sent'
  if (budget === 0) return 'Thinking: off'
  return `Thinking budget: ${budget.toLocaleString()} tokens`
}

/** One `label value suffix` group. The value carries `font-mono tabular-nums` (ADR-252's "mono
 *  only where it earns it" — these are genuinely stats) and the label deliberately does not:
 *  proportional label + mono value is what makes the pair read as one labelled fact rather than
 *  another run of monospace characters. */
function Stat({ label, value, suffix, title }: { label?: string; value: string; suffix?: string; title: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title={title}>
      {label && <span>{label}</span>}
      <span className="font-mono tabular-nums text-ink">{value}</span>
      {suffix && <span className="font-mono tabular-nums">{suffix}</span>}
    </span>
  )
}

function Divider() {
  return <span aria-hidden className="select-none opacity-50">·</span>
}

export interface CodeStatsFooterProps {
  thinkingBudget: number
  /** When set (the loaded model supports it — ModelEntry.reasoningEffort), replaces the
   *  "Think" stat with a "Reasoning" one so the footer reports whichever control is actually
   *  live for this model instead of an unused/stale thinkingBudget value. */
  reasoningEffort?: ReasoningEffort
  ctxUsed: number
  ctxMax: number
  /** Most recent completed turn. `undefined` renders no segment at all rather than a misleading
   *  0/0 — the same rule the original footer followed, kept verbatim. */
  lastPromptTokens?: number
  lastGenTokens?: number
  lastPromptTps?: number
  lastGenTps?: number
  /** Mid-session repo context (composer only, and only where the screen isn't already showing
   *  it — see CodeComposer's own call site for which variant passes these). */
  branch?: string
  cwd?: string
  /** Right-aligned affordance/keybind hint, caller-owned: the composer's keybinds, the terminal's
   *  Ctrl+D. Must describe something that actually works — a hint for a shortcut with no handler
   *  is the exact regression CodeComposer's "keybind-hint honesty" tests exist to catch. */
  hint?: string
}

export function CodeStatsFooter({
  thinkingBudget, reasoningEffort, ctxUsed, ctxMax,
  lastPromptTokens, lastGenTokens, lastPromptTps, lastGenTps,
  branch, cwd, hint,
}: CodeStatsFooterProps) {
  const pct = ctxMax > 0 ? Math.round(Math.min(1, ctxUsed / ctxMax) * 100) : 0

  const groups: ReactNode[] = [
    reasoningEffort
      ? <Stat key="think" label="Reasoning" value={reasoningEffortLabel(reasoningEffort)} title={`Reasoning effort: ${reasoningEffortLabel(reasoningEffort)}`} />
      : <Stat key="think" label="Think" value={thinkingValue(thinkingBudget)} title={thinkingTitle(thinkingBudget)} />,
  ]

  if (ctxMax > 0) {
    groups.push(
      <Stat
        key="ctx"
        label="Context"
        value={`${pct}%`}
        suffix={`of ${fmtCompactTokens(ctxMax)}`}
        title={`Context: ${ctxUsed.toLocaleString()} / ${ctxMax.toLocaleString()} tokens (${pct}%)`}
      />,
    )
  }

  if (lastPromptTokens !== undefined && lastGenTokens !== undefined) {
    groups.push(
      <Stat
        key="turn"
        label="Last turn"
        value={`↑${fmtCompactTokens(lastPromptTokens)} ↓${fmtCompactTokens(lastGenTokens)}`}
        title={`Last turn: ${lastPromptTokens.toLocaleString()} prompt tokens` +
          (lastPromptTps !== undefined ? ` (${lastPromptTps.toFixed(0)} tok/s prefill)` : '') +
          `, ${lastGenTokens.toLocaleString()} generated` +
          (lastGenTps !== undefined ? ` (${lastGenTps.toFixed(1)} tok/s)` : '')}
      />,
    )
  }

  if (lastGenTps !== undefined) {
    groups.push(
      <Stat key="tps" value={`${lastGenTps.toFixed(1)} tok/s`} title="Generation speed on the last turn" />,
    )
  }

  if (branch || cwd) {
    groups.push(
      <span key="repo" className="inline-flex min-w-0 items-baseline gap-1" title={cwd}>
        {branch && <span className="truncate text-ink">{branch}</span>}
        {branch && cwd && <Divider />}
        {cwd && <span className="truncate">{folderName(cwd)}</span>}
      </span>,
    )
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] leading-5 text-faint">
      {groups.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <Divider />}
          {group}
        </Fragment>
      ))}
      {hint && <span className="ml-auto min-w-0 truncate pl-2">{hint}</span>}
    </div>
  )
}

import { useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  CornerDownRight,
  FileEdit,
  FilePlus,
  FileText,
  FolderTree,
  HelpCircle,
  ListChecks,
  Loader2,
  RotateCcw,
  Search,
  SendHorizontal,
  SquareTerminal,
  Terminal,
  XCircle,
} from 'lucide-react'
import type { LiveToolCall, Message, MessageTimelineBlock, ToolCallRecord } from '../../lib/chat-types'
import type { QueuedTurn, ShellRun, SteerKind, TodoItem } from '../../lib/code-types'
import type { RetryState } from '../../lib/code-session-client'
import { useDisplayPref } from '../../lib/code-display-prefs'
import type { LiveBlock } from '../../lib/live-timeline'
import { friendlyName } from '../../lib/tool-explain'
import { cn } from '../../lib/utils'
import { CopyButton } from '../../components/ui/copy-button'
import { Skeleton } from '../../components/ui/skeleton'
import { Markdown } from '../chat/MessageBubble'

// ── Code session transcript ──────────────────────────────────────────────────
//
// A dense, flat activity log (ADR-262) — modelled on opencode/pi's terminal FEEL,
// the tools this redesign was commissioned against, NOT on chat/MessageBubble.tsx's
// bubbles. Same real data (genuine diffs/tool calls/reasoning/text off the SSE
// stream, nothing faked), presented as a log:
//   - tool calls are FLAT glyph-prefixed lines (a leading tool icon + the file
//     path/command), not bordered cards, and not collapsed into a group→side-panel.
//     Each line expands inline to its diff/output — the reference's "click to
//     expand" pattern, not a separate Sheet.
//   - the user's task/follow-ups stay a right-aligned instruction callout;
//     everything the agent does stays left-aligned. Sender is distinguished by
//     alignment + color alone (Chat already proves this works), NO vertical rail —
//     the rail was a TurboLLM-only construct with no analog in either reference,
//     dropped per ADR-262.
//   - tool output/diffs use the near-black --log-bg/--log-ink + --diff-* tokens
//     (spec 11 / Phase 0), so they read as a console; reasoning gets the same
//     monospace log treatment (agent narration, not its final answer); assistant
//     commentary stays in normal prose type, so the eye tells "code/activity" from
//     "explanation" at a glance.
//   - density is tight (small gaps, one-line tool entries) toward the reference's
//     look — deliberately less airy than the old card-and-rail layout, without
//     going cramped/illegible. ADR-252 still holds: prose stays sans (mono only
//     where it earns it), light+dark both first-class, no literal terminal chrome.

type ToolStatus = 'pending' | 'done' | 'error' | 'awaiting_approval'

interface NormalizedCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  result?: string
  diff?: string
  /** Live cumulative output snapshot while a streaming tool (bash) is still running (Phase 2) —
   *  only ever present on a live call, never a persisted one. */
  partial?: string
}

function toRecordCall(tc: ToolCallRecord): NormalizedCall {
  return { id: tc.id, name: tc.name, args: tc.args, status: tc.error ? 'error' : 'done', result: tc.error ?? tc.result, diff: tc.diff }
}
function toLiveCall(tc: LiveToolCall): NormalizedCall {
  return { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result, diff: tc.diff, partial: tc.partial }
}

const EDIT_TOOLS = new Set(['edit'])
const WRITE_TOOLS = new Set(['write'])
const BASH_TOOLS = new Set(['bash'])
const READ_TOOLS = new Set(['read'])
const SEARCH_TOOLS = new Set(['grep', 'find'])

function toolIcon(name: string) {
  if (EDIT_TOOLS.has(name)) return FileEdit
  if (WRITE_TOOLS.has(name)) return FilePlus
  if (BASH_TOOLS.has(name)) return Terminal
  if (READ_TOOLS.has(name)) return FileText
  if (SEARCH_TOOLS.has(name)) return Search
  if (name === 'ls') return FolderTree
  return Terminal
}

// Mirrors the backend's MUTATING_TOOLS (code-session.ts) — edit/write/bash are the tools that
// can change the filesystem; read/grep/find/ls never do. bash carries no path argument (the
// backend's own comment: "containment can't confine it, the mode system is its only guard"), so
// this is a conservative "may write" signal applied to EVERY bash call, never sniffed from the
// command string itself — a heuristic that labels a destructive command "read" would actively
// mislead, which is worse than no label at all.
const MUTATING_TOOLS = new Set(['edit', 'write', 'bash'])

function isMutating(name: string): boolean {
  return MUTATING_TOOLS.has(name)
}

/** Hover tooltip explaining what a tool call actually does, read/write-explicit. `label` is the
 *  same path/command string the line itself already shows. */
function toolTooltip(name: string, label: string): string {
  if (EDIT_TOOLS.has(name)) return `Modifies ${label}`
  if (WRITE_TOOLS.has(name)) return `Creates or overwrites ${label}`
  if (BASH_TOOLS.has(name)) return 'Runs a shell command — may read or write anywhere'
  if (READ_TOOLS.has(name)) return `Reads ${label}`
  if (SEARCH_TOOLS.has(name)) return `Searches for ${label}`
  if (name === 'ls') return `Lists ${label}`
  return friendlyName(name)
}

/** A file-taking tool's `path` arg, for the flat line's label — falls back to the
 *  friendly tool name when there's no path (bash, or an odd/legacy call shape).
 *  invoke_skill has neither a path nor a command, just a skillId, so without this it would
 *  render as the unhelpfully generic "invoke skill" for every skill call alike. */
function toolLabel(name: string, args: Record<string, unknown>): string {
  const path = args.path
  if (typeof path === 'string' && path.trim()) return path
  if (BASH_TOOLS.has(name) && typeof args.command === 'string') return args.command
  if (name === 'invoke_skill' && typeof args.skillId === 'string' && args.skillId.trim()) {
    return `${friendlyName(name)} (${args.skillId})`
  }
  return friendlyName(name)
}

const STATUS_COLOR: Record<ToolStatus, string> = {
  pending: 'var(--accent)',
  done: 'var(--ok)',
  error: 'var(--err)',
  awaiting_approval: 'var(--warn)',
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'pending') return <Loader2 size={13} className="shrink-0 animate-spin" style={{ color: STATUS_COLOR.pending }} />
  if (status === 'done') return <CheckCircle2 size={13} className="shrink-0" style={{ color: STATUS_COLOR.done }} />
  if (status === 'error') return <XCircle size={13} className="shrink-0" style={{ color: STATUS_COLOR.error }} />
  return <HelpCircle size={13} className="shrink-0" style={{ color: STATUS_COLOR.awaiting_approval }} />
}

/** Count +/- lines for the line's compact stat chip (skips the +++/--- file
 *  headers, which start with the same characters but aren't real changes). */
function diffStats(diff: string): { add: number; del: number } {
  let add = 0, del = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
}

/** Two-gutter (old-line# | new-line#), line-colored unified-diff panel — real
 *  line numbers reconstructed from the diff's own `@@ -a,b +c,d @@` hunk
 *  headers, IDE-style. No diffing computed client-side; this only lays out
 *  pi's own diff output (turbollm/src/code/code-session.ts). The diff CONTENT
 *  stays fully readable (line numbers + add/del coloring) — ADR-262 flattened the
 *  chrome AROUND tool calls, not the usefulness of the diff itself. */
function CodeDiffPanel({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n')
  let oldLine = 0
  let newLine = 0
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border border-border">
      <table className="w-full border-collapse font-mono text-[12px] leading-relaxed">
        <tbody>
          {lines.map((line, i) => {
            const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
            if (hunk) {
              oldLine = parseInt(hunk[1], 10)
              newLine = parseInt(hunk[2], 10)
              return (
                <tr key={i}>
                  <td
                    colSpan={3}
                    className="select-none whitespace-pre px-3 py-1"
                    style={{ color: 'var(--accent)', background: 'var(--diff-hunk-bg)' }}
                  >
                    {line}
                  </td>
                </tr>
              )
            }
            if (line.startsWith('+++') || line.startsWith('---')) {
              return (
                <tr key={i}>
                  <td colSpan={3} className="select-none whitespace-pre px-3 py-1 text-faint">{line}</td>
                </tr>
              )
            }
            const isAdd = line.startsWith('+')
            const isDel = line.startsWith('-')
            const isNoNewline = line.startsWith('\\')
            const rowOld = isAdd || isNoNewline ? null : oldLine
            const rowNew = isDel || isNoNewline ? null : newLine
            if (!isAdd && !isNoNewline) oldLine++
            if (!isDel && !isNoNewline) newLine++
            const bg = isAdd
              ? 'var(--diff-add-bg)'
              : isDel
                ? 'var(--diff-del-bg)'
                : undefined
            const fg = isAdd ? 'var(--ok)' : isDel ? 'var(--err)' : 'var(--ink)'
            return (
              <tr key={i} style={{ background: bg }}>
                <td className="w-px select-none px-2 text-right text-faint tabular-nums">{rowOld ?? ''}</td>
                <td className="w-px select-none px-2 text-right text-faint tabular-nums">{rowNew ?? ''}</td>
                <td className="whitespace-pre px-2" style={{ color: fg }}>{line || ' '}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Non-diff tool output (bash stdout, read/grep/find/ls results) — the SAME
 *  near-black log tokens EngineLogPanel.tsx uses for real process output, so
 *  this reads as a console. When `streaming` (a live `tool_progress` snapshot,
 *  Phase 2) it follows the TAIL (newest output, like a real terminal) instead of
 *  the head, and shows a pulsing cursor. */
function CodeOutputPanel({ text, streaming }: { text: string; streaming?: boolean }) {
  const truncated = text.length > 4000
    ? (streaming ? `…(earlier output hidden)\n${text.slice(-4000)}` : `${text.slice(0, 4000)}\n…(truncated)`)
    : text
  return (
    <div className="max-h-80 overflow-auto rounded-md" style={{ background: 'var(--log-bg)' }}>
      <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[12px] leading-relaxed" style={{ color: 'var(--log-ink)' }}>
        {truncated || <span style={{ color: 'var(--log-faint)' }}>{streaming ? '' : '(no output)'}</span>}
        {streaming && <span className="tllm-pulse" style={{ color: 'var(--log-faint)' }}>▋</span>}
      </pre>
    </div>
  )
}

/** One tool call as a FLAT glyph-prefixed line (ADR-262) — a leading tool icon +
 *  the file path/command on one row, a trailing status glyph, click to expand its
 *  diff/output inline BELOW (indented under the label). No card border, no
 *  group→Sheet: every call in a run renders as its own dense line, matching
 *  opencode/pi. Edits/writes (which carry a diff) auto-expand — they ARE the point
 *  of a code session; reads/searches/bash start collapsed. `/details` (ADR-258)
 *  force-opens every line globally; the per-line toggle still works when it's off. */
function CodeToolLine({ call }: { call: NormalizedCall }) {
  const Icon = toolIcon(call.name)
  const label = toolLabel(call.name, call.args)
  const mutating = isMutating(call.name)
  const hasDiff = !!call.diff?.trim()
  // Live cumulative output while the tool is still running (bash) — shown before the terminal
  // `result` exists (Phase 2). Once the real result lands it takes over.
  const streamingPartial = call.status === 'pending' && !!call.partial?.length && !call.result?.length
  const hasOutput = !!call.result?.length || hasDiff || !!call.partial?.length
  const [expanded, setExpanded] = useState(hasDiff)
  const detailsPref = useDisplayPref('details')
  // `streamingPartial` makes it visible WHILE actively running, without persisting into
  // `expanded` — once the real result lands and streaming ends, this drops out and the panel
  // reverts to the user's own manual choice (or `hasDiff`'s default). Collapsed by default for a
  // finished command with no diff, same as any other tool call (founder feedback, 2026-07-24: an
  // earlier version force-expanded `expanded` itself on stream-start and never reverted it, so
  // every bash call that streamed output stayed open forever after finishing too).
  const open = expanded || detailsPref || streamingPartial
  const stats = hasDiff ? diffStats(call.diff!) : null

  return (
    <div>
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((e) => !e)}
        disabled={!hasOutput}
        title={toolTooltip(call.name, label)}
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-panel-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Icon
          size={13}
          className={cn('shrink-0', !mutating && 'text-muted')}
          style={mutating ? { color: 'var(--warn)' } : undefined}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{label}</span>
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span style={{ color: 'var(--ok)' }}>+{stats.add}</span>{' '}
            <span style={{ color: 'var(--err)' }}>&minus;{stats.del}</span>
          </span>
        )}
        <StatusIcon status={call.status} />
      </button>
      {/* Expanded content, indented under the label (icon 13px + gap 8px). The result supersedes a
          live partial the moment it arrives. */}
      {open && hasDiff && <div className="ml-[21px] mb-1 mt-0.5"><CodeDiffPanel diff={call.diff!} /></div>}
      {open && !hasDiff && call.result && <div className="ml-[21px] mb-1 mt-0.5"><CodeOutputPanel text={call.result} /></div>}
      {open && !hasDiff && !call.result && call.partial && <div className="ml-[21px] mb-1 mt-0.5"><CodeOutputPanel text={call.partial} streaming /></div>}
    </div>
  )
}

/** The leading subcommand word of a `bash` tool call's command — `git` for `git status`, `npm`
 *  for `npm install .` — used to decide which consecutive terminal commands are "similar" enough
 *  to group. Null for any NON-bash tool call (edit/write/read/grep/find/ls never group; they read
 *  distinctly by icon and the founder ask was specifically about terminal commands) or a bash call
 *  with no usable command string. */
function bashLeadWord(call: NormalizedCall): string | null {
  if (!BASH_TOOLS.has(call.name)) return null
  const cmd = call.args.command
  if (typeof cmd !== 'string') return null
  const first = cmd.trim().split(/\s+/)[0]
  return first || null
}

type ToolRunItem =
  | { kind: 'single'; call: NormalizedCall }
  | { kind: 'group'; lead: string; calls: NormalizedCall[] }

/** Partition a run of consecutive tool calls into single lines and GROUPS of 2+ consecutive `bash`
 *  commands sharing the same leading subcommand word (a run of `git …`/`git …`/`git …` collapses
 *  into one "3 git commands" unit). A lone bash command — even flanked by other, differently-led
 *  bash commands — stays its own line (nothing similar adjacent to group with). This is NARROWER
 *  than the retired 2+→Sheet grouping ADR-262 killed: only SIMILAR commands group, and the group
 *  expands INLINE (see CodeToolGroup), never into a side panel. Runs through ToolRun, so it applies
 *  to BOTH the live (chunkTimeline) and persisted (chunkPersistedTimeline) tool sequences alike. */
function groupToolCalls(calls: NormalizedCall[]): ToolRunItem[] {
  const items: ToolRunItem[] = []
  let i = 0
  while (i < calls.length) {
    const lead = bashLeadWord(calls[i])
    if (lead !== null) {
      let j = i + 1
      while (j < calls.length && bashLeadWord(calls[j]) === lead) j++
      const run = calls.slice(i, j)
      if (run.length >= 2) items.push({ kind: 'group', lead, calls: run })
      else items.push({ kind: 'single', call: calls[i] })
      i = j
    } else {
      items.push({ kind: 'single', call: calls[i] })
      i++
    }
  }
  return items
}

/** A run of 2+ consecutive SIMILAR terminal commands (same leading subcommand — see groupToolCalls)
 *  collapsed into one expandable line, e.g. "3 git commands" (founder feedback, 2026-07-24: a burst
 *  of consecutive git/npm commands each on its own flat line read as noise). Collapsed by default —
 *  nothing in this redesign default-opens anymore — with a status glyph rolled up from its members
 *  (error if any errored, else pending if any still running, else done). Expands INLINE to each
 *  command as its OWN CodeToolLine, each still independently clickable for ITS own output: expanding
 *  the group reveals the list, not one flattened blob, and not the retired side-Sheet. `/details`
 *  force-opens the group (and, transitively, each inner line) just like a single CodeToolLine. */
function CodeToolGroup({ lead, calls }: { lead: string; calls: NormalizedCall[] }) {
  const [expanded, setExpanded] = useState(false)
  const detailsPref = useDisplayPref('details')
  const open = expanded || detailsPref
  const status: ToolStatus = calls.some((c) => c.status === 'error')
    ? 'error'
    : calls.some((c) => c.status === 'pending')
      ? 'pending'
      : calls.some((c) => c.status === 'awaiting_approval')
        ? 'awaiting_approval'
        : 'done'
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        title="Runs shell commands — may read or write anywhere"
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-panel-2"
      >
        <ChevronRight size={13} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        {/* Every member of a group is a bash call (groupToolCalls/bashLeadWord) — same
            unconditional warn tint as a single CodeToolLine's bash icon. */}
        <Terminal size={13} className="shrink-0" style={{ color: 'var(--warn)' }} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{calls.length} {lead} commands</span>
        <StatusIcon status={status} />
      </button>
      {open && (
        <div className="ml-[21px] flex flex-col">
          {calls.map((c) => <CodeToolLine key={c.id} call={c} />)}
        </div>
      )}
    </div>
  )
}

/** A run of consecutive tool calls (from the chunker) rendered as a tight stack of
 *  flat lines (ADR-262 — no more 1→card / 2+→group-Sheet split; every call is its
 *  own line). Consecutive SIMILAR terminal commands are first folded into one expandable
 *  CodeToolGroup (see groupToolCalls); everything else stays its own CodeToolLine. The lines pack
 *  tightly (their own py-0.5 is the spacing); the outer turn container's gap separates this run
 *  from adjacent commentary/reasoning. */
function ToolRun({ calls }: { calls: NormalizedCall[] }) {
  if (calls.length === 0) return null
  return (
    <div className="flex flex-col">
      {groupToolCalls(calls).map((it) =>
        it.kind === 'group'
          ? <CodeToolGroup key={`g:${it.calls[0].id}`} lead={it.lead} calls={it.calls} />
          : <CodeToolLine key={it.call.id} call={it.call} />,
      )}
    </div>
  )
}

/** The user's task (session-starting prompt or a follow-up). No label —
 *  right-aligned (`ml-auto w-fit`), width-capped the same way chat's own user
 *  bubble is (`min(88%,900px)`, see MessageBubble.tsx) so alone that's enough to
 *  read as "yours" against the agent's left-aligned activity (ADR-262 keeps this
 *  alignment convention deliberately; only the rail was dropped). */
function CodeInstructionEntry({
  content, contextFiles, onRevert,
}: {
  content: string
  contextFiles?: string[]
  /** Omitted for the session's very first message (nothing before it to revert to) or
   *  whenever a run is live (the backend 409s on this anyway — hidden here for a cleaner
   *  affordance rather than a guaranteed-fail click). */
  onRevert?: () => void
}) {
  return (
    // `group` on the OUTER wrapper (not the box) — the action row is a sibling BELOW the box, not
    // a child inside it, so it no longer pads out the box's own height (founder feedback,
    // 2026-07-24: buttons living inside the box read as an odd extra inch of empty space under
    // the text). Hovering the box still reveals it, since `.group:hover .hover-actions` matches
    // any descendant of this wrapper.
    <div className="group ml-auto flex w-fit max-w-[min(88%,900px)] flex-col items-end gap-1">
      <div
        className="w-full rounded-lg border px-4 py-3"
        style={{ borderColor: 'var(--instruction-border)', background: 'var(--instruction-bg)' }}
      >
        {!!contextFiles?.length && (
          <div className="mb-2 flex flex-wrap justify-end gap-1.5">
            {contextFiles.map((p) => (
              <span
                key={p}
                title={p}
                className="inline-flex max-w-[200px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted"
                style={{ borderColor: 'var(--instruction-chip-border)' }}
              >
                <FileText size={10} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate">{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
              </span>
            ))}
          </div>
        )}
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{content}</p>
      </div>
      <div className="hover-actions flex items-center gap-0.5 px-0.5">
        <CopyButton text={content} size={12} />
        {onRevert && (
          <button
            type="button"
            onClick={onRevert}
            title="Revert to this message — rewinds the chat back to here"
            aria-label="Revert to this message"
            className="rounded p-1 text-faint transition-colors hover:text-ink"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

/** A user-run shell command (`!command`/`!!command`, ADR-258) — the `$ cmd` header over a
 *  console-style output panel (the SAME --log-* tokens tool output uses, so it reads as a real
 *  terminal). Renders both a persisted `!` result (from a message's `shell` tool call) and an
 *  ephemeral `!!` result (client-only), identically. */
function CodeShellEntry({ command, output, exitCode, timedOut }: { command: string; output: string; exitCode: number | null; timedOut?: boolean }) {
  const failed = timedOut || (exitCode !== null && exitCode !== 0)
  return (
    <div>
      <div className="flex items-center gap-2 px-1 py-0.5">
        <SquareTerminal size={13} className="shrink-0" style={{ color: failed ? 'var(--err)' : 'var(--muted)' }} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">$ {command}</span>
        {timedOut
          ? <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--err)' }}>timed out</span>
          : failed
            ? <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--err)' }}>exit {exitCode}</span>
            : null}
      </div>
      {output.trim() && <div className="ml-[21px] mb-1 mt-0.5"><CodeOutputPanel text={output} /></div>}
    </div>
  )
}

/** A message the user has submitted that hasn't run yet — the server-side queue's contents,
 *  rendered INLINE at the transcript tail (after the live turn) instead of the old separate
 *  "Queued" chip strip below the composer (the founder read that strip as a bug — a message you
 *  sent seeming to vanish from the conversation). Same right-aligned instruction grammar as
 *  CodeInstructionEntry so it reads as "yours", but translucent + dashed to say "not sent yet",
 *  with a badge distinguishing a queued STEER (will redirect the current turn) from a FOLLOW-UP
 *  (runs after it) — information the old chip never surfaced. Reuses the --instruction-* tokens
 *  (Phase 0) at reduced opacity rather than introducing queue-specific hex. */
function CodeQueuedEntry({ task, kind, onSendNow }: { task: string; kind: SteerKind; onSendNow?: () => void }) {
  const isSteer = kind === 'steer'
  const Badge = isSteer ? CornerDownRight : Clock
  return (
    <div className="tllm-rise-in">
      <div
        className="group ml-auto w-fit max-w-[min(88%,900px)] rounded-lg border border-dashed px-4 py-3 opacity-70"
        style={{ borderColor: 'var(--instruction-chip-border)', background: 'var(--instruction-bg)' }}
      >
        <div className="mb-1.5 flex items-center justify-end">
          <span
            className="inline-flex items-center gap-1 rounded-full border border-dashed px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
            style={{ borderColor: 'var(--instruction-chip-border)' }}
            title={isSteer
              ? 'Queued as a steer — it will redirect the current turn when it runs'
              : 'Queued — it will run as a new turn after the current one finishes'}
          >
            <Badge size={10} className="shrink-0" />
            {isSteer ? 'Steers this turn' : 'Runs next'}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{task}</p>
        {onSendNow && (
          <div className="mt-1 flex items-center justify-end">
            <button
              type="button"
              onClick={onSendNow}
              title="Send now — stop the current run and run this one next"
              className="inline-flex items-center gap-1 rounded p-1 text-[11px] font-medium text-faint transition-colors hover:text-ink"
            >
              <SendHorizontal size={12} /> Send now
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The agent's internal reasoning — monospace/log-toned (it's narration of a
 *  process, closer to "activity" than a final answer), collapsed by default. */
function CodeReasoning({ reasoning, streaming }: { reasoning: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  // `/thinking` (ADR-258) force-opens every reasoning block globally for reviewing a long run; the
  // per-block toggle still works when it's off. `show` is what actually drives the panel.
  const thinkingPref = useDisplayPref('thinking')
  const show = open || thinkingPref
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[11px] text-muted transition-colors hover:text-ink"
      >
        {streaming ? 'reasoning…' : 'reasoning'}
        {streaming && !show && <span className="tllm-pulse">·</span>}
      </button>
      {show && (
        <pre
          className="ml-[21px] mb-1 mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-md px-3 py-2 font-mono text-[11px] leading-relaxed"
          style={{ background: 'var(--log-bg)', color: 'var(--log-faint)' }}
        >
          {reasoning}
        </pre>
      )}
    </div>
  )
}

/** Assistant commentary — plain flowing prose (the normal Markdown renderer
 *  chat uses), deliberately NOT a bubble and NOT monospace: this is the one
 *  piece of the transcript meant to read as "explanation", set apart from the
 *  monospace tool/reasoning entries around it. */
function CodeCommentary({ content, streaming }: { content: string; streaming?: boolean }) {
  if (!content.trim()) return null
  return (
    <div className="group">
      <div className="prose-tllm text-[14px] leading-[1.7] text-ink">
        <Markdown streaming={streaming}>{content}</Markdown>
      </div>
      {!streaming && (
        <div className="hover-actions">
          <CopyButton text={content} size={12} />
        </div>
      )}
    </div>
  )
}

/** Quiet fade + rise on arrival for a persisted transcript entry — deliberately NOT applied to
 *  CodeStreamingEntry's live chunks below, whose index-keyed shape shifts constantly while
 *  tokens stream in; retriggering this on every reflow there would be distracting flicker, not
 *  polish. A finished message mounts once and stays put, so this only ever plays once. */
function CodeMessageEntry({ message, onRevert }: { message: Message; onRevert?: () => void }) {
  if (message.role === 'user') {
    // A persisted `!command` (ADR-258) is a user message carrying a `shell` tool call — render it
    // as a terminal entry, not a chat-style instruction bubble.
    const shell = (message.toolCalls ?? []).find((tc) => tc.name === 'shell')
    if (shell) {
      const args = shell.args as { command?: unknown; exitCode?: unknown; timedOut?: unknown }
      return (
        <div className="tllm-rise-in">
          <CodeShellEntry
            command={typeof args.command === 'string' ? args.command : ''}
            output={shell.result ?? ''}
            exitCode={typeof args.exitCode === 'number' ? args.exitCode : null}
            timedOut={args.timedOut === true}
          />
        </div>
      )
    }
    return (
      <div className="tllm-rise-in">
        <CodeInstructionEntry content={message.content} contextFiles={message.textAttachments} onRevert={onRevert} />
      </div>
    )
  }
  const calls = (message.toolCalls ?? []).map(toRecordCall)
  const isEmpty = !message.content?.trim() && !message.reasoning?.trim() && calls.length === 0
  // Item 6: a message persisted with a real timeline renders in TRUE chronological order — a run
  // of tool calls followed by text followed by another run of tool calls stays three separate
  // blocks in that order, instead of always collapsing into one "all tools, then all text" shape.
  // `timeline` is absent on messages saved before this field existed; those fall back to the
  // pre-fix grouped rendering below (same shape this component has always used).
  const chunks = message.timeline?.length ? chunkPersistedTimeline(message.timeline, message.toolCalls ?? []) : null
  return (
    <div className="tllm-rise-in flex flex-col gap-2">
      {message.reasoning?.trim() && <CodeReasoning reasoning={message.reasoning} />}
      {chunks
        ? chunks.map((c, i) =>
          c.kind === 'text'
            ? <CodeCommentary key={i} content={c.text} />
            : c.kind === 'tools'
              ? <ToolRun key={i} calls={c.calls} />
              : null, // a persisted message never carries live-only turn dividers
        )
        : (
            <>
              {calls.length > 0 && <ToolRun calls={calls} />}
              {message.content?.trim() && <CodeCommentary content={message.content} />}
            </>
          )}
      {isEmpty && (
        <p className="px-1 text-[13px]" style={{ color: 'var(--err)' }}>
          {message.stats.aborted ? 'Run stopped or failed.' : 'No output for this turn.'}
        </p>
      )}
    </div>
  )
}

// Chunk a live SSE timeline into text blocks and RUNS of consecutive tool
// blocks (so a burst of tool calls between two bits of commentary stays a
// contiguous run, live, the same as a finished message's toolCalls array does).
type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: NormalizedCall[] }
  | { kind: 'turn'; index: number }

function chunkTimeline(timeline: LiveBlock[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let i = 0
  while (i < timeline.length) {
    const b = timeline[i]
    if (b.kind === 'text') {
      if (b.text) chunks.push({ kind: 'text', text: b.text })
      i++
      continue
    }
    if (b.kind === 'turn') {
      chunks.push({ kind: 'turn', index: b.index })
      i++
      continue
    }
    const run: NormalizedCall[] = []
    while (i < timeline.length) {
      const cur = timeline[i]
      if (cur.kind !== 'tool') break
      run.push(toLiveCall(cur.call))
      i++
    }
    if (run.length) chunks.push({ kind: 'tools', calls: run })
  }
  return chunks
}

/** The SAME chunking as chunkTimeline (above), for a PERSISTED message's `timeline` (item 6):
 *  walks the ordered text/tool-call blocks a completed turn was saved with, grouping consecutive
 *  tool blocks into one run and starting a fresh run the instant a text block appears — so a tool
 *  call that comes after some text never merges backward into an earlier group, matching the true
 *  order the turn actually ran in rather than a fixed "all tool calls in one group" rendering.
 *  `{type:'tool', id}` blocks are resolved against `toolCalls` by id; a dangling id (shouldn't
 *  happen — both are written together in the same updateMessage call) is skipped rather than
 *  crashing the render. */
function chunkPersistedTimeline(timeline: MessageTimelineBlock[], toolCalls: ToolCallRecord[]): StreamChunk[] {
  const byId = new Map(toolCalls.map((tc) => [tc.id, tc]))
  const chunks: StreamChunk[] = []
  let i = 0
  while (i < timeline.length) {
    const b = timeline[i]
    if (b.type === 'text') {
      if (b.text) chunks.push({ kind: 'text', text: b.text })
      i++
      continue
    }
    const run: NormalizedCall[] = []
    while (i < timeline.length) {
      const cur = timeline[i]
      if (cur.type !== 'tool') break
      const tc = byId.get(cur.id)
      if (tc) run.push(toRecordCall(tc))
      i++
    }
    if (run.length) chunks.push({ kind: 'tools', calls: run })
  }
  return chunks
}

/** The gap between submit and the first token — covers prefill on a cold/long
 *  context, which can run many seconds with zero timeline/reasoning content.
 *  Without this, CodeStreamingEntry renders nothing at all and the turn looks
 *  stuck (chat/MessageBubble.tsx's StreamingBubble has the equivalent
 *  "always-on activity line" for the same reason). `label` distinguishes pi's
 *  auto-compaction (which silently summarizes history mid-turn with no other
 *  signal) from ordinary "no content yet" — same spinner, different text, so a
 *  long compaction pause doesn't read as a stuck/dead run. */
function CodeThinking({ label = 'thinking…', tone = 'accent' }: { label?: string; tone?: 'accent' | 'warn' }) {
  return (
    <div className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-muted">
      <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)' }} />
      <span>{label}</span>
    </div>
  )
}

/** Prompt-processing (prefill) progress before the first token — llama.cpp only, polled off the
 *  engine's /slots (see LiveState.prefill). Deliberately the SAME compact "Processing prompt NN%"
 *  line + real 3px --accent progress bar chat already uses (MessageBubble.tsx), reused rather than
 *  inventing a second visual language for the identical concept. Sits in the status-banner slot and
 *  clears itself the instant the first token arrives, so it never co-renders with the
 *  retry/compacting/thinking placeholder. */
function CodePrefill({ prefill }: { prefill: { processed: number; total: number; pct: number } }) {
  return (
    <div className="space-y-1 px-1">
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
        <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
        <span>Processing prompt</span>
        <span className="font-medium text-ink">{prefill.pct}%</span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
        <div
          className="h-full rounded-full transition-all duration-200"
          style={{ width: `${prefill.pct}%`, background: 'var(--accent)' }}
        />
      </div>
    </div>
  )
}

/** A subtle divider between agentic rounds within one live assistant turn (Phase 2, ADR-249) —
 *  just a thin tokenized rule, deliberately low-weight (this is grouping, not a hard section
 *  break). Live-only: a persisted turn has no round markers, so the finished transcript reads as
 *  one continuous log. No "Round N" text label (dropped per founder feedback, 2026-07-24 — the
 *  line alone is the grouping signal; a literal round counter read as unwanted clutter). `index`
 *  stays a param even though it's now unused for display, so the call site doesn't need to change
 *  if a label (e.g. a tooltip) is ever wanted back. */
function TurnDivider({ index: _index }: { index: number }) {
  return <span className="block h-px" style={{ background: 'var(--border)' }} aria-hidden />
}

const TODO_STATUS_COLOR: Record<TodoItem['status'], string> = {
  pending: 'var(--faint)',
  in_progress: 'var(--accent)',
  completed: 'var(--ok)',
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <CheckCircle2 size={12} className="mt-0.5 shrink-0" style={{ color: TODO_STATUS_COLOR.completed }} />
  if (status === 'in_progress') return <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" style={{ color: TODO_STATUS_COLOR.in_progress }} />
  return <Circle size={12} className="mt-0.5 shrink-0" style={{ color: TODO_STATUS_COLOR.pending }} />
}

/** The model's own plan for the CURRENT live turn (ADR-255, `update_todos`) — a compact
 *  checklist, not another chat-style card: a quiet header ("Plan · N/total") over a plain list,
 *  same visual weight as CodeReasoning/CodeThinking rather than a heavier new pattern. Ephemeral
 *  and live-only by design (the backend never persists todos past a turn, and resets them at the
 *  start of every new one — see LiveState.todos's doc comment) — renders nothing once `todos` is
 *  empty/undefined, so a finished turn's transcript entry never carries a stale plan.
 *  Pinned above the composer by CodeSessionScreen.tsx, NOT rendered inline in the scrolling
 *  transcript (founder feedback, 2026-07-24: a plan you have to scroll to find isn't a plan) —
 *  exported so the screen can render it directly, outside CodeStreamingEntry. */
export function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  // Flat (ADR-262) — no bordered card / bg-panel-2 header. A quiet "Plan · N/total" header line
  // (same weight as the reasoning label / a CodeToolLine) over a plain list, so it reads as part of
  // the flat log rather than a floating card. The pinned band CodeSessionScreen.tsx wraps it in
  // provides the separation from the transcript/composer, so this component adds none of its own.
  return (
    <div>
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] font-medium text-muted">
        <ListChecks size={12} className="shrink-0" />
        <span>Plan</span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-faint">{done}/{todos.length}</span>
      </div>
      <ul className="flex flex-col gap-1 px-1 pt-0.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[12px] leading-snug">
            <TodoStatusIcon status={t.status} />
            <span className={cn(t.status === 'completed' ? 'text-faint line-through' : t.status === 'in_progress' ? 'text-ink' : 'text-muted')}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CodeStreamingEntry({
  timeline, reasoning, compacting, retry, prefill,
}: {
  timeline: LiveBlock[]
  reasoning: string
  compacting?: boolean
  retry?: RetryState | null
  prefill?: { processed: number; total: number; pct: number } | null
}) {
  const chunks = chunkTimeline(timeline)
  const hasContent = !!reasoning?.trim() || chunks.length > 0
  return (
    <div className="flex flex-col gap-2">
      {reasoning?.trim() && <CodeReasoning reasoning={reasoning} streaming />}
      {chunks.map((c, i) =>
        c.kind === 'text'
          ? <CodeCommentary key={i} content={c.text} streaming />
          : c.kind === 'turn'
            ? <TurnDivider key={i} index={c.index} />
            : <ToolRun key={i} calls={c.calls} />,
      )}
      {/* One shared status-banner slot (ADR-250). Prefill happens strictly BEFORE generation begins,
          so it wins the slot while active; it self-clears at the first token (backend stops firing
          the frames, and the reducer nulls it on the first delta/reasoning), handing back to the
          existing retry > compacting > thinking priority. So no two of these ever co-render. */}
      {prefill
        ? <CodePrefill prefill={prefill} />
        : retry
          ? <CodeThinking tone="warn" label={`Retrying… attempt ${retry.attempt} of ${retry.maxAttempts}${retry.message ? ` — ${retry.message}` : ''}`} />
          : compacting
            ? <CodeThinking label="Compacting conversation…" />
            : !hasContent && <CodeThinking />}
    </div>
  )
}

export function CodeTranscript({
  messages, liveAssistantId, live, onRevert, queued, onSendNowQueued, shellRuns,
}: {
  messages: Message[]
  liveAssistantId?: string
  live?: { timeline: LiveBlock[]; reasoning: string; compacting?: boolean; retry?: RetryState | null; prefill?: { processed: number; total: number; pct: number } | null } | null
  /** Revert affordance on each user message — omitted entirely (via `undefined`) while a run
   *  is live, and never shown on the FIRST message (nothing before it to revert to; `messages`
   *  here is already cut at any existing /clear point, so index 0 is always correct). */
  onRevert?: (messageId: string) => void
  /** The server-side message queue (turns waiting behind the active run), rendered inline as
   *  translucent cards at the tail — AFTER the live turn, in send order — never interleaved above
   *  it (the ADR-199 ordering invariant; the caller has already excluded these from `messages`). */
  queued?: QueuedTurn[]
  /** "Send now" on a queued card — stops the active turn and promotes this one to run next.
   *  Omitted disables the affordance (the card still renders). */
  onSendNowQueued?: (userMsgId: string) => void
  /** Transcript-only `!!command` results (ADR-258) — client-only, rendered at the very tail. A `!`
   *  result is NOT here; it's a persisted message rendered inline by CodeMessageEntry. */
  shellRuns?: ShellRun[]
}) {
  // Flat, rail-less log (ADR-262): a plain vertical stack. Ordering is load-bearing — persisted
  // messages, then the live turn, then queued cards, then transcript-only shell peeks. The live
  // turn is ALWAYS rendered before the queued cards, so a queued follow-up never appears above the
  // still-streaming turn (the ADR-199 invariant; `messages` is already cut at the live boundary and
  // has queued ids removed by the caller, so a queued turn renders exactly once, here at the tail).
  return (
    <div className="flex flex-col gap-3">
      {messages
        .filter((m) => m.id !== liveAssistantId)
        .map((m, i) => (
          <CodeMessageEntry
            key={m.id}
            message={m}
            onRevert={onRevert && !live && i > 0 && m.role === 'user' ? () => onRevert(m.id) : undefined}
          />
        ))}
      {live && (
        <CodeStreamingEntry timeline={live.timeline} reasoning={live.reasoning} compacting={live.compacting} retry={live.retry} prefill={live.prefill} />
      )}
      {queued?.map((q) => (
        <CodeQueuedEntry
          key={q.userMsgId}
          task={q.task}
          kind={q.kind ?? 'followUp'}
          onSendNow={onSendNowQueued ? () => onSendNowQueued(q.userMsgId) : undefined}
        />
      ))}
      {shellRuns?.map((s) => (
        <div key={s.id} className="tllm-rise-in">
          <CodeShellEntry command={s.command} output={s.output} exitCode={s.exitCode} timedOut={s.timedOut} />
        </div>
      ))}
    </div>
  )
}

/** Loading placeholder for a session's FIRST load (before any real data has arrived) — a
 *  right-aligned instruction placeholder + a couple of activity lines, matching the flat
 *  transcript's own shape (spec 11 §8: never a bare spinner/blank void). Not used for
 *  reconnects/refetches, only the initial GET. */
export function CodeTranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="ml-auto w-fit max-w-[min(88%,900px)] rounded-lg border border-border px-4 py-3">
        <Skeleton className="h-3.5 w-64" />
      </div>
      <div className="flex flex-col gap-2 px-1">
        <Skeleton className="h-3.5 w-[80%]" />
        <Skeleton className="h-3.5 w-[55%]" />
      </div>
    </div>
  )
}

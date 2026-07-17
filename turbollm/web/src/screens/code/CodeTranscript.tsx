import { useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileText,
  FolderTree,
  HelpCircle,
  Layers,
  Loader2,
  RotateCcw,
  Search,
  SquareTerminal,
  Terminal,
  XCircle,
} from 'lucide-react'
import type { LiveToolCall, Message, MessageTimelineBlock, ToolCallRecord } from '../../lib/chat-types'
import type { LiveBlock } from '../../lib/live-timeline'
import { friendlyName } from '../../lib/tool-explain'
import { cn } from '../../lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { CopyButton } from '../../components/ui/copy-button'
import { Skeleton } from '../../components/ui/skeleton'
import { Markdown } from '../chat/MessageBubble'

// ── Code session transcript ──────────────────────────────────────────────────
//
// A DELIBERATELY different visual language from chat/MessageBubble.tsx's bubbles
// — built after the founder's own critique: "when I start chatting, it feels
// like a chat and not code. I can't feel the diff between the two." Same real
// data (genuine diffs/tool calls/reasoning/text off the SSE stream, nothing
// faked) presented as an activity log instead of a conversation:
//   - a vertical rail connects entries (build-log / commit-graph grammar, not a
//     left/right message stack)
//   - the user's task/follow-ups render as an instruction callout, not a chat
//     bubble aimed at "you"
//   - tool calls are the PRIMARY visual unit — a real file-path header, and for
//     edits, a two-gutter line-numbered diff panel, not a small card nested
//     inside a bubble
//   - a RUN of 2+ consecutive tool calls collapses into one scannable summary
//     ("5 tool calls · 3 edits · 2 reads") instead of a wall of cards — click it
//     to open a side panel (the same Sheet primitive/pattern ContextUsageRing.tsx
//     already uses) listing every call, each individually expandable to its full
//     detail. A lone tool call still renders inline in full, since there's
//     nothing to declutter for just one.
//   - assistant prose is commentary between actions — plain flowing text with a
//     small marker, not another bubble
//   - tool output/diffs use the SAME near-black log-panel tokens
//     (--log-bg/--log-ink) EngineLogPanel.tsx already uses for terminal output,
//     so it reads as "console", and reasoning gets the same monospace treatment
//     (it's the agent's internal narration, not its final answer) — while
//     commentary stays in the app's normal prose type, so the eye can tell
//     "code/activity" from "explanation" at a glance, per the founder's own
//     suggestion.
// Carries the launchpad's own identity through rather than dropping it the
// moment a task starts: SquareTerminal marks the task entry (same icon
// CodeHomeScreen/the sidebar use for Code mode throughout), and the accent
// token colors the rail's active/in-progress states.

type ToolStatus = 'pending' | 'done' | 'error' | 'awaiting_approval'

interface NormalizedCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  result?: string
  diff?: string
}

function toRecordCall(tc: ToolCallRecord): NormalizedCall {
  return { id: tc.id, name: tc.name, args: tc.args, status: tc.error ? 'error' : 'done', result: tc.error ?? tc.result, diff: tc.diff }
}
function toLiveCall(tc: LiveToolCall): NormalizedCall {
  return { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result, diff: tc.diff }
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

/** A one-word kind used for the group summary's breakdown ("3 edits · 2 reads"). */
function toolKind(name: string): 'edit' | 'write' | 'command' | 'read' | 'search' | 'listing' | 'call' {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (BASH_TOOLS.has(name)) return 'command'
  if (READ_TOOLS.has(name)) return 'read'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (name === 'ls') return 'listing'
  return 'call'
}
const KIND_PLURAL: Record<string, string> = {
  edit: 'edits', write: 'writes', command: 'commands', read: 'reads', search: 'searches', listing: 'listings', call: 'calls',
}
/** Present-participle verb for the group summary's live "what's happening now" line. */
const KIND_VERB: Record<string, string> = {
  edit: 'Editing', write: 'Writing', command: 'Running', read: 'Reading', search: 'Searching', listing: 'Listing', call: 'Calling',
}

/** A file-taking tool's `path` arg, for a card's header — falls back to the
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
const STATUS_LABEL: Record<ToolStatus, string> = {
  pending: 'Running',
  done: 'Done',
  error: 'Error',
  awaiting_approval: 'Awaiting approval',
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'pending') return <Loader2 size={13} className="shrink-0 animate-spin" style={{ color: STATUS_COLOR.pending }} />
  if (status === 'done') return <CheckCircle2 size={13} className="shrink-0" style={{ color: STATUS_COLOR.done }} />
  if (status === 'error') return <XCircle size={13} className="shrink-0" style={{ color: STATUS_COLOR.error }} />
  return <HelpCircle size={13} className="shrink-0" style={{ color: STATUS_COLOR.awaiting_approval }} />
}

/** Count +/- lines for the header's compact stat chip (skips the +++/--- file
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
 *  pi's own diff output (turbollm/src/code/code-session.ts). */
function CodeDiffPanel({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n')
  let oldLine = 0
  let newLine = 0
  return (
    <div className="max-h-[420px] overflow-auto border-t border-border">
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
                    style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
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
              ? 'color-mix(in srgb, var(--ok) 10%, transparent)'
              : isDel
                ? 'color-mix(in srgb, var(--err) 10%, transparent)'
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
 *  this reads as a console, not a chat attachment. */
function CodeOutputPanel({ text }: { text: string }) {
  const truncated = text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text
  return (
    <div className="max-h-80 overflow-auto border-t border-border" style={{ background: 'var(--log-bg)' }}>
      <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[12px] leading-relaxed" style={{ color: 'var(--log-ink)' }}>
        {truncated || <span style={{ color: 'var(--log-faint)' }}>(no output)</span>}
      </pre>
    </div>
  )
}

/** The primary visual unit for a LONE tool call — a real file/command header
 *  (monospace, like an editor tab) over either a diff panel (edit) or a
 *  console-style output panel (everything else). Edits/writes start expanded
 *  (they ARE the point of a code session); reads/searches/bash start collapsed
 *  (useful, but not the headline). Only rendered for runs of exactly one call —
 *  2+ in a row collapse into ToolCallGroup below instead. */
function CodeToolCard({ call }: { call: NormalizedCall }) {
  const Icon = toolIcon(call.name)
  const label = toolLabel(call.name, call.args)
  const hasDiff = !!call.diff?.trim()
  const hasOutput = !!call.result?.length || hasDiff
  const [expanded, setExpanded] = useState(hasDiff)
  const stats = hasDiff ? diffStats(call.diff!) : null

  return (
    <div
      className="overflow-hidden rounded-lg border"
      style={call.status === 'awaiting_approval'
        ? { borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 6%, transparent)' }
        : { borderColor: 'var(--border)' }}
    >
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((e) => !e)}
        disabled={!hasOutput}
        className="flex w-full items-center gap-2 bg-panel-2 px-3 py-1.5 text-left disabled:cursor-default"
      >
        <Icon size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{label}</span>
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span style={{ color: 'var(--ok)' }}>+{stats.add}</span>{' '}
            <span style={{ color: 'var(--err)' }}>&minus;{stats.del}</span>
          </span>
        )}
        <StatusIcon status={call.status} />
      </button>
      {expanded && hasDiff && <CodeDiffPanel diff={call.diff!} />}
      {expanded && !hasDiff && call.result && <CodeOutputPanel text={call.result} />}
    </div>
  )
}

/** One row inside the group side panel — richer than CodeToolCard: also shows
 *  raw arguments and a spelled-out status, since this is the "full detail" view
 *  the compact summary exists to keep out of the main transcript. */
function ToolCallDetailRow({ call }: { call: NormalizedCall }) {
  const [expanded, setExpanded] = useState(false)
  const Icon = toolIcon(call.name)
  const label = toolLabel(call.name, call.args)
  const hasArgs = call.args && Object.keys(call.args).length > 0
  const hasDiff = !!call.diff?.trim()

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 bg-panel-2 px-3 py-2 text-left"
      >
        <Icon size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{label}</span>
        <span className="shrink-0 text-[11px] font-medium" style={{ color: STATUS_COLOR[call.status] }}>{STATUS_LABEL[call.status]}</span>
        <ChevronDown size={12} className={cn('shrink-0 text-faint transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="border-t border-border">
          {hasArgs && (
            <div className="border-b border-border px-3 py-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Arguments</div>
              <pre className="overflow-auto font-mono text-[11px] leading-relaxed text-muted">{JSON.stringify(call.args, null, 2)}</pre>
            </div>
          )}
          {hasDiff ? (
            <CodeDiffPanel diff={call.diff!} />
          ) : call.result ? (
            <CodeOutputPanel text={call.result} />
          ) : (
            <div className="px-3 py-2 text-[12px] text-faint">No output.</div>
          )}
        </div>
      )}
    </div>
  )
}

/** A run of 2+ consecutive tool calls: one scannable summary row in the main
 *  transcript ("5 tool calls · 3 edits · 2 reads"), click to open a side panel
 *  (same Sheet primitive ContextUsageRing.tsx uses) listing every call in the
 *  run, each individually expandable to its full detail. */
function ToolCallGroup({ calls, batchTime }: { calls: NormalizedCall[]; batchTime?: string }) {
  const [open, setOpen] = useState(false)
  const errorCount = calls.filter((c) => c.status === 'error').length
  const pendingCount = calls.filter((c) => c.status === 'pending' || c.status === 'awaiting_approval').length
  const overallColor = pendingCount > 0 ? STATUS_COLOR.pending : errorCount > 0 ? STATUS_COLOR.error : STATUS_COLOR.done
  // The most recently STARTED call that hasn't finished yet — calls run in order, so this
  // is the one actually executing right now, not necessarily the first one in the array.
  const activeCall = [...calls].reverse().find((c) => c.status === 'pending' || c.status === 'awaiting_approval')

  const counts = new Map<string, number>()
  for (const c of calls) {
    const k = toolKind(c.name)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const breakdown = [...counts.entries()].map(([k, n]) => `${n} ${n === 1 ? k : KIND_PLURAL[k]}`).join(' · ')
  // While something's actively running, lead with WHAT it's doing (the thing you can't see
  // otherwise until it's done) rather than a static count; falls back to the count once idle.
  const summary = activeCall
    ? `${KIND_VERB[toolKind(activeCall.name)]} ${toolLabel(activeCall.name, activeCall.args)}…`
    : `${calls.length} tool calls · ${breakdown}`

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-left transition-colors hover:border-border-strong"
      >
        <div className="flex -space-x-1.5">
          {calls.slice(-3).map((c, i) => {
            const Icon = toolIcon(c.name)
            return (
              <span key={c.id} className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 bg-panel" style={{ borderColor: 'var(--panel-2)', zIndex: 3 - i }}>
                <Icon size={10} className="text-muted" />
              </span>
            )
          })}
        </div>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{summary}</span>
        {pendingCount > 0
          ? <Loader2 size={13} className="shrink-0 animate-spin" style={{ color: overallColor }} />
          : <StatusIcon status={errorCount > 0 ? 'error' : 'done'} />}
        <ChevronRight size={13} className="shrink-0 text-faint" />
      </button>

      <Sheet open={open} onOpenChange={setOpen} modal={false}>
        <SheetContent className="overflow-y-auto p-5">
          <SheetHeader>
            <SheetTitle>{calls.length} tool calls</SheetTitle>
            <SheetDescription>
              {breakdown}{batchTime ? ` · ${new Date(batchTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : pendingCount > 0 ? ' · in progress' : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-3 flex flex-col gap-2">
            {calls.map((c) => <ToolCallDetailRow key={c.id} call={c} />)}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** Renders a run of tool calls as either a single full card (1 call) or a
 *  collapsed group summary + side panel (2+). */
function ToolRun({ calls, batchTime }: { calls: NormalizedCall[]; batchTime?: string }) {
  if (calls.length === 0) return null
  if (calls.length === 1) return <CodeToolCard call={calls[0]} />
  return <ToolCallGroup calls={calls} batchTime={batchTime} />
}

function runTone(calls: NormalizedCall[]): 'accent' | 'ok' | 'err' {
  if (calls.some((c) => c.status === 'pending' || c.status === 'awaiting_approval')) return 'accent'
  if (calls.some((c) => c.status === 'error')) return 'err'
  return 'ok'
}
function runIcon(calls: NormalizedCall[]) {
  return calls.length === 1 ? toolIcon(calls[0].name) : Layers
}

/** The user's task (session-starting prompt or a follow-up "steer"). No label —
 *  right-aligned, pushed to the far side of the rail (`ml-auto`), width-capped
 *  the same way chat's own user bubble is (`min(88%,900px)`, see MessageBubble.tsx)
 *  so alone that's enough to read as "yours" against the agent's left-aligned
 *  activity, without a heading or reverting to full chat-bubble chrome. */
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
    <div
      className="group ml-auto w-fit max-w-[min(88%,900px)] rounded-lg border px-4 py-3"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--border))', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}
    >
      {!!contextFiles?.length && (
        <div className="mb-2 flex flex-wrap justify-end gap-1.5">
          {contextFiles.map((p) => (
            <span
              key={p}
              title={p}
              className="inline-flex max-w-[200px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted"
              style={{ borderColor: 'color-mix(in srgb, var(--accent) 25%, var(--border))' }}
            >
              <FileText size={10} className="shrink-0 text-faint" />
              <span className="min-w-0 truncate">{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
            </span>
          ))}
        </div>
      )}
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{content}</p>
      <div className="hover-actions mt-1 flex items-center justify-end gap-0.5">
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

/** The agent's internal reasoning — monospace/log-toned (it's narration of a
 *  process, closer to "activity" than a final answer), collapsed by default. */
function CodeReasoning({ reasoning, streaming }: { reasoning: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 bg-panel-2 px-3 py-1.5 text-left font-mono text-[11px] text-muted hover:text-ink"
      >
        {streaming ? 'reasoning…' : 'reasoning'}
        {streaming && !open && <span className="tllm-pulse">·</span>}
      </button>
      {open && (
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed"
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

/** One rail entry: a marker icon anchored on the vertical line, the content to
 *  its right. `tone` picks the marker's ring/icon color. */
function RailEntry({ icon: Icon, tone = 'muted', children }: { icon: typeof SquareTerminal; tone?: 'accent' | 'muted' | 'ok' | 'err'; children: React.ReactNode }) {
  const color = tone === 'accent' ? 'var(--accent)' : tone === 'ok' ? 'var(--ok)' : tone === 'err' ? 'var(--err)' : 'var(--faint)'
  return (
    <div className="relative">
      <div
        className="absolute -left-[25px] top-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border bg-panel"
        style={{ borderColor: color, color }}
      >
        <Icon size={10} />
      </div>
      {children}
    </div>
  )
}

/** Quiet fade + rise on arrival for a persisted transcript entry — deliberately NOT applied to
 *  CodeStreamingEntry's live chunks below, whose index-keyed shape shifts constantly while
 *  tokens stream in; retriggering this on every reflow there would be distracting flicker, not
 *  polish. A finished message mounts once and stays put, so this only ever plays once. */
function CodeMessageEntry({ message, onRevert }: { message: Message; onRevert?: () => void }) {
  if (message.role === 'user') {
    return (
      <div className="tllm-rise-in">
        <RailEntry icon={SquareTerminal} tone="accent">
          <CodeInstructionEntry content={message.content} contextFiles={message.textAttachments} onRevert={onRevert} />
        </RailEntry>
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
    <div className="tllm-rise-in flex flex-col gap-3">
      {message.reasoning?.trim() && (
        <RailEntry icon={Terminal}>
          <CodeReasoning reasoning={message.reasoning} />
        </RailEntry>
      )}
      {chunks
        ? chunks.map((c, i) =>
          c.kind === 'text'
            ? (
                <RailEntry key={i} icon={SquareTerminal}>
                  <CodeCommentary content={c.text} />
                </RailEntry>
              )
            : (
                <RailEntry key={i} icon={runIcon(c.calls)} tone={runTone(c.calls)}>
                  <ToolRun calls={c.calls} batchTime={message.createdAt} />
                </RailEntry>
              ),
        )
        : (
            <>
              {calls.length > 0 && (
                <RailEntry icon={runIcon(calls)} tone={runTone(calls)}>
                  <ToolRun calls={calls} batchTime={message.createdAt} />
                </RailEntry>
              )}
              {message.content?.trim() && (
                <RailEntry icon={SquareTerminal}>
                  <CodeCommentary content={message.content} />
                </RailEntry>
              )}
            </>
          )}
      {isEmpty && (
        <RailEntry icon={XCircle} tone="err">
          <p className="text-[13px]" style={{ color: 'var(--err)' }}>
            {message.stats.aborted ? 'Run stopped or failed.' : 'No output for this turn.'}
          </p>
        </RailEntry>
      )}
    </div>
  )
}

// Chunk a live SSE timeline into text blocks and RUNS of consecutive tool
// blocks (so a burst of tool calls between two bits of commentary collapses
// into one group, live, the same as a finished message's toolCalls array does).
type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: NormalizedCall[] }

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
    const run: NormalizedCall[] = []
    while (i < timeline.length) {
      const cur = timeline[i]
      if (cur.kind !== 'tool') break
      run.push(toLiveCall(cur.call))
      i++
    }
    chunks.push({ kind: 'tools', calls: run })
  }
  return chunks
}

/** The SAME chunking as chunkTimeline (above), for a PERSISTED message's `timeline` (item 6):
 *  walks the ordered text/tool-call blocks a completed turn was saved with, grouping consecutive
 *  tool blocks into one run and starting a fresh run the instant a text block appears — so a tool
 *  call that comes after some text never merges backward into an earlier group, matching the true
 *  order the turn actually ran in rather than today's fixed "all tool calls in one group"
 *  rendering. `{type:'tool', id}` blocks are resolved against `toolCalls` by id; a dangling id
 *  (shouldn't happen — both are written together in the same updateMessage call) is skipped
 *  rather than crashing the render. */
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
function CodeThinking({ label = 'thinking…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
      <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
      <span>{label}</span>
    </div>
  )
}

function CodeStreamingEntry({ timeline, reasoning, compacting }: { timeline: LiveBlock[]; reasoning: string; compacting?: boolean }) {
  const chunks = chunkTimeline(timeline)
  const hasContent = !!reasoning?.trim() || chunks.length > 0
  return (
    <div className="flex flex-col gap-3">
      {reasoning?.trim() && (
        <RailEntry icon={Terminal} tone="accent">
          <CodeReasoning reasoning={reasoning} streaming />
        </RailEntry>
      )}
      {chunks.map((c, i) =>
        c.kind === 'text'
          ? (
              <RailEntry key={i} icon={SquareTerminal} tone="accent">
                <CodeCommentary content={c.text} streaming />
              </RailEntry>
            )
          : (
              <RailEntry key={i} icon={runIcon(c.calls)} tone={runTone(c.calls)}>
                <ToolRun calls={c.calls} />
              </RailEntry>
            ),
      )}
      {compacting
        ? (
            <RailEntry icon={Terminal} tone="accent">
              <CodeThinking label="Compacting conversation…" />
            </RailEntry>
          )
        : !hasContent && (
            <RailEntry icon={Terminal} tone="accent">
              <CodeThinking />
            </RailEntry>
          )}
    </div>
  )
}

export function CodeTranscript({
  messages, liveAssistantId, live, onRevert,
}: {
  messages: Message[]
  liveAssistantId?: string
  live?: { timeline: LiveBlock[]; reasoning: string; compacting?: boolean } | null
  /** Revert affordance on each user message — omitted entirely (via `undefined`) while a run
   *  is live, and never shown on the FIRST message (nothing before it to revert to; `messages`
   *  here is already cut at any existing /clear point, so index 0 is always correct). */
  onRevert?: (messageId: string) => void
}) {
  return (
    <div className="relative flex flex-col gap-5 pl-8">
      {/* The rail — a continuous line behind every marker, build-log grammar
          instead of a left/right bubble stack. */}
      <div className="absolute left-[2px] top-2 bottom-2 w-px" style={{ background: 'var(--border)' }} aria-hidden />
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
        <CodeStreamingEntry timeline={live.timeline} reasoning={live.reasoning} compacting={live.compacting} />
      )}
    </div>
  )
}

/** Loading placeholder for a session's FIRST load (before any real data has arrived) — matches
 *  the transcript's own rail language (marker + content block) rather than a bare spinner or
 *  blank space, per spec 11 §8. Not used for reconnects/refetches, only the initial GET. */
export function CodeTranscriptSkeleton() {
  return (
    <div className="relative flex flex-col gap-5 pl-8">
      <div className="absolute left-[2px] top-2 bottom-2 w-px" style={{ background: 'var(--border)' }} aria-hidden />
      <div className="relative">
        <div className="absolute -left-[25px] top-0.5 h-5 w-5 shrink-0 rounded-full">
          <Skeleton className="h-full w-full rounded-full" />
        </div>
        <div className="ml-auto w-fit max-w-[min(88%,900px)] rounded-lg border border-border px-4 py-3">
          <Skeleton className="h-3.5 w-64" />
        </div>
      </div>
      <div className="relative flex flex-col gap-2">
        <div className="absolute -left-[25px] top-0.5 h-5 w-5 shrink-0 rounded-full">
          <Skeleton className="h-full w-full rounded-full" />
        </div>
        <Skeleton className="h-3.5 w-[80%]" />
        <Skeleton className="h-3.5 w-[55%]" />
      </div>
    </div>
  )
}

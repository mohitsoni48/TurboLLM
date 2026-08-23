import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, FileText, HelpCircle, Loader2, Pencil, RefreshCw, Trash2, XCircle } from 'lucide-react'
import type { ClaimVerdict, LiveToolCall, Message, MessageStats, ResearchMeta, ResearchSource, ToolCallRecord } from '../../lib/chat-types'
import type { LiveBlock } from '../../lib/live-timeline'
import { activateVariant, getMessageVariants } from '../../lib/chat-api'
import { Button } from '../../components/ui/button'
import { CopyButton } from '../../components/ui/copy-button'
import { ArtifactCard, isArtifactLang } from '../../components/ArtifactCard'
import { isRoutineConfirmTool, isSupersededUpdatePreview, RoutineConfirmToolCard } from '../../components/routines/RoutineConfirmToolCard'
import { friendlyName } from '../../lib/tool-explain'
import { track } from '../../lib/api'

// ── Thinking block ────────────────────────────────────────────────────────────

function ThinkingBlock({ reasoning, thinkMs, streaming, showThinking = true }: { reasoning: string; thinkMs?: number; streaming?: boolean; showThinking?: boolean }) {
  // Always collapsed by default; expands into a fixed-height scroll window so long
  // reasoning never balloons the chat.
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (open && streaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [reasoning, open, streaming])
  const label = thinkMs ? `Thought for ${(thinkMs / 1000).toFixed(1)}s` : streaming ? 'Thinking…' : 'Thinking'
  // When thinking is globally hidden, show only the stats line (no expand toggle).
  if (!showThinking) {
    return (
      <div className="mb-3 text-[12px] font-medium text-faint px-0 py-0.5">
        {label}
      </div>
    )
  }
  return (
    <div className="mb-3 rounded-lg border border-border bg-panel-2">
      <button
        type="button"
        onClick={() => { track('chat', 'toggle_thinking_block'); setOpen((o) => !o) }}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-muted hover:text-ink"
      >
        <ChevronDown size={13} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        {label}
        {streaming && !open && <span className="tllm-pulse ml-0.5">·</span>}
      </button>
      {open && (
        <pre
          ref={scrollRef}
          className="max-h-48 overflow-auto px-3 pb-3 font-mono text-[12px] leading-relaxed text-muted whitespace-pre-wrap"
        >
          {reasoning}
        </pre>
      )}
    </div>
  )
}

// ── Stats row ─────────────────────────────────────────────────────────────────

function StatsRow({ stats }: { stats: Partial<MessageStats> }) {
  const parts: string[] = []
  if (stats.tps)          parts.push(`${stats.tps.toFixed(1)} tok/s`)
  if (stats.promptTps)    parts.push(`${stats.promptTps.toFixed(0)} tok/s prefill`)
  if (stats.ttftMs != null && stats.ttftMs > 0) parts.push(`${(stats.ttftMs / 1000).toFixed(2)}s TTFT`)
  if (stats.promptTokens != null && stats.genTokens != null) parts.push(`${stats.promptTokens}+${stats.genTokens} tokens`)
  if (stats.cachedTokens != null && stats.cachedTokens > 0) {
    const pct = stats.promptTokens ? Math.round((stats.cachedTokens / stats.promptTokens) * 100) : 0
    parts.push(`${stats.cachedTokens} cached${pct ? ` (${pct}%)` : ''}`)
  }
  if (stats.totalMs)      parts.push(`${(stats.totalMs / 1000).toFixed(1)}s total`)

  if (!parts.length) return null

  const tooltip = [
    stats.model       ? `Model: ${stats.model}` : '',
    stats.promptMs    ? `Prefill: ${stats.promptMs.toFixed(0)}ms` : '',
    stats.genMs       ? `Gen: ${stats.genMs.toFixed(0)}ms` : '',
    stats.ctxUsed != null ? `Context: ${stats.ctxUsed} / ${stats.ctxMax}` : '',
    stats.aborted     ? 'Aborted' : '',
  ].filter(Boolean).join('\n')

  return (
    <div className="mt-2 text-[11px] text-faint" title={tooltip}>
      {parts.join(' · ')}
      {stats.aborted && <span className="ml-2" style={{ color: 'var(--warn)' }}>· aborted</span>}
    </div>
  )
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

/** Reconstruct raw text from a markdown code block's children. `rehypeHighlight`
 *  tokenizes code into nested <span> elements, so `children` is a React node tree,
 *  not a string — `String(children)` yields "[object Object]". Walk it to get the
 *  original source back (highlight.js wraps text, never drops characters). */
function childrenToString(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(childrenToString).join('')
  if (typeof node === 'object' && 'props' in node) {
    return childrenToString((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

// Exported (in addition to the default export usage below) so CodeTranscript.tsx
// can render assistant prose with the exact same renderer chat uses, rather than
// a second markdown pipeline — Code mode's commentary is genuinely the same kind
// of content chat's is, just presented in a different frame around it.
export const Markdown = memo(function Markdown({ children, streaming }: { children: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ children, href }) => (
          // Styling comes entirely from the unlayered .prose-tllm a rules (index.css);
          // this override exists only to force new-tab + noopener on every link.
          <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
        ),
        code: ({ className, children, ...props }) => {
          // A fenced block without a language tag has no className — detect it by
          // checking for a trailing newline, which react-markdown always appends to
          // block code. Inline code never contains newlines in practice.
          const hasLang = !!className?.includes('language-')
          const isBlock = hasLang || (typeof children === 'string' && children.includes('\n'))
          if (!isBlock) return <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.88em]" {...props}>{children}</code>
          // rehypeHighlight rewrites the class to "hljs language-html", so a plain
          // `.replace('language-','')` leaves "hljs html" and breaks artifact detection.
          // Pull just the language token out of whatever classes are present.
          const lang = className?.match(/language-(\S+)/)?.[1] ?? ''
          const artifactType = isArtifactLang(lang)
          if (artifactType) {
            // While the message is still streaming, the artifact code is partial and
            // re-parsed every token — rendering the live iframe makes it flicker. Show
            // a calm placeholder; the real preview mounts once when generation finishes.
            if (streaming) {
              return (
                <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  Generating artifact…
                </div>
              )
            }
            return <ArtifactCard lang={lang} code={childrenToString(children).replace(/\n$/, '')} />
          }
          return (
            <div className="relative my-2 overflow-hidden rounded-md border border-border bg-[var(--code-bg)]">
              <div className="flex items-center justify-between border-b border-border bg-panel-2 px-3 py-1 font-mono text-[12px] text-muted">
                <span>{lang}</span>
                <CopyButton text={childrenToString(children)} size={12} screen="chat" />
              </div>
              <div className="overflow-x-auto overscroll-x-contain" onScroll={e => e.stopPropagation()}>
                <code className={`${className ?? ''} block p-3 font-mono text-[13px] leading-relaxed whitespace-pre`} {...props}>{children}</code>
              </div>
            </div>
          )
        },
        pre: ({ children }) => <>{children}</>,
        // Borders/padding/font-size/weight for table cells come from the unlayered
        // .prose-tllm table/th/td rules (index.css) — only what prose doesn't set
        // stays here: the scroll wrapper, full width, header tint, left-aligned th
        // (UA default centers th). td needs no override at all anymore.
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="w-full text-[13px]">{children}</table></div>,
        th: ({ children }) => <th className="bg-panel-2 text-left">{children}</th>,
      }}
    >
      {children}
    </ReactMarkdown>
  )
})

// ── Tool call cards ───────────────────────────────────────────────────────────

type CardCall = {
  id: string
  name: string
  /** The tool call's INPUT parameters, as the model sent them. Carried because the routine
   *  confirm gate reads `args.routineId` off an `update_routine` call — see
   *  RoutineConfirmToolCard.tsx. `LiveToolCall` already had this field; `CardCall` did not. */
  args: Record<string, unknown>
  status: 'pending' | 'done' | 'error' | 'awaiting_approval'
  result?: string
  /** Code mode only — pi's edit tool real diff output (turbollm/src/code/code-session.ts). */
  diff?: string
  /** Set only by the completed-message mapping below, which is the only place with SIBLING
   *  context: this update_routine PREVIEW's change was already applied by a later call in the
   *  same message, so its confirm gate must not render. See `isSupersededUpdatePreview`. */
  supersededPreview?: boolean
}

// ── Diff view (Code mode) ───────────────────────────────────────────────────────
//
// Renders pi's own unified-diff output for the edit tool — no diffing is computed
// client-side, this just colors the lines pi already produced. Handles the standard
// unified-diff line prefixes (+/-/space, @@ hunk headers, \ no-newline markers);
// anything else (e.g. a stray blank line) renders as plain context.
function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n')
  return (
    <div className="max-h-64 overflow-auto border-t border-border font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        let style: CSSProperties = { color: 'var(--muted)' }
        if (line.startsWith('+++') || line.startsWith('---')) {
          style = { color: 'var(--faint)' }
        } else if (line.startsWith('@@')) {
          style = { color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }
        } else if (line.startsWith('+')) {
          style = { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 8%, transparent)' }
        } else if (line.startsWith('-')) {
          style = { color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 8%, transparent)' }
        }
        return (
          <div key={i} className="whitespace-pre px-3 py-[1px]" style={style}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function ToolCallCard({ call }: { call: CardCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasDiff = !!call.diff?.trim()
  const hasOutput = !!(call.result?.length) || hasDiff
  const awaitingApproval = call.status === 'awaiting_approval'

  const generic = (
    <div
      className="overflow-hidden rounded-lg border bg-panel-2"
      style={awaitingApproval ? { borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 6%, transparent)' } : { borderColor: 'var(--border)' }}
    >
      <button
        type="button"
        onClick={() => { if (hasOutput) { track('chat', 'toggle_tool_call_detail'); setExpanded((e) => !e) } }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        style={{ cursor: hasOutput ? 'pointer' : 'default' }}
      >
        {call.status === 'pending'            && <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />}
        {call.status === 'done'               && <CheckCircle2 size={12} className="shrink-0" style={{ color: 'var(--ok)' }} />}
        {call.status === 'error'              && <XCircle size={12} className="shrink-0" style={{ color: 'var(--err)' }} />}
        {call.status === 'awaiting_approval'  && <HelpCircle size={12} className="shrink-0" style={{ color: 'var(--warn)' }} />}
        <span className="font-mono text-[12px] font-medium text-ink">{friendlyName(call.name)}</span>
        <span className="text-[11px] text-faint">
          {call.status === 'pending' ? 'running…' : call.status === 'error' ? 'error' : call.status === 'awaiting_approval' ? 'waiting on you' : 'done'}
        </span>
        {hasOutput && (
          <ChevronDown
            size={11}
            className={`ml-auto shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {expanded && hasDiff && <DiffView diff={call.diff!} />}
      {expanded && !hasDiff && call.result && (
        <pre className="max-h-48 overflow-auto border-t border-border px-3 pb-3 pt-2 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
          {call.result.length > 2000 ? `${call.result.slice(0, 2000)}\n…(truncated)` : call.result}
        </pre>
      )}
    </div>
  )

  // Task 8: create_routine/update_routine get an inline confirm gate instead of the generic card.
  // Branching AFTER every hook above has run, per this file's hooks-safety rule — and on the tool
  // NAME only, which never changes for a given call, so the component type at this position is
  // stable across the running→done transition. The wrapper owns every other decision (has the call
  // finished? did it succeed? is the routine still fetchable?) and renders `generic` when the
  // answer is no. `generic` is only an element description — building it costs nothing when the
  // confirm card wins.
  if (isRoutineConfirmTool(call.name)) return <RoutineConfirmToolCard call={call} fallback={generic} superseded={call.supersededPreview} />
  return generic
}

function ToolCallsPanel({ calls }: { calls: CardCall[] }) {
  if (!calls.length) return null
  return (
    <div className="mb-3 space-y-1">
      {calls.map((c) => <ToolCallCard key={c.id} call={c} />)}
    </div>
  )
}

// ── Live inline tool step (streaming) ─────────────────────────────────────────

/** Re-renders every second while `active`, so a long step never looks frozen. */
function useElapsedSeconds(active: boolean): number {
  const [, tick] = useState(0)
  const start = useRef<number | null>(null)
  useEffect(() => {
    if (!active) { start.current = null; return }
    start.current = Date.now()
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  if (!active || start.current == null) return 0
  return Math.floor((Date.now() - start.current) / 1000)
}

/** One tool call rendered inline in the streaming flow, with a live spinner +
 *  elapsed timer while it runs and an expandable result once it settles. */
function InlineToolStep({ call, superseded }: { call: LiveToolCall; superseded?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const pending = call.status === 'pending'
  const hasDiff = !!call.diff?.trim()
  const hasOutput = !!call.result?.length || hasDiff
  const elapsed = useElapsedSeconds(pending)
  const generic = (
    <div className="my-1.5 overflow-hidden rounded-lg border border-border bg-panel-2">
      <button
        type="button"
        onClick={() => { if (hasOutput) { track('chat', 'toggle_tool_call_detail'); setExpanded((e) => !e) } }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        style={{ cursor: hasOutput ? 'pointer' : 'default' }}
      >
        {pending && <Loader2 size={13} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />}
        {call.status === 'done'  && <CheckCircle2 size={13} className="shrink-0" style={{ color: 'var(--ok)' }} />}
        {call.status === 'error' && <XCircle size={13} className="shrink-0" style={{ color: 'var(--err)' }} />}
        <span className="font-mono text-[12px] font-medium text-ink">{friendlyName(call.name)}</span>
        <span className="text-[11px]" style={{ color: pending ? 'var(--accent)' : 'var(--faint)' }}>
          {pending ? 'running…' : call.status === 'error' ? 'error' : 'done'}
        </span>
        {pending && elapsed > 0 && <span className="text-[11px] text-faint">· {elapsed}s</span>}
        {hasOutput && (
          <ChevronDown
            size={11}
            className={`ml-auto shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {expanded && hasDiff && <DiffView diff={call.diff!} />}
      {expanded && !hasDiff && call.result && (
        <pre className="max-h-48 overflow-auto border-t border-border px-3 pb-3 pt-2 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
          {call.result.length > 2000 ? `${call.result.slice(0, 2000)}\n…(truncated)` : call.result}
        </pre>
      )}
    </div>
  )

  // Same Task 8 branch as ToolCallCard's, after every hook (including useElapsedSeconds) has run.
  if (isRoutineConfirmTool(call.name)) return <RoutineConfirmToolCard call={call} fallback={generic} superseded={superseded} />
  return generic
}

// ── F-021: Confidence badge ───────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100)
  const isHigh = confidence >= 0.8
  return (
    <span
      title="Model's self-assessed confidence. A local LLM never reaches 1.0 — that's expected."
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        background: isHigh ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--warn) 15%, transparent)',
        color: isHigh ? 'var(--accent)' : 'var(--warn)',
        border: `1px solid ${isHigh ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--warn) 30%, transparent)'}`,
      }}
    >
      Confidence {pct}%
    </span>
  )
}

// ── F-021: Sources panel ──────────────────────────────────────────────────────

function SourceRow({ source, idx }: { source: ResearchSource; idx: number }) {
  const [open, setOpen] = useState(false)
  const scoreColor = source.relevanceScore >= 0.7 ? 'var(--accent)' : source.relevanceScore >= 0.5 ? 'var(--warn)' : 'var(--faint)'
  return (
    <div className="rounded border border-border bg-panel-2 overflow-hidden">
      <button
        type="button"
        onClick={() => { track('chat', 'toggle_source_row'); setOpen((o) => !o) }}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px]"
      >
        <span className="shrink-0 font-mono text-faint">{idx + 1}.</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-ink truncate block">{source.title || source.domain}</span>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-faint hover:text-accent truncate block"
            onClick={(e) => e.stopPropagation()}
          >
            {source.domain}
          </a>
        </span>
        <span
          className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
          style={{ background: 'color-mix(in srgb, currentColor 12%, transparent)', color: scoreColor }}
        >
          {Math.round(source.relevanceScore * 100)}%
        </span>
        {open ? <ChevronDown size={11} className="shrink-0 text-faint mt-0.5" /> : <ChevronRight size={11} className="shrink-0 text-faint mt-0.5" />}
      </button>
      {open && (
        <p className="border-t border-border px-3 pb-2 pt-1.5 text-[11px] leading-relaxed text-muted">
          {source.passage || '(no passage)'}
        </p>
      )}
    </div>
  )
}

function SourcesPanel({ meta }: { meta: ResearchMeta }) {
  const [open, setOpen] = useState(false)
  const sources = meta.sources ?? []
  if (sources.length === 0) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => { track('chat', 'toggle_sources_panel'); setOpen((o) => !o) }}
        className="flex items-center gap-1 text-[12px] text-muted hover:text-ink"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Sources [{sources.length}]</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {sources.map((s, i) => (
            <SourceRow key={s.url} source={s} idx={i} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── F-022: Annotated reply with inline referee badges ─────────────────────────

function AnnotatedReply({ content, verdicts }: { content: string; verdicts: ClaimVerdict[] }) {
  if (!verdicts.length) return <Markdown>{content}</Markdown>

  // Build a lookup: sentence → verdict
  const verdictMap = new Map<string, ClaimVerdict>()
  for (const v of verdicts) {
    verdictMap.set(v.sentence.trim(), v)
  }

  // Split content into sentences preserving delimiters, then annotate verified/unverified
  const parts: Array<{ text: string; verdict?: 'verified' | 'unverified' }> = []
  let remaining = content
  for (const [sentence, v] of verdictMap) {
    const idx = remaining.indexOf(sentence)
    if (idx === -1) continue
    if (idx > 0) parts.push({ text: remaining.slice(0, idx) })
    parts.push({ text: sentence, verdict: v.verdict === 'uncited' ? undefined : v.verdict })
    remaining = remaining.slice(idx + sentence.length)
  }
  if (remaining) parts.push({ text: remaining })

  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="relative">
          {p.verdict === 'verified' && (
            <span
              title="Claim found in cited source"
              className="inline-block text-[9px] font-bold ml-0.5 mr-0.5 align-super"
              style={{ color: 'var(--ok)' }}
            >✓</span>
          )}
          {p.verdict === 'unverified' && (
            <span
              title="Could not verify this claim in the cited source — check manually"
              className="inline-block text-[9px] font-bold ml-0.5 mr-0.5 align-super"
              style={{ color: 'var(--warn)' }}
            >?</span>
          )}
          <Markdown>{p.text}</Markdown>
        </span>
      ))}
    </>
  )
}

// ── Streaming message (in-progress) ──────────────────────────────────────────

export function StreamingBubble({
  timeline,
  reasoning,
  progress,
  liveGenTps,
  genTokens,
}: {
  timeline: LiveBlock[]
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number
  genTokens: number
}) {
  const isPrefill = !!progress && progress.phase === 'prompt'
  const hasTool = timeline.some((b) => b.kind === 'tool')
  const pendingTool = timeline.some((b) => b.kind === 'tool' && b.call.status === 'pending')
  const generating = liveGenTps > 0
  // Same superseded-preview suppression the completed path applies, for the case where the model
  // previews AND applies an update inside one streaming turn — both blocks are on screen at once.
  const liveCalls = timeline.flatMap((b) => (b.kind === 'tool' ? [b.call] : []))
  const supersededCallIds = new Set(
    liveCalls.filter((_, i) => isSupersededUpdatePreview(liveCalls, i)).map((c) => c.id),
  )

  return (
    <div className="min-w-0 pt-0.5">
      {reasoning?.trim() && <ThinkingBlock reasoning={reasoning} streaming />}

      {/* Interleaved timeline: text the model wrote and tools it ran, in order */}
      {timeline.map((b, i) =>
        b.kind === 'text'
          ? (b.text
              ? <div key={i} className="prose-tllm text-[15px] leading-[1.7] text-ink"><Markdown streaming>{b.text}</Markdown></div>
              : null)
          : b.kind === 'tool'
            ? <InlineToolStep key={b.call.id} call={b.call} superseded={supersededCallIds.has(b.call.id)} />
            : null, // 'turn' round-divider blocks are Code-only; chat never emits them
      )}

      {/* Prefill progress bar */}
      {isPrefill && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] text-faint">
            <Loader2 size={11} className="animate-spin" style={{ color: 'var(--accent)' }} />
            <span>Processing prompt</span>
            <span className="font-medium" style={{ color: 'var(--ink)' }}>{progress.pct}%</span>
            {progress.tps > 0 && <span>· {progress.tps.toFixed(0)} tok/s prefill</span>}
          </div>
          <div className="h-[3px] w-full overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${progress.pct}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>
      )}

      {/* Always-on activity line — guarantees the bubble never looks hung.
          While a tool is running its inline step shows the spinner, so we only
          need a foot line for active generation and the gaps between steps. */}
      {!isPrefill && !pendingTool && (
        generating ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
            <span className="tllm-pulse">·</span>
            {genTokens > 0 && <span className="font-medium" style={{ color: 'var(--ink)' }}>{genTokens} tok</span>}
            <span>· {liveGenTps.toFixed(1)} tok/s</span>
          </div>
        ) : (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--accent)' }}>
            <Loader2 size={12} className="animate-spin" />
            <span>{hasTool ? 'Working…' : reasoning ? 'Generating…' : 'Thinking…'}</span>
          </div>
        )
      )}
    </div>
  )
}

// ── Edit textarea ─────────────────────────────────────────────────────────────

// Editing a message used to drop it into a fixed 3/4-row box, so anything longer than a
// few lines collapsed into a small scrolling window and you lost sight of the text you
// came to edit. This grows to the FULL content height on open (and keeps tracking it as
// you type), so the edit box is the same size as the message it replaces. `max-h-[60vh]`
// is the only cap — a very long message scrolls internally rather than pushing the Save
// buttons off screen. Resetting to 'auto' before reading scrollHeight is what lets it
// shrink again after a deletion, not just grow.
function EditTextarea({
  value,
  onChange,
  onSave,
  onCancel,
  minRows,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  minRows: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    // `+ (offsetHeight - clientHeight)` is the 1px top/bottom border: box-sizing is border-box
    // here, so a plain scrollHeight leaves the box 2px short of its own content and the
    // textarea scrolls by a hairline even when everything fits.
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
  }, [])
  useLayoutEffect(fit, [value, fit])

  // The height above is a pixel value measured at ONE width, so it goes stale the moment the
  // column resizes and the text re-wraps: the conversation sidebar is collapsible AND
  // drag-resizable, and dragging it while an edit box is open used to leave the box at its old
  // height with a scrollbar back inside it until the next keystroke. Re-measure on width
  // changes only — reacting to the height changes we just made ourselves would loop.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver(() => {
      const cur = ref.current
      if (!cur || cur.clientWidth === lastWidth) return
      lastWidth = cur.clientWidth
      fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])
  return (
    <textarea
      ref={ref}
      autoFocus
      className="w-full resize-none overflow-y-auto max-h-[60vh] rounded-[var(--radius-lg)] border border-accent bg-panel px-4 py-2.5 text-[15px] leading-[1.6] text-ink outline-none"
      rows={minRows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSave() }
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

// ── Completed message bubble ──────────────────────────────────────────────────

/** PURE (GitHub #177) — is this bubble a placeholder row the daemon is STILL writing into?
 *
 *  The backend inserts the assistant row empty, with `stats: { aborted: false }`, before a single
 *  token exists (chat-routes.ts, `db.addMessage(convId, 'assistant', '', …)`). Any client that is
 *  not the tab which started the stream — after a reload, in a second tab, in a tab that was
 *  backgrounded — has no local `live` entry for it (ChatScreen's `liveByConv` is per-tab React
 *  state), so it fell straight through to the empty-message branch and painted a red
 *  "This message is empty." card over a turn that was generating perfectly well.
 *
 *  All three conditions are required:
 *   - `daemonGenerating` — /api/v1/status reports a `liveGeneration`. That is the DAEMON's view of
 *     the world and it survives reloads, which is precisely what the local state cannot do.
 *   - `isLast` — only the newest bubble can be the one being written into (ChatScreen passes
 *     `isLast={i === arr.length - 1 && !live}`).
 *   - the row is an UNFINALIZED placeholder — finalization always writes `totalMs`
 *     (chat-routes.ts's stats object sets it unconditionally), so its ABSENCE is the durable
 *     marker for "nothing has finalized this message yet". This is the condition that keeps a
 *     genuinely empty FINISHED message showing its error card even while some other conversation
 *     is generating: `liveGeneration` is engine-wide and carries no conversation id, so the
 *     message row itself has to supply the "this one specifically is unfinished" evidence.
 *
 *  `aborted` is excluded on purpose: a stopped turn is finalized with `aborted: true` and must
 *  keep reading "Generation failed or was stopped." */
export function isAwaitingGeneration(
  message: { stats: Partial<MessageStats> },
  isLast: boolean,
  daemonGenerating: boolean,
): boolean {
  return daemonGenerating && isLast && message.stats?.totalMs === undefined && !message.stats?.aborted
}

export function MessageBubble({
  message,
  convId,
  isLast,
  onEdit,
  onDelete,
  onRegenerate,
  editingId,
  onEditSave,
  onEditCancel,
  showThinking = true,
  daemonGenerating = false,
}: {
  message: Message
  /** Needed for the chat-branching variant switcher (GitHub #52); optional so read-only
   *  share views can keep omitting it — the switcher just doesn't render without it. */
  convId?: string
  isLast: boolean
  /** When undefined, edit/delete/regenerate action buttons are hidden (read-only mode). */
  onEdit?: (m: Message) => void
  onDelete?: (m: Message) => void
  onRegenerate?: () => void
  editingId: string | null
  onEditSave: (content: string) => void
  onEditCancel: () => void
  showThinking?: boolean
  /** GitHub #177: the DAEMON reports a generation in flight (`/api/v1/status` → `liveGeneration`).
   *  Defaults to false so every other caller (read-only share view, tests) is unchanged. */
  daemonGenerating?: boolean
}) {
  const [editDraft, setEditDraft] = useState(message.content)
  const isEditing = editingId === message.id

  if (message.role === 'user') {
    return (
      <div className="group flex justify-end gap-2">
        <div className="flex flex-col items-end gap-1">
          {isEditing ? (
            // Was max-w-[75%] — wrapped user messages far too early given the rest of
            // the app (composer, message column) deliberately has no width cap at all.
            // min(88%, 900px): wide enough to stop premature wrapping, capped so a
            // single-sentence message doesn't stretch absurdly wide on an ultrawide
            // monitor. Kept in sync with the non-editing bubble below — same value.
            <div className="w-full max-w-[min(88%,900px)]">
              <EditTextarea
                value={editDraft}
                onChange={setEditDraft}
                onSave={() => onEditSave(editDraft)}
                onCancel={onEditCancel}
                minRows={1}
              />
              <div className="mt-1.5 flex gap-1.5 justify-end">
                <Button size="sm" variant="ghost" onClick={() => { track('chat', 'cancel_edit_message'); onEditCancel() }}>Cancel</Button>
                <Button size="sm" onClick={() => { track('chat', 'save_edited_message'); onEditSave(editDraft) }}>Save & Resend</Button>
              </div>
            </div>
          ) : (
            <div className="flex max-w-[min(88%,900px)] flex-col items-end">
              <div className="whitespace-pre-wrap break-words rounded-[var(--radius-lg)] bg-accent px-4 py-2.5 text-[15px] leading-[1.6] text-on-accent">
                {message.content}
              </div>
              {message.attachments?.filter((a) => a.startsWith('data:image')).map((url, i) => (
                <img key={i} src={url} className="mt-2 max-h-48 max-w-xs rounded-lg object-contain" alt="attached image" />
              ))}
              {message.textAttachments?.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 justify-end">
                  {message.textAttachments.map((name, i) => (
                    <span key={i} className="flex items-center gap-1 rounded border border-border bg-panel-2 px-2 py-0.5 text-[12px] text-muted">
                      <FileText size={11} className="shrink-0" />
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {!isEditing && (
            <div className="flex items-center gap-0.5">
              {convId && message.variantGroup && <VariantSwitcher convId={convId} message={message} />}
              <div className="hover-actions flex items-center gap-0.5">
                <CopyButton text={message.content} className="rounded p-1 hover:bg-panel-2" screen="chat" />
                {onEdit && <ActionBtn icon={<Pencil size={12} />}  label="Edit"   onClick={() => { track('chat', 'open_edit_message'); setEditDraft(message.content); onEdit(message) }} />}
                {onDelete && <ActionBtn icon={<Trash2 size={12} />} label="Delete" onClick={() => { track('chat', 'delete_message'); onDelete(message) }} destructive />}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Assistant
  const toolCallRecords = message.toolCalls ?? []
  const completedToolCalls: CardCall[] = toolCallRecords.map((tc: ToolCallRecord, i: number) => ({
    id: tc.id,
    name: tc.name,
    // `?? {}` because a record persisted before args were stored (or a hand-built test fixture)
    // can arrive without them; the confirm gate then simply finds no routineId and stays generic.
    args: tc.args ?? {},
    status: tc.error ? 'error' : 'done',
    result: tc.error ?? tc.result,
    diff: tc.diff,
    // The two-phase update protocol leaves BOTH the preview and the apply in a finished
    // transcript. This mapping is the only place that sees the whole list, so it is the only
    // place that can tell the earlier record it has been superseded.
    supersededPreview: isSupersededUpdatePreview(toolCallRecords, i),
  }))
  // A message with no content, no reasoning, and no tool calls has nothing to show — render
  // the same fallback card an aborted-empty finish already used, instead of leaving a blank
  // "phantom" content area that still shows Copy/Edit/Regenerate/Delete on hover (the
  // streaming-side ADR-174 .trim() guard only ever covered the reasoning block above, never
  // this completed-message path).
  // researchMeta excluded (pre-release review, Finding E): a research-only turn can finish
  // with empty content/reasoning but a real sources panel + confidence badge below — showing
  // "This message is empty." above real, populated content would be self-contradictory.
  const isEmptyFinish = !message.content?.trim() && !message.reasoning?.trim() && completedToolCalls.length === 0 && !message.researchMeta
  // GitHub #177: "empty" and "failed" are not the same thing. An empty row whose generation the
  // DAEMON says is still running is simply not finished yet — show the generating affordance, not
  // a red error card. See isAwaitingGeneration for why all three of its conditions are needed.
  const stillGenerating = isEmptyFinish && isAwaitingGeneration(message, isLast, daemonGenerating)
  const hasError = isEmptyFinish && !stillGenerating
  const rm: ResearchMeta | undefined = message.researchMeta
  const verdicts = rm?.refereeVerdicts ?? []
  return (
    <div className="group min-w-0 pt-0.5">
      {message.reasoning?.trim() && (
        <ThinkingBlock reasoning={message.reasoning} thinkMs={message.stats.thinkMs} showThinking={showThinking} />
      )}
      <ToolCallsPanel calls={completedToolCalls} />
      {isEditing ? (
        <div className="w-full">
          <EditTextarea
            value={editDraft}
            onChange={setEditDraft}
            onSave={() => onEditSave(editDraft)}
            onCancel={onEditCancel}
            minRows={2}
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { track('chat', 'cancel_edit_message'); onEditCancel() }}>Cancel</Button>
            {/* GitHub #52: unlike a user-message edit, this only fixes the reply's own
                text in place — it doesn't resend or trigger a new generation. */}
            <Button size="sm" onClick={() => { track('chat', 'save_edited_reply'); onEditSave(editDraft) }}>Save</Button>
          </div>
        </div>
      ) : hasError ? (
        <div className="rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: 'var(--err)', color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 10%, transparent)' }}>
          {message.stats.aborted ? 'Generation failed or was stopped.' : 'This message is empty.'}
          {isLast && onRegenerate && <button type="button" className="ml-3 underline" onClick={() => { track('chat', 'regenerate_message'); onRegenerate() }}>Regenerate</button>}
        </div>
      ) : stillGenerating ? (
        // GitHub #177: the turn is in flight on the daemon but this tab isn't the one streaming it
        // (reload / second tab / restored background tab), so there's no StreamingBubble to show.
        // Same wording and spinner the send button uses while a generation runs.
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" />
          Generating…
        </div>
      ) : (
        <div className="prose-tllm text-[15px] leading-[1.7] text-ink">
          {verdicts.length > 0
            ? <AnnotatedReply content={message.content} verdicts={verdicts} />
            : <Markdown>{message.content}</Markdown>
          }
        </div>
      )}
      {/* F-021: confidence badge */}
      {rm?.confidence !== undefined && (
        <div className="mt-1.5">
          <ConfidenceBadge confidence={rm.confidence} />
        </div>
      )}
      {/* F-021: sources panel */}
      {rm && <SourcesPanel meta={rm} />}
      <div className="flex items-center gap-1.5">
        <StatsRow stats={message.stats} />
        {/* GitHub #52: only ever set by an explicit in-place edit, never by generation. */}
        {message.edited && <span className="text-[11px] text-faint">· Edited</span>}
      </div>
      {!isEditing && (
        <div className="mt-1 flex items-center gap-0.5">
          {convId && message.variantGroup && <VariantSwitcher convId={convId} message={message} />}
          <div className="hover-actions flex items-center gap-0.5">
            {/* GitHub #52 (v1.7.5 fix was incomplete): Copy/Edit make no sense on a message
                with no content to copy or edit — hasError already replaces the content area
                with "This message is empty."/"Generation failed…", but this action row still
                rendered all four buttons underneath regardless, which is the "block" the
                follow-up report was pointing at. Delete/Regenerate stay: both are genuinely
                useful on a failed/empty message. */}
            {/* `stillGenerating` (GitHub #177) joins hasError here for the same reason: there is
                no text to copy or edit yet, and the row is about to be rewritten by the daemon. */}
            {!hasError && !stillGenerating && <CopyButton text={message.content} className="rounded p-1 hover:bg-panel-2" screen="chat" />}
            {!hasError && !stillGenerating && onEdit && <ActionBtn icon={<Pencil size={12} />} label="Edit" onClick={() => { track('chat', 'open_edit_message'); setEditDraft(message.content); onEdit(message) }} />}
            {isLast && onRegenerate && <ActionBtn icon={<RefreshCw size={12} />} label="Regenerate" onClick={() => { track('chat', 'regenerate_message'); onRegenerate() }} />}
            {onDelete && <ActionBtn icon={<Trash2 size={12} />} label="Delete" onClick={() => { track('chat', 'delete_message'); onDelete(message) }} destructive />}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Chat branching (GitHub #52): ‹ 2/3 › switcher for regenerated sibling replies ──

function VariantSwitcher({ convId, message }: { convId: string; message: Message }) {
  const qc = useQueryClient()
  const group = message.variantGroup!
  const variantsQ = useQuery({
    queryKey: ['message-variants', group],
    queryFn: () => getMessageVariants(convId, message.id),
  })
  const [switching, setSwitching] = useState(false)

  const variants = variantsQ.data?.variants ?? []
  const index = variants.findIndex((v) => v.id === message.id)
  // Bail if still loading, a group that collapsed to one, or a stale query mid-refetch
  // (index -1 — this message isn't in the list yet) rather than risk indexing variants[-2].
  if (variants.length < 2 || index === -1) return null
  const go = async (targetId: string) => {
    setSwitching(true)
    try {
      await activateVariant(convId, targetId)
      await qc.invalidateQueries({ queryKey: ['message-variants', group] })
      await qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="flex items-center gap-0.5 text-[11px] text-faint">
      <button
        type="button"
        disabled={switching || index <= 0}
        onClick={() => { track('chat', 'switch_message_variant'); go(variants[index - 1].id) }}
        className="grid h-5 w-5 place-items-center rounded hover:bg-panel-2 disabled:pointer-events-none disabled:opacity-30"
        title="Previous version"
      >
        <ChevronLeft size={12} />
      </button>
      <span className="tabular-nums">{index + 1}/{variants.length}</span>
      <button
        type="button"
        disabled={switching || index >= variants.length - 1}
        onClick={() => { track('chat', 'switch_message_variant'); go(variants[index + 1].id) }}
        className="grid h-5 w-5 place-items-center rounded hover:bg-panel-2 disabled:pointer-events-none disabled:opacity-30"
        title="Next version"
      >
        <ChevronRight size={12} />
      </button>
    </div>
  )
}

function ActionBtn({ icon, label, onClick, destructive }: { icon: ReactNode; label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="rounded p-1 transition-colors hover:bg-panel-2"
      style={{ color: destructive ? 'var(--err)' : 'var(--faint)' }}
    >
      {icon}
    </button>
  )
}

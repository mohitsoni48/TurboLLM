import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CheckCircle2, ChevronDown, ChevronRight, FileText, HelpCircle, Loader2, Pencil, RefreshCw, Trash2, XCircle } from 'lucide-react'
import type { ClaimVerdict, LiveToolCall, Message, MessageStats, ResearchMeta, ResearchSource, ToolCallRecord } from '../../lib/chat-types'
import { Button } from '../../components/ui/button'
import { CopyButton } from '../../components/ui/copy-button'
import { ArtifactCard, isArtifactLang } from '../../components/ArtifactCard'

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
        onClick={() => setOpen((o) => !o)}
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

const Markdown = memo(function Markdown({ children, streaming }: { children: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">{children}</a>
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
            <div className="relative my-2 overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border bg-panel-2 px-3 py-1 font-mono text-[11px] text-muted">
                <span>{lang}</span>
                <CopyButton text={childrenToString(children)} size={12} />
              </div>
              <div className="overflow-x-auto overscroll-x-contain" onScroll={e => e.stopPropagation()}>
                <code className={`${className ?? ''} block p-3 font-mono text-[13px] leading-relaxed whitespace-pre`} {...props}>{children}</code>
              </div>
            </div>
          )
        },
        pre: ({ children }) => <>{children}</>,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="w-full border-collapse text-[13px]">{children}</table></div>,
        th: ({ children }) => <th className="border border-border bg-panel-2 px-3 py-1.5 text-left font-semibold text-[13px]">{children}</th>,
        td: ({ children }) => <td className="border border-border px-3 py-1.5 text-[13px]">{children}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  )
})

// ── Tool call cards ───────────────────────────────────────────────────────────

type CardCall = { id: string; name: string; status: 'pending' | 'done' | 'error' | 'awaiting_approval'; result?: string }

export function friendlyName(name: string): string {
  if (name.startsWith('mcp__')) return name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  return name.replace(/_/g, ' ')
}

function ToolCallCard({ call }: { call: CardCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasOutput = !!(call.result?.length)
  const awaitingApproval = call.status === 'awaiting_approval'

  return (
    <div
      className="overflow-hidden rounded-lg border bg-panel-2"
      style={awaitingApproval ? { borderColor: 'var(--warn,#ca8a04)', background: 'color-mix(in srgb, var(--warn,#ca8a04) 6%, transparent)' } : { borderColor: 'var(--border)' }}
    >
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        style={{ cursor: hasOutput ? 'pointer' : 'default' }}
      >
        {call.status === 'pending'            && <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />}
        {call.status === 'done'               && <CheckCircle2 size={12} className="shrink-0" style={{ color: '#4ade80' }} />}
        {call.status === 'error'              && <XCircle size={12} className="shrink-0" style={{ color: 'var(--err)' }} />}
        {call.status === 'awaiting_approval'  && <HelpCircle size={12} className="shrink-0" style={{ color: 'var(--warn,#ca8a04)' }} />}
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
      {expanded && call.result && (
        <pre className="max-h-48 overflow-auto border-t border-border px-3 pb-3 pt-2 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
          {call.result.length > 2000 ? `${call.result.slice(0, 2000)}\n…(truncated)` : call.result}
        </pre>
      )}
    </div>
  )
}

function ToolCallsPanel({ calls }: { calls: CardCall[] }) {
  if (!calls.length) return null
  return (
    <div className="mb-3 space-y-1">
      {calls.map((c) => <ToolCallCard key={c.id} call={c} />)}
    </div>
  )
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
        onClick={() => setOpen((o) => !o)}
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
        onClick={() => setOpen((o) => !o)}
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
  content,
  reasoning,
  progress,
  liveGenTps,
  genTokens,
  toolCalls = [],
}: {
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number
  genTokens: number
  toolCalls?: LiveToolCall[]
}) {
  const isPrefill = !!progress && progress.phase === 'prompt'

  return (
    <div className="flex gap-3">
      <ModelAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        {reasoning && <ThinkingBlock reasoning={reasoning} streaming />}
        <ToolCallsPanel calls={toolCalls} />
        <div className="prose-tllm text-[15px] leading-[1.7] text-ink">
          {content ? <Markdown streaming>{content}</Markdown> : (
            <span className="text-muted">
              {isPrefill ? 'Processing prompt…' : reasoning ? 'Generating…' : toolCalls.length ? 'Working…' : 'Thinking…'}
            </span>
          )}
        </div>

        {/* Prefill progress bar */}
        {isPrefill && (
          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] text-faint">
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

        {/* Live generation: running token count + tok/s */}
        {!isPrefill && (content || reasoning) && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
            <span className="tllm-pulse">·</span>
            {genTokens > 0 && <span className="font-medium" style={{ color: 'var(--ink)' }}>{genTokens} tok</span>}
            {liveGenTps > 0
              ? <span>· {liveGenTps.toFixed(1)} tok/s</span>
              : genTokens === 0 && <span>…</span>
            }
          </div>
        )}
      </div>
    </div>
  )
}

// ── Completed message bubble ──────────────────────────────────────────────────

export function MessageBubble({
  message,
  isLast,
  onEdit,
  onDelete,
  onRegenerate,
  editingId,
  onEditSave,
  onEditCancel,
  showThinking = true,
}: {
  message: Message
  isLast: boolean
  /** When undefined, edit/delete/regenerate action buttons are hidden (read-only mode). */
  onEdit?: (m: Message) => void
  onDelete?: (m: Message) => void
  onRegenerate?: () => void
  editingId: string | null
  onEditSave: (content: string) => void
  onEditCancel: () => void
  showThinking?: boolean
}) {
  const [editDraft, setEditDraft] = useState(message.content)
  const isEditing = editingId === message.id

  if (message.role === 'user') {
    return (
      <div className="group flex justify-end gap-2">
        <div className="flex flex-col items-end gap-1">
          {isEditing ? (
            <div className="w-full max-w-[75%]">
              <textarea
                autoFocus
                className="w-full resize-none rounded-[var(--radius-lg)] border border-accent bg-panel px-4 py-2.5 text-[15px] leading-[1.6] text-ink outline-none"
                rows={3}
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onEditSave(editDraft) }
                  if (e.key === 'Escape') onEditCancel()
                }}
              />
              <div className="mt-1.5 flex gap-1.5 justify-end">
                <Button size="sm" variant="ghost" onClick={onEditCancel}>Cancel</Button>
                <Button size="sm" onClick={() => onEditSave(editDraft)}>Save & Resend</Button>
              </div>
            </div>
          ) : (
            <div className="flex max-w-[75%] flex-col items-end">
              <div className="whitespace-pre-wrap rounded-[var(--radius-lg)] bg-accent px-4 py-2.5 text-[15px] leading-[1.6] text-on-accent">
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
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={message.content} className="rounded p-1 hover:bg-panel-2" />
              {onEdit && <ActionBtn icon={<Pencil size={12} />}  label="Edit"   onClick={() => { setEditDraft(message.content); onEdit(message) }} />}
              {onDelete && <ActionBtn icon={<Trash2 size={12} />} label="Delete" onClick={() => onDelete(message)} destructive />}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Assistant
  const hasError = message.stats.aborted && !message.content
  const completedToolCalls: CardCall[] = (message.toolCalls ?? []).map((tc: ToolCallRecord) => ({
    id: tc.id,
    name: tc.name,
    status: tc.error ? 'error' : 'done',
    result: tc.error ?? tc.result,
  }))
  const rm: ResearchMeta | undefined = message.researchMeta
  const verdicts = rm?.refereeVerdicts ?? []
  return (
    <div className="group flex gap-3">
      <ModelAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        {message.reasoning && (
          <ThinkingBlock reasoning={message.reasoning} thinkMs={message.stats.thinkMs} showThinking={showThinking} />
        )}
        <ToolCallsPanel calls={completedToolCalls} />
        {hasError ? (
          <div className="rounded-lg border px-4 py-3 text-[14px]" style={{ borderColor: 'var(--err)', color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 8%, transparent)' }}>
            Generation failed or was stopped.
            {isLast && onRegenerate && <button type="button" className="ml-3 underline" onClick={onRegenerate}>Regenerate</button>}
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
        <StatsRow stats={message.stats} />
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.content} className="rounded p-1 hover:bg-panel-2" />
          {isLast && onRegenerate && <ActionBtn icon={<RefreshCw size={12} />} label="Regenerate" onClick={onRegenerate} />}
          {onDelete && <ActionBtn icon={<Trash2 size={12} />} label="Delete" onClick={() => onDelete(message)} destructive />}
        </div>
      </div>
    </div>
  )
}

function ModelAvatar() {
  return <div className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded bg-panel-2 text-[9px] font-bold text-muted">T</div>
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

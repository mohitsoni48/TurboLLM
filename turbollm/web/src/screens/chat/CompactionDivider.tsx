import { useState } from 'react'
import { ChevronDown, ChevronUp, Undo2 } from 'lucide-react'

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface CompactionDividerProps {
  summary: string
  tokensBefore: number
  /** Omitted for a readonly (shared-link) conversation — no undo affordance there. */
  onUndo?: () => void
}

/** The transcript marker at a compaction cut (ADR-420). Nothing above or below it is
 *  hidden or altered — this is a pure annotation over messages that are all still
 *  rendering normally; expanding it only reveals the summary TEXT, it never toggles
 *  message visibility. */
export function CompactionDivider({ summary, tokensBefore, onUndo }: CompactionDividerProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="my-3 flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 self-center rounded-full border border-border px-3 py-1 text-[11px] text-muted hover:text-ink transition-colors"
      >
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        Everything above is now sent as a summary · {fmtK(tokensBefore)} tokens freed
      </button>
      {expanded && (
        <div className="mx-auto max-w-[600px] rounded-lg border border-border bg-panel p-3 text-[13px] text-muted">
          {/* Says plainly what the dimmed messages above are FOR — the divider used to read
              "Context compacted · N tokens summarized" while that content sat visibly
              unchanged right above it, which read as the feature having done nothing. */}
          <p className="mb-2 text-[12px] text-faint">
            The messages above are still here, but the model now reads this summary in their place:
          </p>
          <p className="whitespace-pre-wrap">{summary}</p>
          {onUndo && (
            <button
              type="button"
              onClick={onUndo}
              className="mt-2 flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              <Undo2 size={12} /> Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

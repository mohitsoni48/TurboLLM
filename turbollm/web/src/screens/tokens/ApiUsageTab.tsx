import type { ApiUsageStats } from '../../lib/types'

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return n.toLocaleString()
}

/** Rank-based accent shade — same scheme as the Models tab, kept local since this tab's
 *  model list is a separate ranking (API traffic only, not combined with chat). */
function colorForRank(rank: number): string {
  const intensity = Math.max(20, 85 - rank * 12)
  return `color-mix(in srgb, var(--accent) ${intensity}%, var(--panel-2))`
}

const SOURCE_LABEL: Record<ApiUsageStats['bySource'][number]['source'], string> = {
  anthropic: 'Claude Code / Anthropic-protocol clients',
  openai: 'OpenAI-compatible clients',
}

/** Tokens from gateway (external-client) traffic — Claude Code, other CLIs/extensions
 *  hitting /v1/messages or /v1/chat/completions — as opposed to in-app chat, which the
 *  Overview/Models tabs already cover (GitHub #71). */
export function ApiUsageTab({ api }: { api: ApiUsageStats }) {
  if (api.requests === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-faint">
        No API or extension traffic in this range yet. This counts requests to TurboLLM's
        OpenAI/Anthropic-compatible gateway from tools like Claude Code — not in-app chat.
      </p>
    )
  }

  const byModelTotal = api.byModel.reduce((sum, m) => sum + m.totalTokens, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="text-[12px] text-muted">Requests</div>
          <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
            {api.requests.toLocaleString()}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="text-[12px] text-muted">Tokens in range</div>
          <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
            {formatTokenCount(api.totalTokens)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="text-[12px] text-muted">Lifetime tokens</div>
          <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
            {formatTokenCount(api.lifetimeTotalTokens)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-3 text-[13px] font-medium text-ink">By source</div>
        <div className="flex flex-col gap-1">
          {api.bySource.map((s) => (
            <div key={s.source} className="flex items-center gap-3 rounded-md px-2 py-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-ink">{SOURCE_LABEL[s.source]}</span>
              <span className="shrink-0 tabular-nums text-muted">{s.requests.toLocaleString()} requests</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-faint">{formatTokenCount(s.totalTokens)}</span>
            </div>
          ))}
        </div>
      </div>

      {api.byModel.length > 0 && (
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="mb-3 text-[13px] font-medium text-ink">By model</div>
          <div className="flex flex-col gap-1">
            {api.byModel.map((m, i) => (
              <div key={m.modelKey} className="flex items-center gap-3 rounded-md px-2 py-2 text-[13px]">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorForRank(i) }} />
                <span className="min-w-0 flex-1 truncate text-ink">{m.displayName}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {formatTokenCount(m.promptTokens)} in · {formatTokenCount(m.genTokens)} out
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-faint">
                  {byModelTotal > 0 ? `${((m.totalTokens / byModelTotal) * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

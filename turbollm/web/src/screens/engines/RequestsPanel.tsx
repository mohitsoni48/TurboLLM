import { useMemo, useState } from 'react'
import { Settings2, Trash2, Download } from 'lucide-react'
import { useRequestLog } from '../../lib/use-request-log'
import { useSettings } from '../../lib/queries'
import { clearRequests, track } from '../../lib/api'
import { cn } from '../../lib/utils'
import type { RequestLogEntry, RequestLogSource } from '../../lib/types'
import { Switch } from '../../components/ui/switch'
import { Badge } from '../../components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { RequestDetail } from './RequestDetail'

// ── Requests panel (issue #211 follow-up) ───────────────────────────────────
//
// "The logs being shown are still too basic. See LM Studio logs. They show request, response,
// temperature and each and everything is configurable what is visible in log." — founder.
//
// The engine's own stderr log (MonitorLogPanel, the other half of this segmented control)
// physically cannot show a prompt, a response, or `temperature` — llama.cpp never emits them.
// This panel is TurboLLM's own proxy-layer capture instead (gateway.ts / chat-upstream.ts),
// which sees every completion regardless of engine: external API clients, Code sessions, and
// in-app Chat alike, each row carrying the sampling params, timings and token counts LM Studio
// shows. Sharing the live-tail/cap/auto-scroll shape with the engine-log side via
// `useRequestLog` (lib/use-request-log.ts), the same split that `MonitorLogPanel`/
// `EngineLogPanel` already use for `useEngineLog`.

const OPTIONAL_COLUMNS = [
  { key: 'harness', label: 'Harness' },
  { key: 'duration', label: 'Duration' },
  { key: 'ttft', label: 'TTFT' },
] as const
type ColumnKey = (typeof OPTIONAL_COLUMNS)[number]['key']
const COLUMNS_KEY = 'tllm.requestlog.columns'

/** All optional columns default ON — LM Studio parity means showing everything by default and
 *  letting the user hide what they don't want, not starting sparse. Mirrors the `tllm.hwBar`
 *  precedent (SettingsScreen.tsx) for a client-only, per-viewer display preference. */
function loadColumnPrefs(): Record<ColumnKey, boolean> {
  const defaults = { harness: true, duration: true, ttft: true } as Record<ColumnKey, boolean>
  try {
    const raw = localStorage.getItem(COLUMNS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, boolean>>
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

function saveColumnPrefs(prefs: Record<ColumnKey, boolean>): void {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(prefs))
  } catch {
    /* private browsing / storage disabled — the toggle just doesn't persist */
  }
}

const SOURCE_LABEL: Record<RequestLogSource, string> = { openai: 'API', anthropic: 'API', chat: 'Chat' }

function StatusDot({ entry }: { entry: RequestLogEntry }) {
  const color = entry.status === null ? 'var(--muted)' : entry.status >= 400 ? 'var(--err)' : 'var(--ok)'
  const label = entry.status === null ? 'pending' : entry.error ? entry.error.message : String(entry.status)
  return (
    <span className="flex items-center gap-1.5" title={label}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-[12px] tabular-nums text-muted">{entry.status ?? '…'}</span>
    </span>
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function exportJsonl(entries: RequestLogEntry[]): void {
  const text = entries.map((e) => JSON.stringify(e)).join('\n')
  const blob = new Blob([text], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `turbollm-requests-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function RequestsPanel({ active }: { active: boolean }) {
  const { entries, autoScroll, setAutoScroll, viewportRef } = useRequestLog(active)
  const { query: settingsQ, save } = useSettings()
  const [columns, setColumns] = useState(loadColumnPrefs)
  const [selected, setSelected] = useState<RequestLogEntry | null>(null)
  const [sourceFilter, setSourceFilter] = useState<'all' | RequestLogSource>('all')

  const captureBodies = settingsQ.data?.requestLog?.captureBodies ?? false

  const toggleColumn = (key: ColumnKey) => {
    setColumns((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveColumnPrefs(next)
      return next
    })
  }

  const filtered = useMemo(
    () => (sourceFilter === 'all' ? entries : entries.filter((e) => e.source === sourceFilter)),
    [entries, sourceFilter],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-1">
          {(['all', 'openai', 'anthropic', 'chat'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { track('monitor', 'switch_monitor_view'); setSourceFilter(s) }}
              className={cn(
                'rounded px-2 py-1 text-[12px] font-medium capitalize transition-colors',
                sourceFilter === s ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink',
              )}
            >
              {s === 'all' ? 'All' : s === 'openai' ? 'API (OpenAI)' : s === 'anthropic' ? 'API (Anthropic)' : 'Chat'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <Switch
              checked={autoScroll}
              onCheckedChange={(v) => { track('monitor', 'toggle_engine_log_autoscroll'); setAutoScroll(v) }}
            />
            Auto-scroll
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Request log settings"
                className="rounded p-1 text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                <Settings2 size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Columns</div>
              {OPTIONAL_COLUMNS.map(({ key, label }) => (
                <DropdownMenuItem
                  key={key}
                  onSelect={(e) => { e.preventDefault(); track('monitor', 'toggle_request_column'); toggleColumn(key) }}
                >
                  <Switch checked={columns[key]} className="pointer-events-none" />
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5">
                <label className="flex items-start gap-2 text-[12px] text-ink">
                  <Switch
                    checked={captureBodies}
                    onCheckedChange={(v) => {
                      track('monitor', 'toggle_request_log_bodies')
                      save.mutate({ requestLog: { captureBodies: v } })
                    }}
                    className="mt-0.5 shrink-0"
                  />
                  <span>
                    Log prompts and responses
                    <span className="mt-0.5 block text-[11px] font-normal text-faint">
                      In-memory on this machine only — never saved to disk or sent anywhere. Off by default.
                    </span>
                  </span>
                </label>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { track('monitor', 'export_request_log'); exportJsonl(entries) }}>
                <Download size={14} /> Export JSONL
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                onSelect={() => { track('monitor', 'clear_request_log'); void clearRequests() }}
              >
                <Trash2 size={14} /> Clear log
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        ref={viewportRef}
        tabIndex={0}
        aria-label="Request log"
        className="min-h-0 flex-1 overflow-auto"
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--log-faint)' }}>
            No requests captured yet — traffic through the API, Code, or Chat will appear here.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => { track('monitor', 'open_request_detail'); setSelected(entry) }}
                className="flex w-full items-center gap-3 px-4 py-1.5 text-left font-mono text-[12px] transition-colors hover:bg-panel-2"
              >
                <span className="w-20 shrink-0 text-faint">{formatTime(entry.ts)}</span>
                <Badge variant="mono" className="w-24 shrink-0 justify-center">{SOURCE_LABEL[entry.source]}</Badge>
                {columns.harness && <span className="w-24 shrink-0 truncate text-muted">{entry.harness ?? '—'}</span>}
                <span className="w-40 shrink-0 truncate text-ink">{entry.modelKey ?? '—'}</span>
                <span className="w-14 shrink-0"><StatusDot entry={entry} /></span>
                {columns.duration && <span className="w-16 shrink-0 text-muted">{formatMs(entry.timings.durationMs)}</span>}
                {columns.ttft && <span className="w-16 shrink-0 text-muted">{formatMs(entry.timings.ttftMs)}</span>}
                <span className="w-28 shrink-0 text-muted">
                  {entry.tokens.prompt}→{entry.tokens.completion} tok
                </span>
                <span className="w-20 shrink-0 text-muted">
                  {entry.tokens.genTps !== null ? `${entry.tokens.genTps.toFixed(0)} t/s` : '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-faint">
                  {JSON.stringify(entry.params) !== '{}' ? JSON.stringify(entry.params) : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <RequestDetail entry={selected} onClose={() => setSelected(null)} captureBodies={captureBodies} />
    </div>
  )
}

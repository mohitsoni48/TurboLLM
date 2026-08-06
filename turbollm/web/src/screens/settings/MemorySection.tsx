import { useState } from 'react'
import { Brain, ChevronRight, Trash2 } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { useMemoryFacts, useMemoryFactMutations } from '../../lib/chat-queries'
import { ApiError, track } from '../../lib/api'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { Badge } from '../../components/ui/badge'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'

/** Compact relative-time ("just now", "3h ago", "2d ago"), same convention as
 *  ManagedEngines.tsx / EnginesScreen.tsx's file-local helper. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Auto-memory (Release 3): background extraction of durable facts from the user's own
 *  chat messages, injected into future new conversations. Extraction itself is silent (no
 *  per-fact confirmation) — this section is the transparency surface: a master toggle plus
 *  a "saved memory" list the user can review and delete from at any time. */
export function MemorySection() {
  const [open, setOpen] = useState(false)
  const { query: settingsQ, save } = useSettings()
  const factsQ = useMemoryFacts()
  const { remove } = useMemoryFactMutations()
  const enabled = settingsQ.data?.autoMemoryEnabled ?? false
  const facts = factsQ.data?.facts ?? []

  const setEnabled = (v: boolean) => {
    save.mutate(
      { autoMemoryEnabled: v },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update memory setting.') },
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-panel p-4">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ChevronRight size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <Brain size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Memory</h2>
        <Badge variant="accent" className="normal-case tracking-normal">Experimental</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <label className="mt-3 flex cursor-pointer items-center justify-between border-b border-border py-2 pb-3">
          <div>
            <div className="text-[14px] font-medium text-ink">Remember facts about you</div>
            <div className="text-[12px] text-muted">
              Silently extracts durable facts you mention in chat (name, preferences, setup) and adds them to
              new conversations. Nothing leaves your device — it uses the model you already have loaded.
            </div>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
        </label>

        <p className="mb-3 mt-3 text-[11px] text-faint">
          Facts apply to new chats going forward — the conversation where something was mentioned won't
          retroactively include it.
        </p>

        {factsQ.isLoading && <p className="text-[13px] text-faint">Loading…</p>}
        {!factsQ.isLoading && facts.length === 0 && (
          <p className="text-[13px] text-faint">No facts saved yet.</p>
        )}

        {facts.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {facts.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">{f.factText}</div>
                  <div className="text-[11px] text-faint">{relativeTime(f.createdAt)}</div>
                </div>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => { track('settings', 'delete_memory_fact'); remove.mutate(f.id) }}
                  disabled={remove.isPending}
                  className="shrink-0 rounded p-1 transition-colors hover:bg-bg disabled:opacity-60"
                  style={{ color: 'var(--err)' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

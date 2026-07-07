import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ChevronRight, ShieldCheck } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { ApiError, type ToolPolicy } from '../../lib/api'
import { fetchAvailableTools } from '../../lib/chat-api'
import { friendlyName } from '../chat/MessageBubble'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'

const POLICY_OPTIONS: { value: ToolPolicy; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
]

/** Per-tool Ask/Allow/Deny approval gate (F-025). Lives in Settings — it governs what
 *  the chat/agent model may execute, i.e. model behavior/safety, not external access. */
export function ToolPermissionsSection() {
  const [open, setOpen] = useState(false)
  const toolsQ = useQuery({ queryKey: ['available-tools'], queryFn: fetchAvailableTools })
  const { query: settingsQ, save } = useSettings()
  const tools = toolsQ.data ?? []
  const policies = settingsQ.data?.toolPolicies ?? {}

  const setPolicy = (name: string, value: ToolPolicy) => {
    save.mutate(
      { toolPolicies: { ...policies, [name]: value } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update tool permission.') },
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-panel p-4">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ChevronRight size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <ShieldCheck size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Tool permissions</h2>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mb-3 mt-3 text-[12px] text-muted">
          Control whether each tool the model can call runs automatically, is always blocked, or asks
          for your approval in chat each time.
        </p>

        {toolsQ.isLoading && <p className="text-[13px] text-faint">Loading tools…</p>}
        {!toolsQ.isLoading && tools.length === 0 && (
          <p className="text-[13px] text-faint">No tools available.</p>
        )}

        {tools.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {tools.map((t) => {
              const current = policies[t.name] ?? 'ask'
              return (
                <div key={t.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="font-mono text-[13px] font-medium text-ink">{friendlyName(t.name)}</div>
                    {t.description && (
                      <div className="truncate text-[11px] text-faint" title={t.description}>{t.description}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 overflow-hidden rounded-lg border border-border">
                    {POLICY_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setPolicy(t.name, value)}
                        disabled={save.isPending}
                        className="px-3 py-1.5 text-[12px] transition-colors disabled:opacity-60"
                        style={{
                          background: current === value ? 'var(--accent)' : 'transparent',
                          color: current === value ? 'var(--on-accent)' : 'var(--muted)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

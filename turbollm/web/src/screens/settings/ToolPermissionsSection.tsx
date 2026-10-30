import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ChevronRight, ShieldCheck } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { ApiError, track, type ToolPolicy } from '../../lib/api'
import { fetchAvailableTools } from '../../lib/chat-api'
import { friendlyName } from '../../lib/tool-explain'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { Switch } from '../../components/ui/switch'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'

/** chatApprovalWaitMinutes's bounds and default, as the daemon's config-bounds.ts has them. */
const WAIT_MIN = 0
const WAIT_MAX = 1440
const WAIT_DEFAULT = 30

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
  const autoAllowAll = settingsQ.data?.autoAllowAll ?? false
  const savedWait = settingsQ.data?.chatApprovalWaitMinutes ?? WAIT_DEFAULT
  // The field's text while it is edited; saved on blur or Enter, and put back to the saved value
  // whenever that changes (a save here, or one from another tab once the settings are read again).
  const [waitText, setWaitText] = useState(String(savedWait))
  useEffect(() => { setWaitText(String(savedWait)) }, [savedWait])

  const setPolicy = (name: string, value: ToolPolicy) => {
    track('settings', 'set_tool_policy')
    save.mutate(
      { toolPolicies: { ...policies, [name]: value } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update tool permission.') },
    )
  }

  const setAutoAllowAll = (value: boolean) => {
    track('settings', 'toggle_auto_allow_tools')
    save.mutate(
      { autoAllowAll: value },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update tool permission.') },
    )
  }

  const commitWait = () => {
    const n = Number(waitText)
    if (waitText.trim() === '' || !Number.isFinite(n)) { setWaitText(String(savedWait)); return }
    const value = Math.max(WAIT_MIN, Math.min(WAIT_MAX, Math.round(n)))
    setWaitText(String(value))
    if (value === savedWait) return
    save.mutate(
      { chatApprovalWaitMinutes: value },
      {
        onError: (e) => {
          setWaitText(String(savedWait))
          toast.error(e instanceof ApiError ? e.message : 'Could not update the approval wait.')
        },
      },
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

        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">Auto-allow all</div>
            <div className="text-[11px] text-faint">
              Skip the approval prompt for every tool set to Ask below. A tool set to Deny stays blocked.
            </div>
          </div>
          <Switch checked={autoAllowAll} onCheckedChange={setAutoAllowAll} disabled={save.isPending} />
        </div>

        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
          <label htmlFor="chat-approval-wait" className="min-w-0">
            <div className="text-[13px] font-medium text-ink">Wait for an answer</div>
            <div className="text-[11px] text-faint">
              Minutes a chat reply waits for your answers to its tools set to Ask, all its calls together. Past
              that, they are not run and the reply goes on. 0 waits until you answer.
            </div>
          </label>
          <div className="flex shrink-0 items-center gap-2">
            <input
              id="chat-approval-wait"
              type="number"
              inputMode="numeric"
              min={WAIT_MIN}
              max={WAIT_MAX}
              step={1}
              value={waitText}
              onChange={(e) => setWaitText(e.target.value)}
              onBlur={commitWait}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              disabled={save.isPending}
              className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none disabled:opacity-60"
            />
            <span className="text-[12px] text-muted">min</span>
          </div>
        </div>

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

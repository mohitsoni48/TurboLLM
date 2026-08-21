import { useState } from 'react'
import { Check, ChevronDown, Download, Loader2, Terminal } from 'lucide-react'
import { useAgentAvailability, useSettings, useStatus } from '../../lib/queries'
import { ApiError, installCodeAgent, track } from '../../lib/api'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { availableCodeAgents, CODE_AGENTS } from '../../lib/code-types'

/** Which coding agent NEW Code sessions launch with. Read once, at session creation
 *  (code-routes.ts) — changing this only affects sessions created afterward; an
 *  already-open session keeps whatever it was created with, same as its repoRoot. */
export function CodeAgentSection() {
  const { query: settingsQ, save } = useSettings()
  const statusQ = useStatus()
  // Only a daemon that explicitly says `false` has no terminal backend. `undefined` means the
  // daemon predates this flag, and every such build had node-pty as a hard dependency — so
  // treating "unknown" as available is the accurate reading, not an optimistic one.
  const terminalAvailable = statusQ.data?.terminalAvailable !== false
  const agents = availableCodeAgents(terminalAvailable)
  const current = settingsQ.data?.code?.defaultAgent ?? 'turbollm'
  // A stored agent that isn't in the offered list — someone who picked pi/opencode before they
  // were withdrawn, or `claude` on a machine whose terminal backend didn't install — must still be
  // reported honestly: the daemon keeps honoring the saved value for new sessions, so falling back
  // to the first entry here would label the trigger "turbollm" while Code actually launches
  // something else. Show what is really set, and say WHY it isn't in the list.
  const selected = agents.find((a) => a.id === current) ?? {
    id: current,
    label: current,
    description: CODE_AGENTS.some((a) => a.id === current && a.needsTerminal) && !terminalAvailable
      ? 'Needs a terminal, which this install does not have — choose one below to change it.'
      : 'No longer offered — choose one below to change it.',
  }

  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not update the Code agent.')

  // Which harnesses are actually on PATH. A missing one is NOT hidden (it is one `npm i -g` away,
  // and hiding it would make TurboLLM look like it doesn't support the tool) — it is shown,
  // refused for selection, and offered an install button. Before this, picking an uninstalled
  // harness opened a terminal that printed "<cli> is not installed or not on your PATH" and then
  // sat there dead, which is the failure ADR-239's rule exists to prevent.
  const availabilityQ = useAgentAvailability()
  const availability = availabilityQ.data?.agents
  const [installing, setInstalling] = useState<string | null>(null)
  /** Unknown (still loading, or the daemon predates this endpoint) counts as INSTALLED — the same
   *  reading `terminalAvailable` uses for an older daemon. Blocking selection on a missing answer
   *  would lock the picker for everyone on a daemon that simply can't report yet. */
  const infoFor = (id: string) => availability?.find((a) => a.id === id)
  const isInstalled = (id: string) => id === 'turbollm' || (infoFor(id)?.installed ?? true)

  const runInstall = async (id: string) => {
    setInstalling(id)
    try {
      await installCodeAgent(id)
      await availabilityQ.refetch()
      toast.success(`${id} installed — you can select it now.`)
    } catch (e) {
      // Surfaces npm's own diagnostic tail, which is far more actionable than "install failed".
      toast.error(e instanceof ApiError ? e.message : `Could not install ${id}.`)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-1 flex items-center gap-2">
        <Terminal size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Code agent</h2>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Which agent new Code sessions launch with. Applies only going forward — sessions already
        created keep the agent they started with.
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={save.isPending}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-left text-[13px] text-ink disabled:opacity-60"
          >
            <span>
              <span className="font-medium">{selected.label}</span>
              <span className="ml-2 text-[12px] text-muted">{selected.description}</span>
            </span>
            <ChevronDown size={14} className="shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
          {agents.map((agent) => {
            const installed = isInstalled(agent.id)
            const busy = installing === agent.id
            return (
              <DropdownMenuItem
                key={agent.id}
                // A not-installed harness must not be selectable. `disabled` alone is not enough:
                // Radix still fires onSelect for a programmatic/keyboard activation in some paths,
                // so the guard is repeated in the handler rather than trusted to the prop.
                disabled={!installed || busy}
                onSelect={(e) => {
                  if (!installed || busy) { e.preventDefault(); return }
                  if (agent.id === current) return
                  track('settings', 'set_default_code_agent')
                  save.mutate({ code: { defaultAgent: agent.id } }, { onError })
                }}
                className={cn('flex items-start justify-between gap-2', !installed && 'opacity-100')}
              >
                <div className={cn(!installed && 'opacity-55')}>
                  <div className="font-medium">{agent.label}</div>
                  <div className="text-[11px] text-muted">
                    {installed ? agent.description : `Not installed — ${infoFor(agent.id)?.installCommand ?? 'install it'}`}
                  </div>
                </div>
                {installed ? (
                  <Check size={14} className={cn('mt-0.5 shrink-0 text-accent', agent.id === current ? 'opacity-100' : 'opacity-0')} />
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    // Stop the click bubbling into the menu item, which would otherwise both close
                    // the menu and (before the guard above) attempt a selection.
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); void runInstall(agent.id) }}
                    onPointerDown={(e) => e.stopPropagation()}
                    // `pointer-events-auto` is LOAD-BEARING, not styling. The enclosing
                    // DropdownMenuItem is `disabled`, and dropdown-menu.tsx applies
                    // `data-[disabled]:pointer-events-none`, which the whole subtree inherits — so
                    // without this the button's onClick/onPointerDown can never fire and the Install
                    // affordance is decorative. Found by hostile QA; the sibling
                    // `data-[disabled]:opacity-50` had already been noticed and countered, this had not.
                    className="pointer-events-auto mt-0.5 flex shrink-0 items-center gap-1 rounded border border-border bg-panel-2 px-2 py-1 text-[11px] font-medium text-ink hover:bg-panel disabled:opacity-60"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {busy ? 'Installing…' : 'Install'}
                  </button>
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  )
}

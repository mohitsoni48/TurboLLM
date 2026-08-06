import { Check, ChevronDown, Terminal } from 'lucide-react'
import { useSettings, useStatus } from '../../lib/queries'
import { ApiError, track } from '../../lib/api'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import type { CodeAgent } from '../../lib/code-types'

// `pi` and `opencode` are deliberately NOT offered right now. Both are still supported end to end
// (cli-launch.ts, the CodeAgent type, and any session already created with one keeps working) —
// they're withdrawn from the picker until their terminal integration is actually verified against
// a real binary, rather than shipping a choice that half-works. Re-adding them is this list plus
// nothing else. Same rule as the engine catalog: don't offer what isn't confirmed (ADR-239).
//
// `needsTerminal` marks an agent that can only run inside a PTY. `node-pty` is an OPTIONAL
// dependency — it's a native module, and a failed build must not fail the install for everyone —
// so npm skips it silently when no prebuild fits the platform/ABI, and a perfectly healthy install
// can have no way to spawn a terminal at all. Those agents are hidden there rather than offered
// and then failing at session-open, which is the same ADR-239 rule applied per machine instead of
// per catalog.
const ALL_AGENTS: Array<{ id: CodeAgent; label: string; description: string; needsTerminal?: boolean }> = [
  { id: 'turbollm', label: 'turbollm', description: 'The built-in chat agent — uses whatever model TurboLLM has loaded.' },
  { id: 'claude', label: 'claude', description: 'Launches inside a full-screen terminal (turbollm launch claude).', needsTerminal: true },
]

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
  const agents = ALL_AGENTS.filter((a) => !a.needsTerminal || terminalAvailable)
  const current = settingsQ.data?.code?.defaultAgent ?? 'turbollm'
  // A stored agent that isn't in the offered list — someone who picked pi/opencode before they
  // were withdrawn, or `claude` on a machine whose terminal backend didn't install — must still be
  // reported honestly: the daemon keeps honoring the saved value for new sessions, so falling back
  // to the first entry here would label the trigger "turbollm" while Code actually launches
  // something else. Show what is really set, and say WHY it isn't in the list.
  const selected = agents.find((a) => a.id === current) ?? {
    id: current,
    label: current,
    description: ALL_AGENTS.some((a) => a.id === current && a.needsTerminal) && !terminalAvailable
      ? 'Needs a terminal, which this install does not have — choose one below to change it.'
      : 'No longer offered — choose one below to change it.',
  }

  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not update the Code agent.')

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
          {agents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => {
                if (agent.id === current) return
                track('settings', 'set_default_code_agent')
                save.mutate({ code: { defaultAgent: agent.id } }, { onError })
              }}
              className="flex items-start justify-between gap-2"
            >
              <div>
                <div className="font-medium">{agent.label}</div>
                <div className="text-[11px] text-muted">{agent.description}</div>
              </div>
              <Check size={14} className={cn('mt-0.5 shrink-0 text-accent', agent.id === current ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  )
}

import { Check, ChevronDown, Terminal } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { ApiError } from '../../lib/api'
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
const AGENTS: Array<{ id: CodeAgent; label: string; description: string }> = [
  { id: 'turbollm', label: 'turbollm', description: 'The built-in chat agent — uses whatever model TurboLLM has loaded.' },
  { id: 'claude', label: 'claude', description: 'Launches inside a full-screen terminal (turbollm launch claude).' },
]

/** Which coding agent NEW Code sessions launch with. Read once, at session creation
 *  (code-routes.ts) — changing this only affects sessions created afterward; an
 *  already-open session keeps whatever it was created with, same as its repoRoot. */
export function CodeAgentSection() {
  const { query: settingsQ, save } = useSettings()
  const current = settingsQ.data?.code?.defaultAgent ?? 'turbollm'
  // A stored agent that is no longer listed (someone who had picked pi/opencode before they were
  // withdrawn) must still be reported honestly: the daemon keeps honoring the saved value for new
  // sessions, so falling back to AGENTS[0] here would label the trigger "turbollm" while Code
  // actually launches pi. Show what is really set; the list below is what you can change it to.
  const selected = AGENTS.find((a) => a.id === current) ?? {
    id: current,
    label: current,
    description: 'No longer offered — choose one below to change it.',
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
          {AGENTS.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => {
                if (agent.id === current) return
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

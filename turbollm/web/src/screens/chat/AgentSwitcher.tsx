import { Check, ChevronDown, UserRound } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'

export interface SwitchableAgent { id: string; name: string; description: string }

/** The chat header's agent control. Before the first message the empty chat shows an agent picker; once a chat has
 *  messages this is how the agent is changed, so the same prompt can be tried with another agent without starting a
 *  new chat (GitHub #52). While a reply is generating (or the chat is read-only) it is the plain badge it used to be:
 *  the system prompt and tool list must not change under a turn that is already running. */
export function AgentSwitcher({ agents, selectedId, onSwitch, disabledReason }: {
  agents: readonly SwitchableAgent[]
  selectedId: string
  onSwitch: (id: string) => void
  /** Why switching is unavailable right now; absent when it is available. */
  disabledReason?: string
}) {
  const selected = agents.find((a) => a.id === selectedId)
  // An agent deleted in Customize after the chat began is no longer in the list: say so, and still let the user pick another.
  const label = selected?.name ?? 'Choose agent'
  const pill = 'items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted'

  if (disabledReason) {
    if (!selected) return null
    return (
      <span title={`${selected.description} — ${disabledReason}`} className={`hidden select-none sm:inline-flex ${pill}`}>
        <UserRound size={11} />
        {label}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Agent: ${label}. Change agent`}
          title={selected ? `${selected.description} — click to switch agent` : 'This chat’s agent no longer exists — pick another'}
          className={`inline-flex ${pill} transition-colors hover:border-accent hover:text-ink`}
        >
          <UserRound size={11} />
          <span className="max-w-[9rem] truncate">{label}</span>
          <ChevronDown size={11} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <p className="px-2 pb-1 pt-1.5 text-[11px] text-faint">
          Switching changes the system prompt and tools for the next reply. Earlier messages stay as they are.
        </p>
        {agents.map((a) => (
          <DropdownMenuItem
            key={a.id}
            className="items-start text-[13px]"
            onSelect={() => { if (a.id !== selectedId) onSwitch(a.id) }}
          >
            <Check size={13} className={`mt-0.5 shrink-0 ${a.id === selectedId ? 'text-accent' : 'invisible'}`} />
            <span className="min-w-0">
              <span className="block truncate">{a.name}</span>
              <span className="block truncate text-[11px] text-faint">{a.description}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { Check, ChevronDown, CircleSlash, Cpu, Loader2, SlidersHorizontal, Star } from 'lucide-react'
import type { ModelEntry } from '../lib/types'
import { usePinnedModels } from '../lib/usePinnedModels'
import { track } from '../lib/api'
import { toast } from './ui/sonner'
import { cn } from '../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/**
 * Model selector + eject control. Lists discovered models; selecting one loads it
 * (the engine auto-starts), and "Eject" stops the running engine. Shared by the
 * Chat and Models screens. Click the sliders icon (or Alt+click a row) to open its
 * config before loading.
 */
export function ModelLoadMenu({
  models,
  loadedKey,
  loadedName,
  pending,
  ejecting,
  onLoad,
  onEject,
  onSettings,
  align = 'start',
  screen,
  blockedReason,
}: {
  models: ModelEntry[]
  loadedKey?: string | null
  loadedName?: string | null
  pending?: boolean
  ejecting?: boolean
  onLoad: (key: string) => void
  onEject: () => void
  onSettings?: (key: string) => void
  align?: 'start' | 'end'
  screen: 'chat' | 'code'
  /** When set, this control cannot change the model, and clicking it explains why instead of
   *  opening the list. For a harness whose model can only be chosen from INSIDE its own TUI
   *  (opencode) — offering a picker that silently does nothing is worse than not offering one. */
  blockedReason?: string
}) {
  const { isPinned } = usePinnedModels()
  // Pinned models float to the top (same convention as the library list in ModelsScreen),
  // stable otherwise so unpinned order is unaffected.
  const loadable = models
    .filter((m) => !m.incomplete && !m.parseError)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const p = Number(isPinned(b.m.key)) - Number(isPinned(a.m.key))
      return p !== 0 ? p : a.i - b.i
    })
    .map(({ m }) => m)
  const label = ejecting ? 'Ejecting…' : (loadedName || (loadedKey ? 'Loaded model' : 'Load a model'))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-8 max-w-[160px] items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60 md:max-w-[260px]',
          blockedReason && 'cursor-not-allowed opacity-60 hover:border-border',
        )}
        disabled={pending}
        // Deliberately NOT the `disabled` attribute: a disabled button fires no click, so the user
        // gets a dead control and no explanation. Blocking the open here keeps it clickable purely
        // so the reason can be surfaced.
        title={blockedReason}
        onPointerDown={blockedReason ? (e) => { e.preventDefault(); toast.info(blockedReason) } : undefined}
      >
        {pending || ejecting ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : (
          <Cpu size={14} className={loadedKey ? 'text-accent' : 'text-muted'} />
        )}
        <span className="truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[60vh] w-[280px] overflow-y-auto">
        <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
          {loadable.length ? 'Load a model' : 'No models found'}
        </div>
        {loadable.map((m) => {
          const active = m.key === loadedKey
          const pinned = isPinned(m.key)
          return (
            <div
              key={m.key}
              role="menuitem"
              tabIndex={-1}
              className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none hover:bg-panel-2 focus:bg-panel-2"
              onClick={(e) => {
                if (e.altKey && onSettings) { track(screen, 'open_model_load_settings'); onSettings(m.key); return }
                if (!active) { track(screen, 'load_model'); onLoad(m.key) }
              }}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {active && <Check size={14} className="text-accent" />}
              </span>
              {pinned && <Star size={12} className="shrink-0 fill-current text-accent" />}
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {onSettings && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    track(screen, 'open_model_load_settings')
                    onSettings(m.key)
                  }}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-panel hover:text-ink"
                  title="Configure before loading"
                  aria-label={`Configure ${m.name} before loading`}
                >
                  <SlidersHorizontal size={13} />
                </button>
              )}
              <span className="shrink-0 text-[11px] uppercase text-faint">
                {m.quant}
              </span>
            </div>
          )
        })}
        {loadedKey && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { track(screen, 'eject_model'); onEject() }} style={{ color: 'var(--err)' }}>
              <CircleSlash size={14} /> Eject model
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

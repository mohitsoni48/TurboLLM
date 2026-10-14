import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { AlertTriangle, Check, ChevronDown, CircleSlash, Cloud, Cpu, Loader2, Search, SlidersHorizontal, Star } from 'lucide-react'
import { filterModelGroups, moveActiveIndex, resolveActiveIndex } from '../lib/model-picker-filter'
import type { ModelEntry } from '../lib/types'
import type { LinkRecord } from '../lib/link-api'
import { groupModelChoices, isFlat, type ModelChoice, type RemoteModelRow } from '../lib/remote-models'
import { usePinnedModels } from '../lib/usePinnedModels'
import { track } from '../lib/api'
import { toast } from './ui/sonner'
import { cn } from '../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/** Key of the Eject row in the keyboard highlight; NUL cannot occur in a model key or remote id. */
const EJECT_KEY = '\u0000eject'

type PickTarget = ModelChoice | typeof EJECT_KEY

const ROW_CLASS =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none data-[active]:bg-panel-2'
const SECTION_LABEL_CLASS = 'px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint'

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
  links,
  remoteModels,
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
  /** Turbo Link (ADR-376 §6.3). Both optional and both absent on every install with no
   *  links — in which case the list renders exactly as it did before Turbo Link existed,
   *  flat and unheaded. Capability state comes from these records' host-reported
   *  `grantedCapabilities`, never from a local guess about what a link "probably" allows. */
  links?: LinkRecord[]
  remoteModels?: RemoteModelRow[]
}) {
  const { isPinned } = usePinnedModels()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The highlight is tracked by the target's KEY, never by index, so a list refresh under an
  // open menu cannot slide it onto another row (ADR-389: a stray Enter must not load or eject).
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const handoffRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const idPrefix = useId()
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

  // All of the "which group, what does the user read, is this row pickable and why not"
  // logic lives in the PURE helper (lib/remote-models.ts) and is unit-tested there; this
  // component only renders what it returns.
  const repoByKey = new Map(loadable.flatMap((m) => (m.sourceRepo ? [[m.key, m.sourceRepo] as const] : [])))
  const groups = groupModelChoices({ local: loadable, links: links ?? [], remote: remoteModels ?? [] })
  const flat = isFlat(groups)
  const total = groups.reduce((n, g) => n + g.choices.length, 0)
  const searching = query.trim() !== ''
  const { groups: shown, choices } = filterModelGroups(groups, query, repoByKey)
  const nothingMatches = searching && shown.length === 0
  const targets: PickTarget[] = loadedKey ? [...choices, EJECT_KEY] : choices
  const targetKeys = targets.map(keyOfTarget)
  const disabledKeys = new Set(choices.filter((c) => c.disabled).map((c) => c.id))
  const activeIndex = resolveActiveIndex(activeKey, targetKeys, choices.length, searching, disabledKeys)
  const activeDescendantId = activeIndex < 0 ? undefined : domIdOfTarget(idPrefix, activeIndex, choices.length)

  useEffect(() => {
    if (activeDescendantId) document.getElementById(activeDescendantId)?.scrollIntoView({ block: 'nearest' })
  }, [activeDescendantId])

  // Radix forwards `onOpenAutoFocus` at runtime but omits it from DropdownMenu.Content's types,
  // hence a spread. On a touch device the event is left alone: Radix then focuses the content, which
  // blurs the composer and drops the soft keyboard instead of covering the list.
  const focusSearchOnOpen = {
    onOpenAutoFocus: (e: Event) => {
      if (window.matchMedia('(pointer: coarse)').matches) return
      e.preventDefault()
      inputRef.current?.focus({ preventScroll: true })
    },
  }

  function setOpenAndReset(next: boolean) {
    if (next && blockedReason) {
      toast.info(blockedReason)
      return
    }
    setOpen(next)
    if (!next) {
      setQuery('')
      setActiveKey(null)
    }
  }

  function openSettings(choice: ModelChoice) {
    handoffRef.current = true
    track(screen, 'open_model_load_settings')
    onSettings?.(choice.id)
  }

  function pick(target: PickTarget | undefined, { alt }: { alt: boolean }) {
    if (target === undefined) return
    if (target === EJECT_KEY) {
      track(screen, 'eject_model')
      onEject()
    } else if (target.disabled) {
      toast.info(target.disabledReason!)
      return
    } else if (alt && onSettings && !target.remote) {
      openSettings(target)
    } else if (target.id !== loadedKey) {
      // The QUALIFIED `<machine>/<model>` id for a remote choice: that is what the router
      // resolves on; the bare name is display only.
      track(screen, 'load_model')
      onLoad(target.id)
    }
    setOpenAndReset(false)
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    keepTypingInsideBox(e)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const modified = e.ctrlKey || e.metaKey || e.altKey
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !modified) {
      e.preventDefault()
      const next = moveActiveIndex(e.key, activeIndex, targets.length)
      setActiveKey(targetKeys[next] ?? null)
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      if (activeIndex >= 0) pick(targets[activeIndex], { alt: e.altKey })
    }
  }

  function highlightOnMouseMove(key: string) {
    return () => { if (activeKey !== key) setActiveKey(key) }
  }

  function renderChoice(choice: ModelChoice) {
    const active = choice.id === loadedKey
    const pinned = !choice.remote && isPinned(choice.id)
    const index = targetKeys.indexOf(choice.id)
    return (
      <div
        key={choice.id}
        id={optionId(idPrefix, index)}
        data-active={index === activeIndex ? '' : undefined}
        onMouseMove={highlightOnMouseMove(choice.id)}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={choice.disabled || undefined}
        // Deliberately NOT the `disabled` attribute, and never a bare grey row: a dead
        // control with no explanation sends the user hunting for a problem that isn't
        // there. The row stays clickable purely so the reason can be surfaced — the same
        // decision the trigger's `blockedReason` above already makes.
        title={choice.disabledReason}
        className={cn(ROW_CLASS, choice.disabled && 'cursor-not-allowed opacity-60')}
        onClick={(e) => pick(choice, { alt: e.altKey })}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {active && <Check size={14} className="text-accent" />}
        </span>
        {pinned && <Star size={12} className="shrink-0 fill-current text-accent" />}
        {choice.remote && <Cloud size={13} className="shrink-0 text-muted" aria-label="On another machine" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{choice.name}</span>
          {choice.machine && <span className="truncate text-[11px] text-faint">{choice.machine}</span>}
          {choice.disabledReason && (
            <span className="truncate text-[11px]" style={{ color: 'var(--warn)' }}>{choice.disabledReason}</span>
          )}
        </span>
        {onSettings && !choice.remote && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openSettings(choice)
              setOpenAndReset(false)
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-panel hover:text-ink"
            title="Configure before loading"
            aria-label={`Configure ${choice.name} before loading`}
          >
            <SlidersHorizontal size={13} />
          </button>
        )}
        <span className="shrink-0 text-[11px] uppercase text-faint">
          {choice.quant}
        </span>
      </div>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpenAndReset}>
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
      <DropdownMenuContent
        align={align}
        className="max-h-[min(60vh,var(--radix-dropdown-menu-content-available-height))] w-[280px] scroll-pt-11 overflow-y-auto"
        {...focusSearchOnOpen}
        onCloseAutoFocus={(e) => {
          // Radix would hand focus back to the trigger and steal it from the settings dialog.
          if (!handoffRef.current) return
          e.preventDefault()
          handoffRef.current = false
        }}
      >
        <PickerSearch
          inputRef={inputRef}
          value={query}
          onChange={(next) => { setQuery(next); setActiveKey(null) }}
          onKeyDown={handleSearchKeyDown}
          activeDescendantId={activeDescendantId}
          listId={listIdOf(idPrefix)}
        />
        <div id={listIdOf(idPrefix)} role="none">
          {nothingMatches && <div className={SECTION_LABEL_CLASS}>No matching models</div>}
          {flat ? (
            <>
              {!nothingMatches && (
                <div className={SECTION_LABEL_CLASS}>{total ? 'Load a model' : 'No models found'}</div>
              )}
              {(shown[0]?.choices ?? []).map(renderChoice)}
            </>
          ) : (
            shown.map((g) => (
              <div key={g.key}>
                <div className={cn('flex items-center gap-1.5', SECTION_LABEL_CLASS)}>
                  {g.kind === 'machine' && <Cloud size={12} className="shrink-0" />}
                  <span className="truncate">{g.label}</span>
                </div>
                {/* The link's own `lastError` — the actionable sentence — never a bare
                    "offline", the same rule the Turbo Link settings panel already follows. */}
                {g.note && (
                  <div
                    className="flex items-start gap-1.5 px-2 pb-1.5 text-[11px]"
                    style={{ color: g.status === 'unknown' ? 'var(--muted)' : 'var(--warn)' }}
                  >
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{g.note}</span>
                  </div>
                )}
                {g.kind === 'local' && g.choices.length === 0 && (
                  <div className="px-2 pb-1.5 text-[11px] text-faint">No local models found.</div>
                )}
                {g.choices.map(renderChoice)}
              </div>
            ))
          )}
          {loadedKey && (
            <>
              <DropdownMenuSeparator />
              <div
                role="menuitem"
                tabIndex={-1}
                id={ejectId(idPrefix)}
                data-active={targetKeys[activeIndex] === EJECT_KEY ? '' : undefined}
                onMouseMove={highlightOnMouseMove(EJECT_KEY)}
                className={ROW_CLASS}
                style={{ color: 'var(--err)' }}
                onClick={() => pick(EJECT_KEY, { alt: false })}
              >
                <CircleSlash size={14} /> Eject model
              </div>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PickerSearch({
  inputRef,
  value,
  onChange,
  onKeyDown,
  activeDescendantId,
  listId,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  onChange: (next: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  activeDescendantId: string | undefined
  listId: string
}) {
  return (
    <div className="sticky top-0 z-10 bg-panel pb-1">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search models"
          aria-expanded={true}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder="Search models"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-activedescendant={activeDescendantId}
          onKeyDown={onKeyDown}
          className="h-8 w-full rounded-md border border-border bg-bg pl-7 pr-2 text-base outline-none md:text-[13px]"
        />
      </div>
    </div>
  )
}

function keyOfTarget(target: PickTarget): string {
  return target === EJECT_KEY ? EJECT_KEY : target.id
}

function optionId(idPrefix: string, index: number): string {
  return `${idPrefix}-opt-${index}`
}

function ejectId(idPrefix: string): string {
  return `${idPrefix}-eject`
}

function listIdOf(idPrefix: string): string {
  return `${idPrefix}-list`
}

function domIdOfTarget(idPrefix: string, index: number, choiceCount: number): string {
  return index < choiceCount ? optionId(idPrefix, index) : ejectId(idPrefix)
}

/** Radix type-ahead hijacks every plain character typed inside the menu, so those keys must not
 *  bubble out of the box. Escape, Tab and Ctrl/Cmd/Alt combinations (except Alt+Enter, the
 *  settings shortcut) do bubble: Radix ignores modified keys, and the app's own window shortcuts
 *  (new chat, find, sidebar search, terminal toggle) must keep working with focus here. */
function keepTypingInsideBox(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Escape' || e.key === 'Tab') return
  const modified = e.ctrlKey || e.metaKey || e.altKey
  if (modified && !(e.altKey && e.key === 'Enter')) return
  e.stopPropagation()
}

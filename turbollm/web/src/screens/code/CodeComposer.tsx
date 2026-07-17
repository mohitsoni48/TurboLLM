import { useEffect, useState, type RefObject } from 'react'
import { Check, ChevronDown, CircleDot, FileText, FolderGit2, FolderOpen, GitBranch, ListTodo, Loader2, Plus, SendHorizontal, Square, Wand2, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { ModelLoadMenu } from '../../components/ModelLoadMenu'
import { ThinkingBudgetSlider } from '../../components/ThinkingBudgetSlider'
import type { ModelEntry } from '../../lib/types'
import { cn } from '../../lib/utils'
import { ContextUsageRing } from './ContextUsageRing'
import { AGENT_MODES, type AgentMode, type AgentModeId } from './code-mock'

// ── Shared Code composer ─────────────────────────────────────────────────────
//
// ONE component rendered by both CodeHomeScreen.tsx (starting a session) and
// CodeSessionScreen.tsx (following up on one) — extracted after the founder
// flagged that the two composers had drifted into visibly different UIs (a bare
// single-row textarea on the session view vs. the launchpad's full toolbar),
// which read as "the textfield changing" when a task was submitted. Keeping this
// as one component is the fix: whatever's added/changed here applies to both
// screens automatically instead of needing two hand-synced copies.
//
// Repo/worktree are the only thing genuinely fixed once a session starts (the
// repo is fixed for the session's lifetime) — pass `repo` to get that row on the
// "new session" form; omit it post-session, where that whole row is simply
// absent, not shown-disabled. Mode and model are BOTH editable "at any stage" —
// pre-session (sets what a new session starts with) and mid-session (mode
// PATCHes the session, taking effect on its next run; model loading is the
// engine-wide action ChatScreen already exposes) — so both controls render
// identically in either variant, no read-only fallback needed.
//
// Model + context-usage stay in this toolbar for BOTH variants (not the screen's
// header) — deliberately: they pair naturally with each other (which model, how
// much of its context window), and putting them in the composer means switching
// models is possible "at any stage" (launchpad AND mid-session) via the exact
// same control, with zero risk of the two screens' pickers drifting apart.

const MODE_ICONS: Record<AgentModeId, typeof Wand2> = {
  auto: Wand2,
  plan: ListTodo,
  ask: CircleDot,
}

export interface RepoPickerState {
  repoPath: string | null
  recentRepos: string[]
  onChoose: (path: string) => void
  onBrowse: () => void
  branchLabel: string
  branchTitle: string
  useWorktree: boolean
  onWorktreeChange: (v: boolean) => void
  branchName: string
  onBranchNameChange: (v: string) => void
  branchNamePlaceholder: string
  baseBranch: string
  onBaseBranchChange: (v: string) => void
  repoBranches: string[]
  currentBranch: string
}

export interface CodeComposerProps {
  inputRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onValueChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  textareaDisabled?: boolean

  /** Present only pre-session (CodeHomeScreen) — the repo/worktree row. Absent
   *  mid-session, where the repo is already fixed. */
  repo?: RepoPickerState

  mode: AgentMode
  /** Editable at any stage — pre-session (sets the mode a new session will start
   *  with) and mid-session (PATCHes the session). An auto↔ask switch takes effect
   *  LIVE within a run in flight: code-session.ts re-reads the mode fresh on every
   *  tool call to gate ask-mode approvals. Switching TO/FROM plan only takes effect
   *  on the NEXT run (plan's toolset is baked at session creation) — see
   *  code-routes.ts's PATCH /code/sessions/:id/mode. Same control, same slot, in
   *  both variants; only what `onModeChange` actually does differs upstream. */
  onModeChange: (m: AgentMode) => void

  models: ModelEntry[]
  loadedKey: string | null
  loadedName: string | null
  modelPending: boolean
  ejecting: boolean
  onLoadModel: (key: string) => void
  onEjectModel: () => void
  onModelSettings?: (key: string) => void

  ctxUsed: number
  ctxMax: number

  /** True while a run is streaming — swaps Send for Stop. */
  live?: boolean
  onStop?: () => void
  sendDisabled: boolean

  onAddContext?: () => void
  /** Absolute paths currently attached via "Add context" — rendered as removable chips.
   *  Cleared by the caller after a successful send (same lifecycle as `value`). */
  contextFiles?: string[]
  onRemoveContextFile?: (path: string) => void
  hintText: string

  /** -1 = unlimited (default), 0 = off, N>0 = a real token cap — same control/semantics as
   *  ChatScreen's own thinking budget slider (chat-routes.ts's `thinkingBudget`), applied to
   *  this session's turns via code-session.ts's before_provider_request hook. */
  thinkingBudget: number
  onThinkingBudgetChange: (v: number) => void

  /** '/' commands this composer variant supports (e.g. compact only applies mid-session, not on
   *  the launchpad's "start a new session" composer — see CodeSessionScreen/CodeHomeScreen for
   *  which list each passes). Selecting one INSERTS the token (`/id `), it does not submit —
   *  mirrors ChatScreen's own '/' skill picker exactly, so this reads as "the same feature" in
   *  both places rather than a lookalike. Omit/empty to render no picker at all. */
  slashCommands?: { id: string; description: string }[]
}

export function CodeComposer({
  inputRef, value, onValueChange, onSubmit, placeholder, textareaDisabled,
  repo, mode, onModeChange,
  models, loadedKey, loadedName, modelPending, ejecting, onLoadModel, onEjectModel, onModelSettings,
  ctxUsed, ctxMax, live, onStop, sendDisabled,
  onAddContext, contextFiles, onRemoveContextFile, hintText, slashCommands = [],
  thinkingBudget, onThinkingBudgetChange,
}: CodeComposerProps) {
  const ModeIcon = MODE_ICONS[mode.id]

  // '/' picker — only while the WHOLE input is still just the slash + a partial command name
  // (same match shape as ChatScreen's skill picker), so it never re-opens over a longer message
  // that merely starts with a slash.
  const slashMatch = /^\/([a-z0-9-]*)$/i.exec(value)
  const slashQuery = slashMatch?.[1]?.toLowerCase() ?? ''
  const filteredCommands = slashMatch
    ? slashCommands.filter((c) => !slashQuery || c.id.includes(slashQuery))
    : []
  const slashPickerOpen = !!slashMatch && filteredCommands.length > 0 && !live
  const [slashPickerIndex, setSlashPickerIndex] = useState(0)
  useEffect(() => { setSlashPickerIndex(0) }, [slashQuery, slashPickerOpen])

  const selectSlashCommand = (cmd: { id: string }) => {
    onValueChange(`/${cmd.id} `)
  }

  // Grow the textarea with its content (up to the CSS max-h-* cap below, which then scrolls
  // internally) instead of staying pinned at its initial `rows` height. Resetting to 'auto'
  // first lets scrollHeight reflect the CONTENT's natural height (not the previous inline
  // height) before growing/shrinking to match — also what makes it shrink back down after a
  // submit clears the value, not just grow one-way.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, inputRef])

  return (
    <div>
      <div className="relative">
        {/* '/' command picker */}
        {slashPickerOpen && (
          <div className="absolute bottom-full left-0 mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-border bg-panel shadow-[var(--shadow-2)]">
            {filteredCommands.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectSlashCommand(c)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-[13px]',
                  i === slashPickerIndex ? 'bg-panel-2' : 'hover:bg-panel-2',
                )}
              >
                <span className="text-ink">/{c.id}</span>
                <span className="text-[12px] text-muted">{c.description}</span>
              </button>
            ))}
          </div>
        )}
      <div className="rounded-[var(--radius-lg)] border border-border bg-panel shadow-[var(--shadow-2)] transition-colors focus-within:border-[color:var(--accent)]">
        {/* Repo/worktree row — pre-session only. Unticked (default) the task runs
            right in the repo folder on the checked-out branch; ticked, it gets its
            own worktree and a second row slides open for the new-branch name +
            base branch. Slide (grid-rows 0fr→1fr) instead of instant show/hide
            keeps the textarea below from jumping. */}
        {repo && (
          <div className="border-b border-border">
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title="Choose a repository"
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[12px] leading-none text-muted transition-colors hover:border-border-strong hover:text-ink"
                  >
                    <FolderGit2 size={12} />
                    {repo.repoPath ? repo.repoPath.split(/[\\/]/).filter(Boolean).pop() || repo.repoPath : 'Choose a repo…'}
                    <ChevronDown size={11} className="text-faint" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {repo.recentRepos.length === 0 && (
                    <DropdownMenuItem disabled>No recent repos yet</DropdownMenuItem>
                  )}
                  {repo.recentRepos.map((p) => (
                    <DropdownMenuItem key={p} onSelect={() => repo.onChoose(p)}>
                      <FolderGit2 size={13} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate" title={p}>{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
                      {p === repo.repoPath && <Check size={13} className="shrink-0 text-accent" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={repo.onBrowse}>
                    <FolderOpen size={13} className="text-muted" />
                    <span className="flex-1">Browse…</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {repo.repoPath && (
                <span
                  title={repo.branchTitle}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[12px] leading-none text-muted"
                >
                  <GitBranch size={12} />
                  {repo.branchLabel}
                </span>
              )}
              {/* Worktree tickbox — a real (sr-only) checkbox in chip clothing so it
                  keyboard/AT-behaves like a checkbox but sits in the strip's pill
                  language. Focus ring recreated via :has() since the global
                  :focus-visible rule can't reach the hidden input's label. */}
              <label
                title="Tick to run this task in a git worktree — an isolated checkout on its own branch. Untick to work directly in the repo folder on the current branch."
                className={cn(
                  'inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none transition-colors',
                  'has-[:focus-visible]:[outline:2px_solid_color-mix(in_srgb,var(--accent)_40%,transparent)] has-[:focus-visible]:[outline-offset:1px]',
                  repo.useWorktree
                    ? 'border-[color:var(--accent)] text-accent'
                    : 'border-border bg-panel-2 text-muted hover:border-border-strong hover:text-ink',
                )}
                style={repo.useWorktree ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={repo.useWorktree}
                  onChange={(e) => repo.onWorktreeChange(e.target.checked)}
                />
                <span
                  className="grid h-[13px] w-[13px] place-items-center rounded-[3px] border transition-colors"
                  style={repo.useWorktree
                    ? { background: 'var(--accent)', borderColor: 'var(--accent)' }
                    : { borderColor: 'var(--border-strong)' }}
                  aria-hidden
                >
                  {repo.useWorktree && <Check size={9} strokeWidth={3.5} style={{ color: 'var(--on-accent)' }} />}
                </span>
                Use worktree
              </label>
            </div>
            {/* Worktree details — kept mounted so the slide can animate; inert
                while collapsed so its fields drop out of the tab order. */}
            <div
              className={cn(
                'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                repo.useWorktree ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
              )}
              inert={!repo.useWorktree}
              aria-hidden={!repo.useWorktree}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
                  <label
                    title="Branch for the worktree — leave empty to accept the suggestion"
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[12px] leading-none text-muted transition-colors focus-within:border-[color:var(--accent)]"
                  >
                    <GitBranch size={12} className="shrink-0" />
                    <input
                      value={repo.branchName}
                      onChange={(e) => repo.onBranchNameChange(e.target.value)}
                      placeholder={repo.branchNamePlaceholder}
                      aria-label="New branch name"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-[164px] bg-transparent text-ink placeholder:text-faint md:w-[220px]"
                      style={{ outline: 'none' }}
                    />
                  </label>
                  <span className="text-[11px] text-faint">from</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="Base branch — where the new branch starts from"
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[12px] leading-none text-muted transition-colors hover:border-border-strong hover:text-ink"
                      >
                        <GitBranch size={12} />
                        {repo.baseBranch}
                        <ChevronDown size={11} className="text-faint" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {repo.repoBranches.length === 0 && (
                        <DropdownMenuItem disabled>{repo.currentBranch || 'No branches found'}</DropdownMenuItem>
                      )}
                      {repo.repoBranches.map((b) => (
                        <DropdownMenuItem key={b} onSelect={() => repo.onBaseBranchChange(b)}>
                          <GitBranch size={13} className="text-muted" />
                          <span className="flex-1">{b}</span>
                          {b === repo.currentBranch && <span className="text-[11px] text-faint">current</span>}
                          {b === repo.baseBranch && <Check size={13} className="text-accent" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="ml-auto hidden text-[11px] text-faint lg:inline">
                    Isolated copy — your checkout stays untouched
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Attached context-file chips — files picked via "Add context" (the Plus button in the
            toolbar below). Removable individually; cleared by the caller once the message sends,
            same lifecycle as the textarea's own value. */}
        {!!contextFiles?.length && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            {contextFiles.map((p) => (
              <span
                key={p}
                title={p}
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[12px] text-muted"
              >
                <FileText size={11} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate">{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
                {onRemoveContextFile && (
                  <button
                    type="button"
                    onClick={() => onRemoveContextFile(p)}
                    aria-label={`Remove ${p}`}
                    className="shrink-0 text-faint transition-colors hover:text-ink"
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Task input */}
        <textarea
          ref={inputRef}
          rows={repo ? 2 : 1}
          value={value}
          disabled={textareaDisabled}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (slashPickerOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashPickerIndex((i) => Math.min(i + 1, filteredCommands.length - 1)); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashPickerIndex((i) => Math.max(i - 1, 0)); return }
              if (e.key === 'Tab') { e.preventDefault(); selectSlashCommand(filteredCommands[Math.min(slashPickerIndex, filteredCommands.length - 1)]); return }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectSlashCommand(filteredCommands[Math.min(slashPickerIndex, filteredCommands.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); onValueChange(''); return }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() }
          }}
          placeholder={placeholder}
          className={cn(
            'w-full resize-none bg-transparent text-[15px] text-ink placeholder:text-faint',
            repo ? 'max-h-48 min-h-[64px] px-4 pt-3.5' : 'max-h-40 min-h-9 px-4 py-3',
          )}
          // The card's focus-within accent border is the focus indicator here; the
          // global :focus-visible ring on top of it reads as a double border.
          style={{ outline: 'none' }}
        />

        {/* Toolbar — same five-slot shape in both variants: mode | add-context |
            spacer | context ring | model | send/stop. Mode and model are both
            editable in both variants — "at any stage" applies to each identically.
            `overflow-x-auto` is a safety net on narrow phones — with every slot filled
            (mode + add-context + ring + thinking-budget + model + send/stop) the row
            can exceed a ~375px viewport; scrolling the row itself keeps Send reachable
            without changing layout at any width that already fits (same pattern the
            launchpad's activity heatmap already uses for its own overflow-prone row). */}
        <div className="flex items-center gap-1 overflow-x-auto px-2.5 pb-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={`${mode.label} — ${mode.desc}`}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                <ModeIcon size={13} />
                {mode.label}
                <ChevronDown size={12} className="text-faint" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {AGENT_MODES.map((m) => {
                const Icon = MODE_ICONS[m.id]
                return (
                  <DropdownMenuItem key={m.id} onSelect={() => onModeChange(m)}>
                    <Icon size={13} className="mt-0.5 self-start text-muted" />
                    {/* Label inherits DropdownMenuItem's base text-sm (14px) — the house
                        convention (ModelLoadMenu, EngineRow leave it unstyled too).
                        Description at 12px, the app's common secondary-text size. */}
                    <span className="flex min-w-0 flex-col">
                      <span className="text-ink">{m.label}</span>
                      <span className="text-[12px] text-muted">{m.desc}</span>
                    </span>
                    {m.id === mode.id && <Check size={13} className="ml-2 shrink-0 self-start text-accent" />}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          {onAddContext && (
            <button
              type="button"
              onClick={onAddContext}
              title="Add context — files, folders, or URLs"
              aria-label="Add context"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              <Plus size={15} />
            </button>
          )}
          <div className="flex-1" />
          <ContextUsageRing used={ctxUsed} max={ctxMax} />
          <ThinkingBudgetSlider value={thinkingBudget} onChange={onThinkingBudgetChange} />
          <ModelLoadMenu
            models={models}
            loadedKey={loadedKey}
            loadedName={loadedName}
            pending={modelPending}
            ejecting={ejecting}
            onLoad={onLoadModel}
            onEject={onEjectModel}
            onSettings={onModelSettings}
            align="end"
          />
          {live ? (
            // Mid-run: Stop controls the live run; a Send button also appears when
            // there's text to submit, so a follow-up can be QUEUED (fires after the
            // current run settles — see CodeSessionScreen's queue). Hidden when the
            // field is empty so the launchpad/idle look is unaffected.
            <>
              {!sendDisabled && (
                <Button
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={onSubmit}
                  aria-label="Queue follow-up"
                  title="Queue this follow-up — runs after the current run finishes"
                >
                  <SendHorizontal size={15} />
                </Button>
              )}
              <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={onStop} title="Stop this run">
                <Square size={15} />
              </Button>
            </>
          ) : (
            <Button size="icon" className="h-8 w-8 shrink-0" onClick={onSubmit} disabled={sendDisabled} aria-label="Send">
              <SendHorizontal size={15} />
            </Button>
          )}
        </div>
      </div>
      </div>
      {/* Persistent, always-visible busy indicator (founder-reported gap, 2026-07-13): the only
          "is the agent busy" signal near the composer used to be this hint's plain STRING swap
          (idle text ↔ running text) — no icon, no animation. The inline CodeThinking/
          CodeStreamingEntry activity live INSIDE the scrolling transcript body and can be
          scrolled out of view during a long run; this lives in the composer itself, so it's
          visible regardless of scroll position. Reuses CodeThinking's own spinner styling
          (Loader2, accent color) rather than inventing a new motion language. */}
      <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-[11px] text-faint">
        {live && <Loader2 size={11} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />}
        <span>{hintText}</span>
      </p>
    </div>
  )
}

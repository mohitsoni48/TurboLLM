import { useEffect, useRef, useState, type RefObject } from 'react'
import { Check, ChevronDown, CornerDownRight, FileText, FolderGit2, FolderOpen, GitBranch, HelpCircle, ListTodo, Loader2, Plus, SendHorizontal, Square, Wand2, X } from 'lucide-react'
import type { SteerKind } from '../../lib/code-types'
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
import { toast } from '../../components/ui/sonner'
import { browseFs, track } from '../../lib/api'
import type { ModelEntry } from '../../lib/types'
import { cn } from '../../lib/utils'
import { CodeStatsFooter } from './CodeStatsFooter'
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

// `ask` mode reuses the SAME icon as CodeTranscript's "awaiting approval" tool-card status
// (founder feedback, 2026-07-24: they're the same concept — ask mode is what makes that status
// possible — and used to have two unrelated icons with no visual link between them).
const MODE_ICONS: Record<AgentModeId, typeof Wand2> = {
  auto: Wand2,
  plan: ListTodo,
  ask: HelpCircle,
}

// ── `@`-mention file index (ADR-259) ─────────────────────────────────────────
//
// Backs the `@`-mention popover below. No dedicated repo-file-listing endpoint exists yet
// (spec 15 §3 anticipates one, containment-checked against the session's repoRoot) — rather
// than add new backend surface area from this composer-only task, this reuses the SAME
// local-only `/api/v1/fs/browse` endpoint FsBrowser/"Add context" already call one directory
// at a time (`browseFs`, lib/api.ts), just driven as a bounded breadth-first walk instead of
// one click at a time. Noise directories are skipped outright, and the walk stops once either
// cap is hit — cheap enough for a real repo, bounded enough that a huge one (or one full of
// build output the server doesn't filter for us) can't hang the popover.
const MENTION_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.turbo', '.next', '.cache', '.venv', 'venv', '__pycache__', '.git',
])
const MENTION_MAX_FILES = 500
const MENTION_MAX_DIRS = 150
const MENTION_MAX_RESULTS = 8

interface MentionFile { path: string; rel: string }

async function walkRepoFiles(root: string): Promise<MentionFile[]> {
  const files: MentionFile[] = []
  let dirsVisited = 0
  let level = [root]
  while (level.length && dirsVisited < MENTION_MAX_DIRS && files.length < MENTION_MAX_FILES) {
    const listings = await Promise.all(level.map((dir) => browseFs(dir).catch(() => null)))
    const nextLevel: string[] = []
    for (const listing of listings) {
      if (!listing) continue
      dirsVisited++
      for (const entry of listing.entries) {
        if (entry.isDir) {
          if (!MENTION_SKIP_DIRS.has(entry.name)) nextLevel.push(entry.path)
        } else if (files.length < MENTION_MAX_FILES) {
          files.push({ path: entry.path, rel: relativeToRoot(root, entry.path) })
        }
      }
      if (dirsVisited >= MENTION_MAX_DIRS || files.length >= MENTION_MAX_FILES) break
    }
    level = nextLevel
  }
  return files
}

function relativeToRoot(root: string, target: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const t = norm(target)
  return t.startsWith(`${r}/`) ? t.slice(r.length + 1) : t
}

// ── Image/screenshot paste (ADR-259) ─────────────────────────────────────────
//
// Wire format matches Chat's own vision pipeline exactly (ChatScreen.tsx's `attachments` state +
// chat-routes.ts's POST /messages `images?: string[]` field — a plain array of `data:image/...`
// URLs, folded server-side into OpenAI-format `image_url` content parts and passed to the model;
// image-only sends with no typed text are explicitly allowed there). Code has no equivalent
// `images` field threaded through `startCodeRun`/`code-routes.ts`/`code-session.ts` yet — adding
// that, plus updating `CodeSessionScreen.tsx`'s/`CodeHomeScreen.tsx`'s `send()` and `sendDisabled`
// to use it, is a follow-up outside this composer-only task (see `onImagesChange` below).
//
// Chat's own attach path (the paperclip file-picker in ChatScreen.tsx) enforces NO size cap at
// all. Paste/drop can silently attach a much larger screenshot than a click-driven file picker
// discourages, so a real ceiling is picked here rather than inheriting "none".
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface PendingImage {
  id: string
  name: string
  dataUrl: string
  size: number
}

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
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
  /** Submit the composed message. `kind` (Phase 1, ADR-246) is only meaningful while a run is
   *  live: 'steer' interjects into the CURRENT turn, 'followUp' queues a fresh turn after it.
   *  Omitted (Enter key, the idle/launchpad Send button) = the caller's default ('followUp'),
   *  byte-identical to the pre-ADR-246 behavior. */
  onSubmit: (kind?: SteerKind) => void
  placeholder: string
  textareaDisabled?: boolean

  /** Present only pre-session (CodeHomeScreen) — the repo/worktree row. Absent
   *  mid-session, where the repo is already fixed. */
  repo?: RepoPickerState

  /** Absolute path to the session's repo root — powers the `@`-mention file picker below.
   *  Pre-session this is redundant with `repo.repoPath` (used automatically when `repoRoot`
   *  itself is omitted); mid-session (CodeSessionScreen, which has no `repo` prop) a caller
   *  needs to pass the session's own `repoRoot` explicitly for `@`-mention to have anything
   *  to search. Omit entirely (both this and `repo`) to render no `@` picker at all. */
  repoRoot?: string

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
  /** A real, in-progress state (running / compacting) — founder feedback, 2026-07-17: the old
   *  approach folded this into `hintText` as tiny 11px faint-gray text below the composer,
   *  identical in weight to the boring "Enter to send" keyboard hint, so an actual in-flight
   *  operation (especially manual /compact, which disables the whole composer) was easy to miss
   *  entirely. Rendered instead as its own prominent, accent-colored banner directly ABOVE the
   *  textarea when present; `hintText` stays reserved for the idle keyboard-shortcut copy. */
  statusText?: string

  /** -1 = unlimited (default), 0 = off, N>0 = a real token cap — same control/semantics as
   *  ChatScreen's own thinking budget slider (chat-routes.ts's `thinkingBudget`), applied to
   *  this session's turns via code-session.ts's before_provider_request hook. */
  thinkingBudget: number
  onThinkingBudgetChange: (v: number) => void

  /** The session's checked-out branch — mid-session only (CodeSessionScreen, which has no
   *  `repo` prop). Powers the stats footer's branch readout (ADR-262); omit entirely to render
   *  no branch segment. Not needed pre-session — the launchpad's own repo-picker row already
   *  shows the branch as a chip (`repo.branchLabel`), so the footer skips it there to avoid
   *  showing the same branch name twice in one composer. */
  repoBranch?: string

  /** The most recently COMPLETED turn's real token counts (`MessageStats.promptTokens`/
   *  `genTokens`, chat-types.ts — real, backend-tracked data, not an estimate). Powers the stats
   *  footer's `↑`/`↓` readout (ADR-262). Both undefined (the default) renders no token segment
   *  at all rather than a misleading 0/0 — this is genuinely not wired from any caller yet (no
   *  per-turn stats are threaded into this component today), so it stays invisible until a
   *  caller starts passing real numbers. See CodeComposer's footer doc comment for the exact
   *  follow-up this needs (a `CodeSessionScreen.tsx` change, outside this task's scope). */
  lastPromptTokens?: number
  lastGenTokens?: number
  /** Same turn's real prefill/generation speed (`MessageStats.promptTps`/`tps`) — rendered
   *  alongside the token counts above, same undefined-means-omit rule. */
  lastPromptTps?: number
  lastGenTps?: number

  /** '/' commands this composer variant supports (e.g. compact only applies mid-session, not on
   *  the launchpad's "start a new session" composer — see CodeSessionScreen/CodeHomeScreen for
   *  which list each passes). Selecting one INSERTS the token (`/id `), it does not submit —
   *  mirrors ChatScreen's own '/' skill picker exactly, so this reads as "the same feature" in
   *  both places rather than a lookalike. Omit/empty to render no picker at all. */
  slashCommands?: { id: string; description: string }[]

  /** Fires whenever the pending pasted/dropped-image list changes (add, remove, or cleared on
   *  submit) — the images themselves are tracked as this component's own internal state (there's
   *  no lifted-state slot for them today, unlike `contextFiles`/`onRemoveContextFile` above,
   *  since wiring one through requires touching `CodeSessionScreen.tsx`/`CodeHomeScreen.tsx`,
   *  outside this task's scope). Optional: a caller that doesn't pass this simply won't observe
   *  the images, but the paste/drop/preview/remove UX still works standalone. See the
   *  `PendingImage`/`MAX_IMAGE_BYTES` comment above for the not-yet-wired backend side. */
  onImagesChange?: (images: PendingImage[]) => void
}

export function CodeComposer({
  inputRef, value, onValueChange, onSubmit, placeholder, textareaDisabled,
  repo, repoRoot, repoBranch, mode, onModeChange,
  models, loadedKey, loadedName, modelPending, ejecting, onLoadModel, onEjectModel, onModelSettings,
  ctxUsed, ctxMax, live, onStop, sendDisabled,
  onAddContext, contextFiles, onRemoveContextFile, hintText, statusText, slashCommands = [],
  thinkingBudget, onThinkingBudgetChange, onImagesChange, lastPromptTokens, lastGenTokens,
  lastPromptTps, lastGenTps,
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
    track('code', 'select_code_slash_command')
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

  // '@' file-mention picker — matched against the text immediately before the CARET (not the
  // whole input, unlike the '/' picker above), since a file mention can sit anywhere inside a
  // longer message ("fix the bug in @composer.tsx"). Triggers on an `@` preceded by start-of-
  // string or whitespace (so "email@domain" text never hijacks it) with no whitespace typed
  // since. `caret` is kept fresh via the textarea's own onChange/onSelect below.
  const effectiveRepoRoot = repo?.repoPath ?? repoRoot
  const [caret, setCaret] = useState(0)
  const beforeCaret = value.slice(0, caret)
  const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret)
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? ''
  const mentionStart = mentionMatch ? caret - mentionMatch[1].length - 1 : -1

  // Escape dismisses the popover without touching the typed text (unlike the '/' picker's
  // Escape, which can safely clear the whole input since a slash command IS the whole input).
  // Reset the dismissal the moment a NEW mention starts (a fresh `@`), not on every keystroke
  // of the same one, so re-typing after a dismissed one still offers to reopen it.
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const prevMentionStartRef = useRef(-1)
  useEffect(() => {
    if (mentionStart !== prevMentionStartRef.current) {
      setMentionDismissed(false)
      prevMentionStartRef.current = mentionStart
    }
  }, [mentionStart])

  // Lazy, cached-per-root file index — walked once the first time a mention is typed against a
  // given repo root, not on mount (most sessions/messages never use '@' at all).
  const [fileIndex, setFileIndex] = useState<MentionFile[] | null>(null)
  const [indexing, setIndexing] = useState(false)
  const indexedRootRef = useRef<string | null>(null)
  useEffect(() => {
    if (!effectiveRepoRoot || mentionStart === -1) return
    if (indexedRootRef.current === effectiveRepoRoot) return
    indexedRootRef.current = effectiveRepoRoot
    setIndexing(true)
    setFileIndex(null)
    void walkRepoFiles(effectiveRepoRoot)
      .then(setFileIndex)
      .finally(() => setIndexing(false))
  }, [effectiveRepoRoot, mentionStart])

  const mentionResults = fileIndex
    ? fileIndex.filter((f) => !mentionQuery || f.rel.toLowerCase().includes(mentionQuery)).slice(0, MENTION_MAX_RESULTS)
    : []
  const mentionPickerOpen =
    mentionStart !== -1 && !mentionDismissed && !live && !!effectiveRepoRoot && (indexing || mentionResults.length > 0)
  const [mentionIndex, setMentionIndex] = useState(0)
  useEffect(() => { setMentionIndex(0) }, [mentionQuery, mentionPickerOpen])

  // Splice `@<relative path> ` in at the mention's `@`, replacing the query typed so far —
  // NOT a whole-value replace like the slash picker's, since the mention can sit mid-message.
  // Caret restore happens in the effect below once React re-renders the textarea with the new
  // value (setSelectionRange on the same render would race the DOM update).
  const pendingCaretRef = useRef<number | null>(null)
  const selectMention = (f: MentionFile) => {
    if (mentionStart === -1) return
    track('code', 'select_code_file_mention')
    const before = value.slice(0, mentionStart)
    const after = value.slice(caret)
    const inserted = `@${f.rel} `
    onValueChange(before + inserted + after)
    pendingCaretRef.current = before.length + inserted.length
    setMentionDismissed(true)
  }
  useEffect(() => {
    if (pendingCaretRef.current == null) return
    const pos = pendingCaretRef.current
    pendingCaretRef.current = null
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(pos, pos)
    setCaret(pos)
  }, [value, inputRef])

  // Pasted/dropped image attachments — see the PendingImage/onImagesChange doc comments above
  // for the wire format this mirrors and what's still unwired on the send path.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  useEffect(() => { onImagesChange?.(pendingImages) }, [pendingImages]) // eslint-disable-line react-hooks/exhaustive-deps
  const [dragOver, setDragOver] = useState(false)

  const attachImageFile = async (file: File) => {
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(`${file.name || 'Image'} is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB — max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB).`)
      return
    }
    const dataUrl = await readImageAsDataUrl(file)
    setPendingImages((prev) => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name || 'pasted-image.png',
      dataUrl,
      size: file.size,
    }])
  }
  const removeImage = (id: string) => setPendingImages((prev) => prev.filter((img) => img.id !== id))

  // Only intercepts the paste when it actually carries an image — a normal text/code paste
  // (the overwhelmingly common case) falls through untouched.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (imageFiles.length === 0) return
    e.preventDefault()
    for (const file of imageFiles) void attachImageFile(file)
  }

  // Drag-and-drop onto the composer card — same attach path as paste, kept cheap since it's
  // bonus scope: only wired on the card that already exists, no new drop zone/overlay chrome.
  const handleDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
    for (const file of files) void attachImageFile(file)
  }

  // Optimistic clear, same as `value`/`contextFiles`' own clear-on-send convention in the
  // callers — but self-contained here since `pendingImages` has no lifted-state slot to be
  // cleared FROM (see PendingImage's doc comment: onSubmit still takes no arguments, so these
  // aren't actually in the request payload yet either way).
  const handleSubmit = (kind?: SteerKind) => {
    setPendingImages([])
    onSubmit(kind)
  }

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
        {/* '@' file-mention picker — same popover shape as the '/' picker above */}
        {mentionPickerOpen && (
          <div className="absolute bottom-full left-0 mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-border bg-panel shadow-[var(--shadow-2)]">
            {indexing && mentionResults.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted">Indexing repo files…</div>
            ) : mentionResults.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted">No matching files.</div>
            ) : (
              mentionResults.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => selectMention(f)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]',
                    i === mentionIndex ? 'bg-panel-2' : 'hover:bg-panel-2',
                  )}
                >
                  <FileText size={12} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={f.rel}>{f.rel}</span>
                </button>
              ))
            )}
          </div>
        )}
      <div
        className={cn(
          // overflow-hidden: without it, the in-progress status banner's own square corners
          // (it's the first child, no independent rounding) poke past this container's rounded
          // top edge instead of following it — the "running highlight clips" bug, founder-caught
          // testing live (2026-07-24). The `/`/`@` popovers are siblings of this div, not
          // children, so clipping here doesn't touch them.
          'overflow-hidden rounded-[var(--radius-lg)] border bg-panel shadow-[var(--shadow-2)] transition-colors focus-within:border-[color:var(--accent)]',
          dragOver ? 'border-[color:var(--accent)]' : 'border-border',
        )}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
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
                    <DropdownMenuItem key={p} onSelect={() => { track('code', 'select_code_repo'); repo.onChoose(p) }}>
                      <FolderGit2 size={13} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate" title={p}>{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
                      {p === repo.repoPath && <Check size={13} className="shrink-0 text-accent" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => { track('code', 'browse_code_repo'); repo.onBrowse() }}>
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
                // Phase 0 audit flagged this as --chip-active-bg (identical expression to
                // ConversationSidebar.tsx's active-row highlight) but recommended defining it at
                // the spec-11 app-wide level, not Code-scoped — that token wasn't part of task
                // #2's landed set (only the 8 Code-surface ones), so left inline here rather than
                // inventing it unilaterally outside this task's scope. See report for task #3.
                style={repo.useWorktree ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={repo.useWorktree}
                  onChange={(e) => repo.onWorktreeChange(e.target.checked)}
                />
                <span
                  className="grid h-3.5 w-3.5 place-items-center rounded-[3px] border transition-colors"
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
                        <DropdownMenuItem key={b} onSelect={() => { track('code', 'select_code_base_branch'); repo.onBaseBranchChange(b) }}>
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
                    onClick={() => { track('code', 'remove_code_context_file'); onRemoveContextFile(p) }}
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

        {/* Pasted/dropped image attachments — thumbnail + name + remove, same shape as Chat's
            own attachment preview (ChatScreen.tsx) so this reads as "the same feature" rather
            than a lookalike. Not yet part of the actual send payload — see PendingImage's doc
            comment above. */}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            {pendingImages.map((img) => (
              <span
                key={img.id}
                title={img.name}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel-2 py-1 pl-1 pr-2 text-[12px] text-muted"
              >
                <img src={img.dataUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                <span className="max-w-[120px] truncate">{img.name}</span>
                <button
                  type="button"
                  onClick={() => { track('code', 'remove_code_image'); removeImage(img.id) }}
                  aria-label={`Remove ${img.name}`}
                  className="shrink-0 text-faint transition-colors hover:text-ink"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Prominent in-progress banner (running / compacting) — directly above the textarea,
            accent-colored, its own row (not folded into the faint keyboard-hint text below). */}
        {statusText && (
          <div
            className="flex items-center gap-2 border-b px-3 py-2 text-[13px] font-medium"
            style={{
              // Phase 0 token wiring (spec 14 appendix): identical math to --instruction-border
              // (CodeTranscript's instruction-entry card), consolidated onto that one token
              // rather than a separate --status-banner-border, per the appendix's own note.
              borderColor: 'var(--instruction-border)',
              background: 'var(--status-banner-bg)',
              color: 'var(--accent)',
            }}
          >
            <Loader2 size={14} className="shrink-0 animate-spin" />
            <span>{statusText}</span>
          </div>
        )}

        {/* Task input */}
        <textarea
          ref={inputRef}
          rows={repo ? 2 : 1}
          value={value}
          disabled={textareaDisabled}
          onChange={(e) => { onValueChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length) }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (slashPickerOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashPickerIndex((i) => Math.min(i + 1, filteredCommands.length - 1)); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashPickerIndex((i) => Math.max(i - 1, 0)); return }
              if (e.key === 'Tab') { e.preventDefault(); selectSlashCommand(filteredCommands[Math.min(slashPickerIndex, filteredCommands.length - 1)]); return }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectSlashCommand(filteredCommands[Math.min(slashPickerIndex, filteredCommands.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); onValueChange(''); return }
            } else if (mentionPickerOpen && mentionResults.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionResults.length - 1)); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return }
              if (e.key === 'Tab') { e.preventDefault(); selectMention(mentionResults[Math.min(mentionIndex, mentionResults.length - 1)]); return }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectMention(mentionResults[Math.min(mentionIndex, mentionResults.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return }
            } else if (e.key === 'Escape' && live && onStop) {
              // Real, functional shortcut (not just advertised) — matches pi's own "escape
              // interrupt" convention (spec 14 §2.3). Gated behind the picker checks above so it
              // never fires while a popover is open and Escape's job there is to dismiss it.
              e.preventDefault()
              onStop()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
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
                  <DropdownMenuItem key={m.id} onSelect={() => { track('code', 'set_code_mode'); onModeChange(m) }}>
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
              onClick={() => { track('code', 'open_code_context_browser'); onAddContext() }}
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
            // Mid-run: Stop controls the live run; when there's text to submit, TWO send actions
            // appear (ADR-246) — Steer interjects into the CURRENT turn (redirects what it's doing
            // right now), Queue sends a fresh turn that runs AFTER it. Both are one click and both
            // visible (steer isn't hidden in a menu — it's a key new capability worth surfacing).
            // Enter still queues (the safe default, via handleSubmit() with no kind). Hidden when
            // the field is empty so the idle look is unaffected.
            <>
              {!sendDisabled && (
                <>
                  {/* handleSubmit calls the caller-supplied onSubmit prop, which
                      CodeSessionScreen already tracks as send_code_message at its own
                      assignment site — tracking here too would double-count. Not tracked
                      here; see the Batch 10 doc comment in telemetry/events/ui.ts. */}
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8 shrink-0"
                    onClick={() => handleSubmit('steer')}
                    aria-label="Steer the current turn"
                    title="Steer — interject into the current turn, redirecting what it's doing right now"
                  >
                    <CornerDownRight size={15} />
                  </Button>
                  <Button
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => handleSubmit('followUp')}
                    aria-label="Queue follow-up"
                    title="Queue — runs as a new turn after the current one finishes"
                  >
                    <SendHorizontal size={15} />
                  </Button>
                </>
              )}
              <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => { track('code', 'stop_code_generation'); onStop?.() }} aria-label="Stop this run" title="Stop this run">
                <Square size={15} />
              </Button>
            </>
          ) : (
            // Same as steer/follow-up above: onSubmit is already tracked by the caller.
            <Button size="icon" className="h-8 w-8 shrink-0" onClick={() => handleSubmit()} disabled={sendDisabled} aria-label="Send">
              <SendHorizontal size={15} />
            </Button>
          )}
        </div>
      </div>
      </div>
      {/* Persistent stats/keybind footer (ADR-262) — the REAL footer ADR-249 originally intended
          and task #8 shipped as a keybind-only placeholder for. Audited against every other
          display in this file first (founder-specified hard constraint — this composer already
          shipped and had to walk back one duplication today: the old version of THIS footer
          repeating the toolbar's mode label + ContextUsageRing's context%):
            - Mode is NOT repeated here — the toolbar's mode dropdown button is still the one
              place it's shown, unchanged.
            - Model name is NOT repeated here either, even though ADR-262's own reference list
              includes "model" — ModelLoadMenu's trigger already shows `loadedName` as permanent
              visible text (not just an icon), so adding it here would be the exact literal-text
              duplication class of bug, not a judgment call.
            - Context %/max IS shown here, as the actual digits — ContextUsageRing communicates
              roughly the same information via ring color + a hover tooltip, but never renders the
              percentage as always-visible text; this is genuinely the one place you can read the
              precise number without hovering or opening the Sheet, matching how pi/opencode's own
              footers are the ONLY place their percentage appears.
            - Thinking effort IS shown here, compactly — the toolbar's Brain icon color-codes
              on/off but never shows the actual budget value except in its title tooltip or its own
              open dropdown; this is new information, not a repeat.
            - Branch/cwd render ONLY in the mid-session variant (no `repo` prop) — pre-session, the
              launchpad's own repo-picker row already shows both (repoPath's folder name in the
              trigger, `repo.branchLabel` as a chip), so repeating them here would duplicate that
              row specifically.
            - Tokens ↑/↓ and t/s (`lastPromptTokens`/`lastGenTokens`/`lastPromptTps`/`lastGenTps`)
              are real backend-tracked data (`MessageStats`, chat-types.ts) — NOT fabricated, NOT
              an estimate — fed from `CodeSessionScreen.tsx`'s `lastRealStats`, itself sourced
              from `code-session.ts`'s `foldTurnUsage` (summed across every agentic round of the
              turn, mirroring Chat's own engine-agnostic timing fallback). Still `undefined` (no
              segment rendered) whenever the engine returns no usable usage at all.
          Keybinds are now genuinely PERMANENT (no more hiding while `textareaDisabled`) — each
          clause instead governs its own accuracy: "Enter to send" only claims true when the
          textarea can actually be typed into; "Esc to stop" only appears once a run is actually
          live (and is now a REAL handler on the textarea above, not just an advertised label).
          `flex-wrap` instead of the toolbar's own `overflow-x-auto` (flagged in the original audit
          as a narrow-phone workaround, not a pattern worth repeating): on a narrow viewport this
          wraps to a second line rather than clipping or requiring horizontal scroll.
          The strip itself now lives in CodeStatsFooter.tsx — the SAME component TerminalToolbar
          renders, so a terminal-agent session's footer is literally this footer rather than a
          hand-copied lookalike that has to be fixed twice (see that file's header for the
          2026-07-29 legibility pass). Everything above about WHICH stats belong here is unchanged
          by that move. */}
      <CodeStatsFooter
        thinkingBudget={thinkingBudget}
        ctxUsed={ctxUsed}
        ctxMax={ctxMax}
        lastPromptTokens={lastPromptTokens}
        lastGenTokens={lastGenTokens}
        lastPromptTps={lastPromptTps}
        lastGenTps={lastGenTps}
        branch={!repo ? repoBranch : undefined}
        cwd={!repo ? effectiveRepoRoot : undefined}
        hint={[
          !textareaDisabled ? hintText : null,
          !live && slashCommands.length > 0 ? '/ for commands' : null,
          !live && effectiveRepoRoot ? '@ to mention a file' : null,
          live ? 'Esc to stop' : null,
        ].filter(Boolean).join(' · ')}
      />
    </div>
  )
}

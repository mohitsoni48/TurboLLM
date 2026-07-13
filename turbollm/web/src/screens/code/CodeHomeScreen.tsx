import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PanelLeft } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { getPersonalization } from '../../lib/personas'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { cn } from '../../lib/utils'
import { ApiError } from '../../lib/api'
import { useGitBranch, useModelActions, useModels, useStatus } from '../../lib/queries'
import { createCodeSession } from '../../lib/code-api'
import { ConversationSidebar } from '../chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from '../chat/SidebarResizeHandle'
import { FsBrowser } from '../engines/FsBrowser'
import { ModelDetailDialog } from '../models/ModelDetailDialog'
import { CodeActivityHeatmap } from './CodeActivityHeatmap'
import { CodeComposer } from './CodeComposer'
import {
  AGENT_MODES,
  CODE_STATS,
  FUN_FACT,
  STARTER_TASKS,
  mockSessionDays,
  type CodeRange,
} from './code-mock'

/** Recently-used repo folders (this browser only) — a plain path list so the composer's
 *  repo pill has quick options beyond "Browse…" without TurboLLM tracking a project
 *  registry server-side (there isn't one; the picker is just the local filesystem). */
const RECENT_REPOS_KEY = 'tllm.code.recentRepos'
function readRecentRepos(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : []
  } catch { return [] }
}
function pushRecentRepo(path: string): string[] {
  const next = [path, ...readRecentRepos().filter((p) => p !== path)].slice(0, 6)
  try { localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next)) } catch { /* best-effort */ }
  return next
}

// ── Code launchpad (Workspace → Code) ────────────────────────────────────────
//
// The home view of Workspace's Code mode: a task composer pinned to the bottom
// of the viewport (mirrors ChatScreen's own composer mechanism — see the layout
// comments below), with the ambient coding-activity band (greeting, stats,
// session heatmap, recent sessions) scrolling above it. Shares the same
// resizable/collapsible ConversationSidebar column as ChatScreen — the sidebar
// shows this mode's history (code sessions) instead of chat's, based on the
// active route (see ConversationSidebar.tsx's `isCodeMode`), so the two
// histories never co-display.
// Repo, model, and session data are real (fs/browse + git-branch, GET /status, the
// code-routes.ts session API). Model loading reuses ChatScreen.tsx's own
// useModels/useModelActions hooks verbatim — selecting a model here is a real
// load, not a preview stub. The coding-activity stats/heatmap band stays mock —
// see code-mock.ts — until real diff-stat aggregation lands (Phase 1 plan §6 item 5).
// Submitting a task creates a real session and hands off to CodeSessionScreen.tsx,
// which renders the SAME CodeComposer for follow-ups — see that file for why.

const SESSION_DAYS = mockSessionDays()

const previewToast = () =>
  toast('Task handoff is the next milestone', {
    description: 'The Code launchpad is a UI preview — agent execution lands with the pi-SDK integration.',
  })

/** Suggest a worktree branch name from the task text — kebab of the first few
 *  words under a `turbo/` prefix (the naming agent-created branches will use).
 *  Shown as the branch input's placeholder so an empty field means "accept
 *  the suggestion" — zero typing in the common case. */
function suggestBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
  return slug ? `turbo/${slug}` : 'turbo/my-task'
}

/** Eight-ray starburst mark for the greeting — drawn inline so it stays on the
 *  accent token (spec 11 §1: no hardcoded color) and needs no asset. */
function Starburst({ className }: { className?: string }) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const r = (v: number) => Math.round((12 + Math.cos(a) * v) * 100) / 100
    const s = (v: number) => Math.round((12 + Math.sin(a) * v) * 100) / 100
    return <line key={i} x1={r(4.4)} y1={s(4.4)} x2={r(9.6)} y2={s(9.6)} />
  })
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" className={className} aria-hidden>
      {rays}
    </svg>
  )
}

/** Same segmented control as the Usage screen (kept local there too). */
function Segmented<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background: value === o.value ? 'var(--accent)' : 'transparent',
            color: value === o.value ? 'var(--on-accent)' : 'var(--muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Stat tile — mirrors the Usage screen's tile exactly, plus a quiet hover. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-4 transition-colors hover:border-border-strong">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">{value}</div>
    </div>
  )
}

export function CodeHomeScreen() {
  const navigate = useNavigate()
  const [range, setRange] = useState<CodeRange>('all')
  // Real repo picker: a path chosen via the local filesystem browser (no server-side
  // "known repos" registry — see FsBrowser). null until the user picks one.
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [recentRepos, setRecentRepos] = useState<string[]>(() => readRecentRepos())
  const [browserOpen, setBrowserOpen] = useState(false)
  const gitQ = useGitBranch(repoPath, !!repoPath)
  const repoBranch = gitQ.data?.isRepo ? gitQ.data.branch : ''
  const repoBranches = gitQ.data?.isRepo ? gitQ.data.branches : []

  const statusQ = useStatus()
  const model = statusQ.data?.model ?? null
  const engineState = statusQ.data?.engine.state
  const engineReady = engineState === 'running' && !!model

  // Real model catalog — identical hooks/handlers to ChatScreen.tsx (ADR-044: only
  // engine-compatible models are offered), so picking a model here triggers a real
  // load (the engine auto-starts), exactly like Chat's own model picker.
  const modelsQ = useModels()
  const modelActions = useModelActions()
  const allModels = (modelsQ.data?.models ?? []).filter((m) => m.compatibleWithActiveEngine)
  const modelBusy =
    modelActions.load.isPending ||
    modelActions.eject.isPending ||
    engineState === 'starting' ||
    engineState === 'stopping'
  const [settingsKey, setSettingsKey] = useState<string | null>(null)

  const handleLoadModel = (key: string) => {
    modelActions.load.mutate(
      { key },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.') },
    )
  }
  const handleEject = () => {
    modelActions.eject.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not eject model.'),
    })
  }

  const [mode, setMode] = useState(AGENT_MODES[0])
  const [input, setInput] = useState('')
  // Thinking budget — same control/semantics as ChatScreen's/CodeSessionScreen's own slider.
  // No session exists yet here, so this reads/writes only the shared global default
  // (`tllm.thinkingBudget.default`) — the new session's first run (auto-started by
  // CodeSessionScreen) falls back to that same key since it has no per-session value yet.
  const [thinkingBudget, setThinkingBudgetState] = useState<number>(() => {
    const v = localStorage.getItem('tllm.thinkingBudget.default')
    return v !== null ? Number(v) : -1
  })
  const setThinkingBudget = (val: number) => {
    localStorage.setItem('tllm.thinkingBudget.default', String(val))
    setThinkingBudgetState(val)
  }
  const [submitting, setSubmitting] = useState(false)
  // Worktree tick — off by default: the simple case is running right in the
  // repo folder on the checked-out branch. Ticked, the task gets an isolated
  // worktree on a new branch (name + base picked in the reveal row below).
  const [useWorktree, setUseWorktree] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const isDesktop = useIsDesktop()

  // Sidebar column — same collapse/resize state shape as ChatScreen.tsx (shared
  // constants/handle via SidebarResizeHandle.tsx) so the two modes feel like one
  // continuous surface, not two independently-behaving screens.
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(Math.max(readSavedSidebarWidth(), SIDEBAR_MIN_W), sidebarMaxW()))
  const sidebarRef = useRef<HTMLDivElement>(null)

  const userName = getPersonalization().userName.trim()
  const stats = CODE_STATS[range]

  // The launchpad's job is starting a task — put the cursor there on arrival.
  // Desktop only: autofocus on mobile would pop the keyboard over the page.
  useEffect(() => {
    if (isDesktop) inputRef.current?.focus()
  }, [isDesktop])

  // Once the picked repo's branch resolves, default the worktree's base branch to it
  // (the base a worktree normally branches from) — only when the user hasn't already
  // picked a different base for this repo.
  useEffect(() => {
    if (repoBranch) setBaseBranch(repoBranch)
  }, [repoBranch])

  const chooseRepo = (path: string) => {
    setRepoPath(path)
    setBranchName('')
    setRecentRepos(pushRecentRepo(path))
  }

  // "New session" (sidebar's New chat-equivalent in Code mode) fires this via
  // onNew below. There's nowhere to navigate TO — we're already on the blank
  // launchpad — so instead it resets the task-specific fields (the text just
  // submitted, and the worktree naming that was derived from it) while keeping
  // the picked repo and agent mode, which are more "current session defaults"
  // than "this task's text" and are more convenient left alone.
  const resetComposer = () => {
    setInput('')
    setUseWorktree(false)
    setBranchName('')
    inputRef.current?.focus()
  }

  const autoResize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`
  }

  const fillTask = (text: string) => {
    setInput(text)
    inputRef.current?.focus()
    setTimeout(autoResize, 0)
  }

  // Composer commands like /compact only make sense against an EXISTING session's real
  // history — CodeSessionScreen.tsx's composer handles them; this launchpad composer starts a
  // brand-new session, so typing one here as if it were a task would silently create a
  // nonsense session titled "/compact" and navigate away with no compaction having happened
  // (confirmed live — this exact thing happened before this guard existed). Catch it explicitly
  // rather than letting it become a real, confusing session.
  const KNOWN_SESSION_COMMANDS = new Set(['compact'])
  const slashCommandMatch = /^\/([a-z0-9-]+)\b/i.exec(input.trim())

  const send = async () => {
    const task = input.trim()
    if (!task || submitting) return
    if (slashCommandMatch && KNOWN_SESSION_COMMANDS.has(slashCommandMatch[1].toLowerCase())) {
      toast.error(`/${slashCommandMatch[1]} only works inside an existing session — start a task first, then use it as a follow-up.`)
      return
    }
    if (!repoPath) { toast.error('Choose a repository first.'); return }
    if (!engineReady || !model) { toast.error('Load a model first.'); return }

    setSubmitting(true)
    try {
      const { sessionId } = await createCodeSession({
        repoRoot: repoPath,
        repoBranch: repoBranch || undefined,
        modelKey: model.key,
        mode: mode.id,
        task,
        useWorktree,
        worktreeBranch: useWorktree ? (branchName.trim() || suggestBranchName(task)) : undefined,
        worktreeBase: useWorktree ? baseBranch : undefined,
      })
      navigate(`/workspace/code/${sessionId}`)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start the task.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
    {/* Outer row mirrors ChatScreen.tsx's top-level shape exactly: a resizable/
        collapsible ConversationSidebar column on the left (its own content driven
        by the active route — code sessions here, chat history on /workspace/chat)
        plus this screen's own column on the right. */}
    <div className="flex h-full overflow-hidden">
      {!isDesktop && mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden
        />
      )}
      <div
        ref={sidebarRef}
        className={cn(
          'tllm-chat-sidebar',
          isDesktop
            ? sidebarOpen ? 'shrink-0' : 'w-10 shrink-0'
            : cn(
                'fixed inset-y-0 left-0 z-40 w-[84vw] max-w-[300px] shadow-[var(--shadow-2)]',
                mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
              ),
        )}
        style={isDesktop && sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        <ConversationSidebar
          activeId={null}
          onSelect={(id) => { navigate(`/workspace/chat/${id}`); if (!isDesktop) setMobileSidebarOpen(false) }}
          onNew={() => { resetComposer(); if (!isDesktop) setMobileSidebarOpen(false) }}
          collapsed={isDesktop ? !sidebarOpen : false}
          onToggle={isDesktop ? () => setSidebarOpen((o) => !o) : () => setMobileSidebarOpen(false)}
        />
      </div>
      {isDesktop && sidebarOpen && <SidebarResizeHandle sidebarRef={sidebarRef} onCommit={setSidebarWidth} />}

    {/* Same mechanism as ChatScreen.tsx's own thread column: a fixed-height flex
        column with overflow-hidden, a `min-h-0 flex-1 overflow-y-auto` scroller
        for content, and the composer as a plain sibling AFTER the scroller.
        Because the scroller absorbs all remaining flex space, the composer's
        natural height lands pinned at the bottom of the viewport — no
        position:fixed needed. */}
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Top bar — mirrors ChatScreen's h-12 shrink-0 header: chrome that stays
          visible above the scroll area, not page content that scrolls away. */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 md:gap-3 md:px-8">
        {/* Mobile: open the conversation drawer (off-canvas below md, same as
            ChatScreen's own trigger). */}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0 md:hidden"
          onClick={() => setMobileSidebarOpen(true)}
          title="History"
          aria-label="Open sidebar"
        >
          <PanelLeft size={16} />
        </Button>
        {/* No Chat|Code mode switch here — the sidebar's pill (ConversationSidebar.tsx)
            is the single place to switch modes; duplicating it in this header too
            was redundant chrome. */}
        <span
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[11px] leading-none text-muted"
          title="Sessions run for real — the activity stats and heatmap below are illustrative until diff-stat tracking lands."
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--warn)' }} />
          Beta · activity stats are illustrative
        </span>
      </div>

      {/* Scrollable content — mirrors ChatScreen's `scrollerRef` div exactly. No
          max-width cap, same as ChatScreen's own message column: full-width flow,
          bounded only by px-4/md:px-8 padding. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex w-full flex-col px-4 py-6 md:px-8">
          {/* Greeting */}
          <div className="tllm-rise flex flex-col items-center text-center">
            <Starburst className="h-9 w-9 text-accent" />
            <h1 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">
              What&rsquo;s up next{userName ? `, ${userName}` : ''}?
            </h1>
            <p className="mt-1.5 text-[13px] text-muted">
              Hand a coding task to an agent that runs entirely on your machine.
            </p>
          </div>

          {/* Coding activity */}
          <div className="tllm-rise mt-12" style={{ animationDelay: '50ms' }}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Coding activity</h2>
              <Segmented
                value={range}
                onChange={setRange}
                options={[{ value: 'all', label: 'All' }, { value: '30d', label: '30d' }, { value: '7d', label: '7d' }]}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="Sessions" value={stats.sessions.toLocaleString()} />
              <StatTile label="Tasks shipped" value={stats.tasksShipped.toLocaleString()} />
              <StatTile label="Files touched" value={stats.filesTouched.toLocaleString()} />
              <StatTile label="Diff shipped" value={stats.diffShipped} />
              <StatTile label="Active days" value={stats.activeDays.toLocaleString()} />
              <StatTile label="Current streak" value={stats.currentStreak} />
              <StatTile label="Longest streak" value={stats.longestStreak} />
              <StatTile label="Favorite model" value={stats.favoriteModel} />
            </div>
            <div className="mt-3 rounded-lg border border-border bg-panel p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">Session activity</span>
                <span className="text-[11px] text-faint">one box = one day</span>
              </div>
              <CodeActivityHeatmap days={SESSION_DAYS} />
              <p className="mt-3 text-center text-[12px] italic text-muted">{FUN_FACT}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Composer — static bottom bar, mirrors ChatScreen's composer wrapper
          exactly (px-3 pb-3 md:px-8 md:pb-5, no max-width, natural-height sibling
          after the flex-1 scroller above — that's what pins it to the bottom). */}
      <div className="shrink-0 px-3 pb-3 md:px-8 md:pb-5">
        {/* Starter tasks: kept beside the composer they populate (quick-fill chips
            read best right next to the input, and the founder's brief only named
            greeting/stats/heatmap/sessions as content that flows into the scroll
            area) rather than up with the greeting. */}
        <div className="mb-3 flex flex-wrap justify-center gap-2">
          {STARTER_TASKS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => fillTask(t)}
              className="rounded-full border border-border bg-panel px-3 py-1.5 text-[12px] text-muted transition-all hover:-translate-y-px hover:border-[color:var(--accent)] hover:text-ink"
            >
              {t}
            </button>
          ))}
        </div>

        <CodeComposer
          inputRef={inputRef}
          value={input}
          onValueChange={(v) => { setInput(v); autoResize() }}
          onSubmit={() => void send()}
          placeholder="Describe a task or ask a question…"
          repo={{
            repoPath,
            recentRepos,
            onChoose: chooseRepo,
            onBrowse: () => setBrowserOpen(true),
            branchLabel: gitQ.isFetching ? '…' : gitQ.data?.isRepo ? (repoBranch || 'no commits') : 'no git',
            branchTitle: gitQ.isFetching ? 'Reading branch…' : gitQ.data?.isRepo ? `Checked-out branch: ${repoBranch || '(no commits yet)'}` : 'Not a git repository — no branch info',
            useWorktree,
            onWorktreeChange: setUseWorktree,
            branchName,
            onBranchNameChange: setBranchName,
            branchNamePlaceholder: suggestBranchName(input),
            baseBranch,
            onBaseBranchChange: setBaseBranch,
            repoBranches,
            currentBranch: repoBranch,
          }}
          mode={mode}
          onModeChange={setMode}
          models={allModels}
          loadedKey={model?.key ?? null}
          loadedName={model?.name ?? null}
          modelPending={modelBusy}
          ejecting={modelActions.eject.isPending}
          onLoadModel={handleLoadModel}
          onEjectModel={handleEject}
          thinkingBudget={thinkingBudget}
          onThinkingBudgetChange={setThinkingBudget}
          onModelSettings={(key) => setSettingsKey(key)}
          ctxUsed={0}
          ctxMax={model?.ctx ?? 0}
          sendDisabled={!input.trim() || !repoPath || !engineReady || submitting}
          onAddContext={previewToast}
          hintText="Enter to start · Shift+Enter for newline · 100% local — your code never leaves this machine"
        />
      </div>
    </div>
    </div>
    <FsBrowser
      open={browserOpen}
      onOpenChange={setBrowserOpen}
      onSelect={chooseRepo}
      mode="folder"
      title="Choose a repository"
      description="Open the project folder you want the agent to work in, then click Select this folder."
    />
    <ModelDetailDialog modelKey={settingsKey} onClose={() => setSettingsKey(null)} />
    </>
  )
}

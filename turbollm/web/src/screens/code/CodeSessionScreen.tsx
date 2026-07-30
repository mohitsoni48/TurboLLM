import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Diff, Download, Eraser, FolderOpen, GitBranch, MoreHorizontal, PanelLeft, Pencil, RotateCcw } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { skillKeys, fetchSkills } from '../../lib/agent-api'
import { useModelActions, useModels, useStatus } from '../../lib/queries'
import { compactCodeSession, execShellCommand, revertCodeSession, sendCodeQueuedTurnNow, startCodeRun, steerOutcomeMessage, stopCodeSession } from '../../lib/code-api'
import type { QueuedTurn, ShellRun, SteerKind } from '../../lib/code-types'
import {
  codeKeys, useClearCodeSession, useCodeSession, useCodeSessionLastUsage, useCodeSessionRename,
  useExportCodeSession, useResumeCodeSession, useUpdateCodeSessionMode, useUpdateCodeSessionThinkingBudget,
} from '../../lib/code-queries'
import { CodeSessionClient, type LiveState } from '../../lib/code-session-client'
import { matchCodeCommand, pickerCodeCommands } from '../../lib/code-commands'
import { toggleDisplayPref } from '../../lib/code-display-prefs'
import { Button, buttonVariants } from '../../components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { toast } from '../../components/ui/sonner'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { cn, folderName, formatDiff, writeLastCodeSessionId } from '../../lib/utils'
import { ToolApprovalBar } from '../chat/ToolApprovalBar'
import { ConversationSidebar } from '../chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from '../chat/SidebarResizeHandle'
import { ModelDetailDialog } from '../models/ModelDetailDialog'
import { FsBrowser } from '../engines/FsBrowser'
import { CodeComposer } from './CodeComposer'
import { CodeResourcesHeader } from './CodeResourcesHeader'
import { CodeGitDialog } from './CodeGitDialog'
import { CodeTranscript, CodeTranscriptSkeleton, TodoChecklist } from './CodeTranscript'
import { AGENT_MODES, type AgentModeId } from './code-mock'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { TerminalToolbar } from './TerminalToolbar'

/** The fixed prompt `/init` sends (ADR-258) — drives the agent to inspect the repo and author an
 *  AGENTS.md, which persona.ts's agentsMdBlock then picks up on every later turn. Sent as this
 *  turn's promptOverride only; the stored user message stays the literal "/init". */
const INIT_AGENTS_PROMPT =
  'Create or update an AGENTS.md file at the root of this repository. First inspect the project — ' +
  'its README, package/build manifests, test and lint scripts, directory layout, and dominant ' +
  'conventions — then write a concise AGENTS.md capturing: how to build, test, run, and lint the ' +
  'project; the key commands; the code style and conventions a contributor should follow; and ' +
  'anything non-obvious about the architecture. If an AGENTS.md already exists, review and improve ' +
  'it rather than overwriting it wholesale. Keep it practical and specific to THIS repo — no ' +
  'generic boilerplate.'

/** The real execution view for a Code session (Phase 1 plan §5) — streams from
 *  the real pi-SDK run via code-api.ts. Renders CodeTranscript.tsx (a
 *  deliberately non-chat activity-log presentation, not chat's MessageBubble —
 *  see that file's header comment for why) and the SAME CodeComposer
 *  CodeHomeScreen.tsx uses for follow-up "steer" messages on the same run, so
 *  starting a session doesn't feel like landing on a different app. A session
 *  starts with just its seeded task (one user message, no reply yet); this
 *  screen kicks off that first run automatically. */
export function CodeSessionScreen() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: status } = useStatus()
  const isDesktop = useIsDesktop()

  const detailQ = useCodeSession(sessionId ?? null)
  const session = detailQ.data?.session
  const conversation = detailQ.data?.conversation
  // /clear now DEACTIVATES its messages server-side (is_active=0, v34/ADR-261), the same mechanism
  // /revert uses — so the API already omits cleared history from `conversation.messages` (getMessages
  // filters is_active=1). No client-side cut is needed anymore; `messages` is just the active set the
  // screen renders/measures. /resume reactivates the range and the messages reappear on the next fetch.
  const messages = conversation?.messages ?? []

  // Rename — same shared hook/UX as the sidebar's CodeSessionItem (ConversationSidebar.tsx),
  // surfaced here too since the header is the bigger, always-visible spot for a session's title.
  const rename = useCodeSessionRename(session?.id, session?.title)

  // Mode — editable at any stage (not just at creation), same as the model
  // picker. `modeOverride` is the optimistic local value shown the instant the
  // user picks a new one; the PATCH (useUpdateCodeSessionMode) persists it and
  // the query refetch reconciles `session.mode` to match. Reset whenever the
  // session itself changes so a stale override never survives a navigation.
  const [modeOverride, setModeOverride] = useState<AgentModeId | null>(null)
  useEffect(() => { setModeOverride(null); setShellRuns([]) }, [sessionId])

  // Remember this as the last-opened Code session, so switching to Chat and back
  // via the Workspace mode pill (ConversationSidebar.tsx) restores it.
  useEffect(() => { if (sessionId) writeLastCodeSessionId(sessionId) }, [sessionId])
  const modeId = modeOverride ?? (session?.mode as AgentModeId | undefined) ?? 'auto'
  const modeInfo = AGENT_MODES.find((m) => m.id === modeId) ?? AGENT_MODES[0]
  const updateMode = useUpdateCodeSessionMode()
  const handleModeChange = (m: typeof AGENT_MODES[number]) => {
    if (!sessionId || m.id === modeId) return
    setModeOverride(m.id)
    updateMode.mutate(
      { id: sessionId, mode: m.id },
      { onError: (e) => { setModeOverride(null); toast.error(e instanceof ApiError ? e.message : 'Could not change mode.') } },
    )
  }

  // Model — the SAME hooks/handlers ChatScreen.tsx and CodeHomeScreen.tsx use.
  // Model loading is an engine-wide action (not scoped to this session), so
  // "changeable at any stage" needs no session-specific plumbing at all.
  const model = status?.model ?? null
  const engineState = status?.engine.state
  const modelsQ = useModels()
  const modelActions = useModelActions()
  const allModels = (modelsQ.data?.models ?? []).filter((m) => m.compatibleWithActiveEngine)
  const modelBusy =
    modelActions.load.isPending ||
    modelActions.eject.isPending ||
    engineState === 'starting' ||
    engineState === 'stopping'
  const [settingsKey, setSettingsKey] = useState<string | null>(null)
  const [gitDialogOpen, setGitDialogOpen] = useState(false)
  // A non-'turbollm' agent (config.ts's code.defaultAgent, snapshotted onto the session at
  // creation) means this session is terminal-only for its whole lifetime — no manual toggle,
  // no chat UI ever mounts for it. 'turbollm' (or the field being absent, for pre-existing
  // sessions) keeps today's chat behavior unchanged.
  const isTerminalSession = !!session?.codeAgent && session.codeAgent !== 'turbollm'
  const lastUsageQ = useCodeSessionLastUsage(sessionId ?? null, isTerminalSession)
  const lastUsage = lastUsageQ.data?.usage
  const exportMut = useExportCodeSession()
  // Imperative handle onto the live TerminalView (terminal-agent sessions only) — lets
  // handleLoadModel below drive the CLI's OWN `/model` command instead of killing and
  // relaunching the whole terminal (a relaunch loses the entire scrollback/conversation for a
  // switch the CLI can already do live). Confirmed LIVE against a real running session (not
  // assumed from docs, which turned out to describe a DIFFERENT case — see below):
  // `/model claude-<key>` sets the model IMMEDIATELY, no picker, no further interaction —
  // Claude Code printed "Set model to <name> — TurboLLM and saved as your default for new
  // sessions" the moment the command was sent. Claude Code's own docs say a direct `/model <id>`
  // argument only bypasses the picker in non-interactive `-p` mode; that turned out to describe
  // one-shot invocations only, not our case — a real, already-running interactive session DOES
  // accept it directly too. `claude-<key>` is the SAME alias id the gateway already advertises
  // via /v1/models (gateway.ts, ADR-158) — only present when gateway.autoSwap is on; if it is
  // off, Claude Code will show its own "model not found" error in the terminal, same as if the
  // user had mistyped it by hand.
  const terminalViewRef = useRef<TerminalViewHandle>(null)
  const handleLoadModel = (key: string) => {
    modelActions.load.mutate(
      { key },
      {
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.'),
        onSuccess: () => {
          if (isTerminalSession) {
            if (session?.codeAgent === 'claude') {
              // Verified direct-switch alias, this agent only (see comment above) — pi/opencode
              // have their OWN /model pickers (per their own docs) but their direct-argument
              // behavior hasn't been verified the same way, so fall through to the safer
              // open-the-picker path for them instead of guessing at their exact syntax.
              terminalViewRef.current?.sendCommand(`/model claude-${key}`)
            } else {
              terminalViewRef.current?.sendCommand('/model')
              toast.info('Model loaded — pick it from the /model picker now open in the terminal.')
            }
          }
        },
      },
    )
  }
  const handleEject = () => {
    // Ejecting kills the whole engine — stop this session's own daemon-owned run first (so it
    // doesn't fail mid-engine-call), mirroring ChatScreen's handleEject aborting live chat gen.
    if (sessionId) void stopCodeSession(sessionId).catch(() => {})
    modelActions.eject.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not eject model.'),
    })
  }

  // Thinking budget — same control/semantics/localStorage convention as ChatScreen's own
  // slider (including the shared `tllm.thinkingBudget.default` global fallback), just keyed
  // by sessionId instead of convId. -1 = unlimited (default), 0 = off, N>0 = a real cap.
  const readThinkingBudget = (sid: string | null): number => {
    if (sid) {
      const perSession = localStorage.getItem(`tllm.thinkingBudget.${sid}`)
      if (perSession !== null) return Number(perSession)
    }
    const global = localStorage.getItem('tllm.thinkingBudget.default')
    return global !== null ? Number(global) : -1
  }
  const [thinkingBudget, setThinkingBudgetState] = useState<number>(() => readThinkingBudget(sessionId ?? null))
  const updateThinkingBudget = useUpdateCodeSessionThinkingBudget()
  const setThinkingBudget = (val: number) => {
    if (sessionId) localStorage.setItem(`tllm.thinkingBudget.${sessionId}`, String(val))
    setThinkingBudgetState(val)
    // Terminal-agent sessions have no per-turn send call to attach this to — the CLI drives its
    // own requests directly against the gateway, so this is a live, server-enforced override
    // instead (session-auth.ts / gateway.ts), taking effect on the session's very next request.
    if (isTerminalSession && sessionId) {
      updateThinkingBudget.mutate(
        { id: sessionId, tokens: val },
        { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update thinking budget.') },
      )
    }
  }
  useEffect(() => {
    setThinkingBudgetState(readThinkingBudget(sessionId ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  // Sync the (localStorage-restored) budget to the backend once when a terminal-agent session
  // opens — otherwise the gateway override would only start reflecting reality after the user
  // actually touches the slider, even though a previously-saved non-default value is already
  // showing in the UI.
  useEffect(() => {
    if (!isTerminalSession || !sessionId) return
    updateThinkingBudget.mutate({ id: sessionId, tokens: readThinkingBudget(sessionId) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminalSession, sessionId])

  const [live, setLive] = useState<LiveState | null>(null)
  // The SERVER-side message queue's contents (tasks waiting behind the active run). Driven by
  // the daemon — `queue` SSE frames while streaming, plus the session detail on load — NOT
  // browser memory, so queued follow-ups survive a disconnect/reload and still fire in order
  // server-side. (Previously this was a client-only array that was lost on navigation.)
  const [queued, setQueued] = useState<QueuedTurn[]>([])
  // Transcript-only `!!command` results (ADR-258) — client-side, never persisted, rendered at the
  // transcript tail. `!command` results are NOT here; they come back as a persisted message.
  const [shellRuns, setShellRuns] = useState<ShellRun[]>([])
  // A queued follow-up's user message is persisted (POST /messages) the moment it's SUBMITTED,
  // not when its own turn actually starts — code-routes.ts's `enqueue` can leave it waiting
  // behind the active run for a while. Since `messages` renders in seq order, that follow-up's
  // instruction card would appear ABOVE the still-streaming current turn's live content (which
  // always renders last, after the full `messages` list) — reading as if the queued message had
  // jumped ahead (the ADR-199 ordering fix). Two cuts keep queued turns strictly at the tail:
  //   1. cut the transcript at the current live turn's own assistant placeholder — anything after
  //      it (an already-persisted but not-yet-started queued follow-up) stays out of `messages`;
  //   2. also drop any message whose id is a live queue entry — belt-and-suspenders for the brief
  //      on-load/reconnect window where the queue is seeded but `live` isn't set yet (cut #1's
  //      boundary doesn't exist), so a queued message never renders BOTH as a normal transcript
  //      card and as its inline translucent queued card (CodeTranscript renders those from
  //      `queued` directly, at the tail).
  const queuedIds = new Set(queued.map((q) => q.userMsgId))
  const liveBoundaryIdx = live ? messages.findIndex((m) => m.id === live.assistantId) : -1
  const cutMessages = liveBoundaryIdx === -1 ? messages : messages.slice(0, liveBoundaryIdx + 1)
  const transcriptMessages = queuedIds.size ? cutMessages.filter((m) => !queuedIds.has(m.id)) : cutMessages
  const [input, setInput] = useState('')
  // "Add context" — absolute paths picked via a file browser, sent alongside the next follow-up
  // as contextFiles (see code-api.ts's startCodeRun / code-routes.ts's contextFilesBlock).
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [contextBrowserOpen, setContextBrowserOpen] = useState(false)
  // The GET /stream subscription, owned by a React-free client (code-session-client.ts). It owns
  // the reconnect loop, the ring-buffer seq cursor, and the event-to-LiveState reduction; this
  // screen only mirrors its `onLive` into `live` state and drives connect()/abort(). Aborting only
  // DETACHES this client from the run — the daemon keeps executing it — so it never stops the run.
  const clientRef = useRef<CodeSessionClient | null>(null)
  const autoStartedRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(Math.max(readSavedSidebarWidth(), SIDEBAR_MIN_W), sidebarMaxW()))
  const sidebarRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback((force = false) => {
    const el = scrollerRef.current
    if (!el) return
    if (force || !userScrolledUp.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setShowScrollBtn(false)
    }
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const handler = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !atBottom
      setShowScrollBtn(!atBottom && !!live)
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [live])

  useEffect(() => { if (live) scrollToBottom() }, [live, scrollToBottom])

  // ── the single, reconnectable run subscription ────────────────────────────────
  // Build/tear down ONE React-free CodeSessionClient per mounted session. The client owns the
  // persistent GET /stream (replay-from-seq + live-tail + reconnect) and the event-to-LiveState
  // reduction; this screen only supplies the framework side effects (state sync, query
  // invalidation, toasts, scroll) and mirrors `onLive` into `live`. Recreating it per session is
  // what resets the seq cursor / active-assistant id (the old teardown effect's manual resets),
  // and its abort() DETACHES without stopping the daemon-owned run. Declared BEFORE the auto-start
  // / reconnect-on-load effects so clientRef.current is populated by the time they run.
  useEffect(() => {
    if (!sessionId) return
    const client = new CodeSessionClient(sessionId, {
      onLive: setLive,
      onQueue: setQueued,
      onTurnStart: () => { void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) }) },
      onTurnDone: () => {
        void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
        void qc.invalidateQueries({ queryKey: ['code-sessions'] })
        void qc.invalidateQueries({ queryKey: ['code-stats'] })
        setTimeout(() => scrollToBottom(true), 80)
      },
      onTurnError: (message) => {
        void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
        void qc.invalidateQueries({ queryKey: ['code-sessions'] })
        void qc.invalidateQueries({ queryKey: ['code-stats'] })
        toast.error(message)
      },
      onIdle: () => {
        void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
        void qc.invalidateQueries({ queryKey: ['code-sessions'] })
      },
      onLostConnection: (silent) => { if (!silent) toast.error('Lost connection to the run.') },
    })
    clientRef.current = client
    return () => {
      // DETACHES this client without stopping the daemon-owned run; discarding the instance resets
      // the reconnect cursor for the next session.
      client.abort()
      clientRef.current = null
      setLive(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Auto-start the first run of a freshly-created session (one seeded user message, no reply,
  // nothing live in the daemon). POST kicks it off server-side; then we connect to watch it.
  // Guarded by a ref so StrictMode double-invoke / refetches never fire it twice.
  useEffect(() => {
    if (!sessionId || !detailQ.isSuccess) return
    if (autoStartedRef.current === sessionId) return
    // Terminal-agent sessions have no daemon-owned "run" at all — the seeded first user message
    // is just the session's title/prompt, and the actual work happens entirely inside the
    // external CLI in the terminal. Without this guard, a terminal-agent session's very first
    // load silently kicks off the built-in turbollm agent loop (real tool calls, real token
    // spend) behind a UI that never even mounts a transcript to show it happened.
    const needsFirstRun = !isTerminalSession && messages.length === 1 && messages[0]?.role === 'user' && !detailQ.data?.running
    if (needsFirstRun) {
      autoStartedRef.current = sessionId
      // Read directly rather than closing over `thinkingBudget` state: navigating between two
      // already-visited sessions (no remount, only the :sessionId param changes) can run this
      // effect in the SAME commit as the sibling effect that resyncs `thinkingBudget` for the
      // new session — the state update from that effect hasn't applied yet, so the closure here
      // would still hold the PREVIOUS session's value. readThinkingBudget is a synchronous
      // localStorage read, immune to that ordering race.
      void startCodeRun(sessionId, '', readThinkingBudget(sessionId))
        .then(() => { void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) }); clientRef.current?.connect() })
        .catch((e) => { autoStartedRef.current = null; toast.error(e instanceof ApiError ? e.message : 'Could not start the run.') })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, detailQ.isSuccess, messages.length])

  // Reconnect on load: a session opened while a run is live in the daemon (closed the tab and
  // came back, reloaded, opened on another device) must ATTACH to that run — replaying its
  // buffered history and continuing live — instead of assuming a fresh page has nothing in flight.
  useEffect(() => {
    if (!sessionId || !detailQ.isSuccess) return
    if (detailQ.data?.running && !clientRef.current?.isActive) clientRef.current?.connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, detailQ.isSuccess, detailQ.data?.running])

  // Seed the queued turns from the session detail on load, until the stream's own `queue` frames
  // take over as the live source of truth. (Rendered inline as cards at the transcript tail now,
  // not the old below-composer chip strip — see CodeTranscript's CodeQueuedEntry.)
  useEffect(() => {
    if (!clientRef.current?.isActive) setQueued(detailQ.data?.queued ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, detailQ.data?.queued])

  // `/compact [focus instructions]` — a composer command, not a normal turn: it never reaches
  // startCodeRun/the daemon queue, just the dedicated compact endpoint. Case-insensitive,
  // optional trailing free text becomes pi's customInstructions (mirrors pi's own `/compact
  // [instructions]`). Any run must be idle first (the route 409s otherwise) — this only ever
  // sends when nothing's live, so there's no need to check `live` here too.
  // '/' skill picker — same shared skills library ChatScreen's own picker reads (lib/agent-api.ts),
  // but Code's invocation model differs: there's no persistent "enabled skills" state to mutate
  // here (unlike Chat's conversations.skillIds), so the model only knows to use a skill via a real
  // invoke_skill(skillId, task) TOOL CALL (persona.ts's skillCatalogBlock) — plain "/skillid" text
  // means nothing to it. Submitting "/skillid task" USED TO rewrite the stored/displayed message
  // itself into an explicit tool instruction — the founder flagged this as bad UX (your own typed
  // message shouldn't be silently altered). Now the literal text is always what's stored/shown;
  // skillPromptOverride computes a SEPARATE string sent only as this turn's prompt (see
  // startCodeRun's promptOverride param / code-routes.ts) to still reliably steer the model
  // toward invoke_skill, without touching what the user actually typed.
  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, staleTime: 30_000 })
  const SKILL_RE = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i
  const skillPromptOverride = (text: string): string | undefined => {
    const match = SKILL_RE.exec(text)
    const skill = match ? (skillsQ.data ?? []).find((s) => s.id === match[1]) : undefined
    const task = (match?.[2] ?? '').trim()
    return skill && task ? `Use the invoke_skill tool with skillId "${skill.id}" for this task: ${task}` : undefined
  }

  // Founder-reported UX gap, 2026-07-17: manual /compact showed NO progress indication at all
  // while compactCodeSession awaited (a real LLM summarization call, easily several seconds to a
  // minute+) — the composer just went blank with nothing to show for it until a toast finally
  // landed. `live.compacting` (driving the SAME "Compacting conversation…" hint text below) only
  // ever fires for AUTO-compaction's SSE event mid-turn; the manual command is a separate,
  // non-streaming POST with no live state of its own until now.
  const [manualCompacting, setManualCompacting] = useState(false)
  const runCompact = async (text: string) => {
    if (!sessionId) return
    // `text` is always a /compact input here (send() dispatched on it) — read its captured
    // argument (pi's customInstructions) back off the same registry pattern that matched it.
    const instructions = matchCodeCommand(text)?.match[1]?.trim() || undefined
    setInput('')
    setManualCompacting(true)
    try {
      const result = await compactCodeSession(sessionId, instructions)
      void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      toast.success(`Compacted — ${result.tokensBefore.toLocaleString()} tokens of history summarized.`)
    } catch (e) {
      setInput(text) // restore so the command isn't lost
      if (e instanceof ApiError && e.code === 'nothing_to_compact') toast.info('Nothing to compact yet — history is already short enough.')
      else toast.error(e instanceof ApiError ? e.message : 'Could not compact.')
    } finally {
      setManualCompacting(false)
    }
  }

  // `/clear` hides the conversation so far (repo/worktree/branch untouched, nothing deleted);
  // `/resume` un-hides it. Same "composer command, not a real turn" shape as /compact above.
  // Their triggers live in the shared registry (code-commands.ts) — see send()'s dispatch.
  const clearMut = useClearCodeSession()
  const resumeMut = useResumeCodeSession()
  const runClear = async () => {
    if (!sessionId) return
    setInput('')
    try {
      await clearMut.mutateAsync(sessionId)
      toast.success('Chat cleared — use /resume or the banner above to bring it back.')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'nothing_to_clear') toast.info(e.message)
      else toast.error(e instanceof ApiError ? e.message : 'Could not clear.')
    }
  }
  const runResume = async () => {
    if (!sessionId) return
    setInput('')
    try {
      await resumeMut.mutateAsync(sessionId)
      toast.success('Chat resumed.')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_cleared') toast.info(e.message)
      else toast.error(e instanceof ApiError ? e.message : 'Could not resume.')
    }
  }

  // Revert-to-message: rewinds the transcript to just before a user message — deactivating it
  // and everything after it (v33; independent of /clear's clearedUpToMessageId cursor — /resume
  // still un-hides it) — and refills the composer with that message's ORIGINAL text. When the
  // discarded range touched real files (any edit-tool call with a stored patch), asks whether to
  // ALSO reverse-apply those edits — reverting the transcript alone is always safe/reversible;
  // reverting files is a real, separate, less-reversible action the user should explicitly opt into.
  const [pendingRevert, setPendingRevert] = useState<{ messageId: string; hasFileEdits: boolean } | null>(null)
  const openRevertConfirm = (messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId)
    const hasFileEdits = idx !== -1 && messages.slice(idx).some((m) => m.toolCalls.some((tc) => tc.name === 'edit' && !!tc.patch))
    setPendingRevert({ messageId, hasFileEdits })
  }
  const runRevert = async (messageId: string, revertFiles: boolean) => {
    if (!sessionId) return
    try {
      const result = await revertCodeSession(sessionId, messageId, revertFiles)
      void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      setInput(result.revertText)
      if (result.failedFiles.length) {
        toast.warning(`Reverted — ${result.failedFiles.length} file(s) couldn't be cleanly reverted (they may have drifted since).`)
      } else if (result.revertedFiles.length) {
        toast.success(`Reverted the chat and ${result.revertedFiles.length} file(s).`)
      } else {
        toast.success('Reverted to this message.')
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not revert.')
    }
  }

  // `!command`/`!!command` shell escape (ADR-258): run the command in the repo, not a model turn.
  // `!` (feedToModel) persists the command+output as a user message the model reads next turn — it
  // shows up in the transcript via the detail refetch (as a `shell` tool call on that message). `!!`
  // is transcript-only: its result is held in ephemeral client state and never persisted or fed to
  // the model.
  const runShell = async (bang: string, command: string) => {
    if (!sessionId || !command) return
    const feedToModel = bang === '!'
    setInput('')
    userScrolledUp.current = false
    try {
      const res = await execShellCommand(sessionId, command, feedToModel)
      if (feedToModel) {
        void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      } else {
        setShellRuns((r) => [...r, { id: `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, command: res.command, output: res.output, exitCode: res.exitCode, timedOut: res.timedOut }])
      }
      setTimeout(() => scrollToBottom(true), 60)
    } catch (e) {
      setInput(`${bang}${command}`) // restore so the command isn't lost
      toast.error(e instanceof ApiError ? e.message : 'Could not run the command.')
    }
  }

  // `kind` (Phase 1, ADR-246) picks how this message is delivered when a run is already active:
  // 'followUp' (the default — byte-identical to pre-ADR-246 behavior) queues a fresh turn behind
  // the active one; 'steer' redirects the CURRENTLY ACTIVE turn. The UI trigger that chooses which
  // is being built separately in CodeComposer.tsx — this signature is the plumbing it calls into.
  const send = async (kind: SteerKind = 'followUp') => {
    const text = input.trim()
    if (!text || !sessionId) return
    // Built-in composer commands — matched against the ONE shared registry (code-commands.ts) that
    // also feeds the '/' picker's list, then dispatched by id. Most never reach startCodeRun (their
    // own endpoint / an instant client-side toggle); `/init` is the exception — a real agentic turn
    // with a fixed prompt (falls through below). Anything not a built-in becomes a normal turn (with
    // skillPromptOverride still steering an invoke_skill for a "/skillid task").
    const command = matchCodeCommand(text)
    if (command) {
      if (command.id === 'compact') { await runCompact(text); return }
      if (command.id === 'clear') { await runClear(); return }
      if (command.id === 'resume') { await runResume(); return }
      // `/details` + `/thinking` (ADR-258) — instant global display toggles, not a turn. The
      // literal command text is never stored/sent; it just flips a persisted UI preference.
      if (command.id === 'details' || command.id === 'thinking') {
        const on = toggleDisplayPref(command.id)
        setInput('')
        toast.success(command.id === 'details'
          ? `Tool-call details ${on ? 'shown' : 'collapsed'} for every step.`
          : `Reasoning ${on ? 'always shown' : 'hidden by default'}.`)
        return
      }
      // `!command` / `!!command` (ADR-258) — run a shell command in the repo, not a model turn.
      // match[1] is the bang ('!' feeds output to the model as context, '!!' doesn't), match[2] the
      // command. Never reaches startCodeRun.
      if (command.id === 'shell') { await runShell(command.match[1], command.match[2].trim()); return }
    }
    // `/init` (ADR-258) is a real turn: the composer text stays "/init" (shown verbatim, per the
    // founder's don't-rewrite-my-message rule) while a fixed instruction is what's actually prompted
    // — the agent inspects the repo and writes AGENTS.md, which persona.ts's agentsMdBlock reads back
    // on every subsequent turn. Same promptOverride mechanism the "/skillid task" shorthand uses.
    const promptOverride = command?.id === 'init' ? INIT_AGENTS_PROMPT : skillPromptOverride(text)
    const filesToSend = contextFiles
    setInput('')
    setContextFiles([])
    userScrolledUp.current = false
    // Always POST: the daemon starts the turn if idle, or QUEUES it (in order) behind the active
    // run. Either way it's owned server-side, so a queued follow-up survives a disconnect. The
    // open stream reflects the result (a new `queue` frame, or the turn going live when it runs).
    try {
      const res = await startCodeRun(sessionId, text, thinkingBudget, promptOverride, filesToSend, kind)
      // `steered` reports whether a steer actually injected into the live turn vs. was queued —
      // confirm the real outcome. followUp needs no toast: its queued card already shows inline.
      if (kind === 'steer') toast.success(steerOutcomeMessage(res.steered))
      void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      clientRef.current?.connect()
    } catch (e) {
      setInput(text) // restore so the message isn't lost
      setContextFiles(filesToSend)
      toast.error(e instanceof ApiError ? e.message : 'Could not send.')
    }
  }

  const handleStop = async () => {
    if (!sessionId) return
    // Stop the DAEMON's run + clear its server-side queue. The open stream will receive the
    // aborted turn's terminal frame and then end on its own — don't abort the stream here.
    setQueued([])
    await stopCodeSession(sessionId).catch(() => {})
  }

  // "Send now" on a queued card: stops the active turn and promotes this one to run next,
  // WITHOUT dropping the rest of the queue (unlike handleStop above). No optimistic setQueued
  // here — the reordered queue comes back as a fresh `queue` SSE frame moments later, and
  // guessing the reorder client-side risks a flash of the wrong order if it doesn't match.
  const handleSendNow = async (userMsgId: string) => {
    if (!sessionId) return
    await sendCodeQueuedTurnNow(sessionId, userMsgId).catch(() => {})
  }

  // At most one tool call awaits interactive approval at a time (ask mode's gate is
  // sequential — same invariant ChatScreen relies on).
  const pendingApprovalBlock = live?.timeline.find((b) => b.kind === 'tool' && b.call.status === 'awaiting_approval')
  const pendingApproval = pendingApprovalBlock?.kind === 'tool' ? pendingApprovalBlock.call : undefined

  // The last assistant message with a REAL ctxUsed, not just the last assistant row — a new turn
  // gets an empty placeholder row (code-run-manager.ts's pump(), `stats: {aborted: false}`, no
  // ctxUsed field) the instant it starts, which `messages.findLast(role === 'assistant')` alone
  // would pick up immediately, snapping the ring to 0% right when a turn begins (items 4 and 5 of
  // the founder's 2026-07-13 report turned out to share this one root cause: reading a statless
  // placeholder as "the last assistant message"). Skipping to the last message that actually HAS
  // ctxUsed keeps the ring showing the last real value instead of a false 0.
  const lastRealStats = messages.findLast((m) => m.role === 'assistant' && m.stats?.ctxUsed !== undefined)?.stats
  // While a turn is live, no persisted message has this turn's real ctxUsed yet — pi only reports
  // it once the turn fully completes. Rather than stay frozen at the pre-turn value the whole
  // time (item 4's exact complaint), estimate live usage from what's already streaming in: the
  // pre-turn base plus a rough chars/4 token estimate of everything accumulated in `live` so far
  // (text, reasoning, and each tool call's serialized args/result). Not exact — there is no real
  // tokenizer on the client — but a moving, directionally-correct estimate is a large improvement
  // over a ring frozen at 0%/stale for the whole duration of a long run.
  const liveCharsSoFar = live
    ? live.content.length + live.reasoning.length + live.timeline.reduce((sum, b) => {
      if (b.kind !== 'tool') return sum
      return sum + JSON.stringify(b.call.args).length + (b.call.result?.length ?? 0)
    }, 0)
    : 0
  const ctxUsed = live
    ? (lastRealStats?.ctxUsed ?? 0) + Math.ceil(liveCharsSoFar / 4)
    : lastRealStats?.ctxUsed ?? 0
  const ctxMax = status?.model?.ctx || lastRealStats?.ctxMax || 0

  const notFound = detailQ.isError
  // Initial load only (not a reconnect/refetch) — detailQ.data is undefined until the first
  // response lands. Skeleton matches the transcript's own rail shape (spec 11 §8: never a bare
  // spinner/blank void).
  const initialLoading = detailQ.isLoading && !detailQ.data
  const generatingIds = useMemo(() => (live ? new Set([sessionId ?? '']) : new Set<string>()), [live, sessionId])

  return (
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
          onNew={() => { navigate('/workspace/code'); if (!isDesktop) setMobileSidebarOpen(false) }}
          collapsed={isDesktop ? !sidebarOpen : false}
          onToggle={isDesktop ? () => setSidebarOpen((o) => !o) : () => setMobileSidebarOpen(false)}
          generatingIds={generatingIds}
        />
      </div>
      {isDesktop && sidebarOpen && <SidebarResizeHandle sidebarRef={sidebarRef} onCommit={setSidebarWidth} />}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Header — identity + run status only now; mode and context-usage moved
            into the composer toolbar below (see CodeComposer.tsx) so they read
            the same way in both the launchpad and an active session. */}
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 md:gap-2 md:px-4">
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
          {session && (
            <>
              {rename.editing ? (
                <input
                  autoFocus
                  className="min-w-[80px] flex-1 bg-transparent text-[13px] font-medium text-ink outline-none"
                  value={rename.draft}
                  onChange={(e) => rename.setDraft(e.target.value)}
                  onBlur={rename.commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename.commit(); if (e.key === 'Escape') rename.cancel() }}
                />
              ) : (
                <span
                  className="min-w-[80px] flex-1 truncate text-[13px] font-medium text-ink"
                  title={session.title}
                  onDoubleClick={rename.start}
                >
                  {session.title}
                </span>
              )}
              {!rename.editing && (
                <button
                  type="button"
                  onClick={rename.start}
                  className="shrink-0 rounded p-1 text-faint transition-colors hover:text-ink"
                  aria-label="Rename session"
                  title="Rename session"
                >
                  <Pencil size={13} />
                </button>
              )}
              {/* Repo/branch/diff-stat chips + the session-actions menu, grouped into one
                  shrinkable, horizontally-scrollable strip — NOT siblings-of-title directly
                  anymore. Root cause of a real regression (caught live by Playwright at 375px/
                  320px, spec 16 §2): every chip here is shrink-0 (a fixed-size pill; only its
                  OWN inner text truncates via max-w-[70px]), and the title above was `min-w-0
                  flex-1` — in flexbox, `min-w-0` means the title has NO real floor, so it's the
                  only element that can be squeezed, all the way to literally 0px, the instant the
                  shrink-0 siblings' total natural width exceeds the row's available space. That
                  was already fragile with just two chips (repo+branch); adding the diff-stat chip
                  and the Export/Git overflow menu (Phase 3) pushed the fixed total past the
                  container width even on a single long repo+branch pair, reproducing the exact
                  original 0px bug. The real fix is structural, not "cap one more thing": the title
                  now has a genuine min-width floor (`min-w-[80px]`, not `min-w-0`) so flexbox's own
                  shrink algorithm has a hard stop it will never squeeze past, and everything else
                  that used to compete with it directly is moved into ITS OWN flex child
                  (`min-w-0 shrink overflow-x-auto`, no `flex-1`) — a plain flex item, so once the
                  title claims its guaranteed minimum, 100% of any further squeeze lands on this
                  group instead. Nothing is ever clipped/hidden: `overflow-x-auto` (the same pattern
                  CodeComposer.tsx's own toolbar row already uses for the same reason) lets the
                  chips/menu scroll horizontally within their own strip when they don't all fit,
                  so Export/Git stays reachable rather than disappearing off-screen. This holds
                  regardless of how many chips end up present — it's the shrink/min-width
                  RELATIONSHIP between the title and the group that's now correct, not a count of
                  today's specific chips. */}
              <div className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto">
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted"
                  title={session.repoRoot}
                >
                  <FolderOpen size={11} className="shrink-0" />
                  <span className="max-w-[70px] truncate md:max-w-none">{folderName(session.repoRoot)}</span>
                </span>
                {session.branch && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                    <GitBranch size={11} className="shrink-0" />
                    <span className="max-w-[70px] truncate md:max-w-none">{session.branch}</span>
                  </span>
                )}
                {(session.add > 0 || session.del > 0) && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                    <Diff size={11} className="shrink-0" />
                    <span className="max-w-[70px] truncate md:max-w-none">{formatDiff(session.add, session.del)}</span>
                  </span>
                )}
                {/* Session actions (Phase 3, ADR-251/259) — Export + Git grouped into one overflow
                    menu rather than two more standalone buttons: neither action is frequent
                    enough to earn its own always-visible icon. Works regardless of run state —
                    export reads only already-persisted messages, and the git dialog fetches live
                    status itself when opened. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-faint transition-colors hover:text-ink data-[state=open]:text-ink"
                      title="Session actions"
                      aria-label="Session actions"
                    >
                      <MoreHorizontal size={15} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={exportMut.isPending}
                      onSelect={() => exportMut.mutate(session.id)}
                    >
                      <Download size={13} /> {exportMut.isPending ? 'Exporting…' : 'Export'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setGitDialogOpen(true)}>
                      <GitBranch size={13} /> Git…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </div>

        {/* Loaded-resources header — shown only for turbollm (chat) sessions */}
        {!isTerminalSession && session && !notFound && (
          <CodeResourcesHeader
            skillCount={skillsQ.data?.length ?? 0}
            hasAgentsMd={detailQ.data?.hasAgentsMd ?? { project: false, global: false }}
          />
        )}

        {/* Main content — a non-turbollm agent is full-screen terminal for its entire
            lifetime (no chat UI ever mounts); 'turbollm' keeps the normal transcript +
            composer view unchanged. */}
        {isTerminalSession && session ? (
          <>
            <TerminalView
              ref={terminalViewRef}
              sessionId={session.id}
              // repoRoot + the launch command are both resolved server-side from the
              // session's AgentRun (terminal-routes.ts) — nothing terminal-specific to
              // pass through here.
              onClose={() => navigate('/workspace/code')}
            />
            {/* Composer-parity chrome (model / context / thinking / stats) — the SAME row
                a turbollm chat session's composer shows, just without anything to type into
                (the terminal above owns keyboard input). Keeps this in the exact screen
                position the chat composer occupies so switching agents only changes what's
                ABOVE this row. */}
            <TerminalToolbar
              agent={session.codeAgent}
              models={allModels}
              loadedKey={model?.key ?? null}
              loadedName={model?.name ?? null}
              modelPending={modelBusy}
              ejecting={modelActions.eject.isPending}
              onLoadModel={handleLoadModel}
              onEjectModel={handleEject}
              onModelSettings={(key) => setSettingsKey(key)}
              // NOT the shared `ctxUsed` above — that one reads the last PERSISTED assistant
              // message's stats, and a terminal-agent session never writes one: the CLI talks to
              // the gateway directly, so nothing of its conversation lands in the code session's
              // message store. The ring and footer were therefore showing whichever stale value
              // happened to be sitting in this session's very first (pre-terminal) turn, frozen
              // forever. Measured live on 2026-07-29 against the founder's own `claude` session:
              // persisted message said 30,645 tokens / 15% (written two days earlier, and the
              // number in the screenshot that prompted this fix) while the CLI's actual context
              // at that moment was 98,259 / 49%. The last gateway request's prompt size IS this
              // conversation's real current context — an Anthropic-style CLI resends the whole
              // conversation every turn — and it's already polled for the footer's ↑ figure, so
              // it costs nothing extra and is the same quantity `ctxUsed` means for a chat turn.
              ctxUsed={lastUsage?.promptTokens ?? 0}
              ctxMax={ctxMax}
              thinkingBudget={thinkingBudget}
              onThinkingBudgetChange={setThinkingBudget}
              lastPromptTokens={lastUsage?.promptTokens}
              lastGenTokens={lastUsage?.genTokens}
              lastPromptTps={lastUsage?.promptTps ?? undefined}
              lastGenTps={lastUsage?.genTps ?? undefined}
            />
          </>
        ) : (
          <>
            {/* Transcript — activity-log presentation (CodeTranscript.tsx), not
                chat's bubble stack. See that file's header comment for the full
                rationale. */}
            <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <div className="flex w-full flex-col px-4 py-4 md:px-8 md:py-6">
                {notFound && (
                  <div className="flex flex-col items-center gap-2 py-16 text-center">
                    <p className="text-[14px] text-muted">This session couldn&rsquo;t be found.</p>
                    <Button size="sm" variant="outline" onClick={() => navigate('/workspace/code')}>Back to Code</Button>
                  </div>
                )}
                {/* /clear banner */}
                {!notFound && session?.clearedUpToMessageId && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">
                    <Eraser size={13} className="shrink-0 text-faint" />
                    <span className="flex-1">Chat cleared — earlier messages hidden.</span>
                    <button
                      type="button"
                      onClick={() => void runResume()}
                      disabled={resumeMut.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-ink transition-colors hover:bg-panel"
                    >
                      <RotateCcw size={12} /> Resume
                    </button>
                  </div>
                )}
                {/* Revert banner */}
                {!notFound && session?.revertedFromMessageId && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">
                    <RotateCcw size={13} className="shrink-0 text-faint" />
                    <span className="flex-1">Reverted to an earlier message — later messages hidden.</span>
                    <button
                      type="button"
                      onClick={() => void runResume()}
                      disabled={resumeMut.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-ink transition-colors hover:bg-panel"
                    >
                      <RotateCcw size={12} /> Resume
                    </button>
                  </div>
                )}
                {initialLoading && <CodeTranscriptSkeleton />}
                {!notFound && !initialLoading && (
                  <CodeTranscript
                    messages={transcriptMessages}
                    liveAssistantId={live?.assistantId}
                    live={live ? { timeline: live.timeline, reasoning: live.reasoning, compacting: live.compacting, retry: live.retry, prefill: live.prefill } : null}
                    onRevert={live || queued.length > 0 ? undefined : openRevertConfirm}
                    queued={queued}
                    onSendNowQueued={(id) => void handleSendNow(id)}
                    shellRuns={shellRuns}
                  />
                )}
              </div>
            </div>

            {showScrollBtn && (
              <button
                type="button"
                onClick={() => { userScrolledUp.current = false; scrollToBottom(true) }}
                className="absolute bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1.5 text-[12px] text-muted shadow-[var(--shadow-1)] hover:text-ink"
              >
                <ArrowDown size={13} /> Jump to latest
              </button>
            )}

            {sessionId && pendingApproval && (
              <ToolApprovalBar key={pendingApproval.id} pending={pendingApproval} convId={session?.convId ?? ''} onResolved={() => {}} />
            )}

            {/* The live turn's plan — pinned above the composer */}
            {!!live?.todos?.length && (
              <div className="border-t border-border px-3 py-1.5 md:px-8">
                <TodoChecklist todos={live.todos} />
              </div>
            )}

            {/* Composer — the SAME CodeComposer CodeHomeScreen.tsx renders */}
            <div className="px-3 pb-3 md:px-8 md:pb-5">
              <CodeComposer
                inputRef={inputRef}
                value={input}
                onValueChange={setInput}
                onSubmit={(kind) => void send(kind)}
                placeholder={live ? 'Queue a follow-up…' : 'Send a follow-up…'}
                textareaDisabled={manualCompacting}
                mode={modeInfo}
                onModeChange={handleModeChange}
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
                ctxUsed={ctxUsed}
                ctxMax={ctxMax}
                lastPromptTokens={lastRealStats?.promptTokens}
                lastGenTokens={lastRealStats?.genTokens}
                lastPromptTps={lastRealStats?.promptTps}
                lastGenTps={lastRealStats?.tps}
                live={!!live}
                onStop={() => void handleStop()}
                sendDisabled={!input.trim() || manualCompacting}
                onAddContext={() => setContextBrowserOpen(true)}
                contextFiles={contextFiles}
                onRemoveContextFile={(p) => setContextFiles((cf) => cf.filter((x) => x !== p))}
                slashCommands={[
                  ...pickerCodeCommands({ cleared: !!(session?.clearedUpToMessageId || session?.revertedFromMessageId) }),
                  ...(skillsQ.data ?? []).map((s) => ({ id: s.id, description: s.description })),
                ]}
                statusText={
                  manualCompacting || live?.compacting
                    ? 'Compacting conversation…'
                    : live
                      ? (queued.length ? `${queued.length} queued · Enter to queue another` : 'Running — Enter to queue a follow-up')
                      : undefined
                }
                hintText="Enter to send · Shift+Enter for newline"
              />
            </div>
          </>
        )}
      </div>
      <ModelDetailDialog modelKey={settingsKey} onClose={() => setSettingsKey(null)} />
      {session && <CodeGitDialog sessionId={session.id} open={gitDialogOpen} onOpenChange={setGitDialogOpen} />}
      <FsBrowser
        open={contextBrowserOpen}
        onOpenChange={setContextBrowserOpen}
        onSelect={(p) => setContextFiles((cf) => (cf.includes(p) ? cf : [...cf, p]))}
        mode="file"
        startPath={session?.repoRoot}
        title="Add context"
        description="Pick a file to point the agent at — it'll read it if relevant to the task."
      />
      {/* Revert confirmation — only asks about files when the discarded range actually touched
          any (a plain history rewind is always offered with one click, no dialog needed for
          that half; this dialog exists purely for the file-mutation decision). */}
      <AlertDialog open={!!pendingRevert} onOpenChange={(open) => { if (!open) setPendingRevert(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert to this message?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevert?.hasFileEdits
                ? 'This rewinds the chat back to here and refills the composer with your original message. The agent also edited files since then — revert those too, or just the chat?'
                : 'This rewinds the chat back to here and refills the composer with your original message. Nothing is deleted — you can bring it back with /resume.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {pendingRevert?.hasFileEdits ? (
              <>
                <AlertDialogAction
                  className={cn(buttonVariants({ variant: 'outline' }))}
                  onClick={() => { const id = pendingRevert?.messageId; if (id) void runRevert(id, false) }}
                >
                  Chat only
                </AlertDialogAction>
                <AlertDialogAction onClick={() => { const id = pendingRevert?.messageId; if (id) void runRevert(id, true) }}>
                  Chat + files
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction onClick={() => { const id = pendingRevert?.messageId; if (id) void runRevert(id, false) }}>
                Revert
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

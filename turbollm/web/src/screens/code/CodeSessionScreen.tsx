import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Clock, Diff, Eraser, FolderOpen, GitBranch, PanelLeft, Pencil, RotateCcw, SendHorizontal } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { skillKeys, fetchSkills } from '../../lib/agent-api'
import { useModelActions, useModels, useStatus } from '../../lib/queries'
import { compactCodeSession, revertCodeSession, sendCodeQueuedTurnNow, startCodeRun, streamCodeSession, stopCodeSession } from '../../lib/code-api'
import type { QueuedTurn } from '../../lib/code-types'
import {
  codeKeys, useClearCodeSession, useCodeSession, useCodeSessionRename, useResumeCodeSession,
  useUpdateCodeSessionMode,
} from '../../lib/code-queries'
import type { LiveToolCall } from '../../lib/chat-types'
import { appendTextDelta, upsertToolCall, type LiveBlock } from '../../lib/live-timeline'
import { Button, buttonVariants } from '../../components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { toast } from '../../components/ui/sonner'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { cn, folderName, formatDiff, writeLastCodeSessionId } from '../../lib/utils'
import { ToolApprovalBar } from '../chat/ToolApprovalBar'
import { ConversationSidebar } from '../chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from '../chat/SidebarResizeHandle'
import { ModelDetailDialog } from '../models/ModelDetailDialog'
import { FsBrowser } from '../engines/FsBrowser'
import { CodeComposer } from './CodeComposer'
import { CodeTranscript, CodeTranscriptSkeleton } from './CodeTranscript'
import { AGENT_MODES, type AgentModeId } from './code-mock'

interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  timeline: LiveBlock[]
  /** True between a 'compaction' SSE event's start and end phases — pi's own AUTO-compaction
   *  silently summarizing history mid-turn (distinct from the manual /compact command). Drives
   *  CodeThinking's "Compacting conversation…" state instead of a blank/generic gap. */
  compacting?: boolean
}

/** Apply `fn` to the current live block, creating one (anchored to `fallbackId`) if none exists
 *  yet — so a live delta/tool_call that arrives on a reconnect BEFORE a `meta` frame (e.g. the
 *  real meta aged out of the daemon's ring buffer) still attaches to the right assistant turn
 *  instead of being dropped. */
function reduceLive(l: LiveState | null, fallbackId: string, fn: (b: LiveState) => LiveState): LiveState {
  const base = l ?? { assistantId: fallbackId, content: '', reasoning: '', timeline: [] }
  return fn(base)
}

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
  const allMessages = conversation?.messages ?? []
  // /clear hides everything at/before clearedUpToMessageId from the transcript (the messages
  // themselves are never deleted — /resume un-hides them again). `messages` below is what the
  // rest of this screen renders/measures (context ring, transcript); server-side history replay
  // for the MODEL applies the same cut via resolveEffectiveHistory (code-session.ts).
  const clearedIdx = session?.clearedUpToMessageId
    ? allMessages.findIndex((m) => m.id === session.clearedUpToMessageId)
    : -1
  const messages = clearedIdx === -1 ? allMessages : allMessages.slice(clearedIdx + 1)
  const clearedCount = clearedIdx === -1 ? 0 : clearedIdx + 1

  // Rename — same shared hook/UX as the sidebar's CodeSessionItem (ConversationSidebar.tsx),
  // surfaced here too since the header is the bigger, always-visible spot for a session's title.
  const rename = useCodeSessionRename(session?.id, session?.title)

  // Mode — editable at any stage (not just at creation), same as the model
  // picker. `modeOverride` is the optimistic local value shown the instant the
  // user picks a new one; the PATCH (useUpdateCodeSessionMode) persists it and
  // the query refetch reconciles `session.mode` to match. Reset whenever the
  // session itself changes so a stale override never survives a navigation.
  const [modeOverride, setModeOverride] = useState<AgentModeId | null>(null)
  useEffect(() => { setModeOverride(null) }, [sessionId])

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
  const handleLoadModel = (key: string) => {
    modelActions.load.mutate(
      { key },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.') },
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
  const setThinkingBudget = (val: number) => {
    if (sessionId) localStorage.setItem(`tllm.thinkingBudget.${sessionId}`, String(val))
    setThinkingBudgetState(val)
  }
  useEffect(() => {
    setThinkingBudgetState(readThinkingBudget(sessionId ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const [live, setLive] = useState<LiveState | null>(null)
  // A queued follow-up's user message is persisted (POST /messages) the moment it's SUBMITTED,
  // not when its own turn actually starts — code-routes.ts's `enqueue` can leave it waiting
  // behind the active run for a while. Since `messages` renders in seq order, that follow-up's
  // instruction card used to appear ABOVE the still-streaming current turn's live content
  // (which always renders last, after the full `messages` list) — reading as if the queued
  // message had jumped ahead. The existing "Queued" chips below the composer already show
  // what's waiting, so cut the transcript off at the current live turn's own assistant
  // placeholder — anything after it (an already-persisted but not-yet-started queued follow-up)
  // stays hidden from the transcript until it actually starts running.
  const liveBoundaryIdx = live ? messages.findIndex((m) => m.id === live.assistantId) : -1
  const transcriptMessages = liveBoundaryIdx === -1 ? messages : messages.slice(0, liveBoundaryIdx + 1)
  const [input, setInput] = useState('')
  // "Add context" — absolute paths picked via a file browser, sent alongside the next follow-up
  // as contextFiles (see code-api.ts's startCodeRun / code-routes.ts's contextFilesBlock).
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [contextBrowserOpen, setContextBrowserOpen] = useState(false)
  // The SERVER-side message queue's contents (tasks waiting behind the active run). Driven by
  // the daemon — `queue` SSE frames while streaming, plus the session detail on load — NOT
  // browser memory, so queued follow-ups survive a disconnect/reload and still fire in order
  // server-side. (Previously this was a client-only array that was lost on navigation.)
  const [queued, setQueued] = useState<QueuedTurn[]>([])
  // The GET /stream subscription. Aborting it only DETACHES this client from the run — the
  // daemon keeps executing it — so it never stops the run. One active stream per mounted session.
  const streamAbortRef = useRef<AbortController | null>(null)
  const streamActiveRef = useRef(false)
  // The last ring-buffer seq this client has consumed, so a reconnect resumes from there.
  const lastSeqRef = useRef(0)
  // The in-flight turn's assistant message id (from the `meta` frame), so live deltas that arrive
  // after a reconnect (whose meta may have aged out of the buffer) still attach to the right turn.
  const activeAssistantIdRef = useRef('')
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
  // ONE persistent GET /stream per mounted session (not one-per-turn). It replays whatever the
  // daemon already buffered for the in-flight turn (from lastSeqRef) then live-tails; on a
  // network drop it reconnects from the last seq seen. It ends only when the daemon reports the
  // session idle (the async generator completing) — at which point we reconcile with the DB
  // transcript. Because the run is daemon-owned, closing this stream never stops the run.
  const RECONNECT_MAX = 6
  const connect = useCallback(() => {
    if (!sessionId || streamActiveRef.current) return
    streamActiveRef.current = true
    const ac = new AbortController()
    streamAbortRef.current = ac
    let attempt = 0

    const run = async () => {
      try {
        for await (const evt of streamCodeSession(sessionId, lastSeqRef.current, ac.signal)) {
          if (typeof evt.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, evt.seq + 1)
          if (evt.event === 'meta') {
            attempt = 0 // a real frame means the connection is healthy again
            activeAssistantIdRef.current = evt.data.assistantMessageId
            setLive((l) => (l && l.assistantId === evt.data.assistantMessageId
              ? l
              : { assistantId: evt.data.assistantMessageId, content: '', reasoning: '', timeline: [] }))
            void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
          } else if (evt.event === 'queue') {
            setQueued(evt.data.queued)
          } else if (evt.event === 'compaction') {
            const compacting = evt.data.phase === 'start'
            setLive((l) => reduceLive(l, activeAssistantIdRef.current, (b) => ({ ...b, compacting })))
          } else if (evt.event === 'reasoning') {
            const delta = evt.data.delta
            setLive((l) => reduceLive(l, activeAssistantIdRef.current, (b) => ({ ...b, reasoning: b.reasoning + delta })))
          } else if (evt.event === 'delta') {
            const delta = evt.data.delta
            setLive((l) => reduceLive(l, activeAssistantIdRef.current, (b) => ({ ...b, content: b.content + delta, timeline: appendTextDelta(b.timeline, delta) })))
          } else if (evt.event === 'tool_call') {
            const tc = evt.data
            const call: LiveToolCall = { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result, diff: tc.diff, patch: tc.patch, firstChangedLine: tc.firstChangedLine }
            setLive((l) => reduceLive(l, activeAssistantIdRef.current, (b) => ({ ...b, timeline: upsertToolCall(b.timeline, call) })))
          } else if (evt.event === 'done') {
            setLive(null)
            void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
            void qc.invalidateQueries({ queryKey: ['code-sessions'] })
            void qc.invalidateQueries({ queryKey: ['code-stats'] })
            setTimeout(() => scrollToBottom(true), 80)
          } else if (evt.event === 'error') {
            setLive(null)
            void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
            void qc.invalidateQueries({ queryKey: ['code-sessions'] })
            void qc.invalidateQueries({ queryKey: ['code-stats'] })
            toast.error(evt.data.message)
          }
        }
        // Generator completed = the daemon says this session is idle. Stop and reconcile with DB.
        streamActiveRef.current = false
        setLive(null)
        void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
        void qc.invalidateQueries({ queryKey: ['code-sessions'] })
      } catch (e) {
        if (ac.signal.aborted) { streamActiveRef.current = false; return }
        // Network drop mid-run — the DAEMON kept executing. Reconnect from the last seq seen so
        // we replay only what we missed and continue live.
        attempt += 1
        if (attempt <= RECONNECT_MAX && streamAbortRef.current === ac) {
          setTimeout(() => { if (streamAbortRef.current === ac && !ac.signal.aborted) void run() }, Math.min(500 * attempt, 3000))
        } else {
          streamActiveRef.current = false
          setLive(null)
          if (!(e instanceof ApiError && e.status === 404)) toast.error('Lost connection to the run.')
        }
      }
    }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, qc, scrollToBottom])

  // Auto-start the first run of a freshly-created session (one seeded user message, no reply,
  // nothing live in the daemon). POST kicks it off server-side; then we connect to watch it.
  // Guarded by a ref so StrictMode double-invoke / refetches never fire it twice.
  useEffect(() => {
    if (!sessionId || !detailQ.isSuccess) return
    if (autoStartedRef.current === sessionId) return
    const needsFirstRun = messages.length === 1 && messages[0]?.role === 'user' && !detailQ.data?.running
    if (needsFirstRun) {
      autoStartedRef.current = sessionId
      // Read directly rather than closing over `thinkingBudget` state: navigating between two
      // already-visited sessions (no remount, only the :sessionId param changes) can run this
      // effect in the SAME commit as the sibling effect that resyncs `thinkingBudget` for the
      // new session — the state update from that effect hasn't applied yet, so the closure here
      // would still hold the PREVIOUS session's value. readThinkingBudget is a synchronous
      // localStorage read, immune to that ordering race.
      void startCodeRun(sessionId, '', readThinkingBudget(sessionId))
        .then(() => { void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) }); connect() })
        .catch((e) => { autoStartedRef.current = null; toast.error(e instanceof ApiError ? e.message : 'Could not start the run.') })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, detailQ.isSuccess, messages.length])

  // Reconnect on load: a session opened while a run is live in the daemon (closed the tab and
  // came back, reloaded, opened on another device) must ATTACH to that run — replaying its
  // buffered history and continuing live — instead of assuming a fresh page has nothing in flight.
  useEffect(() => {
    if (!sessionId || !detailQ.isSuccess) return
    if (detailQ.data?.running && !streamActiveRef.current) connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, detailQ.isSuccess, detailQ.data?.running])

  // Seed the queued chips from the session detail on load, until the stream's own `queue` frames
  // take over as the live source of truth.
  useEffect(() => {
    if (!streamActiveRef.current) setQueued(detailQ.data?.queued ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, detailQ.data?.queued])

  // Tear down the subscription on unmount / session change — DETACHES this client without
  // stopping the daemon-owned run, and resets the reconnect cursor for the next session.
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
      streamActiveRef.current = false
      setLive(null)
      lastSeqRef.current = 0
      activeAssistantIdRef.current = ''
    }
  }, [sessionId])

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
  const COMPACT_RE = /^\/compact\b\s*(.*)$/i
  const runCompact = async (text: string) => {
    if (!sessionId) return
    const instructions = COMPACT_RE.exec(text)?.[1]?.trim() || undefined
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
  const CLEAR_RE = /^\/clear\b\s*$/i
  const RESUME_RE = /^\/resume\b\s*$/i
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

  const send = async () => {
    const text = input.trim()
    if (!text || !sessionId) return
    if (COMPACT_RE.test(text)) { await runCompact(text); return }
    if (CLEAR_RE.test(text)) { await runClear(); return }
    if (RESUME_RE.test(text)) { await runResume(); return }
    const promptOverride = skillPromptOverride(text)
    const filesToSend = contextFiles
    setInput('')
    setContextFiles([])
    userScrolledUp.current = false
    // Always POST: the daemon starts the turn if idle, or QUEUES it (in order) behind the active
    // run. Either way it's owned server-side, so a queued follow-up survives a disconnect. The
    // open stream reflects the result (a new `queue` frame, or the turn going live when it runs).
    try {
      await startCodeRun(sessionId, text, thinkingBudget, promptOverride, filesToSend)
      void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      connect()
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

  // "Send now" on a queued chip: stops the active turn and promotes this one to run next,
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
                  className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none"
                  value={rename.draft}
                  onChange={(e) => rename.setDraft(e.target.value)}
                  onBlur={rename.commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename.commit(); if (e.key === 'Escape') rename.cancel() }}
                />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink"
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
                  title="Rename session"
                >
                  <Pencil size={13} />
                </button>
              )}
              {/* Repo/branch context — shown at every width (previously md:-only, hiding it
                  entirely on mobile with no other way to see it in this screen). The title's
                  own min-w-0 flex-1 truncate yields space to these before anything gets fully
                  cut off — but that alone isn't enough: these chips are shrink-0 (fixed to
                  their natural width) with no cap, so a genuinely long repo path + branch name
                  can still claim ALL the row's width and squeeze the title to literally 0px,
                  invisible (caught live, not by inspection — measured 0px with a real long
                  repo/branch pair at 375px). Capping each chip's own text at a small max-width
                  on mobile (relaxed back to fully visible at md: and up, unchanged from before
                  this fix) guarantees the title always keeps a real minimum, at the cost of the
                  chip text itself truncating instead. */}
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
            </>
          )}
        </div>

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
            {/* /clear banner — the underlying messages are never deleted, so this is a
                reminder + one-click undo, not a warning about lost data. */}
            {!notFound && session?.clearedUpToMessageId && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">
                <Eraser size={13} className="shrink-0 text-faint" />
                <span className="flex-1">
                  Chat cleared — {clearedCount} earlier message{clearedCount === 1 ? '' : 's'} hidden.
                </span>
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
            {/* Revert banner — same non-destructive framing as /clear's: the reverted-from
                message and everything after it are deactivated, never deleted (v33). */}
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
                live={live ? { timeline: live.timeline, reasoning: live.reasoning, compacting: live.compacting } : null}
                onRevert={live || queued.length > 0 ? undefined : openRevertConfirm}
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

        {/* Composer — the SAME CodeComposer CodeHomeScreen.tsx renders (no
            `repo`: the repo is fixed for the session's lifetime). Mode and
            model are both editable here too — see the handlers above. */}
        <div className="px-3 pb-3 md:px-8 md:pb-5">
          {queued.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted">
                <Clock size={11} className="text-faint" /> Queued
              </span>
              {queued.map((q) => (
                <span
                  key={q.userMsgId}
                  className="inline-flex max-w-[280px] items-center gap-1 rounded-full border border-border bg-panel-2 py-1 pr-1 pl-2.5 text-[12px] text-muted"
                >
                  <span className="min-w-0 truncate" title={q.task}>{q.task}</span>
                  <button
                    type="button"
                    onClick={() => void handleSendNow(q.userMsgId)}
                    title="Send now — stop the current run and run this one next"
                    aria-label="Send now"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-panel hover:text-ink"
                  >
                    <SendHorizontal size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <CodeComposer
            inputRef={inputRef}
            value={input}
            onValueChange={setInput}
            onSubmit={() => void send()}
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
            live={!!live}
            onStop={() => void handleStop()}
            sendDisabled={!input.trim() || manualCompacting}
            onAddContext={() => setContextBrowserOpen(true)}
            contextFiles={contextFiles}
            onRemoveContextFile={(p) => setContextFiles((cf) => cf.filter((x) => x !== p))}
            slashCommands={[
              { id: 'compact', description: 'Summarize the conversation so far into one summary, to free up context' },
              { id: 'clear', description: 'Clear the chat — repo, worktree, and branch stay as they are' },
              ...(session?.clearedUpToMessageId || session?.revertedFromMessageId ? [{ id: 'resume', description: 'Bring back a cleared or reverted chat' }] : []),
              ...(skillsQ.data ?? []).map((s) => ({ id: s.id, description: s.description })),
            ]}
            // Prominent, accent-colored banner above the textarea for any real in-progress
            // state (founder feedback, 2026-07-17: folding this into the tiny faint hint text
            // below made an actual busy state — especially manual /compact, which disables the
            // whole composer — too easy to miss). hintText stays reserved for the idle case.
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
      </div>
      <ModelDetailDialog modelKey={settingsKey} onClose={() => setSettingsKey(null)} />
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

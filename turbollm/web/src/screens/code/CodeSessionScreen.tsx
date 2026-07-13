import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Clock, FolderOpen, GitBranch, PanelLeft, Pencil } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { skillKeys, fetchSkills } from '../../lib/agent-api'
import { useModelActions, useModels, useStatus } from '../../lib/queries'
import { compactCodeSession, startCodeRun, streamCodeSession, stopCodeSession } from '../../lib/code-api'
import { codeKeys, useCodeSession, useCodeSessionRename, useUpdateCodeSessionMode } from '../../lib/code-queries'
import type { LiveToolCall } from '../../lib/chat-types'
import { appendTextDelta, upsertToolCall, type LiveBlock } from '../../lib/live-timeline'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { cn, folderName, writeLastCodeSessionId } from '../../lib/utils'
import { ToolApprovalBar } from '../chat/ToolApprovalBar'
import { ConversationSidebar } from '../chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from '../chat/SidebarResizeHandle'
import { ModelDetailDialog } from '../models/ModelDetailDialog'
import { CodeComposer } from './CodeComposer'
import { CodeTranscript } from './CodeTranscript'
import { AGENT_MODES, type AgentModeId } from './code-mock'

interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  timeline: LiveBlock[]
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
  const [input, setInput] = useState('')
  // The SERVER-side message queue's contents (tasks waiting behind the active run). Driven by
  // the daemon — `queue` SSE frames while streaming, plus the session detail on load — NOT
  // browser memory, so queued follow-ups survive a disconnect/reload and still fire in order
  // server-side. (Previously this was a client-only array that was lost on navigation.)
  const [queued, setQueued] = useState<string[]>([])
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

  const autoResize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

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
            void qc.invalidateQueries({ queryKey: codeKeys.list })
            setTimeout(() => scrollToBottom(true), 80)
          } else if (evt.event === 'error') {
            setLive(null)
            void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
            void qc.invalidateQueries({ queryKey: codeKeys.list })
            toast.error(evt.data.message)
          }
        }
        // Generator completed = the daemon says this session is idle. Stop and reconcile with DB.
        streamActiveRef.current = false
        setLive(null)
        void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
        void qc.invalidateQueries({ queryKey: codeKeys.list })
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
  // means nothing to it. Submitting "/skillid task" REWRITES the message into an explicit
  // instruction telling the model to call that tool (see rewriteSkillCommand below).
  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, staleTime: 30_000 })
  const SKILL_RE = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i
  const rewriteSkillCommand = (text: string): string => {
    const match = SKILL_RE.exec(text)
    const skill = match ? (skillsQ.data ?? []).find((s) => s.id === match[1]) : undefined
    const task = (match?.[2] ?? '').trim()
    return skill && task ? `Use the invoke_skill tool with skillId "${skill.id}" for this task: ${task}` : text
  }

  const COMPACT_RE = /^\/compact\b\s*(.*)$/i
  const runCompact = async (text: string) => {
    if (!sessionId) return
    const instructions = COMPACT_RE.exec(text)?.[1]?.trim() || undefined
    setInput('')
    setTimeout(autoResize, 0)
    try {
      const result = await compactCodeSession(sessionId, instructions)
      void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      toast.success(`Compacted — ${result.tokensBefore.toLocaleString()} tokens of history summarized.`)
    } catch (e) {
      setInput(text) // restore so the command isn't lost
      setTimeout(autoResize, 0)
      if (e instanceof ApiError && e.code === 'nothing_to_compact') toast.info('Nothing to compact yet — history is already short enough.')
      else toast.error(e instanceof ApiError ? e.message : 'Could not compact.')
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || !sessionId) return
    if (COMPACT_RE.test(text)) { await runCompact(text); return }
    const finalText = rewriteSkillCommand(text)
    setInput('')
    setTimeout(autoResize, 0)
    userScrolledUp.current = false
    // Always POST: the daemon starts the turn if idle, or QUEUES it (in order) behind the active
    // run. Either way it's owned server-side, so a queued follow-up survives a disconnect. The
    // open stream reflects the result (a new `queue` frame, or the turn going live when it runs).
    try {
      await startCodeRun(sessionId, finalText, thinkingBudget)
      void qc.invalidateQueries({ queryKey: codeKeys.detail(sessionId) })
      connect()
    } catch (e) {
      setInput(text) // restore so the message isn't lost
      setTimeout(autoResize, 0)
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

  // At most one tool call awaits interactive approval at a time (ask mode's gate is
  // sequential — same invariant ChatScreen relies on).
  const pendingApprovalBlock = live?.timeline.find((b) => b.kind === 'tool' && b.call.status === 'awaiting_approval')
  const pendingApproval = pendingApprovalBlock?.kind === 'tool' ? pendingApprovalBlock.call : undefined

  const lastStats = messages.findLast((m) => m.role === 'assistant')?.stats
  const ctxUsed = lastStats?.ctxUsed ?? 0
  const ctxMax = status?.model?.ctx || lastStats?.ctxMax || 0

  const notFound = detailQ.isError
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
                  className="min-w-0 truncate text-[13px] font-medium text-ink"
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
              <span
                className="hidden shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted md:inline-flex"
                title={session.repoRoot}
              >
                <FolderOpen size={11} />
                {folderName(session.repoRoot)}
              </span>
              {session.branch && (
                <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted md:inline-flex">
                  <GitBranch size={11} />
                  {session.branch}
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
            {!notFound && (
              <CodeTranscript
                messages={messages}
                liveAssistantId={live?.assistantId}
                live={live ? { timeline: live.timeline, reasoning: live.reasoning } : null}
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
              {queued.map((q, i) => (
                <span
                  key={i}
                  className="inline-flex max-w-[240px] items-center gap-1 rounded-full border border-border bg-panel-2 px-2.5 py-1 text-[12px] text-muted"
                >
                  <span className="min-w-0 truncate" title={q}>{q}</span>
                </span>
              ))}
            </div>
          )}
          <CodeComposer
            inputRef={inputRef}
            value={input}
            onValueChange={(v) => { setInput(v); autoResize() }}
            onSubmit={() => void send()}
            placeholder={live ? 'Queue a follow-up…' : 'Send a follow-up…'}
            textareaDisabled={false}
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
            sendDisabled={!input.trim()}
            onAddContext={() => toast('Add context is coming', { description: 'Attach files, folders, or URLs to steer the agent — not wired yet.' })}
            slashCommands={[
              { id: 'compact', description: 'Summarize the conversation so far into one summary, to free up context' },
              ...(skillsQ.data ?? []).map((s) => ({ id: s.id, description: s.description })),
            ]}
            hintText={live
              ? (queued.length ? `${queued.length} queued · Enter to queue another` : 'Running — Enter to queue a follow-up')
              : 'Enter to send · Shift+Enter for newline'}
          />
        </div>
      </div>
      <ModelDetailDialog modelKey={settingsKey} onClose={() => setSettingsKey(null)} />
    </div>
  )
}

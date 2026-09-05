import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowDown, Copy, Download, PanelLeft, Paperclip, SendHorizontal, Share2, SlidersHorizontal, Square, UserRound, X } from 'lucide-react'
import { continueConversation, fetchSysInfo, listMemoryFacts, sendMessage } from '../lib/chat-api'
import { extractPdfText } from '../lib/pdf-extract'
import { chatKeys, useConversation, useConversationMutations } from '../lib/chat-queries'
import { useBuiltinAgentOverrides, useChatAgents, useEngines, useModelActions, useModelDetail, useModels, useSettings, useStatus } from '../lib/queries'
import type { ChatSseEvent, Conversation, LiveToolCall, Message } from '../lib/chat-types'
import { appendTextDelta, upsertToolCall, type LiveBlock } from '../lib/live-timeline'
import { ApiError, downloadChatExport, getDebugSnapshot, getShareUrl, importChat, track } from '../lib/api'
import { useWorkspaceSidebarOpen } from '../lib/workspace-sidebar'
import { useBackableOverlay } from '../lib/use-backable-overlay'
import { Button } from '../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { toast } from '../components/ui/sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { skillKeys, fetchSkills } from '../lib/agent-api'
import { cn, writeLastChatConvId } from '../lib/utils'
import { ThinkingBudgetSlider } from '../components/ThinkingBudgetSlider'
import { DEFAULT_REASONING_EFFORT, ReasoningEffortSelect, type ReasoningEffort } from '../components/ReasoningEffortSelect'
import { MessageBubble, StreamingBubble } from './chat/MessageBubble'
import { ToolApprovalBar } from './chat/ToolApprovalBar'
import { ContextMeter } from './chat/ContextMeter'
import { ConversationSidebar } from './chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from './chat/SidebarResizeHandle'
import { ModelLoadMenu } from '../components/ModelLoadMenu'
import { useLinks, useLinkStatus, useRemoteModels } from '../lib/link-queries'
import { describeRemoteHost, findRemoteChoice, selectModel } from '../lib/remote-models'
import { ModelDetailDialog } from './models/ModelDetailDialog'
import { ConversationSettingsDialog, type ConversationSettingsDraft } from './chat/ConversationSettingsDialog'
import { useUiStore } from '../stores/ui'
import { useIsDesktop } from '../lib/useIsDesktop'
import {
  buildSystemPrompt, getConvAgentId, getDefaultAgentId,
  getPersonalization, resolveAgents, setConvAgentId,
} from '../lib/personas'

// Sidebar width constants + the drag-resize handle now live in
// ./chat/SidebarResizeHandle.tsx — shared with CodeHomeScreen, which shows the
// same resizable ConversationSidebar in Code mode.

// Streaming state
interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number  // rolling 2s window estimate during generation phase
  genTokens: number   // running count of generated tokens (content + reasoning) for this reply
  timeline: LiveBlock[]
}

/** Fit a model name into the composer placeholder. Measured on-device: the input is 230px at the
 *  narrowest supported width (360px, minus the attach and send buttons), which holds ~31
 *  characters at 15px — so 22 for the name once "Message " is accounted for. Past that the name is
 *  cut and given a real ellipsis, since the browser won't add one to a placeholder itself.
 *  The font is proportional, so this is a budget rather than a guarantee: it's sized against real
 *  model names ("qwen2.5-0.5b-instruct" measures 210px of the 230 available), and a hypothetical
 *  22 characters of capitals would still overrun. Worth revisiting only if names like that appear. */
const PLACEHOLDER_NAME_MAX = 22
function truncateName(name: string): string {
  return name.length > PLACEHOLDER_NAME_MAX ? `${name.slice(0, PLACEHOLDER_NAME_MAX - 1)}…` : name
}

export function ChatScreen({ embedded, convIdOverride }: { embedded?: boolean; convIdOverride?: string } = {}) {
  const { data: status } = useStatus()
  const model = status?.model
  const engineState = status?.engine.state
  const { query: settingsQ } = useSettings()

  // The loaded model's resolved sampling defaults, for the Thread settings sliders
  // (LoadedModel itself carries no sampling — it lives on the per-engine LoadProfile,
  // same source ModelDetailDialog reads/writes; see ADR discussion in that file).
  const enginesQ = useEngines()
  const activeEngine = enginesQ.data?.engines.find((e) => e.id === enginesQ.data?.activeEngineId)
  const modelDetailQ = useModelDetail(model?.key ?? null, activeEngine?.id)
  const modelSampling = modelDetailQ.data?.profile.sampling

  // Route params: /chat/:convId?readonly=1
  const { convId: routeConvId } = useParams<{ convId?: string }>()
  const [searchParams] = useSearchParams()
  const readonly = searchParams.get('readonly') === '1'

  const [activeId, setActiveId] = useState<string | null>(convIdOverride ?? routeConvId ?? null)
  // Embedded mode (Routines' 3-pane layout, RoutineEditPage.tsx): there is no route param to
  // read a new value from when the caller switches which run is selected, only this prop — so
  // re-seed activeId whenever it changes. Not needed outside embedded mode: the standalone
  // /chat/:convId route unmounts and remounts a fresh ChatScreen on navigation instead (App.tsx's
  // <Routes>), which already re-runs the initial useState above.
  useEffect(() => { if (embedded && convIdOverride !== undefined) setActiveId(convIdOverride) }, [embedded, convIdOverride])
  // Remember this as the last-opened Chat conversation, so switching to Code and back
  // via the Workspace mode pill (ConversationSidebar.tsx) restores it. Skipped when embedded —
  // an embedded routine-run view is not "the chat you were in", and letting it win would make
  // switching back to Chat mode land on whatever routine run you last looked at.
  useEffect(() => { if (!embedded && activeId) writeLastChatConvId(activeId) }, [embedded, activeId])
  // streamFrom's async loop outlives the render that started it, so it needs the CURRENT
  // activeId (not the one closed over when the generation began) to tell whether a
  // 'done'/'error' event landed on the conversation the user is still looking at.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  // Keyed by convId, not a single global value — a generation keeps running server-side
  // after the user navigates away (b6d84f3), so its live state must survive navigation
  // too, and multiple conversations can legitimately be generating at once.
  const [liveByConv, setLiveByConv] = useState<Record<string, LiveState>>({})
  const live = activeId ? liveByConv[activeId] : undefined
  // Conversations whose generation finished while the user was elsewhere. Cleared when
  // the user navigates to that conversation. Session-only by design (not persisted).
  const [recentlyCompletedIds, setRecentlyCompletedIds] = useState<Set<string>>(new Set())
  const [input, setInput] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [settingsKey, setSettingsKey] = useState<string | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useWorkspaceSidebarOpen()
  // Below md the sidebar is an off-canvas drawer, hidden until opened from the header.
  const isDesktop = useIsDesktop()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  // QA_BUGS.md BUG-02: Android hardware/gesture back closes this drawer instead of exiting
  // the app — see the hook's own doc comment for why a plain boolean isn't enough on its own.
  useBackableOverlay(mobileSidebarOpen, () => setMobileSidebarOpen(false))
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(Math.max(readSavedSidebarWidth(), SIDEBAR_MIN_W), sidebarMaxW()))
  const [attachments, setAttachments] = useState<{ file: File; dataUrl: string }[]>([])
  // Share menu clipboard fallback (F-023)
  const [clipboardFallback, setClipboardFallback] = useState<{ text: string; title: string } | null>(null)
  // Import state (F-024)
  const importFileRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importModelMismatch, setImportModelMismatch] = useState<string | null>(null)

  // Thinking budget — per-conversation, persisted in localStorage. -1 = unlimited
  // (reasoning models think freely, today's default), 0 = off (model answers directly,
  // no reasoning generated), N>0 = a real sampler-enforced token cap (thinking_budget_tokens
  // — see chat-routes.ts). Supersedes the old on/off-only `tllm.thinkingEnabled.*` toggle
  // (ADR-042) now that the engine genuinely supports a graduated budget, not just 0/-1.
  // Reads per-conv key first; falls back to global default; defaults to unlimited.
  const readThinkingBudget = (convId: string | null): number => {
    if (convId) {
      const perConv = localStorage.getItem(`tllm.thinkingBudget.${convId}`)
      if (perConv !== null) return Number(perConv)
    }
    const global = localStorage.getItem('tllm.thinkingBudget.default')
    return global !== null ? Number(global) : -1
  }
  const [thinkingBudget, setThinkingBudgetState] = useState<number>(() => readThinkingBudget(null))
  const setThinkingBudget = (val: number) => {
    if (activeId) localStorage.setItem(`tllm.thinkingBudget.${activeId}`, String(val))
    setThinkingBudgetState(val)
  }

  // Reasoning effort (Qwen3.8) — same per-conv/global persistence shape as thinkingBudget
  // above, but a DIFFERENT and independent control (see ReasoningEffortSelect.tsx): only
  // shown, and only ever sent, when the loaded model's chat template actually supports it
  // (ModelEntry.reasoningEffort, computed below from loadedEntry).
  const readReasoningEffort = (convId: string | null): ReasoningEffort => {
    if (convId) {
      const perConv = localStorage.getItem(`tllm.reasoningEffort.${convId}`)
      if (perConv === 'off' || perConv === 'low' || perConv === 'medium' || perConv === 'xhigh') return perConv
    }
    const global = localStorage.getItem('tllm.reasoningEffort.default')
    return global === 'off' || global === 'low' || global === 'medium' || global === 'xhigh' ? global : DEFAULT_REASONING_EFFORT
  }
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(() => readReasoningEffort(null))
  const setReasoningEffort = (val: ReasoningEffort) => {
    if (activeId) localStorage.setItem(`tllm.reasoningEffort.${activeId}`, val)
    setReasoningEffortState(val)
  }

  // Agent — per-conversation, defaults to the default set in Customize → Agents.
  // A plain string: besides the fixed built-in ids, a custom agent's id is an
  // arbitrary server-issued one, resolved against `allAgents` below.
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>(() => getDefaultAgentId())
  const customAgentsQ = useChatAgents()
  const builtinOverridesQ = useBuiltinAgentOverrides()
  const allAgents = resolveAgents(customAgentsQ.data ?? [], builtinOverridesQ.data ?? {})
  const selectedAgent = allAgents.find((a) => a.id === selectedPersonaId)
  // Keyed by convId — generations can run concurrently across conversations now that
  // switching away no longer aborts them (b6d84f3).
  const abortRefs = useRef<Record<string, AbortController>>({})
  const deltaTimestamps = useRef<Record<string, number[]>>({})
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const userScrolledUp = useRef(false)
  // Per-conversation scroll offsets (spec 07 §7: "Preserve scroll on conversation
  // switch"). In-memory refs by design — no re-renders, dies with the screen.
  // Absence of an entry means "was pinned at bottom". `pendingScrollRestore` carries
  // the offset captured at switch time, so the restore effect can't read a map entry
  // that the content swap's clamped scroll event may have just overwritten.
  const scrollOffsets = useRef<Record<string, number>>({})
  const pendingScrollRestore = useRef<{ id: string; top: number | null } | null>(null)
  const qc = useQueryClient()
  const mut = useConversationMutations()
  const modelsQ = useModels()
  const modelActions = useModelActions()

  const convQ = useConversation(activeId)
  const conv = convQ.data
  const messages = conv?.messages ?? []

  // Skills enabled before a conversation exists yet (first message hasn't been sent).
  // Once activeId exists, conv.skillIds is the source of truth instead.
  const [pendingSkillIds, setPendingSkillIds] = useState<string[]>([])
  const enabledSkillIds = conv?.skillIds ?? pendingSkillIds

  // Same pattern, extended to the other Thread-settings fields (GitHub #52 follow-up):
  // lets the settings dialog be used on a blank chat screen, before a conversation
  // exists to PATCH. Folded into mut.create.mutateAsync() on first send, then reset.
  const [pendingSystemPrompt, setPendingSystemPrompt] = useState('')
  const [pendingSampling, setPendingSampling] = useState<Record<string, number>>({})
  const [pendingPreserveThinking, setPendingPreserveThinking] = useState(true)
  const draftOnChange = useCallback((patch: Partial<{
    systemPrompt: string
    sampling: Record<string, number>
    skillIds: string[]
    preserveThinking: boolean
  }>) => {
    if (patch.systemPrompt !== undefined) setPendingSystemPrompt(patch.systemPrompt)
    if (patch.sampling !== undefined) setPendingSampling(patch.sampling)
    if (patch.skillIds !== undefined) setPendingSkillIds(patch.skillIds)
    if (patch.preserveThinking !== undefined) setPendingPreserveThinking(patch.preserveThinking)
  }, [])
  // draft is undefined until a model is loaded — the settings dialog uses its presence
  // to enable/disable the trigger on a not-yet-created conversation. Memoized so its
  // identity is stable across unrelated re-renders (composer typing, etc.) — the dialog
  // resyncs its local state whenever this object changes identity.
  const hasConv = !!conv
  const modelLoaded = !!model
  const draft: ConversationSettingsDraft | undefined = useMemo(() => {
    if (hasConv || !modelLoaded) return undefined
    return {
      systemPrompt: pendingSystemPrompt,
      sampling: pendingSampling,
      skillIds: pendingSkillIds,
      preserveThinking: pendingPreserveThinking,
      onChange: draftOnChange,
    }
  }, [hasConv, modelLoaded, pendingSystemPrompt, pendingSampling, pendingSkillIds, pendingPreserveThinking, draftOnChange])

  // '/' picker: typing '/' (optionally followed by letters, at the START of an
  // otherwise-empty composer) shows a filtered skill list. Selecting one enables
  // that skill for the conversation and clears the token.
  const skillsQ = useQuery({ queryKey: skillKeys.list(), queryFn: fetchSkills, staleTime: 30_000 })
  const CHAT_UNSUPPORTED_SKILLS = new Set(['filesystem'])
  const pickableSkills = (skillsQ.data ?? []).filter((s) => !CHAT_UNSUPPORTED_SKILLS.has(s.id))
  const skillPickerMatch = /^\/([a-z0-9-]*)$/i.exec(input)
  const skillPickerQuery = skillPickerMatch?.[1]?.toLowerCase() ?? ''
  const filteredSkills = skillPickerMatch
    ? pickableSkills.filter((s) => !skillPickerQuery || s.id.includes(skillPickerQuery) || s.name.toLowerCase().includes(skillPickerQuery))
    : []
  const skillPickerOpen = !!skillPickerMatch && filteredSkills.length > 0 && !live
  const [skillPickerIndex, setSkillPickerIndex] = useState(0)
  useEffect(() => { setSkillPickerIndex(0) }, [skillPickerQuery, skillPickerOpen])

  const selectSkill = (skill: { id: string; name: string }) => {
    setInput(`/${skill.id} `)
    setTimeout(autoResize, 0)
    if (activeId) {
      const next = Array.from(new Set([...enabledSkillIds, skill.id]))
      mut.update.mutate({ id: activeId, skillIds: next })
    } else {
      setPendingSkillIds((prev) => Array.from(new Set([...prev, skill.id])))
    }
    toast.success(`Skill enabled: ${skill.name}`)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // Open a conversation another screen handed off (e.g. Launch Expert in Settings).
  const pendingConversationId = useUiStore((s) => s.pendingConversationId)
  const setPendingConversationId = useUiStore((s) => s.setPendingConversationId)
  useEffect(() => {
    if (!pendingConversationId) return
    handleSelect(pendingConversationId)
    setPendingConversationId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConversationId])

  // Only offer models the active engine can actually load (ADR-044) — GGUFs under
  // llama.cpp, safetensors under MLX/vLLM. Keeps the chat model menu from listing
  // models that would 409 on load.
  const allModels = (modelsQ.data?.models ?? []).filter((m) => m.compatibleWithActiveEngine)
  // Turbo Link (ADR-376 §6.3): models living on other machines, grouped under their machine
  // in the picker below. Both queries fail soft (`?? []`) — a host-gated 403 or a daemon
  // with no links must leave the chat screen exactly as it was, not error it.
  const linksQ = useLinks()
  const remoteModelsQ = useRemoteModels()
  /** Turbo Link (ADR-376, final-review C-1): the qualified `<machine>/<model>` id this
   *  chat is pointed at, or null for "this machine's loaded model".
   *
   *  A remote model is NOT loaded — it is already up on the other box — so selecting one
   *  is a routing choice, not an engine action. It deliberately does not touch
   *  `modelActions.load`, which posts to the LOCAL engine loader: that aborts every
   *  in-flight generation in every conversation before it does anything else, and then
   *  either 409s or loads a completely different local model.
   *
   *  Held in the UI store, NOT in `useState`: every screen is lazily routed and unmounts
   *  on navigation, so component state made the pick silently revert to the local model as
   *  soon as the user visited another screen and came back. Still not per-conversation —
   *  the daemon holds no per-conversation model and inventing one would be a schema
   *  decision this has no mandate for — but it now outlives the screen (and a reload). */
  const remoteModelId = useUiStore((s) => s.remoteModelId)
  const setRemoteModelId = useUiStore((s) => s.setRemoteModelId)
  const remoteChoice = remoteModelId
    ? findRemoteChoice(remoteModelId, linksQ.data ?? [], remoteModelsQ.data ?? [])
    : undefined
  // A selection whose machine went offline (or whose model stopped being advertised)
  // silently stops being a selection — the same rule the catalog enforces server-side:
  // a listed-but-unusable model is worse than an absent one.
  const activeRemoteId = remoteChoice?.id ?? null
  // Stats parity (spec §5.4, final-review I-5): the HOST's own engine state, read over the
  // link and rendered from the host's own `/api/v1/status` shape. Only polled while a chat
  // is actually pointed at that machine. A soft read — a host that dropped is reported by
  // the send itself, loudly and by name, not by an error banner on the header.
  const remoteStatusQ = useLinkStatus(remoteChoice?.linkId ?? null)
  const remoteHostState = activeRemoteId
    ? (remoteStatusQ.data ? describeRemoteHost(remoteStatusQ.data) : remoteStatusQ.isError ? 'not answering' : null)
    : null
  // Gates ReasoningEffortSelect vs ThinkingBudgetSlider below — `status.model` (LoadedModel)
  // is a slim subset without capability flags, so look the full ModelEntry up by key.
  const loadedModelSupportsReasoningEffort = (modelsQ.data?.models ?? []).find((m) => m.key === model?.key)?.reasoningEffort ?? false
  const modelBusy =
    modelActions.load.isPending ||
    modelActions.eject.isPending ||
    engineState === 'starting' ||
    engineState === 'stopping'

  const handleLoadModel = (key: string) => {
    // The branch itself is `selectModel` (lib/remote-models.ts) and is unit-tested there:
    // a remote row's id names another machine and must NEVER reach the local engine
    // loader, which aborts every in-flight generation before it does anything else.
    const choice = selectModel(key, linksQ.data ?? [], remoteModelsQ.data ?? [])
    if (choice.kind === 'remote') {
      setRemoteModelId(choice.id)
      return
    }
    // Picking a local model is also how the user comes BACK from a remote machine.
    setRemoteModelId(null)
    modelActions.load.mutate(
      { key: choice.key },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.') },
    )
  }
  const handleEject = () => {
    // Pointed at another machine, "Eject" means "stop using it" — this machine's engine is
    // not what is serving these turns, and stopping it would be a surprising side effect.
    if (activeRemoteId) { setRemoteModelId(null); return }
    // Ejecting kills the whole engine — every in-flight generation across every
    // conversation dies with it, not just the active one.
    if (Object.keys(abortRefs.current).length > 0) {
      for (const ac of Object.values(abortRefs.current)) ac.abort()
      abortRefs.current = {}
    }
    setLiveByConv((prev) => (Object.keys(prev).length > 0 ? {} : prev))
    modelActions.eject.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not eject model.'),
    })
  }

  // Auto-resize textarea
  const autoResize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // Autoscroll
  const scrollToBottom = useCallback((force = false) => {
    const el = scrollerRef.current
    if (!el) return
    if (force || !userScrolledUp.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setShowScrollBtn(false)
    }
  }, [])

  // Save the current conversation's scroll position into the per-conversation map.
  // At-bottom (< 80px — same threshold as the streaming pin) clears the entry, so
  // switching back to a bottom-pinned conversation lands at the bottom again.
  const saveScrollOffset = useCallback(() => {
    const el = scrollerRef.current
    const id = activeIdRef.current
    if (!el || !id) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atBottom) delete scrollOffsets.current[id]
    else scrollOffsets.current[id] = el.scrollTop
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const handler = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !atBottom
      setShowScrollBtn(!atBottom && !!live)
      saveScrollOffset()
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [live, saveScrollOffset])

  useEffect(() => {
    if (live) scrollToBottom()
  }, [live, scrollToBottom])

  // Preserve scroll on conversation switch (spec 07 §7): once the switched-to
  // conversation's messages are in the DOM (convQ catches up to activeId a render
  // later on a cold cache), restore its saved offset — or land at the bottom when
  // none was saved. Instant jumps, not smooth: the content just appeared, and a
  // smooth scroll would race the save-on-scroll handler above.
  useEffect(() => {
    const el = scrollerRef.current
    const pending = pendingScrollRestore.current
    if (!el || !activeId || conv?.id !== activeId || pending?.id !== activeId) return
    pendingScrollRestore.current = null
    if (pending.top === null) {
      // Never visited this session, or last seen pinned at bottom → bottom, as before.
      userScrolledUp.current = false
      el.scrollTop = el.scrollHeight
      setShowScrollBtn(false)
    } else {
      el.scrollTop = pending.top
      // A restored mid-thread offset counts as "scrolled up": a stream running in
      // this conversation shows the jump-to-latest pill instead of yanking to bottom.
      const atBottom = el.scrollHeight - pending.top - el.clientHeight < 80
      userScrolledUp.current = !atBottom
      setShowScrollBtn(!atBottom && !!liveByConv[activeId])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, conv?.id])

  // Ctrl+N new chat, Esc stop. Whitelist ONLY these exact combos and preventDefault
  // solely for the one we handle (Ctrl/Cmd+N) — never for anything else, so native
  // shortcuts like Ctrl/Cmd+C (copy) are left untouched.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        handleNew()
        return
      }
      if (e.key === 'Escape' && activeId && liveByConv[activeId]) { void handleStop() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  // Sync thinking budget / reasoning effort when conversation changes.
  useEffect(() => {
    setThinkingBudgetState(readThinkingBudget(activeId))
    setReasoningEffortState(readReasoningEffort(activeId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // ── Share handlers (F-023) ────────────────────────────────────────────────

  const copyText = async (text: string, successMsg: string, title: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(successMsg)
    } catch {
      // Clipboard API unavailable — show fallback modal with pre-selected text
      setClipboardFallback({ text, title })
    }
  }

  const handleCopyLink = async () => {
    if (!activeId) return
    try {
      const { url } = await getShareUrl(activeId)
      await copyText(url, 'Link copied', 'Share link')
    } catch {
      toast.error('Could not get share URL.')
    }
  }

  const handleCopyDebugInfo = async () => {
    if (!activeId) return
    try {
      const json = await getDebugSnapshot(activeId)
      await copyText(json, 'Debug info copied', 'Debug snapshot')
    } catch {
      toast.error('Could not get debug info.')
    }
  }

  const handleExportChat = () => {
    if (!activeId) return
    downloadChatExport(activeId)
  }

  // ── Import handler (F-024) ────────────────────────────────────────────────

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)
    setImportModelMismatch(null)
    let payload: unknown
    try {
      const text = await file.text()
      payload = JSON.parse(text)
    } catch {
      setImportError('Invalid file — could not parse JSON.')
      return
    }
    // Check model mismatch before importing (only applicable to object formats)
    if (!Array.isArray(payload)) {
      const exportModel = (payload as Record<string, unknown>)?.model as string | undefined
      if (exportModel) {
        const models = modelsQ.data?.models ?? []
        const found = models.some((m) => m.key === exportModel)
        if (!found) setImportModelMismatch(exportModel)
      }
    }
    try {
      const { id } = await importChat(payload)
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      handleSelect(id)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Import failed. Check the file is a valid .turbollm-chat.json or OpenAI-format JSON.'
      setImportError(msg)
    }
  }

  const handleNew = () => {
    saveScrollOffset()
    setActiveId(null)
    setInput('')
    setSelectedPersonaId(getDefaultAgentId())
    inputRef.current?.focus()
  }

  const handleSelect = (id: string) => {
    // Switching conversations must not kill an in-flight generation — only an explicit
    // Stop/Eject/delete should. The backend keeps generating and saves the result when
    // done; live state is now per-conversation (keyed by convId, not activeId), so it
    // needs no clearing here — the render layer just looks up whatever entry (if any)
    // matches the newly-active id.
    // Preserve scroll (spec 07 §7): save the outgoing conversation's offset now —
    // before the content swap clamps it — and capture the target's saved offset for
    // the restore effect to apply once the target's messages have rendered.
    saveScrollOffset()
    pendingScrollRestore.current = { id, top: scrollOffsets.current[id] ?? null }
    setActiveId(id)
    setEditingId(null)
    setSelectedPersonaId(getConvAgentId(id))
    if (recentlyCompletedIds.has(id)) {
      setRecentlyCompletedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // The currently-open conversation was deleted — abort any live generation and
  // close it (clear activeId) so we don't hold a dangling reference.
  const handleActiveDeleted = (id: string) => {
    if (id !== activeId) return
    abortRefs.current[id]?.abort()
    delete abortRefs.current[id]
    delete scrollOffsets.current[id]
    setLiveByConv((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setActiveId(null)
    setEditingId(null)
    setInput('')
    setSelectedPersonaId(getDefaultAgentId())
  }

  const handleStop = async () => {
    if (activeId) {
      abortRefs.current[activeId]?.abort()
      await mut.stop.mutateAsync(activeId).catch(() => {})
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const loaded = await Promise.all(files.map(async (file) => {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      if (isPdf) {
        // PDFs are binary — extract real text client-side instead of reading raw bytes as text.
        const text = await extractPdfText(file)
        return { file, dataUrl: text }
      }
      const dataUrl = await new Promise<string>((res) => {
        const r = new FileReader()
        r.onload = () => res(r.result as string)
        if (file.type.startsWith('image/')) r.readAsDataURL(file)
        else r.readAsText(file)
      })
      return { file, dataUrl }
    }))
    setAttachments((prev) => [...prev, ...loaded])
    e.target.value = ''
  }

  // Record one generated token for `convId` and return its rolling 2-second tok/s estimate.
  const pushGenToken = (convId: string) => {
    const now = Date.now()
    const timestamps = [...(deltaTimestamps.current[convId] ?? []), now].filter((t) => t > now - 2000)
    deltaTimestamps.current[convId] = timestamps
    return Math.round((timestamps.length / 2) * 10) / 10
  }

  // Applies `updater` to convId's live entry, no-op if it's already gone (e.g. the
  // conversation was deleted or ejected mid-stream) — mirrors the old `l ? ... : l` guard.
  const updateLive = (convId: string, updater: (l: LiveState) => LiveState) => {
    setLiveByConv((prev) => (prev[convId] ? { ...prev, [convId]: updater(prev[convId]) } : prev))
  }
  const clearLive = (convId: string) => {
    setLiveByConv((prev) => {
      if (!(convId in prev)) return prev
      const next = { ...prev }
      delete next[convId]
      return next
    })
  }

  // Shared SSE consumer: drives live streaming state for either a fresh send or a continue.
  // Every setLiveByConv/abortRefs access below targets `convId` — the parameter — not
  // `activeId`, because by the time an event arrives the user may have navigated to a
  // different conversation while this generation keeps running in the background.
  const streamFrom = async (convId: string, gen: AsyncGenerator<ChatSseEvent>) => {
    try {
      for await (const evt of gen) {
        if (evt.event === 'meta') {
          deltaTimestamps.current[convId] = []
          setLiveByConv((prev) => ({
            ...prev,
            [convId]: { assistantId: evt.data.assistantMessageId, content: '', reasoning: '', progress: null, liveGenTps: 0, genTokens: 0, timeline: [] },
          }))
          // Optimistically reflect the new/last user msg in the UI by invalidating
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
        } else if (evt.event === 'progress') {
          updateLive(convId, (l) => ({ ...l, progress: { phase: evt.data.phase, pct: evt.data.pct, tps: evt.data.tps } }))
        } else if (evt.event === 'reasoning') {
          // Thinking tokens count toward generation too — track rate + count.
          const liveTps = pushGenToken(convId)
          updateLive(convId, (l) => ({ ...l, reasoning: l.reasoning + evt.data.delta, progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 }))
        } else if (evt.event === 'delta') {
          const liveTps = pushGenToken(convId)
          updateLive(convId, (l) => ({ ...l, content: l.content + evt.data.delta, timeline: appendTextDelta(l.timeline, evt.data.delta), progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 }))
        } else if (evt.event === 'tool_call') {
          const tc = evt.data
          const call: LiveToolCall = { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result }
          updateLive(convId, (l) => ({ ...l, timeline: upsertToolCall(l.timeline, call) }))
        } else if (evt.event === 'done') {
          // Patch the final content into the cache BEFORE clearing live state (pre-release
          // review, Finding A): clearLive un-hides the placeholder synchronously, but the real
          // content only arrives via the async invalidateQueries refetch below — without this
          // patch, the now-visible placeholder would briefly render with its stale empty
          // content (a "This message is empty." flash) in that window. Reading the live
          // snapshot via setLiveByConv's own functional updater guarantees it isn't stale, even
          // though React may batch prior delta/reasoning updates that haven't rendered yet.
          setLiveByConv((prev) => {
            const l = prev[convId]
            if (l) {
              qc.setQueryData<Conversation>(['conversation', convId], (old) =>
                old
                  ? { ...old, messages: (old.messages ?? []).map((m) => (m.id === l.assistantId ? { ...m, content: l.content, reasoning: l.reasoning } : m)) }
                  : old,
              )
            }
            if (!(convId in prev)) return prev
            const next = { ...prev }
            delete next[convId]
            return next
          })
          if (convId !== activeIdRef.current) setRecentlyCompletedIds((prev) => new Set(prev).add(convId))
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          void qc.invalidateQueries({ queryKey: ['conversations'] })
          // Only nudge the scroller when the finished conversation is the one on
          // screen, and never force past the ≥80px pin (spec 07 §7): a user reading
          // up-thread — or a restored mid-thread offset — keeps their place, and a
          // background completion must not yank the conversation being looked at.
          if (convId === activeIdRef.current) setTimeout(() => scrollToBottom(), 80)
        } else if (evt.event === 'error') {
          clearLive(convId)
          if (convId !== activeIdRef.current) setRecentlyCompletedIds((prev) => new Set(prev).add(convId))
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          toast.error(evt.data.message)
        }
      }
      // Stream ended without an explicit done/error (e.g. network cut, silent close)
      clearLive(convId)
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } catch (e) {
      clearLive(convId)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } finally {
      delete abortRefs.current[convId]
    }
  }

  const send = async (overrideInput?: string) => {
    const rawText = (overrideInput ?? input).trim()
    if ((!rawText && attachments.length === 0) || live) return
    if (!ready) { toast.error('Load a model first.'); return }

    // A message that starts with '/skill-id' enables that skill for this send — no matter
    // how the token got there (picker click, Tab-complete, or just typed/pasted) — and the
    // literal token is stripped before it reaches the model (the skill's own instructions
    // may define a different natural-language trigger, e.g. "wan <url>" not "/wan <url>").
    const skillMatch = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(rawText)
    const matchedSkill = skillMatch ? pickableSkills.find((s) => s.id === skillMatch[1]) : undefined
    const text = matchedSkill ? (skillMatch?.[2] ?? '').trim() : rawText

    // Discriminate by file.type (authoritative, same as the preview thumbnail below) rather
    // than sniffing the extracted dataUrl content — a text/PDF attachment whose content
    // happens to start with "data:image/" would otherwise get mis-sent as an image.
    const imageAttachments = attachments.filter((a) => a.file.type.startsWith('image/'))
    const textAttachments = attachments.filter((a) => !a.file.type.startsWith('image/'))
    const images = imageAttachments.map((a) => a.dataUrl)
    const docContext = textAttachments.map((a) => `[Attached: ${a.file.name}]\n${a.dataUrl}`).join('\n\n')

    setInput('')
    setAttachments([])
    setTimeout(autoResize, 0)
    userScrolledUp.current = false

    // Hoisted above the try so the catch block can target the right conversation's
    // live/abort state even when it fails partway through creating a new conversation.
    let convId = activeId
    try {
      // Create conversation on first message, baking in the selected agent + personalization.
      if (!convId) {
        const resolved = allAgents.find((a) => a.id === selectedPersonaId)
        // Release 3, auto-memory: only fetched when the toggle is on, so turning it off is
        // a complete off-switch for new chats (not just "extraction stops" while stale
        // facts keep leaking into every future conversation).
        let memoryFacts: string[] = []
        if (settingsQ.data?.autoMemoryEnabled) {
          try {
            const { facts } = await listMemoryFacts()
            memoryFacts = facts.map((f) => f.factText)
          } catch { /* non-fatal — proceed without memory */ }
        }
        let sp = buildSystemPrompt(selectedPersonaId, resolved?.systemPrompt ?? '', getPersonalization(), memoryFacts)
        if (selectedPersonaId === 'expert') {
          try {
            const sys = await fetchSysInfo()
            const gpuLine = sys.gpus.length > 0
              ? sys.gpus.map(g => `${g.name} (${Math.round(g.vramMb / 1024)} GB VRAM)`).join(', ')
              : 'No GPU detected (CPU inference)'
            const hwSection = `## User's hardware\nGPU: ${gpuLine}\nRAM: ${Math.round(sys.ramMB / 1024)} GB\nOS: ${sys.os}`
            sp = sp ? `${sp}\n\n${hwSection}` : hwSection
          } catch { /* non-fatal — proceed without hardware info */ }
        }
        const initialSkillIds = Array.from(new Set([
          ...pendingSkillIds,
          ...(resolved?.skillIds ?? []),
          ...(matchedSkill ? [matchedSkill.id] : []),
        ]))
        // A system prompt set via Thread settings before the first message is an
        // explicit override — it wins over the agent's own default system prompt.
        const finalSystemPrompt = pendingSystemPrompt.trim() || sp
        const newConv = await mut.create.mutateAsync({
          // The model this conversation was STARTED with, for the sidebar label. A remote
          // machine's qualified id is the honest value there — it is what answered.
          modelKey: activeRemoteId ?? model?.key ?? '',
          systemPrompt: finalSystemPrompt || undefined,
          toolPolicy: selectedPersonaId === 'research' ? 'force_web_search' : undefined,
          skillIds: initialSkillIds.length ? initialSkillIds : undefined,
          // Pass an explicit empty array through as-is (e.g. Blank's fixed []) — collapsing it
          // to undefined here would silently turn "zero tools" back into "unrestricted" before
          // the request ever reaches the backend (GitHub #52).
          allowedTools: resolved?.tools,
          sampling: Object.keys(pendingSampling).length ? pendingSampling : undefined,
          preserveThinking: pendingPreserveThinking,
        })
        convId = newConv.id
        setConvAgentId(convId, selectedPersonaId)
        setActiveId(convId)
        setPendingSkillIds([])
        setPendingSystemPrompt('')
        setPendingSampling({})
        setPendingPreserveThinking(true)
      } else if (matchedSkill && !enabledSkillIds.includes(matchedSkill.id)) {
        // Existing conversation missing this skill — enable it before sending so the
        // system-prompt injection picks it up on this very turn, not the next one.
        await mut.update.mutateAsync({ id: convId, skillIds: Array.from(new Set([...enabledSkillIds, matchedSkill.id])) })
      }
      if (matchedSkill) toast.success(`Using skill: ${matchedSkill.name}`)

      const ac = new AbortController()
      abortRefs.current[convId] = ac

      const textAttachmentNames = textAttachments.map((a) => a.file.name)
      await streamFrom(convId, sendMessage(convId, text, ac.signal, images, docContext, textAttachmentNames, thinkingBudget, reasoningEffort, activeRemoteId ?? undefined))
    } catch (e) {
      if (convId) clearLive(convId)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      if (convId) void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    }
  }

  const handleEditSave = (msgId: string, content: string) => {
    if (!activeId) return
    // GitHub #52: editing the model's own reply just fixes its text in place — no reason
    // to trigger ANOTHER reply after it. Only a user-message edit resends (branching the
    // downstream history, per ADR — see chat-routes.ts's PUT /messages/:msgId).
    const isUserMessage = messages.find((m) => m.id === msgId)?.role === 'user'
    setEditingId(null)
    mut.editMsg.mutate({ convId: activeId, msgId, content }, {
      onSuccess: () => {
        userScrolledUp.current = false
        if (isUserMessage && ready) {
          const ac = new AbortController()
          abortRefs.current[activeId] = ac
          void streamFrom(activeId, continueConversation(activeId, ac.signal, thinkingBudget, reasoningEffort, activeRemoteId ?? undefined))
        }
      },
      onError: () => toast.error('Could not edit message.'),
    })
  }

  const handleRegenerate = async () => {
    if (!activeId || live) return
    if (!ready) { toast.error('Load a model first.'); return }
    await mut.regenerate.mutateAsync(activeId).catch(() => {})
    const ac = new AbortController()
    abortRefs.current[activeId] = ac
    void streamFrom(activeId, continueConversation(activeId, ac.signal, thinkingBudget, reasoningEffort, activeRemoteId ?? undefined))
  }

  const handleDelete = (m: Message) => {
    if (!activeId) return
    mut.deleteMsg.mutate({ convId: activeId, msgId: m.id }, {
      onError: () => toast.error('Could not delete message.'),
    })
  }

  // Context meter
  const lastStats = messages.findLast((m) => m.role === 'assistant')?.stats
  const ctxUsed  = lastStats?.ctxUsed ?? 0
  // Prefer the currently-loaded model's ctx (fresh after a reload) over the last
  // message's reported max, which goes stale when settings change.
  // On a remote machine the last reply's own reported max IS the fresh number — the local
  // manager's `model.ctx` describes a different model on a different box.
  const ctxMax   = activeRemoteId ? (lastStats?.ctxMax ?? 0) : (model?.ctx || lastStats?.ctxMax || 0)

  // Chatting with a linked machine needs nothing loaded HERE. Requiring it is precisely
  // what made every remote row unusable.
  const ready = activeRemoteId ? true : engineState === 'running' && !!model

  // At most one tool call awaits interactive approval at a time (the tool loop is sequential).
  // Read from the timeline — the actual live-updated source — not a separate tracked array.
  const pendingApprovalBlock = live?.timeline.find((b) => b.kind === 'tool' && b.call.status === 'awaiting_approval')
  const pendingApproval = pendingApprovalBlock?.kind === 'tool' ? pendingApprovalBlock.call : undefined

  const generatingIds = useMemo(() => new Set(Object.keys(liveByConv)), [liveByConv])

  // GitHub #177: the DAEMON's own "something is generating right now" signal, selected off the
  // status poll that's already running above (line 59) — no second poller, no new request. The
  // local `live`/`liveByConv` state can't answer this: it belongs to the tab that started the
  // stream, so after a reload (or in another tab) it's empty while the turn is still running,
  // and the still-empty placeholder row rendered as a red "This message is empty." error.
  // It is engine-wide and carries no conversation id, which is why MessageBubble additionally
  // requires the row itself to be an unfinalized placeholder (isAwaitingGeneration).
  const daemonGenerating = !!status?.liveGeneration

  // Close the gap between "the daemon stopped generating" (status poll, 1–2s) and "this client
  // has the finished message" (useConversation's 4s poll). Without this, a passive viewer's
  // bubble could leave its Generating… state up to 4s before the persisted content arrives —
  // and land back on the very error card this fix exists to remove. Fires only on the
  // true→false edge, so it costs one extra fetch per generation at most.
  const wasDaemonGenerating = useRef(false)
  useEffect(() => {
    if (wasDaemonGenerating.current && !daemonGenerating && activeId) {
      void qc.invalidateQueries({ queryKey: chatKeys.detail(activeId) })
    }
    wasDaemonGenerating.current = daemonGenerating
  }, [daemonGenerating, activeId, qc])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar (collapsible, drag-resizable when open). The collapse/expand width
          transition lives in the `tllm-chat-sidebar` CSS class (index.css), not inline,
          so it can be disabled globally while dragging (html.tllm-resizing) without
          fighting the resize handle's own per-pixel style mutation. */}
      {/* Mobile: dim backdrop behind the drawer; tap to dismiss. Embedded mode (Routines' 3-pane
          layout) never renders this own sidebar at all — the embedding page supplies its own. */}
      {!embedded && !isDesktop && mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => { track('chat', 'toggle_sidebar_collapsed'); setMobileSidebarOpen(false) }}
          aria-hidden
        />
      )}
      {!embedded && (
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
            activeId={activeId}
            onSelect={(id) => { handleSelect(id); if (!isDesktop) setMobileSidebarOpen(false) }}
            onNew={() => { handleNew(); if (!isDesktop) setMobileSidebarOpen(false) }}
            onImport={readonly ? undefined : () => importFileRef.current?.click()}
            collapsed={isDesktop ? !sidebarOpen : false}
            onToggle={isDesktop ? () => setSidebarOpen((o) => !o) : () => setMobileSidebarOpen(false)}
            generating={!!live}
            generatingIds={generatingIds}
            recentlyCompletedIds={recentlyCompletedIds}
            onDeleted={handleActiveDeleted}
          />
        </div>
      )}
      {!embedded && isDesktop && sidebarOpen && <SidebarResizeHandle sidebarRef={sidebarRef} onCommit={setSidebarWidth} />}

      {/* Thread */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Read-only banner (F-023: shown when ?readonly=1) */}
        {readonly && (
          // No --tllm-safe-top here: Shell.tsx's own wrapper already pads every screen's
          // top by this exact inset once — this was adding it a second time.
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-panel-2 px-4 py-1.5 text-[12px] text-muted" style={{ paddingBottom: 'var(--tllm-safe-bottom)' }}>
            <span className="font-medium text-ink">Shared view</span>
            <span className="text-faint">—</span>
            <span>read only</span>
          </div>
        )}

        {/* Chat header: model load/switch/eject (always available) */}
        {/* QA_BUGS.md BUG-03 (original fix, now superseded): the safe-area padding that used to
            live here moved to Shell.tsx's own wrapper, which pads every screen's top by this
            same inset once — applying it again here double-counted it (confirmed live: a real
            "extra padding at the top", once the inset's own value got fixed to its correct,
            smaller size — this double-count was always there, just masked by that bug's much
            larger error). */}
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 md:gap-2 md:px-4" style={{ paddingBottom: 'var(--tllm-safe-bottom)' }}>
          {/* Mobile: open the conversation drawer (the sidebar is off-canvas below md). Not
              rendered when embedded — there is no drawer of this component's own to open. */}
          {!embedded && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 md:hidden"
            onClick={() => { track('chat', 'toggle_sidebar_collapsed'); setMobileSidebarOpen(true) }}
            title="Conversations"
            aria-label="Open conversations"
          >
            <PanelLeft size={16} />
          </Button>
          )}
          <ModelLoadMenu
            models={allModels}
            loadedKey={activeRemoteId ?? model?.key ?? null}
            loadedName={remoteChoice ? `${remoteChoice.name} — ${remoteChoice.machine}` : (model?.name ?? null)}
            pending={modelBusy}
            ejecting={modelActions.eject.isPending}
            onLoad={handleLoadModel}
            onEject={handleEject}
            onSettings={(key) => setSettingsKey(key)}
            screen="chat"
            links={linksQ.data ?? []}
            remoteModels={remoteModelsQ.data ?? []}
          />
          {/* Load settings are a LOCAL engine concern — there is nothing on this machine to
              configure for a model running on another one. */}
          {model && !activeRemoteId && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => { track('chat', 'open_model_settings'); setSettingsKey(model.key) }}
              title="Model settings — change on the fly"
            >
              <SlidersHorizontal size={15} />
            </Button>
          )}
          <ConversationSettingsDialog conv={conv} draft={draft} modelSampling={modelSampling} />
          {loadedModelSupportsReasoningEffort ? (
            <ReasoningEffortSelect value={reasoningEffort} onChange={setReasoningEffort} />
          ) : (
            <ThinkingBudgetSlider value={thinkingBudget} onChange={setThinkingBudget} />
          )}
          {activeId && selectedAgent && (
            <span
              title={selectedAgent.description}
              className="hidden items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted select-none sm:inline-flex"
            >
              <UserRound size={11} />
              {selectedAgent.name}
            </span>
          )}
          {engineState === 'starting' && (
            <span className="text-[12px] text-muted">
              Loading model…{model?.loadElapsedMs != null && ` (${Math.round(model.loadElapsedMs / 1000)}s)`}
            </span>
          )}
          {engineState === 'stopping' && !activeRemoteId && <span className="text-[12px] text-muted">Ejecting…</span>}
          {remoteChoice && remoteHostState && (
            <span
              className="hidden text-[12px] text-muted sm:inline"
              title={`Live state of ${remoteChoice.machine}, read over the link`}
            >
              {remoteChoice.machine}: {remoteHostState}
            </span>
          )}
          {ready && (
            <div className="ml-auto hidden sm:flex">
              <ContextMeter ctxUsed={ctxUsed} ctxMax={ctxMax} />
            </div>
          )}

          {/* Share / Export menu (F-023, F-024) — only when a conversation is active */}
          {activeId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-auto h-8 w-8"
                  title="Share or export this chat"
                >
                  <Share2 size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem className="text-[13px]" onSelect={() => { track('chat', 'copy_chat_link'); void handleCopyLink() }}>
                  <Copy size={13} className="text-muted" />
                  Copy link (LAN)
                </DropdownMenuItem>
                <DropdownMenuItem className="text-[13px]" onSelect={() => { track('chat', 'copy_chat_debug_info'); void handleCopyDebugInfo() }}>
                  <Copy size={13} className="text-muted" />
                  Copy debug info
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-[13px]" onSelect={() => { track('chat', 'export_chat'); handleExportChat() }}>
                  <Download size={13} className="text-muted" />
                  Export chat
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Message list — always visible; empty state shown only when no messages */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {/* 768px thread measure (spec 11 §2) — must match the composer wrapper below */}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-4 md:px-8 md:py-6">
            {/* Hidden import file input (F-024) */}
            <input
              ref={importFileRef}
              type="file"
              accept=".json,.turbollm-chat.json"
              hidden
              onChange={(e) => void handleImportFile(e)}
            />

            {/* Model mismatch banner (F-024): shown after a successful import when the
                exported model isn't available on this machine. Inline, not a toast. */}
            {importModelMismatch && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-[color:var(--warn)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-3 py-2 text-[13px]">
                <span className="flex-1">
                  <span className="font-medium">Model not found:</span>{' '}
                  <span className="font-mono">{importModelMismatch}</span> is not available on this machine.
                  The chat was imported — select a different model to continue.
                </span>
                <button type="button" onClick={() => { track('chat', 'dismiss_import_banner'); setImportModelMismatch(null) }} className="shrink-0 text-faint hover:text-ink"><X size={13} /></button>
              </div>
            )}

            {/* Import error (F-024): inline, not toast */}
            {importError && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-[color:var(--err)] bg-[color-mix(in_srgb,var(--err)_8%,transparent)] px-3 py-2 text-[13px]">
                <span className="flex-1 text-[color:var(--err)]">{importError}</span>
                <button type="button" onClick={() => { track('chat', 'dismiss_import_banner'); setImportError(null) }} className="shrink-0 text-faint hover:text-ink"><X size={13} /></button>
              </div>
            )}

            {/* Empty state */}
            {messages.length === 0 && !live && (
              <div className="flex flex-col items-center gap-4 py-16">
                {model ? (
                  <>
                    <p className="text-[15px] font-medium text-ink">{model.name}</p>
                    <AgentPicker selected={selectedPersonaId} onChange={setSelectedPersonaId} agents={allAgents} />
                    <div className="flex flex-wrap justify-center gap-2">
                      {['Explain something to me', 'Help me write', 'Review this code'].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => { track('chat', 'use_suggested_prompt'); setInput(s); setTimeout(() => inputRef.current?.focus(), 0) }}
                          className="rounded-full border border-border px-4 py-1.5 text-[13px] text-muted hover:border-accent hover:text-ink transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-[14px] text-muted">Select a model above to begin</p>
                )}
              </div>
            )}

            {/* Messages — skip the in-flight assistant placeholder while it's still live
                below. The backend inserts that row the moment generation starts
                (chat-routes.ts: `db.addMessage(convId, 'assistant', '', ...)`, before any
                token has streamed), and the 'meta' event's optimistic refetch can pull it
                into this list before the StreamingBubble below has caught up — a real empty
                message bubble momentarily rendering above the answer that's still typing in. */}
            {messages
              .filter((m) => m.id !== live?.assistantId)
              .map((m, i, arr) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  convId={readonly ? undefined : activeId ?? undefined}
                  isLast={i === arr.length - 1 && !live}
                  daemonGenerating={daemonGenerating}
                  onEdit={readonly ? undefined : (msg) => setEditingId(msg.id)}
                  onDelete={readonly ? undefined : handleDelete}
                  onRegenerate={readonly ? undefined : handleRegenerate}
                  editingId={editingId}
                  onEditSave={(content) => handleEditSave(m.id, content)}
                  onEditCancel={() => setEditingId(null)}
                />
              ))}

            {/* Streaming bubble */}
            {live && (
              <StreamingBubble timeline={live.timeline} reasoning={live.reasoning} progress={live.progress} liveGenTps={live.liveGenTps} genTokens={live.genTokens} />
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Scroll-to-bottom pill (spec 07 §7) — fades in over 150ms via the shared
            tllm-rise-in keyframe (index.css), suppressed for motion-sensitive users.
            Gated on `live` too: it's a streaming affordance, and now that done/error
            no longer force-scroll (which used to reset showScrollBtn), the stale flag
            must not leave the pill hanging after a stream ends mid-thread. */}
        {showScrollBtn && live && (
          <button
            type="button"
            onClick={() => { track('chat', 'scroll_to_latest'); userScrolledUp.current = false; scrollToBottom(true) }}
            className="absolute bottom-28 left-1/2 -translate-x-1/2 flex animate-[tllm-rise-in_150ms_ease-out] items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1.5 text-[13px] text-muted shadow-[var(--shadow-2)] transition-colors hover:text-ink motion-reduce:animate-none" style={{ marginBottom: 'var(--tllm-safe-bottom)'}}
          >
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}

        {/* Clipboard fallback modal (F-023): shown when navigator.clipboard is unavailable */}
        {clipboardFallback && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { track('chat', 'dismiss_clipboard_modal'); setClipboardFallback(null) }}>
            <div className="mx-4 w-full max-w-lg rounded-lg border border-border bg-panel p-4 shadow-[var(--shadow-2)]" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'calc(var(--tllm-safe-bottom, 0px) + 1rem)'}}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">{clipboardFallback.title}</span>
                <button type="button" onClick={() => { track('chat', 'dismiss_clipboard_modal'); setClipboardFallback(null) }} className="text-faint hover:text-ink"><X size={14} /></button>
              </div>
              <textarea
                readOnly
                autoFocus
                className="h-48 w-full resize-none rounded border border-border bg-panel-2 p-2 text-[12px] font-mono text-ink outline-none"
                value={clipboardFallback.text}
                onFocus={(e) => e.target.select()}
              />
              <p className="mt-1 text-[11px] text-faint">Select all and copy (Ctrl+C / Cmd+C)</p>
            </div>
          </div>
        )}

        {/* Tool-call approval gate (inline banner, not a modal — coexists with reading
            the transcript). Rendered just above the composer while a background tool
            call awaits interactive approval. */}
        {!readonly && activeId && pendingApproval && (
          <div className="mx-auto w-full max-w-3xl">
            <ToolApprovalBar key={pendingApproval.id} pending={pendingApproval} convId={activeId} onResolved={() => {}} />
          </div>
        )}

        {/* Composer area (always visible; disabled when no model; hidden in readonly) */}
        {readonly ? null : <div className="mx-auto w-full max-w-3xl px-3 pb-3 md:px-8 md:pb-5">
          <div className="relative w-full">
            {/* '/' skill picker */}
            {skillPickerOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-border bg-panel shadow-[var(--shadow-2)]">
                {filteredSkills.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { track('chat', 'select_skill_from_picker'); selectSkill(s) }}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-[13px]',
                      i === skillPickerIndex ? 'bg-panel-2' : 'hover:bg-panel-2',
                    )}
                  >
                    <span className="text-ink">/{s.id}{enabledSkillIds.includes(s.id) ? ' · already on' : ''}</span>
                    {s.description && <span className="text-[12px] text-muted">{s.description}</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="rounded-[var(--radius-lg)] border border-border bg-panel shadow-[var(--shadow-2)] focus-within:border-[color:var(--accent)]">
              {/* Attachment previews */}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                  {attachments.map((a, i) => (
                    <div key={i} className="relative flex items-center gap-1 rounded border border-border bg-panel-2 px-2 py-1 text-[12px]">
                      {a.file.type.startsWith('image/')
                        ? <img src={a.dataUrl} className="h-8 w-8 rounded object-cover" alt="" />
                        : <span className="text-muted">{a.file.name}</span>
                      }
                      <button type="button" onClick={() => { track('chat', 'remove_attachment'); setAttachments((prev) => prev.filter((_, j) => j !== i)) }} className="text-faint hover:text-err">
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2 p-2">
                <button
                  type="button"
                  onClick={() => { track('chat', 'attach_file'); fileInputRef.current?.click() }}
                  disabled={!ready || !!live}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-panel-2 disabled:opacity-40"
                  title="Attach image or document"
                >
                  <Paperclip size={15} className="text-muted" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.log,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.rb,.php,.sh,.sql,.xml,.toml,.ini"
                  hidden
                  onChange={handleFileSelect}
                />
                <textarea
                  ref={inputRef}
                  rows={1}
                  className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-ink outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-faint"
                  // Both halves of this string are shortened in JS rather than left to CSS,
                  // because a <textarea> placeholder does NOT ellipsize: verified on-device that
                  // `text-overflow: ellipsis` (the classes above, and the rule IS in the bundle)
                  // has no effect on ::placeholder in Android's WebView — a long name still chops
                  // mid-glyph. So: the idle text is short enough to fit 360px outright, and a long
                  // model name gets a real "…" spliced in at a width that fits. Previously the
                  // decorative trailing "…" was itself the thing being clipped, leaving what read
                  // as a stray full stop after the model name (QA_UX_REPORT.md F-03, P2-1).
                  placeholder={ready ? `Message ${truncateName(remoteChoice?.name ?? model?.name ?? 'the model')}` : 'Load a model to start chatting'}
                  value={input}
                  disabled={!ready || !!live || !!editingId}
                  onChange={(e) => { setInput(e.target.value); autoResize() }}
                  onKeyDown={(e) => {
                    if (skillPickerOpen) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSkillPickerIndex((i) => Math.min(i + 1, filteredSkills.length - 1)); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setSkillPickerIndex((i) => Math.max(i - 1, 0)); return }
                      if (e.key === 'Tab') {
                        // Tab-complete only: fill in the matched skill's name, don't enable it yet
                        // (Enter still does that, now unambiguous once the text is a full match).
                        e.preventDefault()
                        const s = filteredSkills[Math.min(skillPickerIndex, filteredSkills.length - 1)]
                        setInput(`/${s.id}`)
                        setTimeout(autoResize, 0)
                        return
                      }
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectSkill(filteredSkills[Math.min(skillPickerIndex, filteredSkills.length - 1)]); return }
                      if (e.key === 'Escape') { e.preventDefault(); setInput(''); return }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                    if (e.key === 'ArrowUp' && !input && !live) {
                      const lastUser = messages.findLast((m) => m.role === 'user')
                      if (lastUser) { setEditingId(lastUser.id) }
                    }
                  }}
                />
                {live ? (
                  <Button size="icon" variant="outline" onClick={() => { track('chat', 'stop_generation'); void handleStop() }} title="Stop generation (Esc)">
                    <Square size={15} />
                  </Button>
                ) : (
                  <Button size="icon" onClick={() => { track('chat', 'send_message'); void send() }} disabled={!ready || (!input.trim() && attachments.length === 0) || !!editingId} aria-label="Send">
                    <SendHorizontal size={15} />
                  </Button>
                )}
              </div>
            </div>
            {/* No-model hint lives in the textarea placeholder above — don't repeat it here.
                Hidden ≤720px per spec 11 §4 (the spec value is 720, not the md 768 breakpoint). */}
            {model && (
              <p className="mt-1.5 px-1 text-[11px] text-faint max-[720px]:hidden">
                {model.name} · Enter to send · Shift+Enter for newline
              </p>
            )}
          </div>
        </div>}
      </div>

      <ModelDetailDialog modelKey={settingsKey} onClose={() => setSettingsKey(null)} />
    </div>
  )
}

// ── Agent picker ───────────────────────────────────────────────────────────────

function AgentPicker({ selected, onChange, agents }: {
  selected: string; onChange: (id: string) => void
  agents: Array<{ id: string; name: string; description: string }>
}) {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-1.5">
      <p className="text-[11px] uppercase tracking-wide text-faint">Agent</p>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="w-full max-w-full truncate rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} — {a.description}
          </option>
        ))}
      </select>
    </div>
  )
}

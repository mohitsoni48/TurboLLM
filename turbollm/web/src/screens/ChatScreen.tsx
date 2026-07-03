import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowDown, Brain, Copy, Download, Paperclip, SendHorizontal, Share2, SlidersHorizontal, Square, UserRound, X } from 'lucide-react'
import { continueConversation, fetchSysInfo, sendMessage } from '../lib/chat-api'
import { extractPdfText } from '../lib/pdf-extract'
import { useConversation, useConversationMutations } from '../lib/chat-queries'
import { useModelActions, useModels, useStatus } from '../lib/queries'
import type { ChatSseEvent, LiveToolCall, Message } from '../lib/chat-types'
import { ApiError, downloadChatExport, getDebugSnapshot, getShareUrl, importChat } from '../lib/api'
import { Button } from '../components/ui/button'
import { toast } from '../components/ui/sonner'
import { useQueryClient } from '@tanstack/react-query'
import { MessageBubble, StreamingBubble } from './chat/MessageBubble'
import { ContextMeter } from './chat/ContextMeter'
import { ConversationSidebar } from './chat/ConversationSidebar'
import { ModelLoadMenu } from '../components/ModelLoadMenu'
import { ModelDetailDialog } from './models/ModelDetailDialog'
import { ConversationSettingsDialog } from './chat/ConversationSettingsDialog'
import { useUiStore } from '../stores/ui'
import {
  PERSONAS, buildSystemPrompt, getConvPersonaId, getDefaultPersonaId,
  getPersonalization, setConvPersonaId,
  type PersonaId,
} from '../lib/personas'

// Streaming state
interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number  // rolling 2s window estimate during generation phase
  genTokens: number   // running count of generated tokens (content + reasoning) for this reply
  toolCalls: LiveToolCall[]
}

export function ChatScreen() {
  const { data: status } = useStatus()
  const model = status?.model
  const engineState = status?.engine.state

  // Route params: /chat/:convId?readonly=1
  const { convId: routeConvId } = useParams<{ convId?: string }>()
  const [searchParams] = useSearchParams()
  const readonly = searchParams.get('readonly') === '1'

  const [activeId, setActiveId] = useState<string | null>(routeConvId ?? null)
  const [live, setLive] = useState<LiveState | null>(null)
  const [input, setInput] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [settingsKey, setSettingsKey] = useState<string | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [attachments, setAttachments] = useState<{ file: File; dataUrl: string }[]>([])
  // Share menu state
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const [clipboardFallback, setClipboardFallback] = useState<{ text: string; title: string } | null>(null)
  const shareMenuRef = useRef<HTMLDivElement>(null)
  // Import state (F-024)
  const importFileRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importModelMismatch, setImportModelMismatch] = useState<string | null>(null)

  // Thinking toggle — per-conversation, persisted in localStorage. When OFF the
  // model is told to skip reasoning entirely (answers directly), not merely to
  // hide the reasoning. Reads per-conv key first; falls back to global default;
  // defaults to ON (reasoning models think).
  const readThinkingEnabled = (convId: string | null): boolean => {
    if (convId) {
      const perConv = localStorage.getItem(`tllm.thinkingEnabled.${convId}`)
      if (perConv !== null) return perConv !== 'false'
    }
    const global = localStorage.getItem('tllm.thinkingEnabled.default')
    return global !== 'false'
  }
  const [thinkingEnabled, setThinkingEnabledState] = useState<boolean>(() => readThinkingEnabled(null))
  const setThinkingEnabled = (val: boolean) => {
    if (activeId) localStorage.setItem(`tllm.thinkingEnabled.${activeId}`, String(val))
    setThinkingEnabledState(val)
  }

  // Persona — per-conversation, defaults to the global default from Settings.
  const [selectedPersonaId, setSelectedPersonaId] = useState<PersonaId>(() => getDefaultPersonaId())
  const abortRef = useRef<AbortController | null>(null)
  const deltaTimestamps = useRef<number[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const userScrolledUp = useRef(false)
  const qc = useQueryClient()
  const mut = useConversationMutations()
  const modelsQ = useModels()
  const modelActions = useModelActions()

  const convQ = useConversation(activeId)
  const conv = convQ.data
  const messages = conv?.messages ?? []

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
  const modelBusy =
    modelActions.load.isPending ||
    modelActions.eject.isPending ||
    engineState === 'starting' ||
    engineState === 'stopping'

  const handleLoadModel = (key: string) => {
    modelActions.load.mutate(
      { key },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.') },
    )
  }
  const handleEject = () => {
    if (live) { abortRef.current?.abort(); setLive(null) }
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

  useEffect(() => {
    if (live) scrollToBottom()
  }, [live, scrollToBottom])

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
      if (e.key === 'Escape' && live) { void handleStop() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  // Sync thinking toggle when conversation changes.
  useEffect(() => {
    setThinkingEnabledState(readThinkingEnabled(activeId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Close share menu on outside click
  useEffect(() => {
    if (!shareMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (shareMenuRef.current && !shareMenuRef.current.contains(e.target as Node)) {
        setShareMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [shareMenuOpen])

  // ── Share handlers (F-023) ────────────────────────────────────────────────

  const copyText = async (text: string, successMsg: string, title: string) => {
    setShareMenuOpen(false)
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
    setShareMenuOpen(false)
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
    setActiveId(null)
    setInput('')
    setLive(null)
    setSelectedPersonaId(getDefaultPersonaId())
    inputRef.current?.focus()
  }

  const handleSelect = (id: string) => {
    if (live) { abortRef.current?.abort(); setLive(null) }
    setActiveId(id)
    setEditingId(null)
    setSelectedPersonaId(getConvPersonaId(id))
    userScrolledUp.current = false
    setTimeout(() => scrollToBottom(true), 50)
  }

  // The currently-open conversation was deleted — abort any live generation and
  // close it (clear activeId) so we don't hold a dangling reference.
  const handleActiveDeleted = (id: string) => {
    if (id !== activeId) return
    if (live) { abortRef.current?.abort(); setLive(null) }
    setActiveId(null)
    setEditingId(null)
    setInput('')
    setSelectedPersonaId(getDefaultPersonaId())
  }

  const handleStop = async () => {
    abortRef.current?.abort()
    if (activeId) await mut.stop.mutateAsync(activeId).catch(() => {})
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

  // Record one generated token and return the rolling 2-second tok/s estimate.
  const pushGenToken = () => {
    const now = Date.now()
    deltaTimestamps.current.push(now)
    deltaTimestamps.current = deltaTimestamps.current.filter((t) => t > now - 2000)
    return Math.round((deltaTimestamps.current.length / 2) * 10) / 10
  }

  // Shared SSE consumer: drives live streaming state for either a fresh send or a continue.
  const streamFrom = async (convId: string, gen: AsyncGenerator<ChatSseEvent>) => {
    try {
      for await (const evt of gen) {
        if (evt.event === 'meta') {
          deltaTimestamps.current = []
          setLive({ assistantId: evt.data.assistantMessageId, content: '', reasoning: '', progress: null, liveGenTps: 0, genTokens: 0, toolCalls: [] })
          // Optimistically reflect the new/last user msg in the UI by invalidating
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
        } else if (evt.event === 'progress') {
          setLive((l) => l ? { ...l, progress: { phase: evt.data.phase, pct: evt.data.pct, tps: evt.data.tps } } : l)
        } else if (evt.event === 'reasoning') {
          // Thinking tokens count toward generation too — track rate + count.
          const liveTps = pushGenToken()
          setLive((l) => l ? { ...l, reasoning: l.reasoning + evt.data.delta, progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 } : l)
        } else if (evt.event === 'delta') {
          const liveTps = pushGenToken()
          setLive((l) => l ? { ...l, content: l.content + evt.data.delta, progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 } : l)
        } else if (evt.event === 'tool_call') {
          const tc = evt.data
          setLive((l) => {
            if (!l) return l
            const existing = l.toolCalls.findIndex((x) => x.id === tc.id)
            if (existing >= 0) {
              const updated = [...l.toolCalls]
              updated[existing] = { ...updated[existing], status: tc.status, result: tc.result }
              return { ...l, toolCalls: updated }
            }
            return { ...l, toolCalls: [...l.toolCalls, { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result }] }
          })
        } else if (evt.event === 'done') {
          setLive(null)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          void qc.invalidateQueries({ queryKey: ['conversations'] })
          setTimeout(() => scrollToBottom(true), 80)
        } else if (evt.event === 'error') {
          setLive(null)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          toast.error(evt.data.message)
        }
      }
      // Stream ended without an explicit done/error (e.g. network cut, silent close)
      setLive(null)
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } catch (e) {
      setLive(null)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    }
  }

  const send = async (overrideInput?: string) => {
    const text = (overrideInput ?? input).trim()
    if ((!text && attachments.length === 0) || live) return
    if (engineState !== 'running' || !model) { toast.error('Load a model first.'); return }

    const imageAttachments = attachments.filter((a) => a.dataUrl.startsWith('data:image/'))
    const textAttachments = attachments.filter((a) => !a.dataUrl.startsWith('data:image/'))
    const images = imageAttachments.map((a) => a.dataUrl)
    const docContext = textAttachments.map((a) => `[Attached: ${a.file.name}]\n${a.dataUrl}`).join('\n\n')

    setInput('')
    setAttachments([])
    setTimeout(autoResize, 0)
    userScrolledUp.current = false

    try {
      // Create conversation on first message, baking in the selected persona + personalization.
      let convId = activeId
      if (!convId) {
        let sp = buildSystemPrompt(selectedPersonaId, getPersonalization())
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
        const newConv = await mut.create.mutateAsync({
          modelKey: model.key,
          systemPrompt: sp || undefined,
          toolPolicy: selectedPersonaId === 'research' ? 'force_web_search' : undefined,
        })
        convId = newConv.id
        setConvPersonaId(convId, selectedPersonaId)
        setActiveId(convId)
      }

      const ac = new AbortController()
      abortRef.current = ac

      const textAttachmentNames = textAttachments.map((a) => a.file.name)
      await streamFrom(convId, sendMessage(convId, text, ac.signal, images, docContext, textAttachmentNames, !thinkingEnabled))
    } catch (e) {
      setLive(null)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      if (activeId) void qc.invalidateQueries({ queryKey: ['conversation', activeId] })
    }
  }

  const handleEditSave = (msgId: string, content: string) => {
    if (!activeId) return
    setEditingId(null)
    mut.editMsg.mutate({ convId: activeId, msgId, content }, {
      onSuccess: () => {
        userScrolledUp.current = false
        if (engineState === 'running' && model) {
          const ac = new AbortController()
          abortRef.current = ac
          void streamFrom(activeId, continueConversation(activeId, ac.signal, !thinkingEnabled))
        }
      },
      onError: () => toast.error('Could not edit message.'),
    })
  }

  const handleRegenerate = async () => {
    if (!activeId || live) return
    if (engineState !== 'running' || !model) { toast.error('Load a model first.'); return }
    await mut.regenerate.mutateAsync(activeId).catch(() => {})
    const ac = new AbortController()
    abortRef.current = ac
    void streamFrom(activeId, continueConversation(activeId, ac.signal, !thinkingEnabled))
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
  const ctxMax   = model?.ctx || lastStats?.ctxMax || 0

  const ready = engineState === 'running' && !!model

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar (collapsible) */}
      <div className={sidebarOpen ? 'w-56 shrink-0' : 'w-10 shrink-0'} style={{ transition: 'width 0.15s' }}>
        <ConversationSidebar
          activeId={activeId}
          onSelect={handleSelect}
          onNew={handleNew}
          onImport={readonly ? undefined : () => importFileRef.current?.click()}
          collapsed={!sidebarOpen}
          onToggle={() => setSidebarOpen((o) => !o)}
          generating={!!live}
          onDeleted={handleActiveDeleted}
        />
      </div>

      {/* Thread */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Read-only banner (F-023: shown when ?readonly=1) */}
        {readonly && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-panel-2 px-4 py-1.5 text-[12px] text-muted">
            <span className="font-medium text-ink">Shared view</span>
            <span className="text-faint">—</span>
            <span>read only</span>
          </div>
        )}

        {/* Chat header: model load/switch/eject (always available) */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <ModelLoadMenu
            models={allModels}
            loadedKey={model?.key ?? null}
            loadedName={model?.name ?? null}
            pending={modelBusy}
            ejecting={modelActions.eject.isPending}
            onLoad={handleLoadModel}
            onEject={handleEject}
            onSettings={(key) => setSettingsKey(key)}
          />
          {model && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => setSettingsKey(model.key)}
              title="Model settings — change on the fly"
            >
              <SlidersHorizontal size={15} />
            </Button>
          )}
          <ConversationSettingsDialog conv={conv} />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => setThinkingEnabled(!thinkingEnabled)}
            title={thinkingEnabled
              ? 'Thinking on — model reasons before answering. Click to disable.'
              : 'Thinking off — model answers directly. Click to enable reasoning.'}
            style={{ color: thinkingEnabled ? 'var(--accent)' : 'var(--faint)' }}
          >
            <Brain size={15} />
          </Button>
          {activeId && (() => {
            const p = PERSONAS.find((px) => px.id === selectedPersonaId)
            return p ? (
              <span
                title={p.description}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted select-none"
              >
                <UserRound size={11} />
                {p.name}
              </span>
            ) : null
          })()}
          {engineState === 'starting' && <span className="text-[12px] text-muted">Loading model…</span>}
          {engineState === 'stopping' && <span className="text-[12px] text-muted">Ejecting…</span>}
          {ready && (
            <ContextMeter ctxUsed={ctxUsed} ctxMax={ctxMax} />
          )}

          {/* Share / Export menu (F-023, F-024) — only when a conversation is active */}
          {activeId && (
            <div ref={shareMenuRef} className="relative ml-auto">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setShareMenuOpen((o) => !o)}
                title="Share or export this chat"
              >
                <Share2 size={15} />
              </Button>
              {shareMenuOpen && (
                <div className="absolute right-0 top-9 z-50 min-w-[180px] rounded-md border border-border bg-panel shadow-[var(--shadow-2)] py-1">
                  <button
                    type="button"
                    onClick={() => void handleCopyLink()}
                    className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-ink hover:bg-panel-2"
                  >
                    <Copy size={13} className="text-muted" />
                    Copy link (LAN)
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyDebugInfo()}
                    className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-ink hover:bg-panel-2"
                  >
                    <Copy size={13} className="text-muted" />
                    Copy debug info
                  </button>
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    onClick={handleExportChat}
                    className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-ink hover:bg-panel-2"
                  >
                    <Download size={13} className="text-muted" />
                    Export chat
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Message list — always visible; empty state shown only when no messages */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex w-full flex-col gap-6 px-8 py-6">
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
              <div className="mb-2 flex items-start gap-2 rounded-md border border-[color:var(--warn,#ca8a04)] bg-[color-mix(in_srgb,var(--warn,#ca8a04)_8%,transparent)] px-3 py-2 text-[13px]">
                <span className="flex-1">
                  <span className="font-medium">Model not found:</span>{' '}
                  <span className="font-mono">{importModelMismatch}</span> is not available on this machine.
                  The chat was imported — select a different model to continue.
                </span>
                <button type="button" onClick={() => setImportModelMismatch(null)} className="shrink-0 text-faint hover:text-ink"><X size={13} /></button>
              </div>
            )}

            {/* Import error (F-024): inline, not toast */}
            {importError && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-[color:var(--err)] bg-[color-mix(in_srgb,var(--err)_8%,transparent)] px-3 py-2 text-[13px]">
                <span className="flex-1 text-[color:var(--err)]">{importError}</span>
                <button type="button" onClick={() => setImportError(null)} className="shrink-0 text-faint hover:text-ink"><X size={13} /></button>
              </div>
            )}

            {/* Empty state */}
            {messages.length === 0 && !live && (
              <div className="flex flex-col items-center gap-4 py-16">
                {model ? (
                  <>
                    <p className="text-[15px] font-medium text-ink">{model.name}</p>
                    <PersonaPicker selected={selectedPersonaId} onChange={setSelectedPersonaId} />
                    <div className="flex flex-wrap justify-center gap-2">
                      {['Explain something to me', 'Help me write', 'Review this code'].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 0) }}
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

            {/* Messages */}
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                isLast={i === messages.length - 1 && !live}
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
              <StreamingBubble content={live.content} reasoning={live.reasoning} progress={live.progress} liveGenTps={live.liveGenTps} genTokens={live.genTokens} toolCalls={live.toolCalls} />
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Scroll-to-bottom pill */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={() => { userScrolledUp.current = false; scrollToBottom(true) }}
            className="absolute bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1.5 text-[12px] text-muted shadow-[var(--shadow-1)] hover:text-ink"
          >
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}

        {/* Clipboard fallback modal (F-023): shown when navigator.clipboard is unavailable */}
        {clipboardFallback && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setClipboardFallback(null)}>
            <div className="mx-4 w-full max-w-lg rounded-lg border border-border bg-panel p-4 shadow-[var(--shadow-2)]" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">{clipboardFallback.title}</span>
                <button type="button" onClick={() => setClipboardFallback(null)} className="text-faint hover:text-ink"><X size={14} /></button>
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

        {/* Composer area (always visible; disabled when no model; hidden in readonly) */}
        {readonly ? null : <div className="px-8 pb-5">
          <div className="w-full">
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
                      <button type="button" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} className="text-faint hover:text-err">
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2 p-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
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
                  className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-ink outline-none placeholder:overflow-hidden placeholder:whitespace-nowrap placeholder:text-faint"
                  placeholder={ready ? `Message ${model.name}…` : 'Load a model above to start chatting'}
                  value={input}
                  disabled={!ready || !!live || !!editingId}
                  onChange={(e) => { setInput(e.target.value); autoResize() }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                    if (e.key === 'ArrowUp' && !input && !live) {
                      const lastUser = messages.findLast((m) => m.role === 'user')
                      if (lastUser) { setEditingId(lastUser.id) }
                    }
                  }}
                />
                {live ? (
                  <Button size="icon" variant="outline" onClick={() => void handleStop()} title="Stop generation (Esc)">
                    <Square size={15} />
                  </Button>
                ) : (
                  <Button size="icon" onClick={() => void send()} disabled={!ready || (!input.trim() && attachments.length === 0) || !!editingId} aria-label="Send">
                    <SendHorizontal size={15} />
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-faint">
              {model ? `${model.name} · Enter to send · Shift+Enter for newline` : 'Load a model above to start chatting'}
            </p>
          </div>
        </div>}
      </div>

      <ModelDetailDialog modelKey={settingsKey} onClose={() => setSettingsKey(null)} />
    </div>
  )
}

// ── Persona picker ─────────────────────────────────────────────────────────────

function PersonaPicker({ selected, onChange }: { selected: PersonaId; onChange: (id: PersonaId) => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="text-[11px] uppercase tracking-wide text-faint">Persona</p>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value as PersonaId)}
        className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
      >
        {PERSONAS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {p.description}
          </option>
        ))}
      </select>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Moon, Sun, Monitor, Save, ExternalLink, ShieldAlert, RefreshCw, Check, X, Loader2, AlertTriangle, ArrowUpCircle, SlidersHorizontal, Boxes, ShieldCheck, Wifi, Cpu, ChevronRight, FlaskConical } from 'lucide-react'
import { getPersonalization, savePersonalization, type Personalization } from '../lib/personas'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { cn } from '../lib/utils'
import { useUiStore, type Theme } from '../stores/ui'
import {
  useComfyGate,
  useDaemonRestart,
  useHfTokenTest,
  useModelDirs,
  useModelMutations,
  useNetworkInfo,
  useSettings,
  useStatus,
  useSysInfo,
  useTelemetryPreview,
  useTelemetryLog,
  useRegenerateMachineId,
  useAppUpdate,
} from '../lib/queries'
import { CopyButton } from '../components/ui/copy-button'
import { ModelDirs } from './models/ModelDirs'
import { ToolPermissionsSection } from './settings/ToolPermissionsSection'
import { CodeContextSection } from './settings/CodeContextSection'
import { CodeAgentSection } from './settings/CodeAgentSection'
import { MemorySection } from './settings/MemorySection'
import { ExperimentalSection } from './settings/ExperimentalSection'
import { TurboLinkSection } from './settings/TurboLinkSection'

import { ApiError, track, type TelemetryLevel } from '../lib/api'
import { TELEMETRY_UI_ENABLED } from '../lib/flags'
import { useDocumentScroll } from '../lib/scroll-mode'
import { toast } from '../components/ui/sonner'

/** localStorage key for the client-only default thinking budget: -1 = unlimited
 *  (default), 0 = off, N>0 = a real sampler-enforced token cap — same key ChatScreen's
 *  and CodeComposer's own ThinkingBudgetSlider fall back to when a conversation/session
 *  has no per-entity value of its own yet. Supersedes the old boolean-only ADR-042 key. */
const THINKING_DEFAULT_KEY = 'tllm.thinkingBudget.default'
const THINKING_MAX_BUDGET = 16_000

/** localStorage key for the client-only "confirm before deleting a conversation"
 *  preference. When ON, deleting a conversation shows a confirmation dialog first;
 *  when OFF, deletes immediately. Default ON when unset. */
const CONFIRM_DELETE_KEY = 'tllm.confirmDeleteConversation'

/** A controlled numeric input that doesn't fight the user mid-edit. A raw
 *  `value={number}` with `Number(e.target.value) || min` snaps an emptied field
 *  straight back to a number, so you can't clear it to retype and every partial
 *  value gets clamped on each keystroke. This keeps a local text draft: the field
 *  may be empty or intermediate while focused, commits finite values up unclamped,
 *  and only clamps to [min,max] on blur / Enter. */
function NumberField({
  value,
  min,
  max,
  step,
  onCommit,
  className,
  ariaLabel,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onCommit: (n: number) => void
  className?: string
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(String(value))
  // Re-sync when the upstream value changes (settings load, programmatic update).
  useEffect(() => { setDraft(String(value)) }, [value])

  const clamp = (n: number) => {
    let v = n
    if (min != null) v = Math.max(min, v)
    if (max != null) v = Math.min(max, v)
    return v
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw) // allow empty / partial input without snapping back
        if (raw.trim() === '') return
        const n = Number(raw)
        if (Number.isFinite(n)) onCommit(n) // commit unclamped so typing isn't fought
      }}
      onBlur={() => {
        const n = Number(draft)
        const next = draft.trim() === '' || !Number.isFinite(n) ? value : clamp(n)
        setDraft(String(next))
        onCommit(next)
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className={className}
    />
  )
}

const clampN = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(n)))

/** Settings categories for the two-pane layout. Each maps to one pane of sections. */
type CatId = 'general' | 'models' | 'tools' | 'network' | 'experimental' | 'system'

const SETTINGS_CATS: { id: CatId; label: string; icon: React.ElementType }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'models', label: 'Models & loading', icon: Boxes },
  { id: 'tools', label: 'Tools & safety', icon: ShieldCheck },
  { id: 'network', label: 'Network & sharing', icon: Wifi },
  { id: 'experimental', label: 'Experimental', icon: FlaskConical },
  { id: 'system', label: 'System', icon: Cpu },
]

/** A labeled range slider with a live formatted value (mirrors the per-model Slider in
 *  ModelDetailDialog.tsx). */
function Slider({ label, hint, value, min, max, step, onChange, fmt }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string
}) {
  return (
    <div className="py-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[14px] font-medium text-ink">{label}</span>
        <span className="font-mono text-[12px] text-muted">{fmt ? fmt(value) : value}</span>
      </div>
      {hint && <div className="mb-1.5 text-[12px] text-muted">{hint}</div>}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </div>
  )
}

export function SettingsScreen() {
  // Issue #178: a long, plain list screen — the window scrolls it, not an inner box.
  useDocumentScroll()
  const { theme, setTheme, fontSize, setFontSize } = useUiStore()
  const { query: settingsQ, save } = useSettings()
  const settings = settingsQ.data
  const modelDirsQ = useModelDirs()
  const modelDirsMut = useModelMutations()
  const modelDirs = modelDirsQ.data?.dirs ?? []
  const primaryModelDir = modelDirsQ.data?.primaryDir ?? ''

  const [ttl, setTtl] = useState<number>(60)
  const [vramHeadroom, setVramHeadroom] = useState<number>(1024)
  const [port, setPort] = useState<number>(6996)
  const [autoTitle, setAutoTitle] = useState(true)
  const [openBrowser, setOpenBrowser] = useState(true)
  const [autoLoad, setAutoLoad] = useState(false)
  const [defCtx, setDefCtx] = useState<number>(8192)
  const [defNgl, setDefNgl] = useState<number>(99)
  const [defImageMax, setDefImageMax] = useState<number>(0)
  const [defMaxTokens, setDefMaxTokens] = useState<number>(0)
  const [telemetry, setTelemetry] = useState<TelemetryLevel>('off')
  const [lanBind, setLanBind] = useState(false)
  const [requireApiKey, setRequireApiKey] = useState(true)
  const [comfyEnabled, setComfyEnabled] = useState(false)
  const [comfyUrl, setComfyUrl] = useState('')
  const [comfyReverseGate, setComfyReverseGate] = useState(false)
  const [gatewayAutoSwap, setGatewayAutoSwap] = useState(true)
  const [gatewayKeepN, setGatewayKeepN] = useState(1)
  // Client-only default thinking budget; default -1 (unlimited).
  const [thinkingBudget, setThinkingBudget] = useState<number>(() => {
    const v = localStorage.getItem(THINKING_DEFAULT_KEY)
    return v !== null ? Number(v) : -1
  })
  // Client-only "confirm before deleting a conversation" preference; default ON.
  const [confirmDelete, setConfirmDelete] = useState(() => localStorage.getItem(CONFIRM_DELETE_KEY) !== 'false')

  // Full-screen overlay while the daemon re-execs (spec 08 §2).
  const [restartOverlay, setRestartOverlay] = useState(false)

  // Active category for the two-pane settings layout.
  const [activeCat, setActiveCat] = useState<CatId>('general')

  useEffect(() => {
    if (settings) {
      setTtl(settings.idleTtlMinutes)
      setVramHeadroom(settings.vramHeadroomMb ?? 1024)
      setPort(settings.port ?? 6996)
      setAutoTitle(settings.autoGenerateTitles)
      setOpenBrowser(settings.openBrowserOnStart)
      setAutoLoad(settings.autoLoadOnStart ?? false)
      setDefCtx(settings.modelDefaults?.ctx ?? 8192)
      setDefNgl(settings.modelDefaults?.ngl ?? 99)
      setDefImageMax(settings.modelDefaults?.imageMaxTokens ?? 0)
      setDefMaxTokens(settings.modelDefaults?.maxTokens ?? 0)
      setTelemetry(settings.telemetryLevel ?? 'off')
      setLanBind(settings.lanBind ?? false)
      setRequireApiKey(settings.requireApiKey ?? true)
      setComfyEnabled(settings.comfyui?.enabled ?? false)
      setComfyUrl(settings.comfyui?.url ?? '')
      setComfyReverseGate(settings.comfyui?.reverseGate ?? false)
      setGatewayAutoSwap(settings.gateway?.autoSwap ?? true)
      setGatewayKeepN(settings.gateway?.keepN ?? 1)
    }
  }, [settings])

  // Persist the thinking budget immediately (no Save round-trip; it's client-only).
  useEffect(() => {
    localStorage.setItem(THINKING_DEFAULT_KEY, String(thinkingBudget))
  }, [thinkingBudget])

  // Persist the confirm-before-delete preference immediately (client-only).
  useEffect(() => {
    localStorage.setItem(CONFIRM_DELETE_KEY, confirmDelete ? 'true' : 'false')
  }, [confirmDelete])

  const settingsPayload = () => ({
    // Clamp defensively: NumberField commits unclamped while editing and only
    // snaps to range on blur, so guard the final ranges here too (spec 08 §2).
    idleTtlMinutes: clampN(ttl, 0, 1440),
    // 0 is the distinct "allow VRAM spill" opt-in (VRAM_HEADROOM_SPILL_MB), not a smaller safety
    // margin — clampN(v, 300, 2048) would otherwise clamp it up to 300 and silently discard it.
    vramHeadroomMb: vramHeadroom === 0 ? 0 : clampN(vramHeadroom, 300, 2048),
    port: clampN(port, 1024, 65535),
    autoGenerateTitles: autoTitle,
    openBrowserOnStart: openBrowser,
    autoLoadOnStart: autoLoad,
    telemetryLevel: telemetry,
    lanBind,
    requireApiKey,
    modelDefaults: {
      ctx: Math.max(256, Math.round(defCtx)),
      ngl: clampN(defNgl, 0, 99),
      imageMaxTokens: Math.max(0, Math.round(defImageMax)),
      maxTokens: Math.max(0, Math.round(defMaxTokens)),
    },
    comfyui: { enabled: comfyEnabled, url: comfyUrl.trim(), reverseGate: comfyReverseGate },
    gateway: { autoSwap: gatewayAutoSwap, keepN: clampN(gatewayKeepN, 1, 4) },
  })

  const handleSave = () => {
    save.mutate(settingsPayload(), {
      onSuccess: (res) => {
        const rb = res.rebind
        if (rb?.portChanged) {
          // The listener moved to a new port — hop the browser over once it's up.
          toast.success(`Port changed to ${rb.port} — reconnecting…`)
          setTimeout(() => {
            const u = new URL(window.location.href)
            u.port = String(rb.port)
            window.location.href = u.toString()
          }, 1300)
        } else if (rb) {
          // LAN-only change: applied in place, no restart, model stays loaded.
          toast.success(rb.lanBind ? 'LAN access enabled — applied (no restart needed)' : 'LAN access disabled — applied')
        } else {
          toast.success('Settings saved')
        }
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save settings.'),
    })
  }

  // Restart must persist pending changes FIRST — otherwise a port/LAN toggle the user
  // just flipped is lost and the re-exec'd daemon comes back on the old config.
  const requestRestart = () => {
    save.mutate(settingsPayload(), {
      onSuccess: () => setRestartOverlay(true),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save settings before restart.'),
    })
  }

  // The daemon-settings draft is dirty when any tracked field diverges from the
  // loaded settings. Drives the single sticky Save bar (Personalization and the HF
  // token keep their own save actions and are intentionally excluded here).
  const dirty =
    !!settings &&
    (ttl !== settings.idleTtlMinutes ||
      vramHeadroom !== (settings.vramHeadroomMb ?? 1024) ||
      port !== (settings.port ?? 6996) ||
      autoTitle !== settings.autoGenerateTitles ||
      openBrowser !== settings.openBrowserOnStart ||
      autoLoad !== (settings.autoLoadOnStart ?? false) ||
      defCtx !== (settings.modelDefaults?.ctx ?? 8192) ||
      defNgl !== (settings.modelDefaults?.ngl ?? 99) ||
      defImageMax !== (settings.modelDefaults?.imageMaxTokens ?? 0) ||
      defMaxTokens !== (settings.modelDefaults?.maxTokens ?? 0) ||
      telemetry !== (settings.telemetryLevel ?? 'off') ||
      lanBind !== (settings.lanBind ?? false) ||
      requireApiKey !== (settings.requireApiKey ?? true) ||
      comfyEnabled !== (settings.comfyui?.enabled ?? false) ||
      comfyUrl.trim() !== (settings.comfyui?.url ?? '') ||
      comfyReverseGate !== (settings.comfyui?.reverseGate ?? false) ||
      gatewayAutoSwap !== (settings.gateway?.autoSwap ?? true) ||
      gatewayKeepN !== (settings.gateway?.keepN ?? 1))

  return (
    <div className="w-full px-4 py-6 md:px-6">
      <ScreenHeader title="Settings" description="Configure TurboLLM behavior and appearance." />

      {restartOverlay && <RestartOverlay onDismiss={() => setRestartOverlay(false)} />}

      {/* Two-pane on desktop; below md the rail stacks above the content as a
          horizontal, scrollable tab strip (same pattern as Customize). */}
      <div className="relative flex flex-col gap-4 md:flex-row md:gap-6">
        {/* Category nav: vertical rail at md+, horizontal scroller on mobile. */}
        <nav className="shrink-0 md:w-44">
          <div className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
            {SETTINGS_CATS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => { track('settings', 'switch_settings_tab'); setActiveCat(id) }}
                className={cn(
                  'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors md:w-full',
                  activeCat === id ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink',
                )}
              >
                <Icon size={15} className="shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </nav>

        {/* Content pane: only the active category's sections */}
        <div className="min-w-0 flex-1 flex flex-col gap-6">
          {activeCat === 'general' && (
            <>
              {/* Theme */}
              <section className="rounded-lg border border-border bg-panel p-4">
                <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Appearance</h2>
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Theme</div>
                    <div className="text-[12px] text-muted">Choose light, dark, or follow your system setting</div>
                  </div>
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    {([
                      { value: 'light', label: 'Light', Icon: Sun },
                      { value: 'system', label: 'System', Icon: Monitor },
                      { value: 'dark', label: 'Dark', Icon: Moon },
                    ] as { value: Theme; label: string; Icon: React.ElementType }[]).map(({ value, label, Icon }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => { track('settings', 'set_theme'); setTheme(value) }}
                        className="flex items-center gap-1.5 px-3 py-2 text-[13px] transition-colors"
                        style={{
                          background: theme === value ? 'var(--accent)' : 'transparent',
                          color: theme === value ? 'var(--on-accent)' : 'var(--muted)',
                        }}
                      >
                        <Icon size={14} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Font size: same Slider component as VRAM headroom (Models & loading →
                    Advanced), scales the whole app's type via --font-scale (index.css). */}
                <div className="border-t border-border pt-3">
                  <Slider
                    label="Font size"
                    hint="Scale text across the whole app"
                    value={fontSize}
                    min={85}
                    max={130}
                    step={5}
                    onChange={setFontSize}
                    fmt={(v) => `${v}%`}
                  />
                </div>

                {/* Default thinking budget: client-only, default unlimited. Real sampler-enforced
                    token cap (thinking_budget_tokens), not just on/off — see ThinkingBudgetSlider. */}
                <div className="mt-2 border-t border-border pt-3">
                  <Slider
                    label="Thinking budget by default"
                    hint="How much a reasoning model may think before answering in new chats/sessions (you can adjust it per chat or session). 0 = answer directly, faster."
                    value={thinkingBudget < 0 ? THINKING_MAX_BUDGET : Math.min(thinkingBudget, THINKING_MAX_BUDGET)}
                    min={0}
                    max={THINKING_MAX_BUDGET}
                    step={500}
                    onChange={(v) => setThinkingBudget(v >= THINKING_MAX_BUDGET ? -1 : v)}
                    fmt={(v) => (v >= THINKING_MAX_BUDGET ? 'Unlimited' : v === 0 ? 'Off' : `${v.toLocaleString()} tokens`)}
                  />
                </div>

                {/* Confirm before deleting a conversation: client-only, default ON. */}
                <label className="flex cursor-pointer items-center justify-between border-t border-border py-2 pt-3">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Confirm before deleting a conversation</div>
                    <div className="text-[12px] text-muted">Ask for confirmation before a conversation is deleted. Off = delete immediately with no prompt.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.checked)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </label>
              </section>

              {/* Personalization */}
              <PersonalizationSection />

              {/* Auto-memory (Release 3) — its ORIGINAL location, unchanged. Only unlocked when
                  Settings → Experimental's Memory row is on (2026-07-14): visibility here AND
                  whether extraction actually runs (chat-routes.ts) both gate on that same flag,
                  not just this section's own "remember facts" toggle underneath it. */}
              {settings?.experimental?.memory && <MemorySection />}

              {/* Chat */}
              <section className="rounded-lg border border-border bg-panel p-4">
                <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Chat</h2>

                <label className="flex cursor-pointer items-center justify-between py-2">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Auto-generate chat titles</div>
                    <div className="text-[12px] text-muted">Uses the model to create a title after the first exchange</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoTitle}
                    onChange={(e) => setAutoTitle(e.target.checked)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </label>
              </section>

              {/* Startup */}
              <section className="rounded-lg border border-border bg-panel p-4">
                <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Startup</h2>

                <label className="flex cursor-pointer items-center justify-between py-2">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Open browser on start</div>
                    <div className="text-[12px] text-muted">Automatically open the UI when the daemon starts</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={openBrowser}
                    onChange={(e) => setOpenBrowser(e.target.checked)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between py-2">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Auto-load last model</div>
                    <div className="text-[12px] text-muted">Reload the last-used model automatically when the daemon starts</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoLoad}
                    onChange={(e) => setAutoLoad(e.target.checked)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </label>
              </section>
            </>
          )}

          {activeCat === 'models' && (
            <>
              {/* Engine — idle timeout (primary) */}
              <section className="rounded-lg border border-border bg-panel p-4">
                <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Engine</h2>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Idle timeout</div>
                    <div className="text-[12px] text-muted">Unload model after this many minutes of inactivity (0 = never)</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <NumberField
                      value={ttl}
                      min={0}
                      max={1440}
                      onCommit={setTtl}
                      ariaLabel="Idle timeout in minutes"
                      className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
                    />
                    <span className="text-[12px] text-muted">min</span>
                  </div>
                </div>
              </section>

              {/* Model Defaults — context length (primary) */}
              <section className="rounded-lg border border-border bg-panel p-4">
                <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Model Defaults</h2>
                <p className="mb-3 text-[12px] text-muted">
                  Applied the first time a model is loaded. A model's own saved settings always
                  override these.
                </p>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <div className="text-[14px] font-medium text-ink">Context length</div>
                    <div className="text-[12px] text-muted">Default context window, capped at each model's native max</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <NumberField
                      value={defCtx}
                      min={256}
                      step={512}
                      onCommit={setDefCtx}
                      ariaLabel="Default context length"
                      className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
                    />
                    <span className="text-[12px] text-muted">tok</span>
                  </div>
                </div>
              </section>

              {/* Gateway intelligence (v0.6.0) */}
              <GatewaySection
                autoSwap={gatewayAutoSwap}
                setAutoSwap={setGatewayAutoSwap}
                keepN={gatewayKeepN}
                setKeepN={setGatewayKeepN}
              />

              {/* Models — folders */}
              <ModelDirs dirs={modelDirs} primaryDir={primaryModelDir} mut={modelDirsMut} />

              {/* Models — Hugging Face token (spec 10 §4) */}
              <HfTokenSection tokenSet={settings?.hfTokenSet ?? false} onSaved={() => void settingsQ.refetch()} />

              {/* Advanced — expert knobs, collapsed by default (auto-first) */}
              <Collapsible className="rounded-lg border border-border bg-panel p-4">
                <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
                  <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-data-[state=open]:rotate-90" />
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Advanced</h2>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-3 border-t border-border pt-1">
                    <Slider
                      label="VRAM headroom"
                      hint={
                        vramHeadroom === 0
                          ? "VRAM spill allowed. For MoE models, auto-tune will keep moving experts onto the GPU past this point as long as it measures a real speed gain — even if that spills the model into slower shared memory. Drag right to restore a safety margin."
                          : "VRAM to keep free during auto-tune, so a later app switch or render job doesn't spill the model into slower shared memory. Drag all the way to the left to instead let auto-tune spill on purpose for more speed."
                      }
                      value={vramHeadroom}
                      min={0}
                      max={2048}
                      step={1}
                      // Snaps straight from 300 to 0 — 0 is a distinct "allow VRAM spill" opt-in
                      // (VRAM_HEADROOM_SPILL_MB), not a smaller safety margin, so 1–299 isn't a
                      // real intermediate value: only the literal minimum position drops to 0.
                      onChange={(v) => setVramHeadroom(v === 0 ? 0 : Math.max(300, v))}
                      fmt={(v) => (v === 0 ? '0 MB — spill allowed' : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`)}
                    />
                  </div>

                  <div className="flex items-center justify-between border-t border-border py-2">
                    <div>
                      <div className="text-[14px] font-medium text-ink">GPU layers</div>
                      <div className="text-[12px] text-muted">Layers to offload to the GPU (99 = all); ignored on CPU-only machines</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <NumberField
                        value={defNgl}
                        min={0}
                        max={99}
                        onCommit={setDefNgl}
                        ariaLabel="Default GPU layers"
                        className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-border py-2">
                    <div>
                      <div className="text-[14px] font-medium text-ink">Image max tokens</div>
                      <div className="text-[12px] text-muted">Per-image token budget for vision models (0 = engine default)</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <NumberField
                        value={defImageMax}
                        min={0}
                        step={256}
                        onCommit={setDefImageMax}
                        ariaLabel="Image max tokens"
                        className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
                      />
                      <span className="text-[12px] text-muted">tok</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-border py-2">
                    <div>
                      <div className="text-[14px] font-medium text-ink">Max response tokens</div>
                      <div className="text-[12px] text-muted">Hard cap on tokens generated per reply (0 = unlimited). Also caps Claude Code / API requests.</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <NumberField
                        value={defMaxTokens}
                        min={0}
                        step={256}
                        onCommit={setDefMaxTokens}
                        ariaLabel="Max response tokens"
                        className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
                      />
                      <span className="text-[12px] text-muted">tok</span>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          {activeCat === 'tools' && (
            <>
              {/* Tool permissions — moved here from Developer. */}
              <ToolPermissionsSection />

              {/* Code's AGENTS.md-style standing-context candidate lists. */}
              <CodeContextSection />

              {/* Which coding agent new Code sessions launch with. */}
              <CodeAgentSection />
            </>
          )}

          {activeCat === 'network' && (
            <>
              {/* Network (spec 08 §2) */}
              <NetworkSection lanBind={lanBind} setLanBind={setLanBind} requireApiKey={requireApiKey} setRequireApiKey={setRequireApiKey} port={port} setPort={setPort} />

              {/* ComfyUI GPU coordination */}
              <ComfyUiSection
                enabled={comfyEnabled}
                setEnabled={setComfyEnabled}
                gatePath={settings?.comfyui?.gatePath ?? ''}
                url={comfyUrl}
                setUrl={setComfyUrl}
                reverseGate={comfyReverseGate}
                setReverseGate={setComfyReverseGate}
              />

              {/* Turbo Link (ADR-376): mint scoped tokens for other machines + manage
                  machines this one has linked to. Only unlocked when Settings → Experimental's
                  Turbo Link row is on — the same two-layer shape MemorySection follows above,
                  and the same one the daemon enforces (link/gate.ts), so a machine with the
                  flag off has no way to reach the surface AND refuses it on the wire. */}
              {settings?.experimental?.turboLink && <TurboLinkSection />}
            </>
          )}

          {activeCat === 'experimental' && (
            <>
              {/* Memory, Code, Cloud Launch/RunPod — three master on/off rows. Memory's OWN
                  settings (the "remember facts" toggle + facts list) stay in General — this is
                  only the unlock switch, see PersonalizationSection's neighboring block above
                  where MemorySection actually renders. */}
              <ExperimentalSection />
            </>
          )}

          {activeCat === 'system' && (
            <>
              {/* Hardware */}
              <HardwarePanel />

              {/* Privacy & telemetry (spec 09 §5) — hidden for MVP launch (ADR-041);
                  no telemetry uploader ships yet. Re-enable via flags.ts when it does. */}
              {TELEMETRY_UI_ENABLED && <PrivacySection level={telemetry} setLevel={setTelemetry} />}

              {/* Advanced (spec 08 §2): daemon restart */}
              <AdvancedSection onRestart={requestRestart} />

              {/* About + app self-update check (F-006) */}
              <AboutSection />

              {/* Help */}
              <HelpSection />
            </>
          )}

          {/* Unified sticky Save bar — only for daemon-settings draft changes.
              Issue #178: this screen now scrolls the DOCUMENT, so the bar sticks against the
              viewport rather than against `main`'s old inner scrollport — and on mobile a plain
              `bottom-0` would park it underneath MobileNav. `--tllm-mobile-nav-h` is that bar's
              height below md while document-scrolling, and 0px everywhere else (index.css). */}
          {dirty && (
            <div className="sticky bottom-[var(--tllm-mobile-nav-h)] z-20 -mx-4 mt-2 flex items-center justify-between border-t border-border bg-panel px-4 py-3 md:-mx-6 md:px-6">
              <span className="text-[13px] text-muted">Unsaved changes</span>
              <Button onClick={() => { track('settings', 'save_settings'); handleSave() }} disabled={save.isPending || settingsQ.isLoading}>
                <Save size={14} />
                {save.isPending ? 'Saving…' : 'Save settings'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── TurboLLM Expert (spec 08 §2): launch an in-app expert chat ─────────────────

// ── ComfyUI GPU coordination (push) ───────────────────────────────────────────
// ComfyUI and the LLM engine both want the GPU's VRAM. A one-time-installed ComfyUI
// node tells TurboLLM the instant a render starts/ends — TurboLLM unloads the model +
// blocks loads while ComfyUI runs, then reloads it. Event-driven; no polling.

function ComfyUiSection({
  enabled,
  setEnabled,
  gatePath,
  url,
  setUrl,
  reverseGate,
  setReverseGate,
}: {
  enabled: boolean
  setEnabled: (v: boolean) => void
  gatePath: string
  url: string
  setUrl: (v: string) => void
  reverseGate: boolean
  setReverseGate: (v: boolean) => void
}) {
  const { data: status } = useStatus()
  const { install, uninstall } = useComfyGate()
  const [path, setPath] = useState('')
  const cu = status?.comfyui
  const installed = !!gatePath
  // The custom_nodes dir the node lives in (gatePath is …/custom_nodes/turbollm_gate).
  const customNodesDir = gatePath.replace(/[\\/]turbollm_gate[\\/]?$/, '')

  const doInstall = (p: string) => {
    if (!p.trim()) {
      toast.error('Enter the path to your ComfyUI folder first.')
      return
    }
    track('settings', 'install_comfyui_gate')
    install.mutate(p.trim(), {
      onSuccess: (r) => {
        toast.success(`Gate installed at ${r.path}. ${r.note ?? ''}`.trim())
        setPath('')
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not install the gate node.'),
    })
  }
  const doUninstall = () => {
    track('settings', 'uninstall_comfyui_gate')
    uninstall.mutate(undefined, {
      onSuccess: () => toast.success('ComfyUI gate removed.'),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove the gate node.'),
    })
  }

  // Live one-liner reflecting the daemon's actual gate state (only once enabled).
  const live = (() => {
    if (!cu?.enabled) return null
    if (!cu.installed) return { color: 'var(--muted)', text: 'Install the gate node in ComfyUI to activate this.' }
    if (cu.held) return { color: 'var(--warn)', text: 'ComfyUI is rendering — the model is unloaded and loads are paused.' }
    if (cu.lastSignalAgoMs == null) return { color: 'var(--muted)', text: 'Installed. Restart ComfyUI, then run a job to connect.' }
    return { color: 'var(--ok)', text: `ComfyUI idle — connected (last signal ${Math.round(cu.lastSignalAgoMs / 1000)}s ago).` }
  })()

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">ComfyUI</h2>
      <p className="mb-3 text-[12px] text-muted">
        Share the GPU with ComfyUI. The instant ComfyUI starts a render, TurboLLM unloads its
        model and pauses new loads so they don't fight over VRAM — then reloads the model when
        ComfyUI's queue is empty. This needs a small one-time setup node installed in ComfyUI.
      </p>

      <label className="flex cursor-pointer items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Pause for ComfyUI</div>
          <div className="text-[12px] text-muted">Unload the model and block loads while ComfyUI renders (Save to apply)</div>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
      </label>

      {enabled && (
        <div className="mt-2 flex flex-col gap-3 border-t border-border pt-3">
          <div className="text-[13px] font-medium text-ink">One-time setup</div>

          {installed ? (
            <>
              <div className="text-[12px] text-muted">
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <Check size={13} style={{ color: 'var(--ok)' }} /> Gate installed
                </span>
                <div className="mt-1 break-all font-mono text-[11px] text-faint">{gatePath}</div>
              </div>
              {cu?.installedVersion != null && cu.installedVersion < (cu.currentVersion ?? Infinity) && (
                <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)' }}>
                  <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--warn)' }}>
                    <AlertTriangle size={13} />
                    Update available — node v{cu.installedVersion} → v{cu.currentVersion}
                  </span>
                  <Button size="sm" onClick={() => doInstall(customNodesDir)} disabled={install.isPending}>
                    {install.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Update node'}
                  </Button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => doInstall(customNodesDir)} disabled={install.isPending}>
                  {install.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  Reinstall / update
                </Button>
                <Button variant="outline" size="sm" onClick={doUninstall} disabled={uninstall.isPending}>
                  {uninstall.isPending ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                  Remove
                </Button>
              </div>
              <div className="text-[12px] text-faint">Restart ComfyUI after installing or updating for the gate to take effect.</div>
            </>
          ) : (
            <>
              <div className="text-[12px] text-muted">
                Enter your ComfyUI folder (the one containing <span className="font-mono">custom_nodes</span>), or the
                <span className="font-mono"> custom_nodes</span> folder itself. TurboLLM writes the gate node there, wired to this daemon.
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="e.g. D:\\ComfyUI_windows_portable\\ComfyUI"
                  spellCheck={false}
                  autoComplete="off"
                  onKeyDown={(e) => { if (e.key === 'Enter') doInstall(path) }}
                  className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
                />
                <Button size="sm" onClick={() => doInstall(path)} disabled={install.isPending || !path.trim()}>
                  {install.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Install gate'}
                </Button>
              </div>
            </>
          )}

          {/* Reverse gate (F-011): the symmetric direction — when TurboLLM loads a model
              it first asks ComfyUI to drop its VRAM, so whichever app the user is driving
              wins the GPU. Needs ComfyUI's URL to reach its native /free endpoint. */}
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <label className="flex cursor-pointer items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-ink">Free ComfyUI when TurboLLM loads</div>
                <div className="text-[12px] text-muted">
                  Before loading a model, tell ComfyUI to unload its VRAM (Save to apply)
                </div>
              </div>
              <input
                type="checkbox"
                checked={reverseGate}
                onChange={(e) => setReverseGate(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
            </label>
            {reverseGate && (
              <div className="flex flex-col gap-1.5">
                <div className="text-[12px] text-muted">
                  ComfyUI's address — TurboLLM calls its <span className="font-mono">/free</span> endpoint here.
                </div>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8188"
                  spellCheck={false}
                  autoComplete="off"
                  className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
                />
              </div>
            )}
          </div>

          {live && (
            <div className="flex items-center gap-2 border-t border-border pt-3 text-[12px] text-muted">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: live.color }} />
              {live.text}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── Gateway intelligence (v0.6.0): auto model-swap + keep-N pool ─────────────

function GatewaySection({
  autoSwap,
  setAutoSwap,
  keepN,
  setKeepN,
}: {
  autoSwap: boolean
  setAutoSwap: (v: boolean) => void
  keepN: number
  setKeepN: (v: number) => void
}) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Gateway</h2>
      <p className="mb-3 text-[12px] text-muted">
        Controls how the OpenAI / Anthropic gateway handles the <code className="font-mono">model</code> field.
        Auto-swap loads the requested model on demand; keep-N holds multiple models hot simultaneously.
      </p>

      <label className="flex cursor-pointer items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Auto model-swap</div>
          <div className="text-[12px] text-muted">Auto-load the model named in each API request (Save to apply)</div>
        </div>
        <input
          type="checkbox"
          checked={autoSwap}
          onChange={(e) => setAutoSwap(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
      </label>

      <div className="flex items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Keep-N models loaded</div>
          <div className="text-[12px] text-muted">Max simultaneous hot models (1 = pure swap, 2–4 = pool with LRU eviction)</div>
        </div>
        <NumberField
          value={keepN}
          min={1}
          max={4}
          onCommit={setKeepN}
          ariaLabel="Keep-N models"
          className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
        />
      </div>
    </section>
  )
}

// ── Network (spec 08 §2): LAN expose toggle ───────────────────────────────────

function NetworkSection({
  lanBind,
  setLanBind,
  requireApiKey,
  setRequireApiKey,
  port,
  setPort,
}: {
  lanBind: boolean
  setLanBind: (v: boolean) => void
  requireApiKey: boolean
  setRequireApiKey: (v: boolean) => void
  port: number
  setPort: (v: number) => void
}) {
  // hasApiKey + the reachable LAN URL come from the daemon (server-derived IP/port).
  const { data: net } = useNetworkInfo()
  const lanUrl = net?.lanUrl ?? ''
  const hasApiKey = net?.hasApiKey ?? false

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Network</h2>

      <div className="flex items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Port</div>
          <div className="text-[12px] text-muted">Port the daemon listens on (1024–65535)</div>
        </div>
        <NumberField
          value={port}
          min={1024}
          max={65535}
          onCommit={setPort}
          ariaLabel="Daemon port"
          className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
        />
      </div>

      <label className="flex cursor-pointer items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Expose on local network (LAN)</div>
          <div className="text-[12px] text-muted">Allow other devices on your network to reach the API</div>
        </div>
        <input
          type="checkbox"
          checked={lanBind}
          onChange={(e) => setLanBind(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
      </label>

      {lanBind && (
        <div className="mt-2 flex flex-col gap-3 border-t border-border pt-3">
          {lanUrl && (
            <div className="text-[13px]">
              <span className="text-muted">LAN URL: </span>
              <span className="font-mono text-ink">{lanUrl}</span>
            </div>
          )}

          <label className="flex cursor-pointer items-center justify-between">
            <div>
              <div className="text-[14px] font-medium text-ink">Require an API key</div>
              <div className="text-[12px] text-muted">
                When off, any device on your network can use this TurboLLM with no key
              </div>
            </div>
            <input
              type="checkbox"
              checked={requireApiKey}
              onChange={(e) => setRequireApiKey(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          <div
            className="flex items-start gap-2 rounded-md border p-2.5 text-[12px]"
            style={{
              borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))',
              background: 'color-mix(in srgb, var(--warn) 8%, transparent)',
            }}
          >
            <ShieldAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
            <div className="text-muted">
              {requireApiKey ? (
                <>
                  Other devices can reach the API, but a valid API key is required.
                  {!hasApiKey && (
                    <>
                      {' '}
                      No API key exists yet — create one on the{' '}
                      <span className="font-medium text-ink">Developer</span> screen.
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="font-medium text-ink">Open access:</span> any device on your
                  network can use this TurboLLM with no key. Only enable this on a network you trust.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Port + LAN binding apply in place on Save — the listener re-binds without a
          full restart, so the model stays loaded (spec 08 §2). */}
      <div className="mt-2 border-t border-border pt-3 text-[12px] text-faint">
        Click <span className="font-medium text-ink">Save settings</span> to apply. The
        listener re-binds in place (no restart, model stays loaded); a port change
        reconnects this page automatically.
      </div>
    </section>
  )
}

// ── Models — Hugging Face token (spec 10 §4) ───────────────────────────────────

function HfTokenSection({ tokenSet, onSaved }: { tokenSet: boolean; onSaved: () => void }) {
  const { query: settingsQ, save } = useSettings()
  const test = useHfTokenTest()
  const [token, setToken] = useState('')
  // Tri-state test result: null = untested, then the daemon's {ok, name}.
  const [tested, setTested] = useState<{ ok: boolean; name?: string } | null>(null)

  // Reset the test result whenever the field changes (the prior result is stale).
  const onChange = (v: string) => {
    setToken(v)
    setTested(null)
  }

  const runTest = () => {
    if (!token.trim()) return
    test.mutate(token.trim(), {
      onSuccess: (r) => setTested(r),
      onError: () => setTested({ ok: false }),
    })
  }

  const handleSaveToken = () => {
    save.mutate(
      { hfToken: token.trim() },
      {
        onSuccess: () => {
          toast.success(token.trim() ? 'Hugging Face token saved' : 'Hugging Face token cleared')
          setToken('')
          setTested(null)
          onSaved()
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the token.'),
      },
    )
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Models</h2>
      <p className="mb-3 text-[12px] text-muted">
        A Hugging Face access token lets you download gated models (e.g. Llama). Accept the
        model's license on huggingface.co, then paste a read token here.{' '}
        <a
          href="https://huggingface.co/settings/tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink underline-offset-2 hover:underline"
        >
          Create a token
        </a>
        .
      </p>

      <div className="flex items-center justify-between py-1">
        <div className="text-[13px] text-muted">
          {tokenSet ? (
            <span className="inline-flex items-center gap-1.5 text-ink">
              <Check size={13} style={{ color: 'var(--ok)' }} />A token is configured
            </span>
          ) : (
            'No token configured'
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="password"
          value={token}
          onChange={(e) => onChange(e.target.value)}
          placeholder={tokenSet ? 'Enter a new token to replace the current one' : 'hf_…'}
          autoComplete="off"
          className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[13px] text-ink outline-none"
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { track('settings', 'test_hf_token'); runTest() }} disabled={!token.trim() || test.isPending}>
            {test.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Test'}
          </Button>
          <Button size="sm" onClick={() => { track('settings', 'save_hf_token'); handleSaveToken() }} disabled={save.isPending || settingsQ.isFetching}>
            {token.trim() ? 'Save token' : 'Clear token'}
          </Button>
        </div>
      </div>

      {tested && (
        <div className="mt-2 text-[12px]">
          {tested.ok ? (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ok)' }}>
              <Check size={13} />
              Valid{tested.name ? ` — signed in as ${tested.name}` : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--err)' }}>
              <X size={13} />
              Invalid or unauthorized token
            </span>
          )}
        </div>
      )}
    </section>
  )
}

// ── Privacy & telemetry (spec 09 §5): on by default, changeable any time ──────

function PrivacySection({ level, setLevel }: { level: TelemetryLevel; setLevel: (v: TelemetryLevel) => void }) {
  const [showPreview, setShowPreview] = useState(false)
  const { data: preview, isFetching } = useTelemetryPreview(showPreview ? level : null)

  const options: { value: TelemetryLevel; label: string; desc: string }[] = [
    // The Off copy is deliberately literal (ADR-299 Decision 5). Choosing Off
    // sends ONE contentless ping recording that choice — no machine id, no
    // hardware, no timestamp — and nothing else, ever. The previous wording
    // ("Send nothing") became false when that ping shipped, and in a
    // source-available client anyone can diff the claim against the code.
    { value: 'off', label: 'Off', desc: 'Sends only your choice, once. Nothing else, ever.' },
    { value: 'anon', label: 'Anonymous usage + benchmarks', desc: 'Which features you use, hardware specs, model name, settings, and speed — no prompts or files.' },
    { value: 'full', label: 'Usage + benchmarks + crash reports', desc: 'Adds error fingerprints, never your content.' },
  ]

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Privacy &amp; telemetry</h2>
      <p className="mb-3 text-[12px] text-muted">
        On by default (Usage + benchmarks + crash reports, below), so setup problems and
        real-hardware speed get found and fixed. Change your level any time — switching to Off
        records that one choice and nothing else, ever. Never sent: your conversations, prompts,
        files, paths, or keys.
      </p>

      <div className="flex flex-col gap-1">
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-2">
            <input
              type="radio"
              name="telemetry"
              value={o.value}
              checked={level === o.value}
              onChange={() => setLevel(o.value)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <div>
              <div className="text-[14px] font-medium text-ink">{o.label}</div>
              <div className="text-[12px] text-muted">{o.desc}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <Button variant="outline" size="sm" onClick={() => { track('settings', 'toggle_telemetry_preview'); setShowPreview((s) => !s) }}>
          {showPreview ? 'Hide preview' : 'Preview what we send'}
        </Button>
        {showPreview && (
          <div className="mt-2">
            <p className="mb-1 text-[12px] text-faint">
              Illustrative example for “{options.find((o) => o.value === level)?.label}”. Nothing is
              transmitted from this screen.
            </p>
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-panel-2 p-2.5 font-mono text-[11px] text-muted">
              {isFetching
                ? 'Building preview…'
                : preview
                  ? JSON.stringify(preview.payload, null, 2)
                  : '—'}
            </pre>
          </div>
        )}
      </div>

      <SubmissionLog />
    </section>
  )
}

/**
 * The local submission log (ADR-299).
 *
 * The preview above shows what we *would* send; this shows what actually left
 * the machine, verbatim. That distinction is the entire point — a preview is a
 * claim, this is the receipt. Deliberately rendered as raw JSON rather than a
 * friendly summary, because a summary is another claim the user would have to
 * take on trust.
 */
function SubmissionLog() {
  const [open, setOpen] = useState(false)
  const logQ = useTelemetryLog(open)
  const regenerate = useRegenerateMachineId()
  const entries = logQ.data?.entries ?? []

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => { track('settings', 'toggle_submission_log'); setOpen((s) => !s) }}>
          {open ? 'Hide what was sent' : 'What was actually sent'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={regenerate.isPending}
          onClick={() => { track('settings', 'regenerate_machine_id'); regenerate.mutate() }}
        >
          {regenerate.isPending ? 'Regenerating…' : 'New anonymous ID'}
        </Button>
      </div>

      {open && (
        <div className="mt-2">
          <p className="mb-1 text-[12px] text-faint">
            Every event this machine has transmitted, newest first, exactly as it was sent. If
            something here surprises you, that is a bug — please report it.
          </p>
          {logQ.isFetching && entries.length === 0 ? (
            <p className="text-[12px] text-muted">Reading log…</p>
          ) : entries.length === 0 ? (
            <p className="text-[12px] text-muted">Nothing has been sent from this machine.</p>
          ) : (
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-panel-2 p-2.5 font-mono text-[11px] text-muted">
              {entries.map((e) => `${e.sentAt}  ${JSON.stringify(e.event)}`).join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ── Advanced (spec 08 §2): daemon restart ─────────────────────────────────────

function AdvancedSection({ onRestart }: { onRestart: () => void }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Advanced</h2>
      <p className="mb-3 text-[12px] text-muted">
        Restart the daemon to apply a new port or LAN binding without killing the terminal.
        Any loaded model is unloaded by a restart and must be reloaded afterward.
      </p>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[14px] font-medium text-ink">Restart daemon</div>
          <div className="text-[12px] text-muted">Stops the engine, then re-launches the daemon process</div>
        </div>
        <Button variant="outline" size="sm" onClick={() => { track('settings', 'restart_daemon'); onRestart() }}>
          <RefreshCw size={13} />
          Restart daemon
        </Button>
      </div>
    </section>
  )
}

// ── Restart overlay (spec 08 §2): fires the restart, then polls /status until the
// new daemon answers and reloads the page. Tolerates the down window (fetch throws
// → keep polling). Uses a raw fetch (not the query cache) since the socket drops. ──

function RestartOverlay({ onDismiss }: { onDismiss: () => void }) {
  const restart = useDaemonRestart()
  const [phase, setPhase] = useState<'restarting' | 'failed'>('restarting')
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await fetch('/api/v1/status', { headers: { Accept: 'application/json' } })
        if (res.ok) {
          // Daemon is back — full reload so the SPA reconnects on the (possibly new) port.
          if (!cancelled) window.location.reload()
          return
        }
      } catch {
        // Daemon still down (socket refused) — expected mid-restart; keep polling.
      }
      if (!cancelled) pollTimer = setTimeout(poll, 700)
    }

    restart.mutate(undefined, {
      onSuccess: () => {
        // Give the old process a beat to release the socket, then poll for the new one.
        pollTimer = setTimeout(poll, 700)
        // If it hasn't come back in 20s, surface a manual fallback.
        giveUpTimer = setTimeout(() => {
          if (!cancelled) setPhase('failed')
        }, 20_000)
      },
      onError: (e) => {
        if (!cancelled) {
          setPhase('failed')
          toast.error(e instanceof ApiError ? e.message : 'Could not restart the daemon.')
        }
      },
    })

    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      if (giveUpTimer) clearTimeout(giveUpTimer)
    }
    // Intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-panel p-6 text-center">
        {phase === 'restarting' ? (
          <>
            <Loader2 size={28} className="animate-spin" style={{ color: 'var(--accent)' }} />
            <div className="text-[15px] font-medium text-ink">Restarting daemon…</div>
            <div className="text-[12px] text-muted">
              Applying your changes. The page will reload automatically when the daemon is back.
            </div>
          </>
        ) : (
          <>
            <ShieldAlert size={28} style={{ color: 'var(--warn)' }} />
            <div className="text-[15px] font-medium text-ink">Daemon is taking a while</div>
            <div className="text-[12px] text-muted">
              It may have moved to a new port. Try reloading, or check the terminal where you
              started TurboLLM.
            </div>
            <div className="mt-1 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { track('settings', 'dismiss_restart_overlay'); onDismiss() }}>
                Dismiss
              </Button>
              <Button size="sm" onClick={() => { track('settings', 'reload_after_restart'); window.location.reload() }}>
                Reload now
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Hardware details (spec 08 §C) ─────────────────────────────────────────────

function HardwarePanel() {
  const { data: sys, isLoading } = useSysInfo()

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Hardware</h2>

      {isLoading || !sys ? (
        <p className="text-[13px] text-faint">Detecting hardware…</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {sys.gpus.length > 0 ? (
            sys.gpus.map((g, i) => (
              <StatRow
                key={i}
                label={sys.gpus.length > 1 ? `GPU ${i + 1}` : 'GPU'}
                value={`${g.name}${g.vramMb > 0 ? ` · ${(g.vramMb / 1000).toFixed(1)} GB VRAM` : ''}`}
              />
            ))
          ) : (
            <StatRow label="GPU" value="None detected (CPU-only)" />
          )}
          <StatRow label="CPU" value={`${sys.cpu || 'Unknown'} · ${sys.cores} cores`} />
          <StatRow label="RAM" value={`${(sys.ramMB / 1000).toFixed(1)} GB`} />
          <StatRow label="OS" value={sys.os} />
        </dl>
      )}
    </section>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-[13px] text-ink">{value}</dd>
    </>
  )
}

// ── Personalization ───────────────────────────────────────────────────────────

function PersonalizationSection() {
  const [p, setP] = useState<Personalization>(() => getPersonalization())
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    savePersonalization(p)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Personalization</h2>
      <p className="mb-3 text-[12px] text-muted">
        Applied as hidden context in every new conversation, on top of whichever agent is selected. Manage
        agents — including the default one for new chats — under Customize → Agents.
      </p>

      <div className="flex flex-col gap-4">
        {/* Assistant name */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="shrink-0">
            <div className="text-[14px] font-medium text-ink">Assistant name</div>
            <div className="text-[12px] text-muted">What the assistant calls itself (empty = model default)</div>
          </div>
          <input
            type="text"
            value={p.assistantName}
            onChange={(e) => setP((prev) => ({ ...prev, assistantName: e.target.value }))}
            placeholder="e.g. Aria"
            className="w-full rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint sm:w-40"
          />
        </div>

        {/* User name */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="shrink-0">
            <div className="text-[14px] font-medium text-ink">Your name</div>
            <div className="text-[12px] text-muted">How the assistant addresses you (empty = not set)</div>
          </div>
          <input
            type="text"
            value={p.userName}
            onChange={(e) => setP((prev) => ({ ...prev, userName: e.target.value }))}
            placeholder="e.g. Alex"
            className="w-full rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink outline-none placeholder:text-faint sm:w-40"
          />
        </div>

        {/* Custom instructions */}
        <div className="flex flex-col gap-1.5">
          <div>
            <div className="text-[14px] font-medium text-ink">Custom instructions</div>
            <div className="text-[12px] text-muted">Extra instructions added to every new conversation</div>
          </div>
          <textarea
            rows={3}
            value={p.customInstructions}
            onChange={(e) => setP((prev) => ({ ...prev, customInstructions: e.target.value }))}
            placeholder="e.g. Always respond in Spanish. Prefer functional programming style."
            className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint"
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={() => { track('settings', 'save_personalization'); handleSave() }} size="sm">
            {saved ? <><Check size={13} /> Saved</> : <><Save size={13} /> Save personalization</>}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ── About + app self-update check (F-006, ADR-031) ────────────────────────────
// Shows the running version and, when npm has a newer TurboLLM, an "update available"
// chip with the install command to copy. Informational only — npm performs the upgrade;
// the app never auto-updates itself. Offline-silent: when the npm check couldn't run we
// just show the current version with no error (never a false "up to date").

const APP_UPDATE_COMMAND = 'npm i -g turbollm'

function AboutSection() {
  // The running version always comes from /status (present immediately); the npm
  // comparison rides the separate, offline-first app-update check.
  const { data: status } = useStatus()
  const { data: update } = useAppUpdate()
  const installed = update?.installed || status?.version || ''
  const hasUpdate = !!update?.hasUpdate && !!update?.latest

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">About</h2>

      <div className="flex items-center justify-between py-1">
        <div>
          <div className="text-[14px] font-medium text-ink">Version</div>
          <div className="text-[12px] text-muted">The TurboLLM version this daemon is running</div>
        </div>
        <span className="font-mono text-[13px] text-ink">{installed ? `v${installed}` : '—'}</span>
      </div>

      {hasUpdate ? (
        <div
          className="mt-2 flex flex-col gap-2 rounded-md border p-3"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))',
            background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
          }}
        >
          <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
            <ArrowUpCircle size={15} />
            TurboLLM v{update!.latest} is available
          </div>
          <div className="text-[12px] text-muted">Update from your terminal:</div>
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5">
            <code className="select-all font-mono text-[12px] text-ink">{APP_UPDATE_COMMAND}</code>
            <CopyButton text={APP_UPDATE_COMMAND} screen="settings" />
          </div>
        </div>
      ) : update?.latest && !update.hasUpdate ? (
        // Checked successfully and current — a quiet confirmation, no call to action.
        <div className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-faint">
          <Check size={13} style={{ color: 'var(--ok)' }} />
          You're on the latest version
        </div>
      ) : null}
    </section>
  )
}

// ── Help ──────────────────────────────────────────────────────────────────────

function HelpSection() {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Help</h2>
      <div className="flex flex-col gap-2">
        <a
          href="https://github.com/bramha-dev/turbollm/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors"
        >
          <ExternalLink size={13} />
          Report a bug
        </a>
        <a
          href="https://github.com/bramha-dev/turbollm/discussions"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors"
        >
          <ExternalLink size={13} />
          Send feedback
        </a>
      </div>
    </section>
  )
}

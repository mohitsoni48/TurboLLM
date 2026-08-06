import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Boxes,
  Check,
  ChevronDown,
  Cpu,
  Download,
  ExternalLink,
  Feather,
  Flame,
  Gauge,
  Gem,
  Layers,
  Loader2,
  Minus,
  MoreHorizontal,
  Network,
  Package,
  Pencil,
  RefreshCw,
  Rocket,
  Server,
  Wrench,
  Zap,
} from 'lucide-react'
import {
  useBackendInstall,
  useBuild,
  useEngineBackends,
  useEngineCatalog,
  useEngineMutations,
  useEngineRecommendation,
  useEngineUpdates,
  useEngines,
  useStatus,
  useSysInfo,
  useUpdatePolicyMutation,
} from '../lib/queries'
import { ApiError, track } from '../lib/api'
import { primaryVendorSummary } from '../lib/vram'
import type {
  CatalogEngine,
  CustomEngineSource,
  Engine,
  EngineBackends,
  EngineFit,
  EngineRecommendationResult,
  EngineUpdateStatus,
  EnginesList,
  UpdatePolicy,
} from '../lib/types'
import { useUiStore } from '../stores/ui'
import { ScreenHeader, InlineError } from '../components/common'
import { StateChip } from '../components/StateChip'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { toast } from '../components/ui/sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import { AddEngineDialog } from './engines/AddEngineDialog'
import { BuildGuideDialog } from './engines/BuildGuideDialog'
import { CustomBuildDialog } from './engines/CustomBuildDialog'
import { EngineStatusHeader } from './engines/EngineStatusHeader'
import { EngineLogPanel } from './engines/EngineLogPanel'
import { LlamaCppBackendRows } from './engines/ManagedEngines'
import {
  customSourceKey,
  groupEngines,
  memberToActivate,
  repoSlug,
  variantLabel,
  type EngineGroup,
} from '../lib/engine-groups'

const ISSUE_URL =
  'https://github.com/mohitsoni48/TurboLLM/issues/new?template=engine-request.yml'

/** Auto-downloaded official llama.cpp builds live in
 *  `<config>/engines/llama.cpp-<tag>-<backend>/`; everything else is a user fork. */
const isOfficialLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

/** Map a registered engine to its catalog id ('llama.cpp' | 'turboquant' | 'ik_llama.cpp' |
 *  'mlx' | 'vllm' | …). Used to line a running engine up against its catalog card. Prefers
 *  `sourceRepo` (set for ANY engine built via "Add via git repo", ADR-186) over binPath
 *  sniffing — the binPath pattern only matches TurboLLM's own auto-download layout
 *  (`engines/turboquant/…`), not the git-build layout (`engines/build/<repo-name>/…`), so a
 *  self-service TurboQuant/ik_llama.cpp build fell through to the 'llama.cpp' default and
 *  showed the wrong catalog card as active. */
export function catalogIdFor(e: Engine): string {
  if (e.kind === 'mlx') return 'mlx'
  if (e.kind === 'vllm') return 'vllm'
  if (e.kind === 'koboldcpp') return 'koboldcpp'
  if (e.kind === 'llamafile') return 'llamafile'
  const repo = repoSlug(e.sourceRepo)
  if (repo === 'atomicbot-ai/atomic-llama-cpp-turboquant') return 'turboquant'
  if (repo === 'ikawrakow/ik_llama.cpp') return 'ik_llama.cpp'
  if (/[\\/]engines[\\/]turboquant[\\/]/.test(e.binPath)) return 'turboquant'
  return 'llama.cpp'
}

/** Human build label for a running engine, e.g. "llama.cpp · CUDA". Derives the GPU
 *  backend from the registered name for official builds; falls back to the kind. */
function buildContextFor(e: Engine, backends: EngineBackends | undefined): string {
  if (e.kind === 'mlx') return 'MLX · Apple Metal'
  if (e.kind === 'rapid-mlx') return 'Rapid-MLX · Apple Metal'
  if (e.kind === 'vllm') return 'vLLM'
  if (e.kind === 'koboldcpp') return 'KoboldCpp'
  if (e.kind === 'llamafile') return 'llamafile'
  if (isOfficialLlama(e.binPath)) {
    const active = backends?.backends.find((b) => b.active)
    return active ? `llama.cpp · ${active.label}` : 'llama.cpp'
  }
  return e.name
}

// ─── Per-engine card copy (front-end curated map) ─────────────────────────────
// Pros/cons + identity per catalog engine, grounded in web research. Curated to a
// few scannable bullets each. Editable here with no backend change.

type EngineMeta = {
  icon: LucideIcon
  tagline: string
  /** Model format(s) it loads — an objective "will my models work" chip. */
  format: string
  pros: string[]
  cons: string[]
}

const ENGINE_META: Record<string, EngineMeta> = {
  'llama.cpp': {
    icon: Boxes,
    tagline: 'The universal default',
    format: 'GGUF',
    pros: [
      'Runs on any GPU or CPU',
      'Widest model support — every GGUF quant',
      'Best-in-class CPU/GPU layer offload',
      'Mature, with an OpenAI-compatible server',
    ],
    cons: ['Weaker under many concurrent users', 'GGUF only — find or convert models', 'Several prebuilt backends to pick from'],
  },
  turboquant: {
    icon: Zap,
    tagline: 'Max context + speed',
    format: 'GGUF',
    pros: [
      'More context in the same VRAM',
      'KV compression (~3.8–6.4× vs F16)',
      'NextN speculative decoding for throughput',
      'Keeps GGUF models + the llama-server API',
    ],
    cons: ['KV quant can slightly affect quality', 'Speculative gains are model-specific', 'Single-maintainer fork; upstream lag'],
  },
  vllm: {
    icon: Server,
    tagline: 'Server-grade throughput',
    format: 'safetensors',
    pros: [
      'Best throughput under concurrent load',
      'PagedAttention serves 2–4× more users',
      'Continuous batching saturates the GPU',
      'Built-in OpenAI-compatible server',
    ],
    cons: ['NVIDIA/Linux-first; Windows needs WSL2', 'Heavy multi-GB install (PyTorch)', 'Slower single-request latency'],
  },
  sglang: {
    icon: Network,
    tagline: 'Throughput + structured output',
    format: 'safetensors',
    pros: [
      'Near-zero-overhead JSON / grammar output',
      'RadixAttention prefix caching',
      'Very high throughput + batching',
      'OpenAI-compatible server out of the box',
    ],
    cons: ['Linux + NVIDIA only', 'Heavy install; needs recent CUDA', 'Overkill for a single desktop user'],
  },
  mlx: {
    icon: Cpu,
    tagline: 'Native Apple Silicon',
    format: 'MLX',
    pros: [
      'Fastest tok/s on Apple Silicon (small models)',
      "Built on Apple's optimized MLX framework",
      'Ships an OpenAI-compatible mlx_lm.server',
      'One-line install, no compiling',
    ],
    cons: ['macOS / Apple Silicon only', 'New models hit GGUF first, MLX lags', 'Weak for high-concurrency serving'],
  },
  'ik_llama.cpp': {
    icon: Flame,
    tagline: 'CPU + big-MoE specialist',
    format: 'GGUF',
    pros: [
      'SOTA low-bit IQK / Trellis quants',
      'Best-in-class CPU + hybrid MoE speed',
      'Strong DeepSeek MLA / FlashMLA performance',
      'Same llama-server + GGUF flow',
    ],
    cons: ['No prebuilts — build from source', 'CPU + CUDA only (no ROCm/Metal)', 'Some quant types are fork-only'],
  },
  koboldcpp: {
    icon: Feather,
    tagline: 'One file, creative tooling',
    format: 'GGUF',
    pros: [
      'Single-file executable, zero install',
      'OpenAI + KoboldAI APIs',
      'Built-in image, TTS and Whisper endpoints',
      'Rich roleplay / story tooling',
    ],
    cons: ['GGUF / GGML only', 'Effectively one maintainer', 'Roleplay-focused UI is niche'],
  },
  llamafile: {
    icon: Package,
    tagline: 'One portable file',
    format: 'GGUF',
    pros: [
      'Single portable file, no install',
      'One file bundles model + runtime',
      'Runs across Windows / macOS / Linux',
      'OpenAI + Anthropic-compatible server',
    ],
    cons: ['Windows caps executables at 4 GB', 'Release cadence has slowed', 'Occasional GPU driver issues'],
  },
  exllamav3: {
    icon: Gauge,
    tagline: 'Big models on limited NVIDIA VRAM',
    format: 'EXL3 / EXL2',
    pros: [
      'EXL3 stays coherent at very low bitrates',
      'Strong quality at 2–3 bpw on consumer NVIDIA',
      'Fast GPU inference, low first-token latency',
      'OpenAI-compatible via TabbyAPI',
    ],
    cons: ['Windows / Linux CUDA only — no macOS/AMD', 'EXL3 format, not GGUF', 'TabbyAPI is a maturing hobby server'],
  },
  'rapid-mlx': {
    icon: Rocket,
    tagline: 'Fastest on Apple Silicon',
    format: 'MLX',
    pros: [
      'Fastest MLX path (vendor claims 2–4× Ollama)',
      'Drop-in OpenAI + Anthropic server',
      'Continuous batching + prompt caching',
      '17 tool-call parsers with recovery',
    ],
    cons: ['macOS Apple Silicon only', 'MLX-format models only, no GGUF', 'Beta; single-maintainer project'],
  },
  nexa: {
    icon: Cpu,
    tagline: 'CPU · GPU · NPU, on-device',
    format: 'GGUF · MLX · .nexa',
    pros: [
      'Rare NPU support: Qualcomm, Intel, Apple ANE',
      'Runs GGUF, MLX and .nexa formats',
      'Day-0 support for new architectures',
      'OpenAI-compatible server, Qualcomm-backed',
    ],
    cons: ['NPU path needs a free license key', 'NexaML engine is proprietary', '.nexa format locks you in'],
  },
  ktransformers: {
    icon: Layers,
    tagline: 'Huge MoE on one GPU + RAM',
    format: 'GGUF · safetensors',
    pros: [
      'Runs DeepSeek-class MoE on one consumer GPU',
      'Hybrid uses big RAM, not just VRAM',
      'Intel AMX / AVX-512 kernels give real speedups',
      'OpenAI-compatible server + web UI',
    ],
    cons: ['No prebuilts; compile from source', 'Research project, experimental', 'Best speed needs Intel AMX + lots of RAM'],
  },
  lmdeploy: {
    icon: Server,
    tagline: 'High-throughput NVIDIA serving',
    format: 'safetensors / AWQ',
    pros: [
      'TurboMind kernels can beat vLLM throughput',
      'Strong AWQ / MXFP4 / FP8 quant support',
      'OpenAI-compatible api_server',
      'Prebuilt pip wheels (incl. Windows)',
    ],
    cons: ['No GGUF — needs HF / AWQ weights', 'NVIDIA-CUDA only', 'Windows limited to a single GPU'],
  },
  'tensorrt-llm': {
    icon: Zap,
    tagline: 'Peak NVIDIA throughput',
    format: 'safetensors',
    pros: [
      'Peak throughput on NVIDIA GPUs',
      'OpenAI-compatible trtllm-serve',
      'PyTorch backend skips engine builds',
      'FP8 / FP4 / INT4 for Blackwell / Hopper',
    ],
    cons: ['NVIDIA + Linux only (Docker)', 'TensorRT backend needs per-model builds', 'Heavyweight setup'],
  },
  prism: {
    icon: Gem,
    tagline: '1-2 bit ternary specialist',
    format: 'GGUF',
    pros: [
      'Purpose-built for 1-2 bit ternary/Bonsai models',
      'Tracks upstream llama.cpp closely (per-commit builds)',
      'Same llama-server API + GGUF flow',
    ],
    cons: ['Niche — most value only for ternary/BitNet-class models', 'No install endpoint yet — build from source', 'Small community'],
  },
  beellama: {
    icon: Layers,
    tagline: 'KV-cache precision at lower bits',
    format: 'GGUF',
    pros: [
      'KVarN: independent K/V bit-widths, better quality-per-bit',
      'KV precision tail keeps recent tokens exact, cheaply',
      'Adaptive DFlash speculative decoding',
    ],
    cons: ['Solo maintainer, fast churn (v0.4.0 dropped TurboQuant/TCQ)', 'No install endpoint yet — build from source', 'KVarN types are manual-pick only, not in the auto-tune sweep yet'],
  },
}

const FALLBACK_META: EngineMeta = { icon: Boxes, tagline: 'Inference engine', format: '', pros: [], cons: [] }
const metaFor = (id: string): EngineMeta => ENGINE_META[id] ?? FALLBACK_META

// ─── Hardware-fit (compatibility) mark ────────────────────────────────────────

type CompatLevel = 'ok' | 'caution' | 'none'
const COMPAT_COLOR: Record<CompatLevel, string> = { ok: 'var(--ok)', caution: 'var(--warn)', none: 'var(--err)' }

/** Green / amber / red hardware fit for a card: incompatible (red) · compatible but with
 *  no prebuilt so it must be built (amber) · ready to install/installed (green). */
function compatFor(fit: EngineFit): { level: CompatLevel; label: string } {
  if (fit.compatible.length === 0) {
    return { level: 'none', label: fit.incompatibleReason ?? 'Not supported on your hardware' }
  }
  if (fit.compatible.every((v) => !v.hasPrebuilt)) {
    return { level: 'caution', label: 'Runs after a build' }
  }
  return { level: 'ok', label: 'Compatible' }
}

function CompatPill({ level, label }: { level: CompatLevel; label: string }) {
  const color = COMPAT_COLOR[level]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

const VENDOR_LABEL: Record<string, string> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple' }
/** Hardware requirement line from the recommended/first compatible variant's `requires`. */
function hardwareLabel(fit: EngineFit): string {
  const v = fit.compatible[0] ?? fit.variants[0]
  const vendor = v?.requires?.gpuVendor?.map((g) => VENDOR_LABEL[g] ?? g).join(' / ')
  const vram = v?.requires?.minVramMb ? `${Math.round(v.requires.minVramMb / 1024)} GB+` : null
  const parts = [vendor, vram].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Any GPU / CPU'
}

const OS_SHORT: Record<string, string> = { win32: 'Win', linux: 'Linux', darwin: 'Mac' }
function osLabel(platforms: string[]): string {
  return platforms.map((p) => OS_SHORT[p] ?? p).join(' · ')
}

/**
 * Engines screen. Three calm zones:
 *  1. Header — detected hardware + the "Running now" engine selector (single source of truth).
 *  2. Engine gallery — one card per engine: hardware-fit mark, pros/cons, install/manage.
 *  3. Diagnostics — the running-engine status + live log, kept out of the default view.
 */
export function EnginesScreen() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const recQ = useEngineRecommendation(provisioning)
  const backendsQ = useEngineBackends(provisioning)
  const logPanelOpen = useUiStore((s) => s.logPanelOpen)
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen)

  const list = enginesQ.data
  const activeId = list?.activeEngineId ?? ''
  const activeEngine = list?.engines.find((e) => e.id === activeId) ?? null

  return (
    <div className="w-full px-4 py-6 md:px-6">
      <ScreenHeader
        title="Engines"
        description="Pick the engine that fits your hardware. Each card shows what it’s good at, its trade-offs, and whether it runs on your machine."
      />

      <div className="flex flex-col gap-5">
        {/* Zone 1 — hardware + the running-engine selector */}
        <EngineHeaderBar
          rec={recQ.data}
          list={list}
          backends={backendsQ.data}
          activeEngine={activeEngine}
        />

        {/* Zone 2 — engine gallery */}
        {enginesQ.isError ? (
          <InlineError
            message={enginesQ.error instanceof ApiError ? enginesQ.error.message : 'Could not load engines.'}
            onRetry={() => void enginesQ.refetch()}
            screen="engines"
          />
        ) : (
          <EngineGallery
            rec={recQ.data}
            isLoading={recQ.isLoading}
            activeCatalogId={activeEngine ? catalogIdFor(activeEngine) : null}
            provisioning={provisioning}
          />
        )}

        {/* Zone 3 — Diagnostics: live engine log, collapsed out of the main flow. */}
        {activeEngine && <EngineLogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />}
      </div>
    </div>
  )
}

// ─── Zone 1 — hardware + running-engine selector ──────────────────────────────

function EngineHeaderBar({
  rec,
  list,
  backends,
  activeEngine,
}: {
  rec: EngineRecommendationResult | undefined
  list: EnginesList | undefined
  backends: EngineBackends | undefined
  activeEngine: Engine | null
}) {
  const mut = useEngineMutations()
  const { data: sys } = useSysInfo()
  const { data: updates } = useEngineUpdates()
  const { data: status } = useStatus()
  const build = useBuild()
  const [rebuildOpen, setRebuildOpen] = useState(false)

  // Pull the newly-built engine into the lists whenever ANY in-app build settles (ADR-100),
  // and surface a global success/error toast. Fires exactly once on active→settled.
  const wasBuilding = useRef(false)
  const eb = status?.engineBuild
  const buildActive = !!eb?.active
  useEffect(() => {
    if (wasBuilding.current && !buildActive && eb) {
      build.refresh()
      if (eb.phase === 'done' && eb.engine && eb.engine !== 'CUDA Toolkit') {
        toast.success(`${eb.engine} built and added — it's now your active engine.`)
      } else if (eb.phase === 'error' && eb.error && eb.engine !== 'CUDA Toolkit') {
        toast.error(eb.error)
      }
    }
    wasBuilding.current = buildActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildActive])

  // Rebuild chip: only when the active source-built engine actually has a NEWER commit.
  const upd = activeEngine ? updates?.updates[activeEngine.id] : undefined
  const showRebuildChip = !!upd?.rebuild && !!upd?.hasUpdate && !!activeEngine?.sourceRepo

  // Hardware line — prefer the recommendation's summed hardware; fall back to the same
  // primary-vendor sum from raw sysinfo (NOT sys.gpus[0], which is the multi-GPU bug).
  // GPU count always comes from raw sysinfo — it's the same physical GPUs either way, and
  // the daemon's HardwareProfile doesn't carry a count, only the summed/headline fields.
  const hw = rec?.hardware
  const sysFallback = primaryVendorSummary(sys?.gpus ?? [])
  const gpuName = hw?.gpuName ?? sysFallback.gpuName
  const vramMb = hw?.vramMb ?? sysFallback.vramMb
  const gpuCount = sysFallback.count
  const osName = hw ? platformName(hw.platform) : sys?.os.split('/')[0] ? platformName(sys.os.split('/')[0]) : ''
  const hwLine = [
    gpuName ? (gpuCount > 1 ? `${gpuCount}× ${gpuName}` : gpuName) : 'CPU-only',
    vramMb > 0 ? `${(vramMb / 1024).toFixed(0)} GB` : null,
    osName || null,
  ]
    .filter(Boolean)
    .join(' · ')

  const installed = list?.engines ?? []
  // Group into LOGICAL engines (ADR-091): one row per engine, per-build variants collapsed.
  const groups = useMemo(() => groupEngines(installed), [installed])
  const activeGroup = activeEngine
    ? groups.find((g) => g.members.some((m) => m.id === activeEngine.id)) ?? null
    : null
  const activeBuild = activeEngine ? buildContextFor(activeEngine, backends) : null

  const busy = mut.activate.isPending
  // The active engine's live run-state drives the traffic-light on the selector below
  // (green running · amber starting · red error · grey stopped).
  const engineState = status?.engine.state ?? 'stopped'

  const activate = (id: string) => {
    if (id === activeEngine?.id) return
    mut.activate.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not switch engine.'),
    })
  }
  const selectGroup = (g: EngineGroup) => {
    const target = memberToActivate(g, activeEngine?.id ?? null)
    if (target) {
      track('engines', 'switch_engine')
      activate(target.id)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <Cpu size={13} className="shrink-0 text-accent" />
            Your hardware
          </div>
          <div className="mt-1 truncate text-base font-semibold text-ink">{hwLine || 'Detecting…'}</div>
        </div>

        <div className="flex flex-col items-start gap-1.5 md:items-end">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Running now</span>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy || groups.length === 0}
                className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60 md:w-auto md:min-w-[220px]"
              >
                <StateChip state={engineState} dotOnly className="shrink-0" />
                <span className="flex-1 truncate text-left">
                  {activeGroup?.label ?? (groups.length ? 'No engine active' : 'No engine installed')}
                </span>
                <ChevronDown size={14} className="shrink-0 text-muted" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[280px]">
                <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                  Installed engines
                </div>
                {groups.length === 0 && (
                  <div className="px-2 py-1.5 text-[12px] text-muted">Install an engine below to get started.</div>
                )}
                {groups.map((g) => {
                  const rebuild = g.members.some(
                    (m) => !!updates?.updates[m.id]?.rebuild && !!updates?.updates[m.id]?.hasUpdate,
                  )
                  const isActiveGroup = g.key === activeGroup?.key
                  return (
                    <DropdownMenuItem key={g.key} onSelect={() => selectGroup(g)} className="flex items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {isActiveGroup && <Check size={14} className="text-accent" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">{g.label}</span>
                      {g.members.length > 1 && (
                        <span className="shrink-0 text-[11px] text-muted">{g.members.length} builds</span>
                      )}
                      {rebuild && (
                        <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent)' }}>
                          rebuild
                        </span>
                      )}
                      {isActiveGroup && <span className="shrink-0 text-[11px] text-accent">active</span>}
                    </DropdownMenuItem>
                  )
                })}
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[11px] text-muted">Install more engines below ↓</div>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Version/build picker — the way to CHOOSE a llama.cpp GPU build (or any engine
                with more than one installed variant). Single-variant engines stay one-line. */}
            {activeGroup && activeGroup.members.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy}
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60 md:w-auto md:min-w-[160px]"
                >
                  <Layers size={14} className="shrink-0 text-accent" />
                  <span className="flex-1 truncate text-left">
                    {activeEngine ? variantLabel(activeEngine) : 'Choose a build'}
                  </span>
                  <ChevronDown size={14} className="shrink-0 text-muted" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[260px]">
                  <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                    Build
                  </div>
                  {activeGroup.members.map((m) => (
                    <DropdownMenuItem key={m.id} onSelect={() => { track('engines', 'switch_engine_build'); activate(m.id) }} className="flex items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {m.id === activeEngine?.id && <Check size={14} className="text-accent" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">{variantLabel(m)}</span>
                      {m.id === activeGroup.latestId && (
                        <span className="shrink-0 text-[11px]" style={{ color: 'var(--ok)' }}>
                          latest
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {activeBuild && <span className="text-[11px] text-muted">{activeBuild}</span>}
          {showRebuildChip && (
            <button
              type="button"
              onClick={() => { track('engines', 'open_rebuild_guide'); setRebuildOpen(true) }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
              style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
            >
              <Wrench size={11} className="shrink-0" />
              Rebuild available
              {upd?.installed && upd?.latest ? ` · ${upd.installed} → ${upd.latest}` : ''}
            </button>
          )}
        </div>
      </div>

      {/* Active-engine status, merged into this panel (state light · model · live stats ·
          Stop/Restart). The engine name lives once, in the selector above. */}
      {activeEngine && (
        <div className="mt-4 border-t border-border pt-3">
          <EngineStatusHeader status={status} activeEngineName={activeEngine.name} embedded />
        </div>
      )}

      {showRebuildChip && activeEngine?.sourceRepo && (
        <BuildGuideDialog
          open={rebuildOpen}
          onOpenChange={setRebuildOpen}
          repoUrl={activeEngine.sourceRepo}
          branch={activeEngine.sourceBranch}
          engineName={activeEngine.name}
          mode="rebuild"
        />
      )}
    </div>
  )
}

// ─── Zone 2 — engine gallery ──────────────────────────────────────────────────

function EngineGallery({
  rec,
  isLoading,
  activeCatalogId,
  provisioning,
}: {
  rec: EngineRecommendationResult | undefined
  isLoading: boolean
  activeCatalogId: string | null
  provisioning: boolean
}) {
  const catalogQ = useEngineCatalog(provisioning)
  const { data: registry } = useEngines()
  const { data: updates } = useEngineUpdates(provisioning)
  const install = useBackendInstall()
  const engineMut = useEngineMutations()
  const policyMut = useUpdatePolicyMutation()
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; registryId: string } | null>(null)

  const catalogById = useMemo(() => {
    const m = new Map<string, CatalogEngine>()
    for (const e of catalogQ.data?.engines ?? []) m.set(e.id, e)
    return m
  }, [catalogQ.data])

  if (isLoading || !rec) {
    return (
      <section className="flex flex-col gap-3">
        <SectionLabel>Install &amp; manage</SectionLabel>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-52 w-full" />
        </div>
      </section>
    )
  }

  const anyPending =
    provisioning ||
    install.vllm.isPending ||
    install.mlx.isPending ||
    install.rapidMlx.isPending ||
    install.turboquant.isPending ||
    install.koboldcpp.isPending ||
    install.llamafile.isPending ||
    install.updateVllm.isPending ||
    install.updateMlx.isPending ||
    install.updateRapidMlx.isPending ||
    install.updateTurboquant.isPending ||
    install.updateKoboldcpp.isPending ||
    install.updateLlamafile.isPending ||
    engineMut.remove.isPending ||
    engineMut.disableCustom.isPending ||
    engineMut.purge.isPending

  // ── lifecycle (unchanged behavior; mirrors ManagedEngines.DiscoverEngines) ──
  const installFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.vllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.mlx
    if (e.installEndpoint === '/api/v1/engines/rapid-mlx') return install.rapidMlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.turboquant
    if (e.installEndpoint === '/api/v1/engines/koboldcpp') return install.koboldcpp
    if (e.installEndpoint === '/api/v1/engines/llamafile') return install.llamafile
    return null
  }
  const updateFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.updateVllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.updateMlx
    if (e.installEndpoint === '/api/v1/engines/rapid-mlx') return install.updateRapidMlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.updateTurboquant
    if (e.installEndpoint === '/api/v1/engines/koboldcpp') return install.updateKoboldcpp
    if (e.installEndpoint === '/api/v1/engines/llamafile') return install.updateLlamafile
    return null
  }
  const registryEngineId = (e: CatalogEngine): string | undefined => {
    const eng = registry?.engines ?? []
    if (e.sourceEngineId) return e.sourceEngineId
    if (e.provision === 'pip') return eng.find((x) => x.kind === e.kind)?.id
    if (e.id === 'turboquant') return eng.find((x) => /[\\/]engines[\\/]turboquant[\\/]/.test(x.binPath))?.id
    if (e.id === 'koboldcpp' || e.id === 'llamafile') return eng.find((x) => x.kind === e.kind)?.id
    return undefined
  }
  const doInstall = (e: CatalogEngine) => {
    const m = installFor(e)
    if (!m) return
    track('engines', 'install_engine')
    m.mutate(undefined, {
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not install ${e.name}.`),
    })
  }
  const doEnable = (e: CatalogEngine) => {
    track('engines', 'enable_engine')
    if (e.sourceBuilt && e.sourceBinPath) {
      engineMut.add.mutate(
        { binPath: e.sourceBinPath, name: e.name, sourceRepo: e.homepage, sourceBranch: e.sourceBranch || undefined },
        {
          onSuccess: () => toast.success(`${e.name} enabled`),
          onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not enable ${e.name}.`),
        },
      )
      return
    }
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`${e.name} enabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not enable ${e.name}.`),
    })
  }
  const doDisable = (e: CatalogEngine) => {
    const id = registryEngineId(e)
    if (!id) { toast.error(`Could not find the installed ${e.name} engine.`); return }
    track('engines', 'disable_engine')
    engineMut.remove.mutate(id, {
      onSuccess: () => toast.success(`${e.name} disabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not disable ${e.name}.`),
    })
  }
  const doUpdate = (e: CatalogEngine) => {
    const m = updateFor(e)
    if (!m) return
    track('engines', 'update_engine')
    m.mutate(undefined, {
      onSuccess: () => toast.success(`Updating ${e.name} to the latest release…`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not update ${e.name}.`),
    })
  }
  const setPolicy = (e: CatalogEngine, policy: UpdatePolicy) => {
    const id = registryEngineId(e)
    if (!id) { toast.error(`Could not find the installed ${e.name} engine.`); return }
    track('engines', 'set_engine_update_policy')
    policyMut.mutate(
      { id, policy },
      { onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change auto-update.') },
    )
  }
  const requestDelete = (e: CatalogEngine) => {
    const registryId = registryEngineId(e)
    if (!registryId) { toast.error(`Could not find the installed ${e.name} engine to delete.`); return }
    setDeleteTarget({ name: e.name, registryId })
  }
  const requestDeleteCustom = (eng: Engine) => setDeleteTarget({ name: eng.name, registryId: eng.id })
  // Custom-engine parity (GitHub: "treated as an outsider... same UI as catalogue engines"):
  // Disable is just registry.remove keyed by the LIVE engine's own id — no registryEngineId
  // lookup needed, unlike a catalog engine (which has to be re-matched via binPath/sourceRepo
  // conventions since it has no single fixed id of its own).
  const doDisableCustom = (eng: Engine) => {
    track('engines', 'disable_engine')
    engineMut.disableCustom.mutate(eng.id, {
      onSuccess: () => toast.success(`${eng.name} disabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not disable ${eng.name}.`),
    })
  }
  // Enable re-registers using the SAME identity that was remembered (recordCustomSource) —
  // instant, no rebuild, exactly like a catalog engine's sourceBuilt Enable.
  const doEnableCustom = (source: CustomEngineSource) => {
    track('engines', 'enable_engine')
    engineMut.add.mutate(
      { name: source.name, binPath: source.binPath, sourceRepo: source.sourceRepo, sourceBranch: source.sourceBranch, sourceCommit: source.sourceCommit },
      {
        onSuccess: () => toast.success(`${source.name} enabled`),
        onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not enable ${source.name}.`),
      },
    )
  }
  // Not routed through the shared delete confirmation dialog (a "remembered but not
  // registered" source has nothing on disk to warn about) — still a real deletion of the
  // remembered engine, so it shares `delete_engine` rather than needing its own action.
  const doForgetCustom = (source: CustomEngineSource) => {
    track('engines', 'delete_engine')
    engineMut.forgetCustomSource.mutate(customSourceKey(source), {
      onSuccess: () => toast.success(`${source.name} removed`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not remove ${source.name}.`),
    })
  }
  const doDelete = () => {
    if (!deleteTarget) return
    track('engines', 'delete_engine')
    engineMut.purge.mutate(deleteTarget.registryId, {
      onSuccess: () => {
        toast.success(`${deleteTarget.name} deleted`)
        setDeleteTarget(null)
      },
      onError: (err) => {
        setDeleteTarget(null)
        toast.error(err instanceof ApiError ? err.message : `Could not delete ${deleteTarget.name}.`)
      },
    })
  }

  const fits = rec.recommendation.fits
    .filter((fit) => {
      // Hide engines not supported on this OS — except vLLM, kept visible (greyed) as the
      // advertised power-user option (user request).
      const c = catalogById.get(fit.engine.id)
      return fit.engine.id === 'vllm' || !c || c.supportedHere !== false
    })
    // Push engines that can't run here (red) to the bottom; stable otherwise.
    .sort((a, b) => (a.compatible.length === 0 ? 1 : 0) - (b.compatible.length === 0 ? 1 : 0))

  // GitHub #51: a custom-added engine (arbitrary binPath, matches no catalog entry) used to be
  // silently omitted here — it only ever showed up buried in the "Running now" dropdown above,
  // even though the backend registered it correctly. Surface it as its own card so "add your own
  // engine" actually shows the engine you added.
  const matchedRegistryIds = new Set(
    fits.map((fit) => registryEngineId(catalogById.get(fit.engine.id) ?? (fit.engine as CatalogEngine))).filter(Boolean),
  )
  // Auto-downloaded official llama.cpp builds already have dedicated UI — the llama.cpp
  // card's own "Manage GPU builds" expander (LlamaCppBackendRows) — so exclude those too;
  // only a genuinely uncategorized engine (any binPath outside both conventions) is "custom".
  const customEngines = (registry?.engines ?? []).filter(
    (e) => !matchedRegistryIds.has(e.id) && !isOfficialLlama(e.binPath),
  )
  // GitHub: "a custom engine added from git url is treated as an outsider — it should get the
  // same UI as catalogue engines with disable/enable/delete/rebuild." Unlike a catalog engine
  // (re-enabled via its own fixed, hardcoded homepage URL), a disabled custom engine has no
  // other identity anywhere in the system — customDisabled (backend customEngineSources) is
  // that memory, so Enable can re-register the still-built binary instead of the entry just
  // vanishing. Already excludes anything matching a currently-live engine (backend-computed).
  const customDisabled = registry?.customDisabled ?? []
  // Reuses engineMut.add (the same mutation catalog Enable/Install already use) — a disabled
  // custom engine's Enable is exactly that: re-register the still-built binary, no rebuild.
  // engineMut.add is shared with AddEngineDialog/catalog Enable too, so this key just won't
  // match any customDisabled entry while one of THOSE is in flight — harmless, no false spinner.
  const enablingKey = engineMut.add.isPending ? customSourceKey(engineMut.add.variables ?? { binPath: '' }) : null

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Install &amp; manage</SectionLabel>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {fits.map((fit) => {
          const regId = registryEngineId(catalogById.get(fit.engine.id) ?? (fit.engine as CatalogEngine))
          return (
            <EngineCard
              key={fit.engine.id}
              fit={fit}
              catalog={catalogById.get(fit.engine.id)}
              isActive={activeCatalogId === fit.engine.id}
              anyPending={anyPending}
              provisioning={provisioning}
              updateStatus={regId ? updates?.updates[regId] : undefined}
              policy={(regId ? updates?.policies[regId] : undefined) ?? 'notify'}
              installFor={installFor}
              onInstall={doInstall}
              onEnable={doEnable}
              onDisable={doDisable}
              onUpdate={doUpdate}
              onDelete={requestDelete}
              onSetPolicy={setPolicy}
            />
          )
        })}
      </div>

      {(customEngines.length > 0 || customDisabled.length > 0) && (
        <div className="flex flex-col gap-2">
          {customEngines.map((eng) => (
            <CustomEngineCard
              key={eng.id}
              id={eng.id}
              name={eng.name}
              binPath={eng.binPath}
              version={eng.version}
              sourceRepo={eng.sourceRepo}
              sourceBranch={eng.sourceBranch}
              disabled={false}
              binPathExists
              anyPending={anyPending}
              enabling={false}
              onDisable={() => doDisableCustom(eng)}
              onEnable={() => {}}
              onDelete={() => requestDeleteCustom(eng)}
            />
          ))}
          {customDisabled.map((source) => (
            <CustomEngineCard
              key={customSourceKey(source)}
              name={source.name}
              binPath={source.binPath}
              sourceRepo={source.sourceRepo}
              sourceBranch={source.sourceBranch}
              disabled
              binPathExists={source.binPathExists}
              anyPending={anyPending}
              enabling={enablingKey === customSourceKey(source)}
              onDisable={() => {}}
              onEnable={() => doEnableCustom(source)}
              onDelete={() => doForgetCustom(source)}
            />
          ))}
        </div>
      )}

      {/* Add your own engine — a compact strip, not a half-empty card. */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong bg-panel px-4 py-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-ink">Add your own engine</span>
          <span className="text-[12px] text-muted"> — point at any llama-server compatible binary, or ask for a new one.</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <a
            href={ISSUE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
          >
            Request an engine <ExternalLink size={11} />
          </a>
          <CustomBuildDialog />
          <AddEngineDialog />
        </div>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Files for this engine are removed from disk. Your models are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} disabled={engineMut.purge.isPending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** One engine card: identity + hardware-fit mark + attribute strip + pros/cons + actions.
 *  llama.cpp is special — it owns an inline "Manage GPU builds" expander (the official
 *  CUDA/ROCm/Vulkan/… backends) so it reads as ONE engine; the active build is chosen from
 *  the "Running now" selector at the top. */
function EngineCard({
  fit,
  catalog,
  isActive,
  anyPending,
  provisioning,
  updateStatus,
  policy,
  installFor,
  onInstall,
  onEnable,
  onDisable,
  onUpdate,
  onDelete,
  onSetPolicy,
}: {
  fit: EngineFit
  catalog: CatalogEngine | undefined
  isActive: boolean
  anyPending: boolean
  provisioning: boolean
  updateStatus: EngineUpdateStatus | undefined
  policy: UpdatePolicy
  installFor: (e: CatalogEngine) => { isPending: boolean } | null
  onInstall: (e: CatalogEngine) => void
  onEnable: (e: CatalogEngine) => void
  onDisable: (e: CatalogEngine) => void
  onUpdate: (e: CatalogEngine) => void
  onDelete: (e: CatalogEngine) => void
  onSetPolicy: (e: CatalogEngine, policy: UpdatePolicy) => void
}) {
  const e = fit.engine
  const meta = metaFor(e.id)
  const Icon = meta.icon
  const [guideOpen, setGuideOpen] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [buildsOpen, setBuildsOpen] = useState(false)
  const isLlama = e.id === 'llama.cpp'
  const sourceBuilt = !!catalog?.sourceBuilt
  const incompatible = fit.compatible.length === 0
  const buildYourself = !incompatible && fit.compatible.every((v) => !v.hasPrebuilt)
  const isInstalled = !!catalog?.installed
  const isEnabled = !!catalog?.enabled
  const isDisabled = isInstalled && !isEnabled
  const compat = compatFor(fit)

  return (
    <div className="flex flex-col rounded-xl border border-border bg-panel p-4">
      {/* Identity row */}
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-muted">
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-ink">{e.name}</span>
            {isActive ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--ok)' }}>
                <Check size={11} /> Active
              </span>
            ) : isEnabled ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted">
                <Check size={11} /> Installed
              </span>
            ) : isDisabled ? (
              <Badge variant="mono">Disabled</Badge>
            ) : null}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">{meta.tagline || e.description}</div>
        </div>
        <CompatPill level={compat.level} label={compat.label} />
      </div>

      {/* Attribute strip — objective facts (hardware / OS / model format). */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <AttrChip icon={<Cpu size={11} />}>{hardwareLabel(fit)}</AttrChip>
        <AttrChip icon={<Boxes size={11} />}>{osLabel(e.platforms)}</AttrChip>
        {meta.format && <AttrChip icon={<Package size={11} />}>{meta.format}</AttrChip>}
      </div>

      {/* Pros / cons */}
      {(meta.pros.length > 0 || meta.cons.length > 0) && (
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold" style={{ color: 'var(--ok)' }}>Pros</div>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {meta.pros.map((p, i) => (
                <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-ink">
                  <Check size={13} className="mt-px shrink-0" style={{ color: 'var(--ok)' }} />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[11px] font-semibold" style={{ color: 'var(--warn)' }}>Cons</div>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {meta.cons.map((c, i) => (
                <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-ink">
                  <Minus size={13} className="mt-px shrink-0" style={{ color: 'var(--warn)' }} />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Footer: docs link + primary action / manage */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
        {catalog ? (
          <a
            href={catalog.homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-ink"
            title={catalog.homepage}
          >
            <ExternalLink size={11} /> docs
          </a>
        ) : (
          <span />
        )}

        <div className="flex shrink-0 items-center gap-2">
          {isLlama ? (
            <Button size="sm" variant="outline" onClick={() => { track('engines', 'toggle_manage_builds'); setBuildsOpen((v) => !v) }}>
              <Layers size={13} /> Manage GPU builds
              <ChevronDown size={13} className="transition-transform" style={{ transform: buildsOpen ? 'rotate(180deg)' : 'none' }} />
            </Button>
          ) : !catalog ? null : isInstalled ? (
            <>
              {isEnabled && updateStatus?.hasUpdate && !sourceBuilt && (
                <Button size="sm" variant="outline" disabled={provisioning} onClick={() => onUpdate(catalog)}>
                  <Download size={13} /> Update
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`Actions for ${e.name}`}
                  disabled={anyPending}
                  className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
                >
                  <MoreHorizontal size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceBuilt ? (
                    <DropdownMenuItem onSelect={() => { track('engines', 'open_rebuild_guide'); setRebuildOpen(true) }} disabled={anyPending}>
                      <RefreshCw size={14} /> {updateStatus?.hasUpdate ? 'Rebuild (new commit)' : 'Rebuild'}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => onUpdate(catalog)} disabled={provisioning}>
                      <Download size={14} /> {updateStatus?.hasUpdate ? 'Update now' : 'Check for update'}
                    </DropdownMenuItem>
                  )}
                  {isEnabled ? (
                    <DropdownMenuItem onSelect={() => onDisable(catalog)}>Disable</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => onEnable(catalog)}>Enable</DropdownMenuItem>
                  )}
                  {isEnabled && (
                    <>
                      <DropdownMenuSeparator />
                      <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                        Auto-update
                      </div>
                      {(['off', 'notify', 'auto'] as UpdatePolicy[]).map((p) => (
                        <DropdownMenuItem
                          key={p}
                          onSelect={() => onSetPolicy(catalog, p)}
                          className="flex items-center gap-2"
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                            {policy === p && <Check size={13} className="text-accent" />}
                          </span>
                          {AUTO_UPDATE_LABEL[p]}
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => onDelete(catalog)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {sourceBuilt && catalog && (
                <BuildGuideDialog
                  open={rebuildOpen}
                  onOpenChange={setRebuildOpen}
                  repoUrl={catalog.homepage}
                  branch={catalog.sourceBranch || undefined}
                  commit={catalog.sourceCommit}
                  patchUrl={catalog.patchUrl}
                  patchSha256={catalog.patchSha256}
                  engineName={e.name}
                  mode="rebuild"
                />
              )}
            </>
          ) : buildYourself ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { track('engines', 'open_build_guide'); setGuideOpen(true) }}
                title="No prebuilt binary — build it from source with a guided walkthrough."
              >
                <Wrench size={13} /> Build from source
              </Button>
              <BuildGuideDialog
                open={guideOpen}
                onOpenChange={setGuideOpen}
                repoUrl={catalog.homepage}
                commit={catalog.sourceCommit}
                patchUrl={catalog.patchUrl}
                patchSha256={catalog.patchSha256}
                engineName={e.name}
              />
            </>
          ) : (
            <Button
              size="sm"
              disabled={anyPending || incompatible || !installFor(catalog)}
              onClick={() => onInstall(catalog)}
              title={incompatible ? fit.incompatibleReason ?? 'Not supported on this hardware' : `Install ${e.name}`}
            >
              {installFor(catalog)?.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              Install
            </Button>
          )}
        </div>
      </div>

      {/* llama.cpp GPU backends, inline (one card = one engine). */}
      {isLlama && buildsOpen && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-[12px] text-muted">
            Download or update a GPU backend below. Pick the active build from “Running now” at the top.
          </p>
          <LlamaCppBackendRows />
        </div>
      )}

      {/* Honest per-engine update status (ADR-085) for enabled non-llama engines. */}
      {!isLlama && isEnabled && (
        <div className="mt-2">
          <CatalogUpdateStatusLine st={updateStatus} />
        </div>
      )}
    </div>
  )
}

/** One custom (non-catalog) engine — either currently live (`disabled: false`) or remembered
 *  but not registered (`disabled: true`, from backend customEngineSources). Gives a custom
 *  engine the SAME lifecycle actions a catalog card gets (Rebuild/Disable/Enable/Delete/
 *  Rename/Re-probe), not just a name + a single Delete button (GitHub: "treated as an
 *  outsider"). Rename/Re-probe need a live registry id, so they're hidden for a
 *  disabled/remembered source. */
function CustomEngineCard({
  id,
  name,
  binPath,
  version,
  sourceRepo,
  sourceBranch,
  disabled,
  binPathExists,
  anyPending,
  enabling,
  onDisable,
  onEnable,
  onDelete,
}: {
  id?: string
  name: string
  binPath: string
  version?: string
  sourceRepo?: string
  sourceBranch?: string
  disabled: boolean
  binPathExists: boolean
  anyPending: boolean
  enabling: boolean
  onDisable: () => void
  onEnable: () => void
  onDelete: () => void
}) {
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const engineMut = useEngineMutations()

  useEffect(() => setDraft(name), [name])

  const commitRename = () => {
    const trimmed = draft.trim()
    setEditing(false)
    if (!id || !trimmed || trimmed === name) {
      setDraft(name)
      return
    }
    engineMut.rename.mutate(
      { id, name: trimmed },
      {
        onSuccess: () => toast.success('Engine renamed'),
        onError: (err) => {
          setDraft(name)
          toast.error(err instanceof ApiError ? err.message : 'Could not rename engine.')
        },
      },
    )
  }

  const onReprobe = () => {
    if (!id) return
    engineMut.reprobe.mutate(id, {
      onSuccess: () => toast.success('Engine re-probed'),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not re-probe engine.'),
    })
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Wrench size={15} className="shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editing ? (
              <Input
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') {
                    setDraft(name)
                    setEditing(false)
                  }
                }}
                className="h-7 max-w-[200px]"
              />
            ) : (
              <span className="truncate text-sm font-medium text-ink">{name}</span>
            )}
            <Badge>Custom</Badge>
            {disabled && <Badge variant="mono">Disabled</Badge>}
          </div>
          <div className="truncate text-[12px] text-muted" title={binPath}>{binPath}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {version && <span className="text-[12px] text-faint">{version}</span>}
        {disabled && !binPathExists && (
          <span
            className="text-[11px] text-faint"
            title="The build folder for this engine no longer exists on disk — rebuild from the repo to bring it back."
          >
            Build not found on disk
          </span>
        )}
        {sourceRepo && (
          <Button size="sm" variant="outline" disabled={anyPending} onClick={() => { track('engines', 'open_rebuild_guide'); setRebuildOpen(true) }}>
            <RefreshCw size={13} /> Rebuild
          </Button>
        )}
        {disabled ? (
          binPathExists && (
            <Button size="sm" disabled={anyPending || enabling} onClick={onEnable}>
              {enabling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Enable
            </Button>
          )
        ) : (
          <Button variant="outline" size="sm" disabled={anyPending} onClick={onDisable}>
            Disable
          </Button>
        )}
        {id && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More actions for ${name}`}
              disabled={anyPending}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => { setDraft(name); setEditing(true) }}>
                <Pencil size={14} /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onReprobe} disabled={engineMut.reprobe.isPending}>
                <RefreshCw size={14} /> Re-probe
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="outline" size="sm" onClick={onDelete}>
          {disabled ? 'Remove' : 'Delete'}
        </Button>
      </div>
      {sourceRepo && (
        <BuildGuideDialog
          open={rebuildOpen}
          onOpenChange={setRebuildOpen}
          repoUrl={sourceRepo}
          branch={sourceBranch || undefined}
          engineName={name}
          mode="rebuild"
        />
      )}
    </div>
  )
}

/** Small attribute pill for the card's hardware/OS/format strip. */
function AttrChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-panel-2 px-2 py-1 text-[11px] text-ink">
      <span className="shrink-0 text-muted">{icon}</span>
      {children}
    </span>
  )
}

// ─── shared helpers ───────────────────────────────────────────────────────────

const AUTO_UPDATE_LABEL: Record<UpdatePolicy, string> = { off: 'Off', notify: 'Notify', auto: 'Auto' }

/** Compact relative-time for the last update check ("just now", "3h ago", "2d ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Honest one-line update status for a catalog card (ADR-085). Never claims "up to date"
 *  without a real upstream check; offline/uncheckable says so explicitly. */
function CatalogUpdateStatusLine({ st, repoUrl }: { st: EngineUpdateStatus | undefined; repoUrl?: string }) {
  if (!st) return null
  if (st.error === 'offline') {
    return <span className="text-[11px] text-muted">Couldn&apos;t check for updates (offline)</span>
  }
  if (st.error === 'no_source' || !st.comparable) {
    return <span className="text-[11px] text-muted">Update status unavailable</span>
  }
  if (st.rebuild && st.hasUpdate) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
        Newer source available · rebuild{' '}
        {repoUrl && (
          <a href={repoUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
            (open repo)
          </a>
        )}
      </span>
    )
  }
  if (st.hasUpdate && st.latest) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
        Update available · {st.installed || '?'} → {st.latest}
      </span>
    )
  }
  return (
    <span className="text-[11px] text-muted">
      Up to date · {st.latest ?? st.installed}
      {st.checkedAt ? ` · checked ${relativeTime(st.checkedAt)}` : ''}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{children}</p>
}

const PLATFORM_DISPLAY: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}
function platformName(p: string): string {
  return PLATFORM_DISPLAY[p] ?? p
}

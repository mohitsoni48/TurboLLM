// Startup auto-load of the last model (spec 05 §7 acceptance #7, ADR-425).
// planAutoLoad decides what to do from the POST-scan config snapshot, following the
// decision order in the run's architecture §3.4 (plus row 3a, AC10). skipLine and
// fallbackLine give the exact one-line reasons (architecture §4.4). All three are pure:
// they read only their arguments and print nothing; the caller owns the console.
// runAutoLoad is that caller at daemon start: it waits for the boot scan, plans once from one post-scan
// snapshot, and loads through the manual Load's chokepoints, printing only through deps.log / deps.warn.
import type { Config, ConfigStore, DevModel, Engine } from '../config/config'
import type { ModelRouter } from '../gateway/model-router'
import type { ModelEntry, Scanner } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'
import type { ComfyGuard } from './comfy-guard'
import { engineAcceptsFormat, engineRejectsAudioModel } from './compat'
import type { Manager, StartOpts } from './manager'
import type { Registry } from './registry'
import { buildStartOpts } from './start-opts'
import { isTurboLinkEnabledIn } from '../link/gate'

export interface AutoLoadDeps {
  /** The boot scan's promise (cli.ts). Never rejects (CoalescedRunner C4). */
  initialScan: Promise<void>
  store: Pick<ConfigStore, 'snapshot'>
  registry: Pick<Registry, 'active'>
  comfy: Pick<ComfyGuard, 'isBlocked' | 'freeComfyUIBeforeLoad'>
  scanner: Pick<Scanner, 'get'>
  manager: Pick<Manager, 'load'>
  modelRouter: Pick<ModelRouter, 'withSwapLock' | 'markPrimaryLoaded' | 'loadExplicit'>
  /** getSysInfo in production; a fixture in tests. */
  sysInfo: () => SysInfo
  /** console.log in production. */
  log: (line: string) => void
  /** console.warn in production. */
  warn: (line: string) => void
}

/** Resolves once the plan is carried out and any load has settled. Never rejects — a failure
 *  anywhere in this function, including while deciding what to do, is reported through
 *  `deps.warn` rather than left to reject the caller's `void runAutoLoad(...)` (cli.ts). */
export async function runAutoLoad(deps: AutoLoadDeps): Promise<AutoLoadPlan> {
  let plan: AutoLoadPlan = { kind: 'disabled' }
  try {
    await deps.initialScan
    const cfg = deps.store.snapshot()
    plan = planAutoLoad({
      cfg,
      engine: deps.registry.active(),
      comfyBlocked: deps.comfy.isBlocked(),
      findModel: (key) => deps.scanner.get(key),
    })
    await carryOut(plan, cfg, deps)
  } catch (e) {
    deps.warn(`auto-load failed: ${e}`)
  }
  return plan
}

export type AutoLoadSkipReason =
  | { code: 'comfyui-busy' }
  | { code: 'no-active-engine' }
  | { code: 'nothing-to-load' }
  | { code: 'model-not-in-library'; modelKey: string }
  | { code: 'model-not-loadable'; modelKey: string }
  | { code: 'engine-incompatible'; modelKey: string; engineName: string; engineKind: string; detail: string }
  | { code: 'remote-model-selected'; selectedModel: string }

export type AutoLoadPlan =
  | { kind: 'disabled' }
  | { kind: 'skip'; reason: AutoLoadSkipReason }
  | { kind: 'load-model'; entry: ModelEntry; engine: Engine }
  | { kind: 'load-dev-model'; devModel: DevModel; engine: Engine; fallbackFrom?: AutoLoadSkipReason }

export interface AutoLoadPlanInput {
  /** The POST-scan snapshot, so a key the scan just migrated is already current. */
  cfg: Config
  /** `registry.active()`. A resume loads onto the active engine, never `lastLoaded.engineId`. */
  engine: Engine | undefined
  /** `comfy.isBlocked()` */
  comfyBlocked: boolean
  findModel: (key: string) => ModelEntry | undefined
}

export function planAutoLoad(input: AutoLoadPlanInput): AutoLoadPlan {
  const { cfg, engine } = input
  if (!cfg.autoLoadOnStart) return { kind: 'disabled' }
  if (input.comfyBlocked) return skipBecause({ code: 'comfyui-busy' })
  if (!engine) return skipBecause({ code: 'no-active-engine' })
  if (isPointedAtLinkedModel(cfg)) {
    return skipBecause({ code: 'remote-model-selected', selectedModel: cfg.selectedRemoteModel })
  }
  return planLocalResume({ cfg, engine, findModel: input.findModel })
}

export function skipLine(reason: AutoLoadSkipReason): string {
  return `auto-load skipped: ${whyNothingLoads(reason)}`
}

export function fallbackLine(reason: AutoLoadSkipReason, devModel: DevModel): string {
  if (!('modelKey' in reason)) {
    throw new Error(`auto-load: skip reason "${reason.code}" names no last model to fall back from`)
  }
  const bypassed = `last model "${reason.modelKey}" ${whyLastModelWasBypassed(reason)}`
  return `auto-load: ${bypassed}; loading legacy devModel "${devModel.label}" instead`
}

interface LocalResumeInput {
  cfg: Config
  engine: Engine
  findModel: AutoLoadPlanInput['findModel']
}

type LastModelResolution =
  | { kind: 'none-recorded' }
  | { kind: 'loadable'; entry: ModelEntry }
  | { kind: 'unresolved'; reason: AutoLoadSkipReason }

type LastModelSkipReason = Extract<AutoLoadSkipReason, { modelKey: string }>

const NOT_IN_LIBRARY = 'is not in the model library'
const NOT_LOADABLE = 'is incomplete or unreadable'

function skipBecause(reason: AutoLoadSkipReason): AutoLoadPlan {
  return { kind: 'skip', reason }
}

function isPointedAtLinkedModel(cfg: Config): boolean {
  // link/gate.ts is the one greppable Turbo Link gate (ADR-376, exit path ADR-280);
  // isTurboLinkEnabledIn reads the already-taken post-scan snapshot directly — a pure planner
  // has no live Deps graph to hand it, and should not have to fabricate one.
  return isTurboLinkEnabledIn(cfg) && Boolean(cfg.selectedRemoteModel)
}

function planLocalResume(input: LocalResumeInput): AutoLoadPlan {
  const { cfg, engine } = input
  const lastModel = resolveLastModel(input)
  if (lastModel.kind === 'loadable') return { kind: 'load-model', entry: lastModel.entry, engine }
  if (cfg.devModel) return loadDevModel(cfg.devModel, engine, lastModel)
  if (lastModel.kind === 'unresolved') return skipBecause(lastModel.reason)
  return skipBecause({ code: 'nothing-to-load' })
}

function loadDevModel(devModel: DevModel, engine: Engine, lastModel: LastModelResolution): AutoLoadPlan {
  if (lastModel.kind !== 'unresolved') return { kind: 'load-dev-model', devModel, engine }
  return { kind: 'load-dev-model', devModel, engine, fallbackFrom: lastModel.reason }
}

function resolveLastModel({ cfg, engine, findModel }: LocalResumeInput): LastModelResolution {
  const modelKey = cfg.lastLoaded.modelKey
  if (!modelKey) return { kind: 'none-recorded' }
  const entry = findModel(modelKey)
  if (!entry) return unresolved({ code: 'model-not-in-library', modelKey })
  if (entry.incomplete || entry.parseError) return unresolved({ code: 'model-not-loadable', modelKey })
  const detail = incompatibilityDetail(engine, entry)
  if (detail) {
    const { name: engineName, kind: engineKind } = engine
    return unresolved({ code: 'engine-incompatible', modelKey, engineName, engineKind, detail })
  }
  return { kind: 'loadable', entry }
}

function unresolved(reason: AutoLoadSkipReason): LastModelResolution {
  return { kind: 'unresolved', reason }
}

/** Why `engine` can't load `entry`, or '' when it can. */
function incompatibilityDetail(engine: Engine, entry: ModelEntry): string {
  if (!engineAcceptsFormat(engine.kind, entry.format)) return `format ${entry.format}`
  if (entry.audio && engineRejectsAudioModel(engine.kind)) return 'audio tower not supported'
  return ''
}

function whyNothingLoads(reason: AutoLoadSkipReason): string {
  switch (reason.code) {
    case 'comfyui-busy':
      return 'ComfyUI is rendering and holds the GPU; load a model manually once its queue finishes'
    case 'no-active-engine':
      return 'no active engine; set one up in Engines'
    case 'nothing-to-load':
      return 'no last-loaded model recorded yet'
    case 'remote-model-selected':
      return `this install is pointed at linked model "${reason.selectedModel}"; `
        + 'pick a model on this machine in the model picker to clear that selection'
    case 'model-not-in-library':
      return `last model "${reason.modelKey}" ${NOT_IN_LIBRARY}`
    case 'model-not-loadable':
      return `last model "${reason.modelKey}" ${NOT_LOADABLE}`
    case 'engine-incompatible':
      return `engine "${reason.engineName}" (${reason.engineKind}) can't load last model "${reason.modelKey}" `
        + `(${reason.detail})`
  }
}

function whyLastModelWasBypassed(reason: LastModelSkipReason): string {
  switch (reason.code) {
    case 'model-not-in-library':
      return NOT_IN_LIBRARY
    case 'model-not-loadable':
      return NOT_LOADABLE
    case 'engine-incompatible':
      return `can't be loaded by engine "${reason.engineName}"`
  }
}

type LastModelResume = Extract<AutoLoadPlan, { kind: 'load-model' }>
type DevModelResume = Extract<AutoLoadPlan, { kind: 'load-dev-model' }>

async function carryOut(plan: AutoLoadPlan, cfg: Config, deps: AutoLoadDeps): Promise<void> {
  switch (plan.kind) {
    case 'disabled':
      return
    case 'skip':
      return deps.log(skipLine(plan.reason))
    case 'load-model':
      return resumeLastModel(plan, cfg, deps)
    case 'load-dev-model':
      return resumeDevModel(plan, deps)
  }
}

async function resumeLastModel({ entry, engine }: LastModelResume, cfg: Config, deps: AutoLoadDeps): Promise<void> {
  if (entry.embedding) return resumeEmbeddingModel(entry, deps)
  const opts = buildStartOpts({ entry, engine, cfg, sys: deps.sysInfo(), trigger: 'resume' })
  await loadPrimaryModel(opts, deps)
}

/** An embedding model takes its own pool slot through the router, exactly like a manual Load (ADR-389). */
async function resumeEmbeddingModel(entry: ModelEntry, deps: AutoLoadDeps): Promise<void> {
  const result = await deps.modelRouter.loadExplicit(entry.key)
  if ('status' in result) deps.warn(`auto-load failed: ${result.message}`)
}

async function resumeDevModel({ devModel, engine, fallbackFrom }: DevModelResume, deps: AutoLoadDeps): Promise<void> {
  if (fallbackFrom) deps.log(fallbackLine(fallbackFrom, devModel))
  await loadPrimaryModel(devModelStartOpts(devModel, engine), deps)
}

function devModelStartOpts(devModel: DevModel, engine: Engine): StartOpts {
  return {
    engine,
    model: { key: devModel.modelPath, name: devModel.label, quant: '', ctx: 0, vision: false },
    modelPath: devModel.modelPath,
    extraArgs: devModel.extraArgs,
    trigger: 'resume',
  }
}

/** The manual Load's chokepoint: the router's swap lock (ADR-285) around Manager.load, which runs the
 *  ComfyUI reverse gate through beforeStart (ADR-067). */
async function loadPrimaryModel(opts: StartOpts, { manager, comfy, modelRouter }: AutoLoadDeps): Promise<void> {
  await modelRouter.withSwapLock(() => manager.load(opts, { beforeStart: () => comfy.freeComfyUIBeforeLoad() }))
  modelRouter.markPrimaryLoaded()
}

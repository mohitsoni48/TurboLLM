// Install an engine from a GitHub release asset (ADR-453). A release install is a flat,
// probed directory under engines/build/<slug>, carrying a provenance marker that is written
// last (ADR-175: the marker means "this flow completed this dir"). That marker, not config,
// is the source of truth for update matching.
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { asDirName } from './build-runner'
import { driverMaxCuda } from './nvidia-smi'
import { downloadFile, extractArchive, stripMacOsQuarantine, type ProvisionProgress, type ReleaseAsset } from './download'
import { probe, ProbeError, type ProbeResult } from './probe'
import {
  assetKey,
  classifyReleaseAsset,
  companionsFor,
  releaseByTag,
  type ClassifiedAsset,
  type HostProfile,
} from './release-assets'
import { suggestEngineName } from './scan'
import {
  MAX_ZIP_BYTES,
  missingCudartWarning,
  pickInstallFiles,
  promoteProbedInstall,
  RELEASE_INSTALL_MARKER,
  SwapBlockedError,
  walkArchiveMembers,
  ZipError,
  type ArchiveMember,
  type InstallSelection,
  type ZipInstallWarning,
} from './zip-install'
import { amdApuOnly, getSysInfo, primaryVendor } from '../sysinfo/sysinfo'

export { RELEASE_INSTALL_MARKER }

export interface ReleaseProvenance {
  repo: string
  tag: string
  asset: string
  assetKey: string
  publishedAt: string
  prerelease: boolean
  companions: string[]
}

const ARCHIVE_EXTENSION = /\.(tar\.gz|tgz|zip)$/i

export function releaseInstallDirName(p: Pick<ReleaseProvenance, 'repo' | 'assetKey'>): string {
  const variant = p.assetKey.replace(ARCHIVE_EXTENSION, '')
  return asDirName(`${p.repo.replace('/', '-')}-${variant}`, 'release-build')
}

export function writeReleaseMarker(dir: string, provenance: ReleaseProvenance): void {
  writeFileSync(join(dir, RELEASE_INSTALL_MARKER), JSON.stringify(provenance))
}

/** The only reader of the marker. Anything unreadable or incomplete is "not a release install". */
export function readReleaseMarker(dir: string | null): ReleaseProvenance | null {
  if (!dir) return null
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RELEASE_INSTALL_MARKER), 'utf8'))
    const complete = ['repo', 'tag', 'assetKey'].every((k) => typeof parsed?.[k] === 'string' && parsed[k])
    return complete ? (parsed as ReleaseProvenance) : null
  } catch {
    return null
  }
}

let cachedDriverMaxCuda: Promise<string | null> | null = null

export async function currentHostProfile(): Promise<HostProfile> {
  const info = getSysInfo()
  const gpuVendor = primaryVendor(info)
  cachedDriverMaxCuda ??= gpuVendor === 'nvidia' ? driverMaxCuda() : Promise.resolve(null)
  return {
    platform: process.platform,
    arch: process.arch,
    gpuVendor,
    hasGpu: info.gpus.length > 0,
    amdApuOnly: amdApuOnly(info),
    driverMaxCuda: await cachedDriverMaxCuda,
  }
}

export interface ReleaseInstallPlan {
  repo: string
  tag: string
  asset: string
}

export type ReleaseInstallResult =
  | { found: false }
  | {
      found: true
      binPath: string
      version: string
      capabilities: ProbeResult['capabilities']
      suggestedName: string
      warning?: ZipInstallWarning
      provenance: ReleaseProvenance
    }

export interface ReleaseInstallOptions {
  probeFn?: (bin: string) => Promise<ProbeResult>
  blockSwap?: () => string | null
  onProgress?: (p: ProvisionProgress) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** Install into this dir name instead of the one derived from the asset (an update keeps its dir). */
  slug?: string
}

export class ReleaseInstallError extends Error {
  constructor(
    readonly code: 'invalid_asset',
    message: string,
  ) {
    super(message)
    this.name = 'ReleaseInstallError'
  }
}

interface AssetParts {
  main: ClassifiedAsset
  companions: ClassifiedAsset[]
}

/** Headless install core: download the chosen asset (and its CUDA runtime), assemble a flat
 *  install, probe it, swap it in. A failure at any step leaves the prior install untouched. */
export async function installReleaseAsset(
  enginesRoot: string,
  plan: ReleaseInstallPlan,
  opts: ReleaseInstallOptions = {},
): Promise<ReleaseInstallResult> {
  const release = await releaseByTag(plan.repo, plan.tag, opts.signal, opts.fetchImpl)
  const parts = chooseParts(release.assets, plan.asset)
  const key = assetKey(parts.main.name, plan.tag)
  const slug = opts.slug ?? releaseInstallDirName({ repo: plan.repo, assetKey: key })
  const workDirs = workDirsFor(enginesRoot, slug)
  try {
    await downloadAndExtractParts(parts, workDirs, opts)
    const selection = pickInstallFiles(walkArchiveMembers(workDirs.raw))
    if (!selection) return { found: false }
    const provenance: ReleaseProvenance = {
      repo: plan.repo,
      tag: plan.tag,
      asset: parts.main.name,
      assetKey: key,
      publishedAt: release.publishedAt,
      prerelease: release.prerelease,
      companions: parts.companions.map((c) => c.name),
    }
    const binFileName = copySelectionFlat(workDirs.raw, selection, workDirs.tmp)
    throwIfCancelled(opts.signal)
    writeReleaseMarker(workDirs.tmp, provenance)
    const { finalBin, probe: probed } = await promoteProbedInstall({
      enginesRoot,
      slug,
      tmpDir: workDirs.tmp,
      binFileName,
      probeFn: opts.probeFn ?? probe,
      blockSwap: () => {
        throwIfCancelled(opts.signal)
        return opts.blockSwap?.() ?? null
      },
    })
    const warning = missingCudartWarning([...selection.files.keys()])
    return {
      found: true,
      binPath: finalBin,
      version: probed.version,
      capabilities: probed.capabilities,
      suggestedName: suggestEngineName(finalBin, probed.version),
      ...(warning ? { warning } : {}),
      provenance,
    }
  } finally {
    rmSync(workDirs.stage, { recursive: true, force: true })
    rmSync(workDirs.tmp, { recursive: true, force: true }) // no-op once renamed into place
  }
}

function chooseParts(assets: ReleaseAsset[], assetName: string): AssetParts {
  const classified = assets.map(classifyReleaseAsset)
  const main = classified.find((a) => a.name === assetName)
  if (!main) throw new ReleaseInstallError('invalid_asset', `The release has no asset named ${assetName}.`)
  if (main.companion !== null || main.archive === null) {
    throw new ReleaseInstallError('invalid_asset', `${assetName} is not an installable engine archive.`)
  }
  const parts = { main, companions: companionsFor(main, classified) }
  for (const part of [parts.main, ...parts.companions]) rejectOversize(part)
  return parts
}

function rejectOversize(asset: ClassifiedAsset): void {
  if (asset.size !== null && asset.size > MAX_ZIP_BYTES) throw tooLarge(asset.name)
}

function tooLarge(name: string): ZipError {
  return new ZipError('zip_too_large', `${name} is larger than the ${MAX_ZIP_BYTES / (1024 * 1024 * 1024)} GiB cap.`)
}

interface WorkDirs {
  stage: string
  raw: string
  tmp: string
}

function workDirsFor(enginesRoot: string, slug: string): WorkDirs {
  const unique = randomUUID().slice(0, 8)
  const stage = join(enginesRoot, 'build', `.${slug}-${unique}.stage`)
  return { stage, raw: join(stage, 'raw'), tmp: join(enginesRoot, 'build', `.${slug}-${unique}.tmp`) }
}

async function downloadAndExtractParts(parts: AssetParts, dirs: WorkDirs, opts: ReleaseInstallOptions): Promise<void> {
  mkdirSync(dirs.raw, { recursive: true })
  const all = [parts.main, ...parts.companions]
  for (const [index, asset] of all.entries()) {
    const position = { part: index + 1, parts: all.length }
    const report = (p: ProvisionProgress) => opts.onProgress?.({ ...p, ...position })
    const archive = join(dirs.stage, asset.name)
    report({ phase: 'downloading', pct: 0 })
    await downloadFile(asset.url, archive, report, opts.signal, refusingOversizeBodies(opts.fetchImpl ?? fetch))
    report({ phase: 'extracting', pct: -1 })
    await extractArchive(archive, dirs.raw)
    rmSync(archive, { force: true })
    throwIfCancelled(opts.signal)
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The install was cancelled.', 'AbortError')
}

function refusingOversizeBodies(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_ZIP_BYTES) {
      await response.body?.cancel()
      throw tooLarge(basename(String(input)))
    }
    return response
  }
}

function copySelectionFlat(rawDir: string, selection: InstallSelection<ArchiveMember>, destDir: string): string {
  mkdirSync(destDir, { recursive: true })
  for (const member of selection.files.values()) {
    copyFileSync(join(rawDir, member.name), join(destDir, basename(member.name)))
  }
  const binFileName = basename(selection.binary.name)
  if (process.platform !== 'win32') chmodSync(join(destDir, binFileName), 0o755)
  stripMacOsQuarantine(destDir)
  return binFileName
}

export interface ReleaseJobView {
  state: 'idle' | 'running' | 'ready' | 'updated' | 'error'
  plan?: ReleaseInstallPlan
  result?: ReleaseInstallResult
  updated?: { id: string; name: string }
  error?: { code: string; message: string }
}

export type ReleaseJobOutcome =
  | { kind: 'ready'; result: ReleaseInstallResult }
  | { kind: 'updated'; updated: { id: string; name: string }; result: ReleaseInstallResult }

/** The single slot behind the release-install HTTP flow. It only remembers; the route owns
 *  every side effect (registry, provisioning, cleanup). A run that was cleared or replaced
 *  while in flight can no longer write its outcome. */
export class ReleaseInstallJob {
  private view: ReleaseJobView = { state: 'idle' }
  private generation = 0

  get(): ReleaseJobView {
    return this.view
  }

  start(plan: ReleaseInstallPlan, run: () => Promise<ReleaseJobOutcome>): void {
    const mine = ++this.generation
    this.view = { state: 'running', plan }
    const settleIfCurrent = (next: ReleaseJobView) => {
      if (mine === this.generation) this.view = next
    }
    run().then(
      (outcome) => settleIfCurrent(viewOf(outcome, plan)),
      (e: unknown) => settleIfCurrent({ state: 'error', plan, error: describeReleaseJobFailure(e) }),
    )
  }

  clear(): void {
    this.generation++
    this.view = { state: 'idle' }
  }
}

function viewOf(outcome: ReleaseJobOutcome, plan: ReleaseInstallPlan): ReleaseJobView {
  if (outcome.kind === 'updated') return { state: 'updated', plan, result: outcome.result, updated: outcome.updated }
  return { state: 'ready', plan, result: outcome.result }
}

const PASS_THROUGH_CODES: ReadonlySet<string> = new Set([
  'no_server_binary',
  'download_failed',
  'unsupported_archive',
  'extract_failed',
  'engine_in_use',
  'invalid_asset',
])

/** Name a release-install failure with the closed job vocabulary. Anything it does not
 *  recognise (including errno codes such as EPERM) is `internal`. */
export function describeReleaseJobFailure(e: unknown): { code: string; message: string } {
  const message = e instanceof Error ? e.message : String(e)
  return { code: jobErrorCode(e), message }
}

function jobErrorCode(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') return 'cancelled'
  if (e instanceof SwapBlockedError) return 'engine_in_use'
  if (e instanceof ProbeError) return e.code.startsWith('probe_') ? e.code : 'probe_failed'
  if (e instanceof ZipError) return e.code === 'zip_too_large' ? 'zip_too_large' : 'bad_zip'
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && PASS_THROUGH_CODES.has(code) ? code : 'internal'
}

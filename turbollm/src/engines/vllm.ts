// vLLM engine provisioning (ADR-044). vLLM is a Python production inference
// server with an OpenAI-compatible API — a *third engine kind* alongside
// llama.cpp and MLX. Like MLX it is not a single binary: we reuse the uv
// bootstrap (`ensureUv`, shared with mlx.ts), create an isolated venv, install
// `vllm`, and run its OpenAI server. No system Python is touched.
//
// Platform reality: vLLM officially targets Linux + NVIDIA/CUDA. macOS is CPU-
// only experimental; Windows is unsupported upstream. We do NOT hard-block any
// platform (ADR-044) — the catalog surfaces support level and the install simply
// attempts `uv pip install vllm`, which fails loudly on an unsupported platform.
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { hostname, machine, release, version as kernelBuild } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import { UvloopPreflight } from './py-engine-blocker'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

// Python line vLLM supports. uv fetches a matching interpreter if absent, so the
// user needs no system Python. Bump deliberately as vLLM's support window moves.
const VLLM_PYTHON = '3.12'

export interface VllmRuntime {
  /** venv python interpreter path */
  python: string
  /** vllm version string, from probe */
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated vLLM runtime: uv → venv (pinned python) → `uv pip
 * install vllm`. The install pulls torch + CUDA wheels and is multi-GB, so the
 * caller should surface indeterminate progress. Returns the venv python + version.
 * When `upgrade` is true, passes `-U` to force an upgrade to the latest release.
 */
export async function ensureVllmEnv(root: string, onProgress?: (p: ProvisionProgress) => void, upgrade = false): Promise<VllmRuntime> {
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'vllm', 'venv')
  const py = venvPython(envDir)

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    // --python <ver> tells uv to fetch + use that interpreter line if the venv
    // doesn't exist yet; uv downloads a standalone build when none is installed.
    await execFileP(uv, ['venv', '--python', VLLM_PYTHON, envDir], { cwd: root })
  }
  // Install (or no-op if already satisfied) vllm into the venv. Large download;
  // generous buffer + no timeout (pip resolves + compiles for minutes).
  // `-U` forces an upgrade to the latest release when requested.
  onProgress?.({ phase: 'extracting', pct: -1 })
  const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['-U'] : []), 'vllm']
  await execFileP(uv, installArgs, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })

  const version = await probeVllm(py)
  return { python: py, version }
}

const uvloopPreflight = new UvloopPreflight('vLLM')

/**
 * Turn a failed `import uvloop` probe into an actionable message (ADR-080). uvloop ships
 * manylinux *and* macOS wheels, so only Windows (unsupported upstream) is framed as a platform
 * that cannot run vLLM; on Linux and macOS a failed import is a fixable local install instead.
 */
export function classifyVllmBlocker(platform: NodeJS.Platform, error: unknown): string {
  return uvloopPreflight.classify(platform, error)
}

/**
 * Preflight (ADR-080): can vLLM's OpenAI server actually run on this machine? Its entrypoint
 * hard-imports `uvloop` plus other deps (NCCL, Triton, CUDA-graph capture), so a broken
 * environment crashes on import before loading anything. Returns a clear, actionable message
 * when vLLM can't serve here, or null when it can. Fast (~1s), run once per load before spawn.
 */
export function vllmServeBlocker(python: string): Promise<string | null> {
  return uvloopPreflight.blockerFor(python)
}

/** Read the installed vllm version (also a smoke test that it imports). */
export async function probeVllm(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import importlib.metadata as m; print(m.version("vllm"))'],
    { timeout: 30_000 },
  )
  return `vllm ${stdout.trim()}`
}

/**
 * Command + args to launch the vLLM OpenAI-compatible server for a model.
 * `model` is an HF repo id (e.g. "meta-llama/Llama-3.1-8B-Instruct") or a local
 * model directory — vLLM resolves both. We invoke the stable module entrypoint
 * (`vllm.entrypoints.openai.api_server`) rather than the `vllm` console script so
 * the launch path doesn't depend on the venv bin being on PATH.
 *
 * `tensorParallelSize` (ADR-054) shards the model across N GPUs via vLLM's
 * `--tensor-parallel-size`. 1 (or undefined) is vLLM's single-GPU default and emits
 * no flag, so existing single-GPU launches are unchanged.
 *
 * `extraArgs` (F-027) carries the model's vLLM load controls (max-model-len,
 * gpu-memory-utilization, dtype, …) built by the caller via `vllmProfileToArgs`,
 * mirroring how llama.cpp and MLX pass their flags through `extraArgs`.
 */
export function vllmServerCommand(
  python: string,
  model: string,
  port: number,
  host: string,
  tensorParallelSize = 1,
  extraArgs: string[] = [],
): { cmd: string; args: string[] } {
  const args = [
    '-m', 'vllm.entrypoints.openai.api_server',
    '--model', model,
    // Serve under a fixed alias so requests can address the model by a stable name
    // (TurboLLM's internal key is a display string with spaces). Mirrors mlx-lm's
    // built-in `default_model` alias; see engineModelAlias() in compat.ts.
    '--served-model-name', 'default_model',
    '--host', host,
    '--port', String(port),
  ]
  if (tensorParallelSize > 1) args.push('--tensor-parallel-size', String(tensorParallelSize))
  args.push(...extraArgs)
  return { cmd: python, args }
}

/**
 * Environment that picks vLLM's model runner for this host (ADR-435). vLLM 0.29 made Model
 * Runner V2 the default; it keeps request state in a UVA buffer, which needs pinned host memory,
 * and vLLM turns pinned memory off under WSL. There V2 dies at engine-core init with "UVA is not
 * available" before any model code runs, whatever the model. The V1 runner still ships and works
 * on WSL, so WSL gets it, unless the user already chose a runner on the daemon's environment.
 * A blank value is not a choice: vLLM parses it with `int()` and would crash on it.
 */
export function vllmModelRunnerEnv(daemonEnv: NodeJS.ProcessEnv, uname: string): Record<string, string> {
  const userChoseRunner = (daemonEnv.VLLM_USE_V2_MODEL_RUNNER ?? '').trim() !== ''
  if (userChoseRunner || !isWsl(daemonEnv, uname)) return {}
  return { VLLM_USE_V2_MODEL_RUNNER: '0' }
}

/** WSL_DISTRO_NAME is set for processes started through wsl.exe but not under systemd or in a
 *  container; the uname catches those too (WSL2's kernel release says "microsoft"). */
function isWsl(daemonEnv: NodeJS.ProcessEnv, uname: string): boolean {
  return Boolean(daemonEnv.WSL_DISTRO_NAME) || /microsoft/i.test(uname)
}

/** The `platform.uname()` fields vLLM's `in_wsl()` searches for "microsoft" (its fifth, the system
 *  name, is always "Linux" here), so TurboLLM predicts vLLM's own WSL verdict. '' off Linux. */
export function hostUname(): string {
  if (process.platform !== 'linux') return ''
  return [hostname(), release(), kernelBuild(), machine()].join(' ')
}

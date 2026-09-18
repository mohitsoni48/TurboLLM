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
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
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

function platformDisplay(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform
}

/**
 * Turn a failed `import uvloop` probe into an actionable message. uvloop ships real
 * manylinux wheels, so a failure on Linux is never "this platform has no build" — Linux is
 * uvloop's primary target. Only Windows (unsupported upstream) and macOS (CPU-only
 * experimental, per the module doc comment above) get the "unsupported platform" framing;
 * everywhere else — including a missing interpreter (ENOENT) from a stale/broken venv —
 * surfaces what actually failed instead of misdiagnosing a fixable local install as a
 * platform limitation.
 */
export function classifyVllmBlocker(platform: NodeJS.Platform, error: unknown): string {
  const plat = platformDisplay(platform)
  if (platform === 'win32' || platform === 'darwin') {
    return (
      `vLLM cannot run on ${plat}: its OpenAI server requires uvloop (and other Linux-only ` +
      `components such as NCCL/Triton), which have no ${plat} build. Use the llama.cpp / TurboQuant ` +
      `engine for GGUF models here, or run vLLM under WSL2 / Linux.`
    )
  }
  const err = error as (NodeJS.ErrnoException & { stderr?: string | Buffer }) | undefined
  if (err?.code === 'ENOENT') {
    return (
      `vLLM's environment looks missing or broken (interpreter not found). ` +
      `Reinstall the vLLM engine from the Engines page.`
    )
  }
  const raw = err?.stderr ? String(err.stderr) : (err?.message ?? 'unknown error')
  const detail = raw.trim().split('\n').filter(Boolean).slice(-1)[0] ?? raw.trim()
  return (
    `vLLM's environment looks broken or incomplete (uvloop failed to import: ${detail}). ` +
    `${plat} is a supported platform for vLLM — reinstall the vLLM engine from the Engines ` +
    `page rather than switching engines.`
  )
}

/**
 * Preflight (ADR-080): can vLLM's OpenAI server actually run on this machine? Its entrypoint
 * hard-imports `uvloop` plus other deps (NCCL, Triton, CUDA-graph capture), so a broken
 * environment crashes on import before loading anything. We probe the *concrete* blocker — can
 * the venv import uvloop — rather than assuming a platform can't work at all, then classify the
 * result via {@link classifyVllmBlocker}. Returns a clear, actionable message when vLLM can't
 * serve here, or null when it can. Fast (~1s) and run once per load, before spawn.
 */
export async function vllmServeBlocker(python: string): Promise<string | null> {
  try {
    await execFileP(python, ['-c', 'import uvloop'], { timeout: 20_000 })
    return null
  } catch (error) {
    return classifyVllmBlocker(process.platform, error)
  }
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

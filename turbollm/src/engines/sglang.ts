// SGLang engine provisioning (ADR-120). SGLang is a high-throughput Python
// inference server with an OpenAI-compatible API — a fourth Python engine kind
// alongside MLX and vLLM. Like vLLM it is not a single binary: we reuse the uv
// bootstrap (ensureUv, shared with mlx.ts/vllm.ts), create an isolated venv,
// install `sglang[all]`, and run its OpenAI server. No system Python is touched.
//
// Platform reality: SGLang officially targets Linux + NVIDIA/CUDA 12+. macOS and
// Windows are unsupported upstream. Same uvloop preflight as vLLM — literally the
// same classifier, which treats only Windows as a hard platform block.
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import { UvloopPreflight } from './py-engine-blocker'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

const SGLANG_PYTHON = '3.12'

export interface SglangRuntime {
  python: string
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated SGLang runtime: uv → venv (pinned python) → `uv pip
 * install sglang[all]`. The install pulls torch + CUDA wheels and is multi-GB.
 * Returns the venv python + version. When `upgrade` is true, passes `-U`.
 */
export async function ensureSglangEnv(root: string, onProgress?: (p: ProvisionProgress) => void, upgrade = false): Promise<SglangRuntime> {
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'sglang', 'venv')
  const py = venvPython(envDir)

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    await execFileP(uv, ['venv', '--python', SGLANG_PYTHON, envDir], { cwd: root })
  }
  onProgress?.({ phase: 'extracting', pct: -1 })
  const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['-U'] : []), 'sglang[all]']
  await execFileP(uv, installArgs, { cwd: root, maxBuffer: 64 * 1024 * 1024 })

  const version = await probeSglang(py)
  return { python: py, version }
}

const uvloopPreflight = new UvloopPreflight('SGLang')

/**
 * Turn a failed `import uvloop` probe into an actionable message — the same classifier vLLM
 * uses (ADR-080), only the engine name differs. uvloop ships manylinux *and* macOS wheels, so
 * only Windows is framed as a platform that cannot run SGLang.
 */
export function classifySglangBlocker(platform: NodeJS.Platform, error: unknown): string {
  return uvloopPreflight.classify(platform, error)
}

/**
 * Preflight: can SGLang's server actually run here? Like vLLM it hard-requires
 * uvloop. Returns a clear, actionable message when blocked, or null when OK.
 */
export function sgLangServeBlocker(python: string): Promise<string | null> {
  return uvloopPreflight.blockerFor(python)
}

/** Read the installed sglang version (also a smoke test that it imports). */
export async function probeSglang(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import importlib.metadata as m; print(m.version("sglang"))'],
    { timeout: 30_000 },
  )
  return `sglang ${stdout.trim()}`
}

/**
 * Command + args to launch the SGLang OpenAI-compatible server for a model.
 * `model` is an HF repo id or a local safetensors dir. We invoke the stable
 * module entrypoint (`sglang.launch_server`).
 *
 * Supported extraArgs (via SglangProfile):
 *   --context-length  (≡ vLLM's --max-model-len)
 *   --mem-fraction-static  (≡ vLLM's --gpu-memory-utilization)
 *   --tp  (tensor parallel)
 *   --served-model-name  (overridden by default_model alias)
 *   --api-key
 *   --disable-flashinfer  (fallback when FlashInfer install fails)
 */
export function sglangServerCommand(
  python: string,
  model: string,
  port: number,
  host: string,
  extraArgs: string[] = [],
): { cmd: string; args: string[] } {
  const args = [
    '-m', 'sglang.launch_server',
    '--model-path', model,
    '--served-model-name', 'default_model',
    '--host', host,
    '--port', String(port),
  ]
  args.push(...extraArgs)
  return { cmd: python, args }
}

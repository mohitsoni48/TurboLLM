// MLX-VLM engine provisioning. A third MLX-based engine for Apple Silicon
// (github.com/Blaizzy/mlx-vlm, PyPI package "mlx-vlm") — vision-language models
// (Qwen-VL, Gemma vision variants, LLaVA, SmolVLM, and others) on top of MLX/Metal.
// Like MLX and Rapid-MLX, it is not a single binary: we bootstrap `uv` into the
// app-data dir, create an isolated venv, install `mlx-vlm`, and run its
// OpenAI-compatible server (`mlx_vlm.server`, a console-script/`-m` entry point).
//
// Runtime is macOS-only (mlx-vlm depends on mlx/mlx-lm, which need Apple Metal).
//
// KNOWN LIMITATION (live-verified, not in mlx-vlm's own declared dependencies):
// loading at least the Idefics3/SmolVLM and Qwen2-VL model families requires
// `torch`/`torchvision` to be importable — transformers' image-processor auto-loader
// falls back to lazy-module placeholder classes without it and load fails with
// "Could not load any image processor class ... Missing optional dependencies:
// torchvision." Confirmed NOT universal: Gemma3-vision and LLaVA families load fine
// without torch/torchvision. We deliberately do NOT install torch/torchvision here —
// it's a large (multi-hundred-MB+) dependency that most mlx-vlm model families don't
// need, and bundling it unconditionally would bloat every install for a subset of
// architectures. If a user hits this error, the fix is a one-off
// `uv pip install --python <this venv>/bin/python torch torchvision` into the venv
// at `<root>/mlx-vlm/venv`.
import { existsSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

export interface MlxVlmRuntime {
  /** venv python interpreter path */
  python: string
  /** mlx-vlm version string, from probe */
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32' ? join(envDir, 'Scripts', 'python.exe') : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated MLX-VLM runtime: uv → venv → `uv pip install mlx-vlm`.
 * macOS-only (mlx-vlm requires Apple Metal via mlx/mlx-lm). Returns the venv python +
 * version. When `upgrade` is true, passes `--upgrade` to force the latest release.
 */
export async function ensureMlxVlmEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
): Promise<MlxVlmRuntime> {
  if (process.platform !== 'darwin') {
    throw new Error('MLX-VLM requires macOS (Apple Silicon).')
  }
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'mlx-vlm', 'venv')
  const py = venvPython(envDir)

  // Mirrors ensureMlxEnv/ensureRapidMlxEnv: wipe an incompatible venv Python (e.g. 3.14,
  // or x86_64 from Rosetta — neither has mlx wheels) so it gets recreated with the pinned
  // interpreter below.
  if (existsSync(py)) {
    let compatible = false
    try {
      const { stdout } = await execFileP(py, ['--version'], { timeout: 5_000 })
      const m = stdout.match(/Python 3\.(\d+)/)
      if (m) {
        const minor = Number(m[1])
        compatible = minor >= 10 && minor <= 13
      }
    } catch { /* treat as incompatible — will recreate */ }
    if (!compatible) rmSync(envDir, { recursive: true, force: true })
  }

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    const PINNED_PYTHON = 'cpython-3.12-macos-aarch64'
    const venvArgs = ['venv', '--python', PINNED_PYTHON, ...(existsSync(envDir) ? ['--clear'] : []), envDir]
    await execFileP(uv, venvArgs, { cwd: root })
  }

  onProgress?.({ phase: 'extracting', pct: -1 })
  const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['--upgrade'] : []), 'mlx-vlm']
  await execFileP(uv, installArgs, { cwd: root, maxBuffer: 16 * 1024 * 1024 })

  const version = await probeMlxVlm(py)
  return { python: py, version }
}

/** Read the installed mlx-vlm version (also serves as a smoke test that it imports). */
export async function probeMlxVlm(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import mlx_vlm, importlib.metadata as m; print(m.version("mlx-vlm"))'],
    { timeout: 20_000 },
  )
  return `mlx-vlm ${stdout.trim()}`
}

/**
 * Command + args to launch the MLX-VLM OpenAI-compatible server for a model.
 * `model` is a local MLX-VLM model directory (mirrors mlxServerCommand's/
 * rapidMlxServerCommand's contract — the same on-disk format the existing MLX
 * engine loads).
 *
 * Passed as `--model`, which mlx_vlm.server treats as a *preload* hint only (it sets
 * MLX_VLM_PRELOAD_MODEL) — NOT a fixed serving alias. This preload runs synchronously
 * inside the ASGI `lifespan` startup handler (a plain, un-awaited `get_cached_model()`
 * call before the `yield`), which uvicorn blocks on before it starts accepting HTTP
 * connections at all (confirmed live: log order is "Waiting for application startup"
 * → "Language model ready" → "Application startup complete" → "Uvicorn running on
 * ..."; a bad `--model` path makes the whole process exit with "Application startup
 * failed. Exiting." instead of ever binding the port). So unlike the request-time
 * lazy-load path below, a `--model` preload failure can never be observed as a false
 * "ready" — /health only starts answering once the preload has actually succeeded.
 *
 * Unlike mlx-lm/vLLM (fixed `default_model` alias) and Rapid-MLX (fixed `default`
 * alias), mlx-vlm's OpenAI endpoint additionally resolves the request body's `model`
 * field as a real model path/repo id on every request (verified live: it's passed
 * straight to `get_cached_model(model_path, ...)`, cached by `(model_path,
 * adapter_path, model_kind)`). A request naming a path other than the one preloaded
 * loads it lazily inside that request handler — ungated by /health, same
 * unobservable-until-it-fails surface as other request-time load failures (e.g. the
 * LLaVA `patch_size: null` crash). Callers must send the preloaded `model` value in
 * the request body's `model` field to stay on the fast, already-loaded path — see
 * engineModelAlias() in compat.ts, which returns the actual model path for `mlx-vlm`
 * rather than a fixed alias.
 *
 * No sampling-args builder exists (unlike mlx-lm's mlxSamplingArgs): mlx_vlm.server
 * --help exposes no --temp/--top-p/--top-k/--min-p flags — sampling is
 * request-body-only, applied per-request by the chat/gateway layer already.
 */
export function mlxVlmServerCommand(python: string, model: string, port: number, host: string): { cmd: string; args: string[] } {
  return {
    cmd: python,
    args: ['-m', 'mlx_vlm.server', '--model', model, '--host', host, '--port', String(port)],
  }
}

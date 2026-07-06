// Rapid-MLX engine provisioning. A second MLX-based engine for Apple Silicon
// (github.com/raullenchai/Rapid-MLX, PyPI package "rapid-mlx", internal module `vllm_mlx` —
// it's built as a vLLM platform plugin targeting Metal). Like MLX, it is not a single binary:
// we bootstrap `uv` into the app-data dir, create an isolated venv, install `rapid-mlx`, and
// run its OpenAI-compatible server via the venv's installed `rapid-mlx` console script.
//
// Runtime is macOS-only (depends on mlx/mlx-lm, which need Apple Metal). The `<model>`
// argument to `rapid-mlx serve` accepts an HF repo id, one of its own built-in aliases, OR a
// local path — we always pass a local MLX model directory (the same on-disk format the
// existing MLX engine loads), so TurboLLM's own model library drives what's servable rather
// than Rapid-MLX's separate alias/download system.
import { existsSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

export interface RapidMlxRuntime {
  /** venv-installed `rapid-mlx` console-script path */
  bin: string
  /** rapid-mlx version string, from probe */
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32' ? join(envDir, 'Scripts', 'python.exe') : join(envDir, 'bin', 'python')
}

function venvBin(envDir: string, name: string): string {
  return process.platform === 'win32' ? join(envDir, 'Scripts', `${name}.exe`) : join(envDir, 'bin', name)
}

/**
 * Provision an isolated Rapid-MLX runtime: uv → venv → `uv pip install rapid-mlx`.
 * macOS-only (rapid-mlx requires Apple Metal via mlx/mlx-lm). Returns the venv's installed
 * `rapid-mlx` binary + version. When `upgrade` is true, passes `--upgrade` to force the latest.
 */
export async function ensureRapidMlxEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
): Promise<RapidMlxRuntime> {
  if (process.platform !== 'darwin') {
    throw new Error('Rapid-MLX requires macOS (Apple Silicon).')
  }
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'rapid-mlx', 'venv')
  const py = venvPython(envDir)
  const bin = venvBin(envDir, 'rapid-mlx')

  // Mirrors ensureMlxEnv: wipe an incompatible venv Python (e.g. 3.14, or x86_64 from
  // Rosetta — neither has mlx wheels) so it gets recreated with the pinned interpreter below.
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
  const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['--upgrade'] : []), 'rapid-mlx']
  await execFileP(uv, installArgs, { cwd: root, maxBuffer: 16 * 1024 * 1024 })

  const version = await probeRapidMlx(bin)
  return { bin, version }
}

/** Read the installed rapid-mlx version (also serves as a smoke test that it runs).
 *  Unlike mlx-lm's bare version number, `rapid-mlx version` already prints "rapid-mlx X.Y.Z". */
export async function probeRapidMlx(bin: string): Promise<string> {
  const { stdout } = await execFileP(bin, ['version'], { timeout: 20_000 })
  return stdout.trim()
}

/**
 * Command + args to launch the Rapid-MLX OpenAI-compatible server for a model.
 * `model` is a local MLX model directory (mirrors mlxServerCommand's contract).
 * No `--served-model-name`-style flag exists (unlike vLLM) — Rapid-MLX's own convention is
 * to always accept the fixed alias "default" for whatever model is currently serving,
 * regardless of what was passed on the command line — see RAPID_MLX_MODEL_ALIAS in compat.ts.
 */
export function rapidMlxServerCommand(bin: string, model: string, port: number, host: string): { cmd: string; args: string[] } {
  return {
    cmd: bin,
    args: ['serve', model, '--host', host, '--port', String(port)],
  }
}

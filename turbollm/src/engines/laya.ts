// Laya engine provisioning. Laya (huggingface.co/convaiinnovations/laya, Apache-2.0) is a System One
// decision model: a ModernBERT/mmBERT encoder plus a custom decision head, PyTorch only — neither
// llama.cpp nor vLLM can load it. Its own package ships `laya-serve`, which already speaks POST
// /v1/systemone, but that entry point downloads checkpoints from the Hub and binds 0.0.0.0. So, like
// MLX, we bootstrap `uv`, create an isolated venv, install `laya[serve]`, and run a small launcher that
// builds laya's Router over the checkpoints in the TurboLLM model folder and serves laya's own app on
// the host and port we choose. Unlike MLX it runs on every desktop platform: `--torch-backend=auto` has
// uv pick the PyTorch build (CUDA, ROCm or CPU) that matches the machine.
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

/** The launcher calls laya's Router and create_app directly, so it is pinned to the line it was written against. */
export const LAYA_PACKAGE = 'laya[serve]>=0.3.20,<0.4'

/** Python the venv is created with; laya needs >= 3.10, and 3.12 has wheels for every torch build. */
const LAYA_PYTHON = '3.12'

export interface LayaRuntime {
  /** venv python interpreter path */
  python: string
  /** laya version string, from probe */
  version: string
}

/** The launcher, run as `python -c`. argv: model folder, host, port. The folder's root checkpoint is served as
 *  `english` (or `multilingual` when its encoder is mmBERT) and the bundle's `multilingual/` and
 *  `typed-decisions/` subfolders under their own names, so laya's Router never reaches for the Hub. A request the
 *  Router sends to a checkpoint the folder lacks is refused (laya-serve answers a ValueError with 422) rather than
 *  answered by another checkpoint: the English one is confidently wrong on non-English text. */
export const LAYA_LAUNCHER_SOURCE = `import json, os, sys


class MissingCheckpoint:
    def __init__(self, present):
        self.present = present

    def on_route(self, ctx):
        wanted = ctx.decision["model"]
        if wanted not in self.present:
            raise ValueError(
                "this request needs the Laya '%s' checkpoint (%s), which is not in this model folder"
                % (wanted, ctx.decision["reason"]))


def checkpoints(model_dir):
    with open(os.path.join(model_dir, "rl_agent_config.json"), encoding="utf-8") as f:
        encoder = str(json.load(f).get("encoder", "")).lower()
    root = "multilingual" if "mmbert" in encoder else "english"
    found = {root: model_dir}
    for name in ("multilingual", "typed-decisions"):
        sub = os.path.join(model_dir, name)
        if name not in found and os.path.isfile(os.path.join(sub, "rl_agent_config.json")):
            found[name] = sub
    return found


def main():
    model_dir, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
    import uvicorn
    from laya.router import Router
    from laya.serve import create_app
    found = checkpoints(model_dir)
    router = Router(device=os.environ.get("LAYA_DEVICE") or None, hooks=[MissingCheckpoint(found)],
                    default=next(iter(found)))
    router.models.update(found)
    router.preload([name for name in found if name != "typed-decisions"])
    uvicorn.run(create_app(router), host=host, port=port, log_level="info")


main()
`

function venvPython(envDir: string): string {
  return process.platform === 'win32' ? join(envDir, 'Scripts', 'python.exe') : join(envDir, 'bin', 'python')
}

export function layaInstallArgs(python: string, upgrade: boolean): string[] {
  return ['pip', 'install', '--python', python, '--torch-backend=auto', ...(upgrade ? ['--upgrade'] : []), LAYA_PACKAGE]
}

/** Provision an isolated Laya runtime: uv → venv → `uv pip install laya[serve]`. When `upgrade` is true, passes
 *  `--upgrade` to move to the newest release the pin allows. */
export async function ensureLayaEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
): Promise<LayaRuntime> {
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'laya', 'venv')
  const python = venvPython(envDir)
  onProgress?.({ phase: 'extracting', pct: -1 })
  if (!existsSync(python)) {
    const venvArgs = ['venv', '--python', LAYA_PYTHON, ...(existsSync(envDir) ? ['--clear'] : []), envDir]
    await execFileP(uv, venvArgs, { cwd: root })
  }
  await execFileP(uv, layaInstallArgs(python, upgrade), { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  return { python, version: await probeLaya(python) }
}

/** Read the installed laya version (also a smoke test that it imports). */
export async function probeLaya(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import laya.serve, importlib.metadata as m; print(m.version("laya"))'],
    { timeout: 60_000 },
  )
  return `laya ${stdout.trim()}`
}

/** Command + args to serve the Laya checkpoints in `modelDir` over POST /v1/systemone. */
export function layaServerCommand(python: string, modelDir: string, port: number, host: string): { cmd: string; args: string[] } {
  return { cmd: python, args: ['-c', LAYA_LAUNCHER_SOURCE, modelDir, host, String(port)] }
}

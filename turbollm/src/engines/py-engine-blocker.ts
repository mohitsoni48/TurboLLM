import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const DETAIL_LIMIT = 200

type PythonProbeFailure = NodeJS.ErrnoException & { stderr?: string | Buffer }

/**
 * The `import uvloop` preflight shared by the Python inference engines (vLLM, SGLang):
 * both hard-import uvloop at startup, so a venv that cannot import it crashes on launch.
 * `engine` is the engine's display name, the only thing that differs between them.
 */
export class UvloopPreflight {
  constructor(
    private readonly engine: string,
    private readonly homeDirectory: () => string = homedir,
  ) {}

  async blockerFor(python: string): Promise<string | null> {
    try {
      await execFileP(python, ['-c', 'import uvloop'], { timeout: 20_000 })
      return null
    } catch (error) {
      return this.classify(process.platform, error)
    }
  }

  // uvloop publishes manylinux *and* macOS wheels, so only Windows is a real platform wall —
  // anywhere else a failed import is a broken local environment the user can reinstall.
  classify(platform: NodeJS.Platform, error: unknown): string {
    if (platform === 'win32') return this.unsupportedPlatform()
    const failure = error as PythonProbeFailure | undefined
    if (failure?.code === 'ENOENT') return this.missingInterpreter()
    return this.brokenEnvironment(platform, failure)
  }

  private unsupportedPlatform(): string {
    return (
      `${this.engine} cannot run on Windows: its server requires uvloop (and other Linux-only ` +
      `components such as NCCL/Triton), which have no Windows build. Use the llama.cpp / TurboQuant ` +
      `engine for GGUF models here, or run ${this.engine} under WSL2 / Linux.`
    )
  }

  private missingInterpreter(): string {
    return (
      `${this.engine}'s environment looks missing or broken (interpreter not found). ` +
      `Reinstall the ${this.engine} engine from the Engines page.`
    )
  }

  private brokenEnvironment(platform: NodeJS.Platform, failure?: PythonProbeFailure): string {
    return (
      `${this.engine}'s environment looks broken or incomplete ` +
      `(uvloop failed to import: ${failureDetail(failure, this.homeOrEmpty())}). ${this.platformStanding(platform)}`
    )
  }

  // homedir() throws (uv_os_homedir ENOENT) for a uid with no passwd entry and no HOME, e.g. a container.
  private homeOrEmpty(): string {
    try {
      return this.homeDirectory()
    } catch {
      return ''
    }
  }

  // Only what is true is claimed: Linux is where these engines are officially supported, while on
  // macOS the catalog rates them experimental / unsupported upstream, so only uvloop's own support
  // may be asserted there.
  private platformStanding(platform: NodeJS.Platform): string {
    const plat = platformDisplay(platform)
    if (platform === 'linux') {
      return (
        `${plat} is a supported platform for ${this.engine} — reinstall the ${this.engine} engine ` +
        `from the Engines page rather than switching engines.`
      )
    }
    if (platform === 'darwin') {
      return (
        `uvloop itself supports ${plat}, so reinstall the ${this.engine} engine from the Engines page ` +
        `first — though ${plat} is not a first-class platform for ${this.engine} upstream.`
      )
    }
    return (
      `${this.engine} support on ${plat} is unverified — reinstall the ${this.engine} engine from ` +
      `the Engines page; if the import keeps failing, ${this.engine} may have no working build here.`
    )
  }
}

function platformDisplay(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

function failureDetail(failure: PythonProbeFailure | undefined, home: string): string {
  const raw = failure?.stderr ? String(failure.stderr) : (failure?.message ?? '')
  return capped(redactHome(lastMeaningfulLine(raw), home))
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.at(-1) ?? 'unknown error'
}

// Matched without regard to case: a case-insensitive filesystem lets Python print `c:\users\owner`
// for `C:\Users\Owner`, and the account name is exactly what must not end up in a pasted error.
function redactHome(text: string, home: string): string {
  // A bare root ("/" in a container with HOME=/) would rewrite every separator in the message.
  if (home.length < 2) return text
  const spellings = new Set([home, home.split('\\').join('/'), home.split('/').join('\\')])
  const anySpelling = new RegExp([...spellings].map(escapeRegExp).join('|'), 'gi')
  return text.replace(anySpelling, '~')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function capped(detail: string): string {
  return detail.length <= DETAIL_LIMIT ? detail : `${detail.slice(0, DETAIL_LIMIT)}…`
}

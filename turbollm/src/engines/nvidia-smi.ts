// The NVIDIA driver probes that BOTH TurboQuant's variant choice (download.ts) and CUDA
// Toolkit provisioning (cuda-provision.ts) need: the driver's max CUDA version, and each
// GPU's compute capability, read from `nvidia-smi`.
//
// A leaf module on purpose. cuda-provision.ts imports download.ts (downloadFile /
// extractArchive), so hosting these in cuda-provision.ts would close a cycle the moment
// download.ts needed them — the shape import-cycles.test.ts exists to catch.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** PURE: the driver's max CUDA version from `nvidia-smi`'s header, or null. Older drivers
 *  print "CUDA Version: 13.0"; 600-series drivers print "CUDA UMD Version: 13.4". */
export function parseDriverMaxCuda(nvidiaSmiOutput: string): string | null {
  const m = nvidiaSmiOutput.match(/CUDA (?:UMD )?Version:\s*([\d.]+)/i)
  return m ? m[1] : null
}

/** The max CUDA version the installed NVIDIA driver supports, via `nvidia-smi`. Null if
 *  nvidia-smi is absent/unparseable. */
export async function driverMaxCuda(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('nvidia-smi', [], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 })
    return parseDriverMaxCuda(stdout)
  } catch {
    return null
  }
}

/** PURE: compute capabilities from `nvidia-smi --query-gpu=compute_cap --format=csv,noheader`
 *  (one "12.0"-style line per GPU); unparseable lines are skipped. */
export function parseComputeCaps(output: string): number[] {
  return output.split(/\r?\n/).map((l) => Number.parseFloat(l.trim())).filter((n) => Number.isFinite(n))
}

/** Compute capability of every NVIDIA GPU (e.g. [12.0] for an RTX 5090); [] if nvidia-smi is
 *  absent or too old to answer the query. */
export async function nvidiaComputeCaps(): Promise<number[]> {
  try {
    const { stdout } = await execFileP('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader'], {
      timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024,
    })
    return parseComputeCaps(stdout)
  } catch {
    return []
  }
}

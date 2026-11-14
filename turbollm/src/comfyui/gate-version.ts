// The installed ComfyUI gate node's version stamp, for /api/v1/status. The status route is polled every couple of
// seconds, so the file is stat'ed per call and read only when it is not the one last read.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Reads `GATE_VERSION = n` out of the gate node's source; null when it has none. */
function parseGateVersion(source: string): number | null {
  const m = source.match(/^GATE_VERSION\s*=\s*(\d+)/m)
  return m ? Number(m[1]) : null
}

/** `version(gatePath)`: the gate's installed version, or null when there is no path, no file, or no stamp. Cached by
 *  file path + mtime + size, so install, update and uninstall (which change or remove the file) invalidate it with
 *  no hook into those routes. `readSource` is the seam for counting reads in tests. */
export function createGateVersionReader(
  readSource: (file: string) => string = (file) => readFileSync(file, 'utf-8'),
): (gatePath: string) => number | null {
  let last: { key: string; version: number | null } | null = null
  return (gatePath) => {
    if (!gatePath) return null
    const file = join(gatePath, '__init__.py')
    try {
      const { mtimeMs, size } = statSync(file)
      const key = `${file}|${mtimeMs}|${size}`
      if (last?.key !== key) last = { key, version: parseGateVersion(readSource(file)) }
      return last.version
    } catch {
      last = null // file missing or unreadable
      return null
    }
  }
}

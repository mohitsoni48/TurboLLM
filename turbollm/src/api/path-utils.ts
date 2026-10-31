/** Infer a HuggingFace `owner/repo` slug from an on-disk file path.
 *  Accepts both MLX directory paths (2 segments: owner/repo) and GGUF file
 *  paths (3+ segments: owner/repo/file.gguf). Returns null when the path is
 *  outside every known model directory or has insufficient segments. */
export function inferRepoFromPath(filePath: string, modelDirs: readonly string[]): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const fp = norm(filePath)
  const seg = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
  for (const dir of modelDirs) {
    const root = norm(dir)
    if (!fp.toLowerCase().startsWith(root.toLowerCase() + '/')) continue
    const parts = fp.slice(root.length + 1).split('/')
    // Need at least owner/repo (MLX dirs) or owner/repo/file (GGUF files).
    if (parts.length >= 2 && seg.test(parts[0]) && seg.test(parts[1])) {
      return `${parts[0]}/${parts[1]}`
    }
    return null
  }
  return null
}

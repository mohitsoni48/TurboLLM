/** Extract `owner/repo` from a GitHub repo URL (ADR-088), tolerating a `.git` suffix,
 *  a trailing slash, and `http(s)://`/`www.`/bare `github.com/` forms. Returns null when
 *  the URL isn't a recognizable GitHub repo URL. PURE — the source-mode update resolver
 *  uses it to turn a user-pasted URL into the `owner/repo` the GitHub API expects.
 *  Leaf module: imports nothing relative, so importing it can never create an import cycle. */
export function parseGitRepo(url: string): string | null {
  const m = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(
    url.trim(),
  )
  if (!m) return null
  const owner = m[1]
  const repo = m[2]
  if (!owner || !repo) return null
  return `${owner}/${repo}`
}

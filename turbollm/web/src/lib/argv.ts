// Shell-lite tokenizer for user-entered engine flags (GitHub #221).
//
// Mirrors `tokenizeExtraArgs` in src/models/profile.ts — the daemon is authoritative and
// re-tokenizes on every load, so this copy exists purely so the chips shown in the model
// dialog match what will actually be launched as the user types. The web bundle can't
// import the daemon module (it pulls in node-side config/engine code, and the daemon's
// tsconfig excludes web/ outright), so the logic is duplicated the same way
// web/src/lib/vram.ts mirrors profile.ts's KV-cache math. Keep the two in sync.

/** Split user-entered extra-flag entries into real argv elements.
 *
 *  Splitting is gated so the function is idempotent (the daemon runs it over
 *  already-normalised saved profiles on every load):
 *   - only an entry whose first non-space character is `-` is a split candidate, so a
 *     value token that legitimately contains spaces (`C:\my path\t.jinja`) is never
 *     chopped in half on a later pass;
 *   - and only when it has whitespace OUTSIDE quotes, so `--foo="a b"` is left verbatim.
 *  Single/double quotes group a value containing spaces and are stripped; empty results
 *  are dropped. An already-correct entry is returned as-is. */
export function tokenizeExtraArgs(entries: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string') continue
    if (!needsTokenize(entry)) {
      if (entry.trim()) out.push(entry)
      continue
    }
    let cur = ''
    let quote: string | null = null
    for (const ch of entry) {
      if (quote) {
        if (ch === quote) quote = null
        else cur += ch
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (/\s/.test(ch)) {
        if (cur) out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

/** True when an entry looks like a flag (`-…`) that has run-together arguments —
 *  i.e. whitespace outside of any quoted section. See {@link tokenizeExtraArgs}. */
function needsTokenize(entry: string): boolean {
  if (!entry.trimStart().startsWith('-')) return false
  let quote: string | null = null
  for (const ch of entry.trim()) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      return true
    }
  }
  return false
}

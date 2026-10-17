// File-revert half of "revert to message" (Code transcript). Reverse-applies every 'edit'
// tool call's stored unified patch for messages being discarded, so an in-repo file can be
// walked back to what it looked like before those turns — not just a UI-level history trim.
//
// Only 'edit' tool calls carry a real unified `patch` (pi's EditToolDetails) — 'write' calls
// create whole files with no natural single reverse, so they're left untouched, never counted
// as failed. jsdiff's applyPatch/reversePatch do the actual patch math (hand-rolling a unified-
// diff reverse-and-apply algorithm is exactly the kind of thing worth a well-tested dependency
// for, given this mutates the user's real files).
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyPatch, parsePatch, reversePatch } from 'diff'
import { isContainedFromRoot, normForCompare, normalizePiToolPath } from './containment'
import type { Message, ToolCallRecord } from '../chat/db'

export interface RevertFilesResult {
  /** Paths successfully walked back to their pre-edit state (relative, as pi's edit tool saw
   *  them — the same string as the tool call's own `args.path`). */
  reverted: string[]
  /** Paths left UNTOUCHED because reverting them wasn't possible — outside repoRoot, the file
   *  is now missing, or a patch no longer applies cleanly (the file drifted from what the
   *  recorded diff expects: edited by hand, or by something else, since). Never a partial
   *  write — a file with multiple edits in the reverted range is all-or-nothing. */
  failed: string[]
}

/** Told about each message holding an edit {@link revertFileEdits} walked back, with that
 *  message's toolCalls as they should now be stored: those edits flagged `reverted`. The caller
 *  saves them (updateMessage), so a later revert whose range reaches the same edits again skips
 *  them rather than reversing them a second time. Edits of a file reported failed are not
 *  flagged: nothing undid them. */
export type MarkUndoneEdits = (messageId: string, toolCalls: ToolCallRecord[]) => void

/** One key for every spelling of the file `absPath` names. pi's edit tool reaches the same file
 *  through a symlinked folder (`link/a.ts` with link -> src), or in another letter case where the
 *  filesystem ignores case (macOS, Windows), and keyed as spelled, those edits made two chains of
 *  one file: the older chain's reverse no longer applied over the newer edit, so it failed while
 *  the newer one was undone — the file half-reverted. The OS's own realpath resolves the links and,
 *  on macOS and Windows, returns each name's case as stored; normForCompare also folds case on
 *  Windows. A missing file keeps its spelling: it is reported failed whichever chain it is in. */
function fileKey(absPath: string): string {
  try {
    return normForCompare(realpathSync.native(absPath))
  } catch {
    return absPath
  }
}

/** Reverse-applies every edit-tool patch found in `messages` (the messages about to be
 *  discarded by a revert), grouped by file. For a file edited more than once in that range,
 *  every step is computed IN MEMORY, most recent edit first, and only written to disk if the
 *  ENTIRE chain succeeds — so a file is never left in a half-reverted state that matches
 *  neither the old nor the new content. */
export function revertFileEdits(messages: Message[], repoRoot: string, markUndone?: MarkUndoneEdits): RevertFilesResult {
  // Grouped by the file pi's edit tool actually edited, not by the raw string. Its resolveToCwd
  // strips one leading `@` and maps Unicode spaces to ' ' (normalizePiToolPath), and does NOT trim.
  // Keying and resolving by the trimmed raw `args.path` failed a revert of `@src/a.ts` (no such
  // file), and applied the reverse of an edit made through ` src/c.ts` to src/c.ts, a file pi
  // never touched, leaving the edited one as it was. A file is reported under the `args.path` of
  // its first edit in the range, and keyed by the file itself, not its spelling (fileKey). A path
  // pi could not convert (null) is never contained: failed.
  // Containment is checked on that raw `args.path` (isContainedFromRoot reads it both ways itself),
  // never on the absolute path: run through pi's normalisation again, a Unicode space in the
  // session folder's own name (a CJK full-width space, a pasted no-break space) became ' ', so the
  // path no longer sat under the root and every revert in that folder failed. pi resolves only
  // the argument, never its cwd.
  //
  // An edit an earlier revert already walked back (`reverted`, see MarkUndoneEdits) is skipped.
  // A revert further back than a previous one reads that one's range again (the route's
  // getMessagesFromIncludingInactive reaches rows it deactivated, which it must, for a chat-only
  // revert's edits), as does a revert after /resume. Reversing an undone edit again no longer
  // applies, so the whole file failed and the earlier edits the new revert was asked for stayed.
  const editsByFile = new Map<string, { path: string; absPath: string | null; patches: string[]; calls: ToolCallRecord[] }>() // chronological order, per file
  for (const m of messages) {
    for (const tc of m.toolCalls) {
      if (tc.name !== 'edit' || !tc.patch || tc.reverted) continue
      const path = typeof tc.args.path === 'string' ? tc.args.path : ''
      if (!path) continue
      const normalized = normalizePiToolPath(path)
      const absPath = normalized === null ? null : resolve(repoRoot, normalized)
      const key = absPath === null ? `\0${path}` : fileKey(absPath)
      const entry = editsByFile.get(key) ?? { path, absPath, patches: [], calls: [] }
      entry.patches.push(tc.patch)
      entry.calls.push(tc)
      editsByFile.set(key, entry)
    }
  }

  const reverted: string[] = []
  const failed: string[] = []
  const undone = new Set<ToolCallRecord>()
  for (const { path, absPath, patches, calls } of editsByFile.values()) {
    if (absPath === null || !isContainedFromRoot(path, repoRoot)) { failed.push(path); continue }
    if (!existsSync(absPath)) { failed.push(path); continue }

    let content: string
    try {
      content = readFileSync(absPath, 'utf8')
    } catch {
      failed.push(path)
      continue
    }
    // pi's edit tool computes its patch on BOM-stripped text but writes the BOM back, so a hunk
    // touching line 1 never matches the raw content. Patch without it, restore it on write.
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
    content = content.slice(bom.length)

    let ok = true
    for (let i = patches.length - 1; i >= 0; i--) {
      let parsed: ReturnType<typeof parsePatch>[number] | undefined
      try {
        parsed = parsePatch(patches[i])[0]
      } catch {
        parsed = undefined
      }
      if (!parsed) { ok = false; break }
      const result = applyPatch(content, reversePatch(parsed))
      if (result === false) { ok = false; break }
      content = result
    }
    if (!ok) { failed.push(path); continue }

    try {
      writeFileSync(absPath, bom + content)
      reverted.push(path)
      for (const tc of calls) undone.add(tc)
    } catch {
      failed.push(path)
    }
  }
  for (const m of messages) {
    if (m.toolCalls.some((tc) => undone.has(tc))) markUndone?.(m.id, m.toolCalls.map((tc) => (undone.has(tc) ? { ...tc, reverted: true } : tc)))
  }
  return { reverted, failed }
}

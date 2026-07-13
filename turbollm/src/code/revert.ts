// File-revert half of "revert to message" (Code transcript). Reverse-applies every 'edit'
// tool call's stored unified patch for messages being discarded, so an in-repo file can be
// walked back to what it looked like before those turns — not just a UI-level history trim.
//
// Only 'edit' tool calls carry a real unified `patch` (pi's EditToolDetails) — 'write' calls
// create whole files with no natural single reverse, so they're left untouched, never counted
// as failed. jsdiff's applyPatch/reversePatch do the actual patch math (hand-rolling a unified-
// diff reverse-and-apply algorithm is exactly the kind of thing worth a well-tested dependency
// for, given this mutates the user's real files).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyPatch, parsePatch, reversePatch } from 'diff'
import { isContainedFromRoot } from './containment'
import type { Message } from '../chat/db'

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

/** Reverse-applies every edit-tool patch found in `messages` (the messages about to be
 *  discarded by a revert), grouped by file. For a file edited more than once in that range,
 *  every step is computed IN MEMORY, most recent edit first, and only written to disk if the
 *  ENTIRE chain succeeds — so a file is never left in a half-reverted state that matches
 *  neither the old nor the new content. */
export function revertFileEdits(messages: Message[], repoRoot: string): RevertFilesResult {
  const patchesByPath = new Map<string, string[]>() // chronological order, per file
  for (const m of messages) {
    for (const tc of m.toolCalls) {
      if (tc.name !== 'edit' || !tc.patch) continue
      const path = typeof tc.args.path === 'string' ? tc.args.path.trim() : ''
      if (!path) continue
      const list = patchesByPath.get(path) ?? []
      list.push(tc.patch)
      patchesByPath.set(path, list)
    }
  }

  const reverted: string[] = []
  const failed: string[] = []
  for (const [path, patches] of patchesByPath) {
    if (!isContainedFromRoot(path, repoRoot)) { failed.push(path); continue }
    const absPath = resolve(repoRoot, path)
    if (!existsSync(absPath)) { failed.push(path); continue }

    let content: string
    try {
      content = readFileSync(absPath, 'utf8')
    } catch {
      failed.push(path)
      continue
    }

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
      writeFileSync(absPath, content)
      reverted.push(path)
    } catch {
      failed.push(path)
    }
  }
  return { reverted, failed }
}

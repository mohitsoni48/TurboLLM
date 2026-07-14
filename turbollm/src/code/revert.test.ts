// Unit tests for revert.ts — reverse-applying real edit-tool patches to real temp files (no
// mocking of the diff library or the filesystem; jsdiff's own createPatch generates the
// fixtures so the format matches exactly what pi's real edit tool produces).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPatch } from 'diff'
import { revertFileEdits } from './revert'
import type { Message, ToolCallRecord } from '../chat/db'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A minimal fake Message carrying the given edit tool calls — only the fields revertFileEdits
 *  actually reads (toolCalls) matter for these tests. */
function msgWithEdits(edits: { path: string; patch: string }[]): Message {
  const toolCalls: ToolCallRecord[] = edits.map((e, i) => ({
    id: `tc-${i}`, name: 'edit', args: { path: e.path }, patch: e.patch,
  }))
  return { toolCalls } as unknown as Message
}

function editPatch(relPath: string, before: string, after: string): string {
  return createPatch(relPath, before, after)
}

test('revertFileEdits: a single edit is reversed, the file returns to its pre-edit content', () => {
  const repoRoot = tmp('tllm-revert-')
  writeFileSync(join(repoRoot, 'a.txt'), 'line1\nnew\nline3\n')
  const patch = editPatch('a.txt', 'line1\nold\nline3\n', 'line1\nnew\nline3\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'a.txt', patch }])], repoRoot)
  assert.deepEqual(result.reverted, ['a.txt'])
  assert.deepEqual(result.failed, [])
  assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'line1\nold\nline3\n')
})

test('revertFileEdits: two edits to the SAME file are walked back most-recent-first, ending at the ORIGINAL content', () => {
  const repoRoot = tmp('tllm-revert-')
  const v0 = 'start\n'
  const v1 = 'start\nmiddle\n'
  const v2 = 'start\nmiddle\nend\n'
  writeFileSync(join(repoRoot, 'b.txt'), v2)
  const patch1 = editPatch('b.txt', v0, v1) // v0 -> v1
  const patch2 = editPatch('b.txt', v1, v2) // v1 -> v2
  // Two separate messages, in chronological order (patch1's turn happened before patch2's).
  const messages = [msgWithEdits([{ path: 'b.txt', patch: patch1 }]), msgWithEdits([{ path: 'b.txt', patch: patch2 }])]
  const result = revertFileEdits(messages, repoRoot)
  assert.deepEqual(result.reverted, ['b.txt'])
  assert.equal(readFileSync(join(repoRoot, 'b.txt'), 'utf8'), v0)
})

test('revertFileEdits: a file outside repoRoot is refused, not reverted', () => {
  const repoRoot = tmp('tllm-revert-')
  const outside = tmp('tllm-revert-outside-')
  writeFileSync(join(outside, 'evil.txt'), 'new content\n')
  const patch = editPatch('evil.txt', 'old content\n', 'new content\n')
  // ../ escape attempt, or an absolute path elsewhere — both must fail containment.
  const escapePath = join(outside, 'evil.txt')
  const result = revertFileEdits([msgWithEdits([{ path: escapePath, patch }])], repoRoot)
  assert.deepEqual(result.reverted, [])
  assert.deepEqual(result.failed, [escapePath])
  assert.equal(readFileSync(join(outside, 'evil.txt'), 'utf8'), 'new content\n', 'untouched')
})

test('revertFileEdits: a missing file is reported failed, not created', () => {
  const repoRoot = tmp('tllm-revert-')
  const patch = editPatch('gone.txt', 'old\n', 'new\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'gone.txt', patch }])], repoRoot)
  assert.deepEqual(result.failed, ['gone.txt'])
  assert.deepEqual(result.reverted, [])
})

test('revertFileEdits: a patch that no longer applies cleanly (file drifted) fails WITHOUT partially writing', () => {
  const repoRoot = tmp('tllm-revert-')
  // The file on disk does NOT match what the patch expects as its "new" content — simulates
  // the file being hand-edited (or touched by something else) since the recorded turn.
  writeFileSync(join(repoRoot, 'c.txt'), 'completely different content\n')
  const patch = editPatch('c.txt', 'old\n', 'new\n')
  const before = readFileSync(join(repoRoot, 'c.txt'), 'utf8')
  const result = revertFileEdits([msgWithEdits([{ path: 'c.txt', patch }])], repoRoot)
  assert.deepEqual(result.failed, ['c.txt'])
  assert.deepEqual(result.reverted, [])
  assert.equal(readFileSync(join(repoRoot, 'c.txt'), 'utf8'), before, 'file left completely untouched on failure')
})

test('revertFileEdits: a multi-edit chain where the EARLIER (chronologically) patch fails leaves the file untouched, not half-reverted', () => {
  const repoRoot = tmp('tllm-revert-')
  const v1 = 'start\nmiddle\n'
  const v2 = 'start\nmiddle\nend\n'
  writeFileSync(join(repoRoot, 'd.txt'), v2)
  // patch1 is about entirely unrelated content, sharing no lines with v1 — applying its
  // reverse (after patch2's reverse correctly produces v1) has no matching context and fails.
  const bogusPatch1 = editPatch('d.txt', 'zzz-unrelated-before\n', 'zzz-unrelated-after\n')
  const patch2 = editPatch('d.txt', v1, v2) // this one DOES match and would succeed alone
  const messages = [msgWithEdits([{ path: 'd.txt', patch: bogusPatch1 }]), msgWithEdits([{ path: 'd.txt', patch: patch2 }])]
  const result = revertFileEdits(messages, repoRoot)
  assert.deepEqual(result.failed, ['d.txt'])
  assert.deepEqual(result.reverted, [])
  // Critically: NOT left at the intermediate (patch2-only-reverted) state.
  assert.equal(readFileSync(join(repoRoot, 'd.txt'), 'utf8'), v2, 'untouched — no partial revert')
})

test('revertFileEdits: a write-tool call (no patch) is ignored, not treated as failed', () => {
  const repoRoot = tmp('tllm-revert-')
  writeFileSync(join(repoRoot, 'e.txt'), 'content\n')
  const msg = { toolCalls: [{ id: 'tc-1', name: 'write', args: { path: 'e.txt' } }] } as unknown as Message
  const result = revertFileEdits([msg], repoRoot)
  assert.deepEqual(result.reverted, [])
  assert.deepEqual(result.failed, [])
})

test('revertFileEdits: multiple independent files each revert correctly', () => {
  const repoRoot = tmp('tllm-revert-')
  writeFileSync(join(repoRoot, 'f1.txt'), 'new1\n')
  writeFileSync(join(repoRoot, 'f2.txt'), 'new2\n')
  const patch1 = editPatch('f1.txt', 'old1\n', 'new1\n')
  const patch2 = editPatch('f2.txt', 'old2\n', 'new2\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'f1.txt', patch: patch1 }, { path: 'f2.txt', patch: patch2 }])], repoRoot)
  assert.deepEqual(result.reverted.sort(), ['f1.txt', 'f2.txt'])
  assert.equal(readFileSync(join(repoRoot, 'f1.txt'), 'utf8'), 'old1\n')
  assert.equal(readFileSync(join(repoRoot, 'f2.txt'), 'utf8'), 'old2\n')
})

test('revertFileEdits: a nested-directory relative path resolves correctly under repoRoot', () => {
  const repoRoot = tmp('tllm-revert-')
  mkdirSync(join(repoRoot, 'src', 'lib'), { recursive: true })
  writeFileSync(join(repoRoot, 'src', 'lib', 'util.ts'), 'export const x = 2\n')
  const patch = editPatch('src/lib/util.ts', 'export const x = 1\n', 'export const x = 2\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'src/lib/util.ts', patch }])], repoRoot)
  assert.deepEqual(result.reverted, ['src/lib/util.ts'])
  assert.equal(readFileSync(join(repoRoot, 'src', 'lib', 'util.ts'), 'utf8'), 'export const x = 1\n')
})

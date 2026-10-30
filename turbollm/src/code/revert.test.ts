// Unit tests for revert.ts — reverse-applying real edit-tool patches to real temp files (no
// mocking of the diff library or the filesystem; jsdiff's own createPatch generates the
// fixtures so the format matches exactly what pi's real edit tool produces).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createPatch } from 'diff'
import { revertFileEdits } from './revert'
import type { Message, ToolCallRecord } from '../chat/db'
import { tmpDir } from '../test-support/tmp'

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
  const repoRoot = tmpDir('tllm-revert-')
  writeFileSync(join(repoRoot, 'a.txt'), 'line1\nnew\nline3\n')
  const patch = editPatch('a.txt', 'line1\nold\nline3\n', 'line1\nnew\nline3\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'a.txt', patch }])], repoRoot)
  assert.deepEqual(result.reverted, ['a.txt'])
  assert.deepEqual(result.failed, [])
  assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'line1\nold\nline3\n')
})

test('revertFileEdits: two edits to the SAME file are walked back most-recent-first, ending at the ORIGINAL content', () => {
  const repoRoot = tmpDir('tllm-revert-')
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
  const repoRoot = tmpDir('tllm-revert-')
  const outside = tmpDir('tllm-revert-outside-')
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
  const repoRoot = tmpDir('tllm-revert-')
  const patch = editPatch('gone.txt', 'old\n', 'new\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'gone.txt', patch }])], repoRoot)
  assert.deepEqual(result.failed, ['gone.txt'])
  assert.deepEqual(result.reverted, [])
})

test('revertFileEdits: a patch that no longer applies cleanly (file drifted) fails WITHOUT partially writing', () => {
  const repoRoot = tmpDir('tllm-revert-')
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
  const repoRoot = tmpDir('tllm-revert-')
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
  const repoRoot = tmpDir('tllm-revert-')
  writeFileSync(join(repoRoot, 'e.txt'), 'content\n')
  const msg = { toolCalls: [{ id: 'tc-1', name: 'write', args: { path: 'e.txt' } }] } as unknown as Message
  const result = revertFileEdits([msg], repoRoot)
  assert.deepEqual(result.reverted, [])
  assert.deepEqual(result.failed, [])
})

test('revertFileEdits: multiple independent files each revert correctly', () => {
  const repoRoot = tmpDir('tllm-revert-')
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
  const repoRoot = tmpDir('tllm-revert-')
  mkdirSync(join(repoRoot, 'src', 'lib'), { recursive: true })
  writeFileSync(join(repoRoot, 'src', 'lib', 'util.ts'), 'export const x = 2\n')
  const patch = editPatch('src/lib/util.ts', 'export const x = 1\n', 'export const x = 2\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'src/lib/util.ts', patch }])], repoRoot)
  assert.deepEqual(result.reverted, ['src/lib/util.ts'])
  assert.equal(readFileSync(join(repoRoot, 'src', 'lib', 'util.ts'), 'utf8'), 'export const x = 1\n')
})

test('REGRESSION: a file with a UTF-8 BOM reverts (an edit touching line 1) and keeps its BOM', () => {
  const repoRoot = tmpDir('tllm-revert-')
  // pi's edit tool strips the BOM before diffing and writes it back, so the stored patch is
  // computed on BOM-less text while the file on disk still starts with U+FEFF.
  writeFileSync(join(repoRoot, 'a.cs'), '\uFEFF' + 'using New;\nclass A {}\n')
  const patch = editPatch('a.cs', 'using Old;\nclass A {}\n', 'using New;\nclass A {}\n')
  const result = revertFileEdits([msgWithEdits([{ path: 'a.cs', patch }])], repoRoot)
  assert.deepEqual(result, { reverted: ['a.cs'], failed: [] })
  assert.equal(readFileSync(join(repoRoot, 'a.cs'), 'utf8'), '\uFEFF' + 'using Old;\nclass A {}\n')
})

test('REGRESSION: an edit made through `@src/a.ts` reverts src/a.ts, chained with edits made through the plain path', () => {
  // pi's edit tool strips one leading `@` (resolveToCwd), so `@src/a.ts` IS src/a.ts. Keyed by the
  // raw string, its revert looked for a file named `@src/a.ts`, failed, and kept the edit.
  const repoRoot = tmpDir('tllm-revert-')
  mkdirSync(join(repoRoot, 'src'))
  const v0 = 'one\n'
  const v1 = 'one\ntwo\n'
  const v2 = 'one\ntwo\nthree\n'
  writeFileSync(join(repoRoot, 'src', 'a.ts'), v2)
  writeFileSync(join(repoRoot, 'src', 'b.ts'), 'new\n')
  const messages = [
    msgWithEdits([{ path: 'src/a.ts', patch: editPatch('src/a.ts', v0, v1) }]),
    msgWithEdits([{ path: '@src/a.ts', patch: editPatch('src/a.ts', v1, v2) }, { path: '@src/b.ts', patch: editPatch('src/b.ts', 'old\n', 'new\n') }]),
  ]
  const result = revertFileEdits(messages, repoRoot)
  assert.deepEqual(result, { reverted: ['src/a.ts', '@src/b.ts'], failed: [] })
  assert.equal(readFileSync(join(repoRoot, 'src', 'a.ts'), 'utf8'), v0)
  assert.equal(readFileSync(join(repoRoot, 'src', 'b.ts'), 'utf8'), 'old\n')
})

test('REGRESSION: edits made through a symlinked folder and through the real one revert as one file', () => {
  // Keyed by the path as spelled, `link/a.ts` (link -> src) and `src/a.ts` were two files: the
  // older edit's reverse no longer applied over the newer one, so it failed, and only the newer
  // edit was undone, which left the file matching neither its old content nor its new one.
  const repoRoot = tmpDir('tllm-revert-')
  mkdirSync(join(repoRoot, 'src'))
  // 'junction' so this also runs on Windows without admin rights; ignored elsewhere.
  symlinkSync(join(repoRoot, 'src'), join(repoRoot, 'link'), 'junction')
  const v0 = 'value = 1\n'
  const v1 = 'value = 2\n'
  const v2 = 'value = 3\n'
  writeFileSync(join(repoRoot, 'src', 'a.ts'), v2)
  const result = revertFileEdits([
    msgWithEdits([{ path: 'src/a.ts', patch: editPatch('src/a.ts', v0, v1) }]),
    msgWithEdits([{ path: 'link/a.ts', patch: editPatch('link/a.ts', v1, v2) }]),
  ], repoRoot)
  assert.deepEqual(result, { reverted: ['src/a.ts'], failed: [] })
  assert.equal(readFileSync(join(repoRoot, 'src', 'a.ts'), 'utf8'), v0)
})

test('REGRESSION: a path is not trimmed, and Unicode spaces read as spaces, as pi\'s edit tool resolves them', () => {
  // ` src/c.ts` is a file in a folder named ` src`; trimmed, its reverse patch was applied to
  // src/c.ts, which pi never touched. A no-break space in a name is a plain space to pi.
  const repoRoot = tmpDir('tllm-revert-')
  mkdirSync(join(repoRoot, ' src'))
  mkdirSync(join(repoRoot, 'src'))
  writeFileSync(join(repoRoot, ' src', 'c.ts'), 'new\n')
  writeFileSync(join(repoRoot, 'src', 'c.ts'), 'new\n')
  writeFileSync(join(repoRoot, 'my file.txt'), 'new\n')
  const result = revertFileEdits([msgWithEdits([
    { path: ' src/c.ts', patch: editPatch(' src/c.ts', 'old\n', 'new\n') },
    { path: 'my file.txt', patch: editPatch('my file.txt', 'old\n', 'new\n') },
  ])], repoRoot)
  assert.deepEqual(result, { reverted: [' src/c.ts', 'my file.txt'], failed: [] })
  assert.equal(readFileSync(join(repoRoot, ' src', 'c.ts'), 'utf8'), 'old\n', 'the file pi edited is reverted')
  assert.equal(readFileSync(join(repoRoot, 'src', 'c.ts'), 'utf8'), 'new\n', 'a file pi never touched is left alone')
  assert.equal(readFileSync(join(repoRoot, 'my file.txt'), 'utf8'), 'old\n')
})

test('REGRESSION: a session folder with a Unicode space in its own name still reverts (pi normalises the path, never its cwd)', () => {
  // Checked on the absolute path, the containment check ran pi's normalisation over the folder's
  // own name too: its U+3000 or U+00A0 read as ' ', the path was no longer under the root, and
  // every revert in that folder was reported failed with the edit kept.
  for (const name of ['my　project', 'my project']) {
    const repoRoot = join(tmpDir('tllm-revert-'), name)
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'new\n')
    const result = revertFileEdits([msgWithEdits([{ path: 'src/a.ts', patch: editPatch('src/a.ts', 'old\n', 'new\n') }])], repoRoot)
    assert.deepEqual(result, { reverted: ['src/a.ts'], failed: [] }, JSON.stringify(name))
    assert.equal(readFileSync(join(repoRoot, 'src', 'a.ts'), 'utf8'), 'old\n')
  }
})

test('REGRESSION: an edit already flagged `reverted` is skipped, and the edits walked back are reported flagged', () => {
  // A revert further back than an earlier one reads that one's edits again: reversed a second
  // time, the undone edit no longer applied and the whole file failed, the earlier edit kept.
  const repoRoot = tmpDir('tllm-revert-')
  const v0 = 'zero\nline2\nline3\nline4\nline5\nline6\nline7\nten\n'
  const v1 = v0.replace('zero', 'one')
  const v2 = v1.replace('ten', 'eleven')
  writeFileSync(join(repoRoot, 'a.txt'), v1) // the edit to v2 was already reverted
  const older = { id: 'm-1', toolCalls: [{ id: 'tc-1', name: 'edit', args: { path: 'a.txt' }, patch: editPatch('a.txt', v0, v1) }] } as unknown as Message
  const undone = { id: 'm-2', toolCalls: [{ id: 'tc-2', name: 'edit', args: { path: 'a.txt' }, patch: editPatch('a.txt', v1, v2), reverted: true }] } as unknown as Message
  const marked: { id: string; toolCalls: ToolCallRecord[] }[] = []
  const result = revertFileEdits([older, undone], repoRoot, (id, toolCalls) => marked.push({ id, toolCalls }))
  assert.deepEqual(result, { reverted: ['a.txt'], failed: [] })
  assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), v0)
  assert.deepEqual(marked, [{ id: 'm-1', toolCalls: [{ ...older.toolCalls[0], reverted: true }] }], 'only the edit undone now is reported')
})

test('revertFileEdits: the edits of a file that failed are not reported as undone', () => {
  const repoRoot = tmpDir('tllm-revert-')
  writeFileSync(join(repoRoot, 'a.txt'), 'drifted\n')
  const marked: string[] = []
  const result = revertFileEdits([msgWithEdits([{ path: 'a.txt', patch: editPatch('a.txt', 'old\n', 'new\n') }])], repoRoot, (id) => marked.push(id))
  assert.deepEqual(result, { reverted: [], failed: ['a.txt'] })
  assert.deepEqual(marked, [])
})

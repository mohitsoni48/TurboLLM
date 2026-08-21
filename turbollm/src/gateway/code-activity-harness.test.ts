// Regression coverage for the bug hostile QA found: coding-activity attribution silently credited
// NOTHING for pi and opencode, because it read claude's argument spellings only.
//
// `observeCodeSessionTurn` gated on `input.file_path` and `continue`d when it was absent. That field
// is Claude Code's spelling and no one else's — pi's edit/write tools take `path`, opencode's take
// `filePath` — so every pi/opencode edit fell through the gate, `pendingCodeToolCalls` stayed empty,
// and the Code launchpad's filesTouched / "Diff shipped" tiles stayed at zero while the run was
// still optimistically marked done. Porting attribution to the OpenAI path was done FOR those two
// harnesses, so the feature was dead on arrival for both.
//
// Every fixture below is the REAL argument shape, read off the installed binaries:
//   pi 0.84.2   dist/core/tools/edit.js  -> Type.Object({ path, edits: [{ oldText, newText }] })
//               dist/core/tools/write.js -> Type.Object({ path, content })
//   opencode    edit  -> Struct({ filePath, oldString, newString });  write -> { filePath, content }
//   claude      Edit  -> { file_path, old_string, new_string }        (unchanged, must not regress)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editedPathForTest, editStringsForTest } from './gateway'

test('the edited path is recovered from all three harness spellings', () => {
  assert.equal(editedPathForTest({ file_path: '/repo/a.ts' }), '/repo/a.ts', 'claude')
  assert.equal(editedPathForTest({ path: '/repo/b.ts' }), '/repo/b.ts', 'pi')
  assert.equal(editedPathForTest({ filePath: '/repo/c.ts' }), '/repo/c.ts', 'opencode')
})

test('a call with no recognisable path yields empty, so it is skipped rather than mis-credited', () => {
  assert.equal(editedPathForTest({}), '')
  assert.equal(editedPathForTest({ path: 42 as unknown as string }), '', 'a non-string must not be trusted')
  assert.equal(editedPathForTest({ path: '' }), '', 'an empty string is not a path')
})

test('claude edit strings still resolve (no regression on the path that already worked)', () => {
  assert.deepEqual(
    editStringsForTest({ file_path: '/a', old_string: 'before', new_string: 'after' }),
    { oldString: 'before', newString: 'after' },
  )
})

test('opencode edit strings resolve from its camelCase spelling', () => {
  assert.deepEqual(
    editStringsForTest({ filePath: '/a', oldString: 'before', newString: 'after' }),
    { oldString: 'before', newString: 'after' },
  )
})

test('pi single-element edits[] resolves to a real diffable pair', () => {
  // pi batches replacements into an array; exactly one element can be rendered as an honest diff.
  assert.deepEqual(
    editStringsForTest({ path: '/a', edits: [{ oldText: 'before', newText: 'after' }] }),
    { oldString: 'before', newString: 'after' },
  )
})

test('pi MULTI-element edits[] yields no diff — the file is still credited, the diff is not faked', () => {
  // Several fragments have unknown line positions relative to each other, so there is no honest
  // unified diff. Empty strings make the caller record the edit WITHOUT a diff, matching the
  // existing MultiEdit policy: an omitted number beats a fabricated one nobody can tell is wrong.
  assert.deepEqual(
    editStringsForTest({ path: '/a', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] }),
    { oldString: '', newString: '' },
  )
  // ...but the path still resolves, which is what keeps filesTouched credit.
  assert.equal(editedPathForTest({ path: '/a' }), '/a')
})

test('a malformed edits[] never throws', () => {
  assert.deepEqual(editStringsForTest({ edits: [] }), { oldString: '', newString: '' })
  assert.deepEqual(editStringsForTest({ edits: [null] as unknown as unknown[] }), { oldString: '', newString: '' })
  assert.deepEqual(editStringsForTest({ edits: 'nope' as unknown as unknown[] }), { oldString: '', newString: '' })
})

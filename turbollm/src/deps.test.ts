// The shared Deps contract's own value types (deps.ts). Checked by `tsc --noEmit` as much as at run time: a value
// here that the type does not admit fails the typecheck.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodeSessionDeletion } from './deps'

test('CodeSessionDeletion: a session kept because its worktree could not be removed carries the note', () => {
  const kept: CodeSessionDeletion = { deleted: false, reason: 'worktree_kept', worktreeNote: 'has local changes' }
  assert.equal(kept.deleted, false)
  assert.equal(kept.reason === 'worktree_kept' ? kept.worktreeNote : null, 'has local changes')
})

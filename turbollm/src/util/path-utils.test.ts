// Regression tests for inferRepoFromPath (PR #3).
// Bug: parts.length >= 3 check excluded MLX directories (which are owner/repo
// with only 2 path segments), so the re-download HF dialog always fell back
// to name-search instead of opening with the correct repo.
// Fix: changed to >= 2 so both MLX dirs (2 segments) and GGUF files (3+) work.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inferRepoFromPath } from './path-utils'

const DIRS = ['/models']

test('MLX dir (2 segments: owner/repo) → returns owner/repo (the regression fix)', () => {
  // Before the fix this returned null because parts.length was 2, not >= 3
  assert.equal(inferRepoFromPath('/models/TheBloke/Mistral-7B-MLX', DIRS), 'TheBloke/Mistral-7B-MLX')
})

test('GGUF file (3 segments: owner/repo/file.gguf) → returns owner/repo', () => {
  assert.equal(
    inferRepoFromPath('/models/TheBloke/Mistral-7B-GGUF/mistral-7b.Q4_K_M.gguf', DIRS),
    'TheBloke/Mistral-7B-GGUF',
  )
})

test('4+ segments → returns the first two as owner/repo', () => {
  assert.equal(
    inferRepoFromPath('/models/owner/repo/subdir/model.gguf', DIRS),
    'owner/repo',
  )
})

test('only 1 path segment after model dir → returns null (no repo to infer)', () => {
  assert.equal(inferRepoFromPath('/models/owner', DIRS), null)
})

test('path outside all model dirs → returns null', () => {
  assert.equal(inferRepoFromPath('/other/owner/repo', DIRS), null)
})

test('empty model dirs list → returns null', () => {
  assert.equal(inferRepoFromPath('/models/owner/repo', []), null)
})

test('owner segment with invalid chars (space) → returns null', () => {
  assert.equal(inferRepoFromPath('/models/bad owner/repo', DIRS), null)
})

test('repo segment with invalid chars (space) → returns null', () => {
  assert.equal(inferRepoFromPath('/models/owner/bad repo', DIRS), null)
})

test('valid segment chars: letters, digits, dots, underscores, hyphens are all allowed', () => {
  assert.equal(
    inferRepoFromPath('/models/Org-Name_123/model.v2_fp16', DIRS),
    'Org-Name_123/model.v2_fp16',
  )
})

test('Windows-style backslashes are normalised to forward slashes', () => {
  assert.equal(
    inferRepoFromPath('C:\\models\\owner\\my-model', ['C:\\models']),
    'owner/my-model',
  )
})

test('trailing slash on model dir is stripped before comparison', () => {
  assert.equal(
    inferRepoFromPath('/models/owner/repo', ['/models/']),
    'owner/repo',
  )
})

test('case-insensitive root match (Windows paths)', () => {
  assert.equal(
    inferRepoFromPath('/Models/owner/repo', ['/models']),
    'owner/repo',
  )
})

test('multiple model dirs — uses the matching one', () => {
  const dirs = ['/models-a', '/models-b']
  assert.equal(inferRepoFromPath('/models-b/owner/repo', dirs), 'owner/repo')
})

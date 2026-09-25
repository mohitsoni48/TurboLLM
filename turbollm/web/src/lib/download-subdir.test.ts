import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downloadSubdir } from './download-subdir'

// A safetensors download (Jev checkpoints, ADR-434 (h); Laya's own nested layout) enqueues
// every component file under ONE model folder on disk. The server stores each file at
// `<subdir>/<basename>`, so a repo-relative path with its own '/' has to carry that same
// subfolder into `subdir`, or two files that happen to share a basename in different
// subfolders (Laya's root `encoder/config.json` vs its `multilingual/encoder/config.json`)
// land at the identical path and overwrite each other.

test('a root-level file (no "/" in its repo path) lands straight in the repo folder', () => {
  assert.equal(downloadSubdir('openjev', 'config.json'), 'openjev')
  assert.equal(downloadSubdir('openjev', 'model.safetensors'), 'openjev')
})

test('a file inside one subfolder keeps that subfolder under the repo folder', () => {
  assert.equal(downloadSubdir('openjev', 'qwen3.5-4b-nli-v2/config.json'), 'openjev/qwen3.5-4b-nli-v2')
  assert.equal(downloadSubdir('openjev', 'qwen3.5-4b-nli-v2/model.safetensors'), 'openjev/qwen3.5-4b-nli-v2')
})

test('a file nested two levels deep keeps its whole subpath, not just the last segment', () => {
  assert.equal(downloadSubdir('laya', 'multilingual/encoder/config.json'), 'laya/multilingual/encoder')
})

test('two files with the same basename in different subfolders never collapse to the same subdir', () => {
  const a = downloadSubdir('laya', 'encoder/config.json')
  const b = downloadSubdir('laya', 'multilingual/encoder/config.json')
  assert.notEqual(a, b)
  assert.equal(a, 'laya/encoder')
  assert.equal(b, 'laya/multilingual/encoder')
})

// This is the existing-repo regression guard: every rule above must reduce to exactly today's
// two behaviors — a root checkpoint's files go straight in the repo folder, a nested
// checkpoint's files go in `<repo>/<checkpoint dir>` — since a checkpoint's own files are always
// named `<cp.dir>/<file>` (checkpoints.ts's `describeCheckpoint`), never nested any deeper.
test('reduces to the existing checkpoint-download behavior for a single level of nesting', () => {
  assert.equal(downloadSubdir('openjev', 'qwen3.5-4b-nli-v1/model.safetensors'), 'openjev/qwen3.5-4b-nli-v1')
})

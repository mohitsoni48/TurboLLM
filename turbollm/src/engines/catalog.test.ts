import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogForPlatform } from './catalog'

// The Engines screen must never guess a branch: a guessed "main" is a hard
// "Remote branch main not found in upstream origin" for any repo whose default is not main
// (Prism's is `prism`, llama.cpp's `master`, KoboldCpp's `concedo`). So every entry that can be built
// from an unpinned branch has to declare the real one. Audited against each remote's HEAD
// (`git ls-remote --symref`) when this guard was added; this test keeps new entries honest.
test('every build-from-source catalog entry on an unpinned branch declares its default branch', () => {
  const buildable = catalogForPlatform().filter(
    (e) => !e.sourceCommit && !e.patchUrl && (e.variants ?? []).some((v) => v.hasPrebuilt === false),
  )
  assert.ok(buildable.length >= 4, `expected the source-build entries to be found, got ${buildable.length}`)
  for (const e of buildable) {
    assert.match(e.defaultBranch ?? '', /^[^\s-]\S*$/, `catalog entry "${e.id}" builds from source but has no usable defaultBranch`)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogForPlatform } from './catalog'

// The Engines screen must never guess a branch: a guessed "main" is a hard
// "Remote branch main not found in upstream origin" for any repo whose default is not main
// (Prism's is `prism`, llama.cpp's `master`, KoboldCpp's `concedo`). So every entry that can be built
// from an unpinned branch has to declare the real one. Audited against each remote's HEAD
// (`git ls-remote --symref`) when this guard was added; this test keeps new entries honest.
test('every build-from-source catalog entry on an unpinned branch declares its default branch', () => {
  // Explicit platform: on Android catalogForPlatform() drops every entry not runnable there, which
  // would leave this guard checking a single entry. Every other platform returns the whole catalog.
  const buildable = catalogForPlatform('linux').filter(
    (e) => !e.sourceCommit && !e.patchUrl && (e.variants ?? []).some((v) => v.hasPrebuilt === false),
  )
  assert.ok(buildable.length >= 4, `expected the source-build entries to be found, got ${buildable.length}`)
  for (const e of buildable) {
    assert.match(e.defaultBranch ?? '', /^[^\s-]\S*$/, `catalog entry "${e.id}" builds from source but has no usable defaultBranch`)
  }
})

// ADR-453: a catalog entry offers "Install prebuilt" only after its release assets were verified
// (ADR-239). Today that is Prism and BeeLlama, nothing else.
test('releaseInstall is set on exactly prism and beellama, each with a repo and not coming-soon', () => {
  const flagged = catalogForPlatform('linux').filter((e) => e.releaseInstall)
  assert.deepEqual(flagged.map((e) => e.id).sort(), ['beellama', 'prism'])
  for (const e of flagged) {
    assert.ok(e.repo, `${e.id} needs a repo to list releases from`)
    assert.ok(!e.comingSoon, `${e.id} is installable, not coming soon`)
  }
})

test('prism and beellama copy no longer claims TurboLLM cannot install a prebuilt', () => {
  for (const id of ['prism', 'beellama']) {
    const e = catalogForPlatform('linux').find((x) => x.id === id)!
    const copy = `${e.description} ${e.note ?? ''}`
    assert.doesNotMatch(copy, /no install endpoint/i, id)
    assert.doesNotMatch(copy, /builds from source here/i, id)
    assert.match(e.description, /Install a prebuilt from its releases, or build it from source\.$/, id)
  }
})

// Unit tests for the Code-session path-containment boundary (containment.ts).
//
// Pure algorithm tests — no pi SDK, no live model. The single most important case is the
// regression at the bottom: a RELATIVE tool-call path (`math-utils.js`, `./index.js`, `.`)
// must be resolved against the session repoRoot, NOT the daemon's own process.cwd(). Before
// the fix, `isContained` resolved relative paths against process.cwd(), so legitimate in-bounds
// calls canonicalized to a path OUTSIDE the root and were falsely rejected in every mode.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  canonicalize,
  normForCompare,
  isInsideAny,
  isContained,
  isContainedFromRoot,
} from './containment'

const isWin = process.platform === 'win32'

// ── normForCompare ───────────────────────────────────────────────────────────────

test('normForCompare: unifies mixed separators to the OS separator', () => {
  const out = normForCompare('a/b\\c/d')
  assert.equal(out, ['a', 'b', 'c', 'd'].join(sep))
})

test('normForCompare: collapses repeated separators', () => {
  const out = normForCompare('a//b\\\\c')
  assert.equal(out, ['a', 'b', 'c'].join(sep))
})

test('normForCompare: case-folds on Windows only', () => {
  const out = normForCompare('/Foo/BAR')
  if (isWin) assert.equal(out, normForCompare('/foo/bar'))
  else assert.notEqual(out, normForCompare('/foo/bar'))
})

// ── isInsideAny (operates on already-canonicalized paths) ─────────────────────────

test('isInsideAny: exact root match', () => {
  assert.ok(isInsideAny('/home/user/project', ['/home/user/project']))
})

test('isInsideAny: nested descendant', () => {
  assert.ok(isInsideAny('/home/user/project/src/index.ts', ['/home/user/project']))
})

test('isInsideAny: path outside all roots', () => {
  assert.ok(!isInsideAny('/tmp/malicious', ['/home/user/project']))
})

test('isInsideAny: sibling-prefix trap is NOT inside (project vs project-evil)', () => {
  // The classic startsWith bug: "/home/user/project-evil" must not count as inside
  // "/home/user/project" just because it shares a string prefix.
  assert.ok(!isInsideAny('/home/user/project-evil/x', ['/home/user/project']))
})

test('isInsideAny: multiple roots — matches the second', () => {
  assert.ok(isInsideAny('/data/safe/file.md', ['/home/user/project', '/data/safe']))
})

test('isInsideAny: Windows case-folding (only case-insensitive on win32)', () => {
  const res = isInsideAny('/Home/User/Project/File.TS', ['/home/user/project'])
  assert.equal(res, isWin)
})

// ── canonicalize ──────────────────────────────────────────────────────────────────

test('canonicalize: null / empty / non-string / NUL → null', () => {
  assert.equal(canonicalize(null), null)
  assert.equal(canonicalize(undefined), null)
  assert.equal(canonicalize(''), null)
  assert.equal(canonicalize('a\0b'), null)
  // @ts-expect-error deliberately wrong type
  assert.equal(canonicalize(42), null)
})

test('canonicalize: resolves .. against a real existing ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-'))
  try {
    // root/sub/../x canonicalizes to root/x (the `..` is collapsed).
    const got = canonicalize(join(root, 'sub', '..', 'x'))
    assert.equal(got, normForCompare(join(canonicalize(root)!, 'x')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── isContained (relative resolved against process.cwd — the pre-fix behavior) ─────

test('isContained: absolute in-bounds path (descendant) → true', () => {
  const root = mkdtempSync(join(tmpdir(), 'contained-'))
  try {
    assert.ok(isContained(join(root, 'sub', 'file.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContained: exact root → true', () => {
  const root = mkdtempSync(join(tmpdir(), 'contained-'))
  try {
    assert.ok(isContained(root, root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContained: .. escape out of root → false', () => {
  const root = mkdtempSync(join(tmpdir(), 'contained-'))
  try {
    assert.ok(!isContained(join(root, '..', 'escapee.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContained: sibling-prefix directory is NOT contained', () => {
  const base = mkdtempSync(join(tmpdir(), 'contained-'))
  const root = join(base, 'project')
  const evil = join(base, 'project-evil') // shares the "project" string prefix
  try {
    // Both are real dirs so realpathSync resolves them identically to the check.
    mkdirSync(root, { recursive: true })
    mkdirSync(evil, { recursive: true })
    assert.ok(!isContained(join(evil, 'x.txt'), root))
    assert.ok(isContained(join(root, 'x.txt'), root)) // sanity: real child IS contained
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('isContained: non-string / NUL input → false', () => {
  const root = mkdtempSync(join(tmpdir(), 'contained-'))
  try {
    assert.ok(!isContained(null, root))
    assert.ok(!isContained(undefined, root))
    assert.ok(!isContained('a\0b', root))
    assert.ok(!isContained('', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── isContainedFromRoot — the fixed tool-call path check ───────────────────────────

test('isContainedFromRoot: bare relative filename resolves against root → true', () => {
  const root = mkdtempSync(join(tmpdir(), 'fromroot-'))
  try {
    writeFileSync(join(root, 'math-utils.js'), '// x')
    assert.ok(isContainedFromRoot('math-utils.js', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: ./file and . (cwd) resolve against root → true', () => {
  const root = mkdtempSync(join(tmpdir(), 'fromroot-'))
  try {
    writeFileSync(join(root, 'index.js'), '// x')
    assert.ok(isContainedFromRoot('./index.js', root))
    assert.ok(isContainedFromRoot('.', root))
    assert.ok(isContainedFromRoot('./sub/deep/new.js', root)) // non-existent tail is fine
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: absolute in-bounds still allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fromroot-'))
  try {
    assert.ok(isContainedFromRoot(join(root, 'sub', 'f.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: relative .. escape still rejected (fails closed)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fromroot-'))
  try {
    assert.ok(!isContainedFromRoot('../evil.txt', root))
    assert.ok(!isContainedFromRoot('../../../../etc/passwd', root))
    assert.ok(!isContainedFromRoot('sub/../../evil.txt', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: absolute out-of-root path rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'fromroot-'))
  const other = mkdtempSync(join(tmpdir(), 'other-'))
  try {
    assert.ok(!isContainedFromRoot(join(other, 'secret.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: non-string / empty / NUL → false', () => {
  const root = mkdtempSync(join(tmpdir(), 'fromroot-'))
  try {
    assert.ok(!isContainedFromRoot(null, root))
    assert.ok(!isContainedFromRoot(undefined, root))
    assert.ok(!isContainedFromRoot('', root))
    assert.ok(!isContainedFromRoot('a\0b', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── REGRESSION: the exact bug that shipped ─────────────────────────────────────────
// A relative tool-call path resolved against a FOREIGN base (the daemon's process.cwd) lands
// outside the real repoRoot and was falsely rejected; resolved against repoRoot it is correctly
// contained. This is the precise defect the verify pass reproduced 3x (read './math-utils.js',
// read 'math-utils.js', ls '.').
test('REGRESSION: relative path wrong against a foreign cwd, correct against repoRoot', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'))
  const foreignCwd = mkdtempSync(join(tmpdir(), 'daemoncwd-')) // stands in for D:\...\turbollm
  try {
    writeFileSync(join(repoRoot, 'math-utils.js'), '// real file in the repo')

    // (1) The BUG: resolving the relative path against the foreign daemon cwd lands OUTSIDE
    //     repoRoot — exactly what `isContained` (resolve against process.cwd) produced.
    const buggyResolved = resolve(foreignCwd, 'math-utils.js')
    assert.ok(
      !isInsideAny(canonicalize(buggyResolved)!, [canonicalize(repoRoot)!]),
      'sanity: the foreign-cwd resolution really is outside repoRoot',
    )

    // (2) The FIX: isContainedFromRoot resolves the SAME relative input against repoRoot → inside.
    assert.ok(
      isContainedFromRoot('math-utils.js', repoRoot),
      'fixed: relative tool-call path is contained when resolved against repoRoot',
    )
    assert.ok(isContainedFromRoot('./math-utils.js', repoRoot))
    assert.ok(isContainedFromRoot('.', repoRoot))

    // (3) And the fix does NOT depend on the ambient cwd being repoRoot: the old `isContained`
    //     (which resolves against process.cwd, not repoRoot) still rejects the bare relative
    //     path here, proving the two functions genuinely differ.
    assert.ok(
      !isContained('math-utils.js', repoRoot),
      'the pre-fix isContained still resolves against cwd and rejects the in-bounds relative path',
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(foreignCwd, { recursive: true, force: true })
  }
})

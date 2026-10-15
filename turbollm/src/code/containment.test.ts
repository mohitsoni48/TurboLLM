// Unit tests for the Code-session path-containment boundary (containment.ts).
//
// Pure algorithm tests — no live model (pi's real write tool is driven once, with no-op filesystem
// operations, only to check path-normalization parity). The single most important case is the
// regression at the bottom: a RELATIVE tool-call path (`math-utils.js`, `./index.js`, `.`)
// must be resolved against the session repoRoot, NOT the daemon's own process.cwd(). Before
// the fix, `isContained` resolved relative paths against process.cwd(), so legitimate in-bounds
// calls canonicalized to a path OUTSIDE the root and were falsely rejected in every mode.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  canonicalize,
  normForCompare,
  isInsideAny,
  isContained,
  isContainedFromRoot,
} from './containment'
import { tmpDir } from '../test-support/tmp'

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
  const root = tmpDir('canon-')
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
  const root = tmpDir('contained-')
  try {
    assert.ok(isContained(join(root, 'sub', 'file.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContained: exact root → true', () => {
  const root = tmpDir('contained-')
  try {
    assert.ok(isContained(root, root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContained: .. escape out of root → false', () => {
  const root = tmpDir('contained-')
  try {
    assert.ok(!isContained(join(root, '..', 'escapee.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContained: sibling-prefix directory is NOT contained', () => {
  const base = tmpDir('contained-')
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
  const root = tmpDir('contained-')
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
  const root = tmpDir('fromroot-')
  try {
    writeFileSync(join(root, 'math-utils.js'), '// x')
    assert.ok(isContainedFromRoot('math-utils.js', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: ./file and . (cwd) resolve against root → true', () => {
  const root = tmpDir('fromroot-')
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
  const root = tmpDir('fromroot-')
  try {
    assert.ok(isContainedFromRoot(join(root, 'sub', 'f.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: relative .. escape still rejected (fails closed)', () => {
  const root = tmpDir('fromroot-')
  try {
    assert.ok(!isContainedFromRoot('../evil.txt', root))
    assert.ok(!isContainedFromRoot('../../../../etc/passwd', root))
    assert.ok(!isContainedFromRoot('sub/../../evil.txt', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: absolute out-of-root path rejected', () => {
  const root = tmpDir('fromroot-')
  const other = tmpDir('other-')
  try {
    assert.ok(!isContainedFromRoot(join(other, 'secret.txt'), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('isContainedFromRoot: non-string / empty / NUL → false', () => {
  const root = tmpDir('fromroot-')
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
  const repoRoot = tmpDir('repo-')
  const foreignCwd = tmpDir('daemoncwd-') // stands in for D:\...\turbollm
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

// ── REGRESSION: the string pi's write/edit tools act on is not the raw argument ─────────────
// pi's resolveToCwd strips a leading `@`, expands `~`/`~/`, and converts `file://` URLs. The guard
// used to check the raw string, so `~/.bashrc` passed as "<repo>/~/.bashrc" while pi wrote to the
// real home directory.

/** The absolute path pi's REAL write tool would write `input` to, with `root` as its cwd —
 *  captured through its injectable operations, so nothing is written anywhere. */
async function piWriteTarget(input: string, root: string): Promise<string> {
  let target = ''
  const tool = createWriteToolDefinition(root, {
    operations: { mkdir: async () => {}, writeFile: async (abs) => { target = abs } },
  })
  await tool.execute('t', { path: input, content: '' }, undefined, undefined, undefined as never)
  return target
}

test('isContainedFromRoot: ~, @ and file:// paths are judged by where pi actually writes them', async () => {
  const root = tmpDir('pinorm-')
  const outside = tmpDir('pinorm-out-')
  try {
    const escapes = [
      '~/.bashrc',
      '~',
      '@' + join(outside, 'x.txt'),
      pathToFileURL(join(outside, 'x.txt')).href,
      '@' + pathToFileURL(join(outside, 'x.txt')).href,
    ]
    for (const p of escapes) assert.ok(!isContainedFromRoot(p, root), `${p} must be rejected`)

    const inBounds = ['@src/a.ts', pathToFileURL(join(root, 'in.txt')).href, 'a\u00A0b.txt', 'src/a.ts']
    for (const p of inBounds) assert.ok(isContainedFromRoot(p, root), `${p} must stay allowed`)

    // Parity with pi itself: the verdict always matches the real write target's containment.
    for (const p of [...escapes, ...inBounds, '~\\.bashrc']) {
      assert.equal(isContainedFromRoot(p, root), isContained(await piWriteTarget(p, root), root), p)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// File symlinks need Windows developer mode / admin.
const fileLinks = { skip: isWin }

test('REGRESSION: a dangling symlink inside the root is judged by its target, not its own name', fileLinks, () => {
  const root = tmpDir('dangle-')
  const outside = tmpDir('dangle-out-')
  try {
    // writeFile follows the link and creates the target, so an outside target must be refused…
    symlinkSync(join(outside, 'authorized_keys'), join(root, 'cfg.json'))
    assert.ok(!isContainedFromRoot('cfg.json', root))
    // …also when the link is a directory component of the path, or its target is relative.
    symlinkSync(join(outside, 'missing-dir'), join(root, 'dirlink'))
    assert.ok(!isContainedFromRoot('dirlink/x.txt', root))
    symlinkSync(join('..', parse(outside).base, 'rel.txt'), join(root, 'rel.json'))
    assert.ok(!isContainedFromRoot('rel.json', root))
    // …also when reached through an in-root directory link: `d/up` is root itself, so the relative
    // target is taken from root (escaping), not lexically from `d/up` (where it would stay in d/).
    mkdirSync(join(root, 'd'))
    symlinkSync('..', join(root, 'd', 'up'))
    assert.ok(!isContainedFromRoot(join('d', 'up', 'rel.json'), root))
    // A dangling link whose target is inside the root stays allowed.
    symlinkSync(join(root, 'not-yet.txt'), join(root, 'inside.json'))
    assert.ok(isContainedFromRoot('inside.json', root))
    // A link cycle can't be resolved at all — fail closed.
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'))
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'))
    assert.ok(!isContainedFromRoot('loop-a', root))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// The kernel follows each link in a target BEFORE applying a later `..`; resolve() and Node's JS
// realpathSync collapse `sub/..` first. With `a/b/sub -> ../..` (the repo itself), the target
// `a/b/sub/../x` is <repo>/../x, not <repo>/a/b/x. POSIX only: Windows keeps lexical resolution.
test('REGRESSION: a `..` after a link in a link target is judged where the kernel lands it', fileLinks, () => {
  const base = tmpDir('kdotdot-')
  const root = join(base, 'repo')
  try {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    symlinkSync(join('..', '..'), join(root, 'a', 'b', 'sub'))
    symlinkSync(join('a', 'b'), join(root, 'deep'))
    const link = (name: string, target: string) => symlinkSync(target, join(root, name))
    // Dangling targets outside, directly, through a chain, and as an absolute target.
    link('notes.md', 'a/b/sub/../x')
    link('chain.md', 'notes.md')
    link('abs.md', `${root}/a/b/sub/../y`) // not join(): it would collapse the `..` itself
    // An EXISTING outside file, with an in-repo decoy where the lexical reading points: the JS
    // realpath succeeds there and reported <repo>/a/b/existing.txt.
    writeFileSync(join(base, 'existing.txt'), 'outside')
    writeFileSync(join(root, 'a', 'b', 'existing.txt'), 'decoy')
    link('edit.md', 'a/b/sub/../existing.txt')
    // Targets the kernel keeps inside, although a lexical reading of the second one leaves the repo.
    link('ok.md', 'deep/../c.txt')
    link('up.md', 'deep/../../d.txt')
    // A `..` after a missing component can't be walked (the write fails ENOENT): fail closed.
    link('gap.md', 'missing/../e.txt')

    const verdicts = new Map<string, boolean>()
    for (const name of ['notes.md', 'chain.md', 'abs.md', 'edit.md', 'ok.md', 'up.md', 'gap.md']) {
      verdicts.set(name, isContainedFromRoot(name, root))
    }
    assert.deepEqual(Object.fromEntries(verdicts), {
      'notes.md': false, 'chain.md': false, 'abs.md': false, 'edit.md': false,
      'ok.md': true, 'up.md': true, 'gap.md': false,
    })
    // Every verdict matches where a real write through the link lands.
    const realRoot = realpathSync.native(root)
    for (const [name, verdict] of verdicts) {
      try { writeFileSync(join(root, name), 'w') } catch { assert.equal(name, 'gap.md'); continue } // ENOENT
      assert.equal(isInsideAny(realpathSync.native(join(root, name)), [realRoot]), verdict, name)
    }
    assert.equal(readFileSync(join(base, 'existing.txt'), 'utf8'), 'w', 'sanity: edit.md wrote outside')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// Repo content alone reaches this check: persona.ts looks for AGENTS.md / CLAUDE.md on every
// session view and turn, synchronously on the daemon's event loop. Link cycles, long chains and
// link texts that dive deep and climb back out must be judged in milliseconds (earlier versions of
// this code took seconds to minutes on some of them). Link texts stay under macOS's 1023-byte
// limit, except in the Linux-only deep case.
test('REGRESSION: hostile link layouts are judged quickly', fileLinks, () => {
  const base = realpathSync.native(tmpDir('khostile-')) // no link above the repo: exact link counts
  const root = join(base, 'repo')
  try {
    mkdirSync(join(root, 'r'), { recursive: true })
    const link = (name: string, target: string) => symlinkSync(target, join(root, name))
    link('d', '.')
    link('loop-a', `${'d/'.repeat(500)}loop-b`)
    link('loop-b', `${'d/'.repeat(500)}loop-a`)
    link('AGENTS.md', `${'d/'.repeat(500)}AGENTS.md`)
    link('cycle-a', `${'r/../'.repeat(200)}cycle-b`)
    link('cycle-b', `${'r/../'.repeat(200)}cycle-a`)
    // A dangling chain: `c1` takes 40 links (the kernel's limit) to reach end.txt, `c0` takes 41.
    for (let i = 0; i <= 40; i++) link(`c${i}`, i === 40 ? 'end.txt' : `c${i + 1}`)
    const expected: Record<string, boolean> = {
      'loop-a': false, 'AGENTS.md': false, 'cycle-a': false, c1: true, c0: false,
    }
    if (process.platform === 'linux') {
      // 30 links into a tree 780 deep and back out (Linux allows 4 KB link texts): each lookup
      // re-walks its path, so following them all costs most of a second. Refused past MAX_LOOKED.
      mkdirSync(join(root, ...Array<string>(780).fill('a')), { recursive: true })
      for (let i = 0; i < 30; i++) link(`deep${i}`, `${'a/'.repeat(780)}${'../'.repeat(780)}deep${i + 1}`)
      expected.deep0 = false
    }
    for (const [name, verdict] of Object.entries(expected)) {
      const start = performance.now()
      assert.equal(isContainedFromRoot(name, root), verdict, name)
      const ms = performance.now() - start
      // Under 60 ms on an idle machine; the walks this bound catches took 8 s and more. The
      // headroom is for a machine under load.
      assert.ok(ms < 2000, `${name} took ${ms.toFixed(0)} ms`)
    }
    if (process.platform === 'linux') {
      // MAX_LINKS is the kernel's own limit: the 40-link write lands, the 41-link one fails ELOOP.
      writeFileSync(join(root, 'c1'), 'w')
      assert.equal(readFileSync(join(root, 'end.txt'), 'utf8'), 'w')
      assert.throws(() => writeFileSync(join(root, 'c0'), 'w'), { code: 'ELOOP' })
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// The walk reads a link's target back as a JS string: bytes that aren't UTF-8 become U+FFFD and
// name a different (missing, in-repo) entry than the one the kernel follows.
test('REGRESSION: a link target that is not UTF-8 fails closed', fileLinks, (t) => {
  const base = tmpDir('kutf8-')
  const root = join(base, 'repo')
  try {
    mkdirSync(join(base, 'out'), { recursive: true })
    mkdirSync(root)
    const name = Buffer.from([0xff, 0x64]) // "\xffd"
    try {
      // `<repo>/\xffd -> <base>/out`, and `L -> \xffd/x`: a write through L lands in <base>/out/x.
      symlinkSync(join(base, 'out'), Buffer.concat([Buffer.from(root + sep), name]))
      symlinkSync(Buffer.concat([name, Buffer.from('/x')]), join(root, 'L'))
    } catch (e) {
      t.skip(`this filesystem refuses non-UTF-8 names: ${(e as NodeJS.ErrnoException).code}`)
      return
    }
    assert.ok(!isContainedFromRoot('L', root))
    writeFileSync(join(root, 'L'), 'w')
    assert.equal(readFileSync(join(base, 'out', 'x'), 'utf8'), 'w', 'sanity: the write landed outside')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('REGRESSION: a filesystem / drive root (`/`, `D:\\`) contains its descendants', () => {
  const fsRoot = parse(process.cwd()).root // '/' or e.g. 'C:\\'
  assert.ok(isInsideAny(join(fsRoot, 'src', 'a.ts'), [fsRoot]))
  assert.ok(isInsideAny(fsRoot, [fsRoot]))
  assert.ok(isContainedFromRoot(join('src', 'a.ts'), fsRoot))
  if (isWin) assert.ok(isInsideAny('D:\\src\\a.ts', ['D:\\']))
})

// Worktree tests, run against REAL git in a throwaway repo.
//
// Deliberately not mocked: every fact this feature depends on is a behaviour of git itself — that
// a worktree may live inside its own repo, that it doesn't recursively contain itself, that
// `worktree remove` refuses while dirty, and that removing one leaves its branch intact. Mocking
// `runGit` would assert only that the code calls the commands it calls, which is exactly the class
// of test that passes while the feature is broken.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentCwd,
  createSessionWorktree,
  ensureLocalExclude,
  findFreeBranchName,
  isGitRepo,
  removeSessionWorktree,
  runGit,
  sanitizeBranchName,
  WORKTREES_SUBDIR,
} from './worktree'

/** A real git repo with one commit. Returned path is absolute. */
async function makeRepo(): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), 'twt-')), 'repo')
  mkdirSync(root, { recursive: true })
  await runGit(root, ['init', '-q', '-b', 'main', '.'])
  await runGit(root, ['config', 'user.email', 't@t.t'])
  await runGit(root, ['config', 'user.name', 't'])
  writeFileSync(join(root, 'README.md'), 'hello\n')
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '-qm', 'init'])
  return root
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('agentCwd: the worktree wins when present, else the repo root', () => {
  assert.equal(agentCwd({ repoRoot: '/r', worktreePath: '/r/.turbollm/worktrees/x' }), '/r/.turbollm/worktrees/x')
  assert.equal(agentCwd({ repoRoot: '/r' }), '/r')
  assert.equal(agentCwd({}), '')
})

test('sanitizeBranchName: produces something git will actually accept', () => {
  assert.equal(sanitizeBranchName('Add login page'), 'add-login-page')
  // `:` and `~` are both illegal in a git ref, so both are stripped rather than escaped.
  assert.equal(sanitizeBranchName('  fix: the thing~1  '), 'fix-the-thing1')
  assert.equal(sanitizeBranchName('a..b'), 'a-b', 'git rejects a double dot in a ref')
  assert.equal(sanitizeBranchName('/leading/and/trailing/'), 'leading/and/trailing')
  assert.equal(sanitizeBranchName('weird.lock'), 'weird', 'git rejects a .lock suffix')
  assert.equal(sanitizeBranchName('~^:?*[]'), 'turbollm-session', 'all-illegal falls back, never empty')
  assert.equal(sanitizeBranchName(''), 'turbollm-session')
})

// ── against real git ─────────────────────────────────────────────────────────

test('isGitRepo: true inside a repo, false outside one', async () => {
  const root = await makeRepo()
  const plain = mkdtempSync(join(tmpdir(), 'twt-plain-'))
  try {
    assert.equal(await isGitRepo(root), true)
    assert.equal(await isGitRepo(plain), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
})

test('createSessionWorktree: creates an isolated checkout inside the repo, and does not nest', async () => {
  const root = await makeRepo()
  try {
    const r = await createSessionWorktree({ repoRoot: root, branch: 'Add login page' })
    assert.equal(r.ok, true, JSON.stringify(r))
    if (!r.ok) return

    assert.equal(r.branch, 'add-login-page')
    assert.equal(r.path, join(root, WORKTREES_SUBDIR, 'add-login-page'))
    assert.ok(existsSync(join(r.path, 'README.md')), 'the worktree has the repo files')
    // A worktree nested in its own repo could in principle contain itself; it cannot, because
    // .turbollm/ is untracked and therefore not part of any branch.
    assert.ok(!existsSync(join(r.path, '.turbollm')), 'must not contain itself')

    // It is a genuinely separate checkout on its own branch, not the base one.
    const head = await runGit(r.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(head.stdout.trim(), 'add-login-page')
    const baseHead = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(baseHead.stdout.trim(), 'main', 'the base repo stays on its own branch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSessionWorktree: edits in the worktree leave the base working tree untouched', async () => {
  // The whole point of the toggle: this is the assertion that was silently false before.
  const root = await makeRepo()
  try {
    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
    assert.ok(r.ok)
    if (!r.ok) return

    writeFileSync(join(r.path, 'README.md'), 'agent rewrote this\n')
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'hello\n', 'base repo file is unchanged')

    const baseStatus = await runGit(root, ['status', '--porcelain'])
    assert.equal(baseStatus.stdout.trim(), '', 'base repo working tree stays clean')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureLocalExclude: hides the worktree dir via .git/info/exclude, not the user\'s .gitignore', async () => {
  const root = await makeRepo()
  try {
    writeFileSync(join(root, '.gitignore'), 'node_modules\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'gitignore'])

    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
    assert.ok(r.ok)

    const status = await runGit(root, ['status', '--porcelain'])
    assert.equal(status.stdout.trim(), '', 'no `?? .turbollm/` noise in the base repo')
    // The user's own tracked file must be untouched — silently committing a line to it would be
    // an edit they never asked for.
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules\n')
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\/\.turbollm\/$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureLocalExclude: idempotent — never appends the same line twice', async () => {
  const root = await makeRepo()
  try {
    await ensureLocalExclude(root)
    await ensureLocalExclude(root)
    await ensureLocalExclude(root)
    const body = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
    const hits = body.split(/\r?\n/).filter((l) => l.trim() === '/.turbollm/').length
    assert.equal(hits, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findFreeBranchName: suffixes past names that already exist', async () => {
  const root = await makeRepo()
  try {
    assert.equal(await findFreeBranchName(root, 'feature'), 'feature')
    await runGit(root, ['branch', 'feature'])
    assert.equal(await findFreeBranchName(root, 'feature'), 'feature-2')
    await runGit(root, ['branch', 'feature-2'])
    assert.equal(await findFreeBranchName(root, 'feature'), 'feature-3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSessionWorktree: a taken branch name is suffixed, not an error', async () => {
  const root = await makeRepo()
  try {
    await runGit(root, ['branch', 'feature'])
    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    assert.equal(r.branch, 'feature-2', 'reported branch is the one git actually made')
    assert.equal(r.path, join(root, WORKTREES_SUBDIR, 'feature-2'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSessionWorktree: branches off the requested base when it resolves', async () => {
  const root = await makeRepo()
  try {
    await runGit(root, ['checkout', '-q', '-b', 'develop'])
    writeFileSync(join(root, 'only-on-develop.txt'), 'x\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'develop work'])
    await runGit(root, ['checkout', '-q', 'main'])

    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature', base: 'develop' })
    assert.ok(r.ok)
    if (!r.ok) return
    assert.ok(existsSync(join(r.path, 'only-on-develop.txt')), 'branched from develop, not main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSessionWorktree: an unresolvable base falls back to HEAD instead of failing', async () => {
  // A session that won't start is a worse answer than one branched off the current checkout.
  const root = await makeRepo()
  try {
    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature', base: 'no-such-branch' })
    assert.ok(r.ok, JSON.stringify(r))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSessionWorktree: a non-git folder is refused with an actionable message', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'twt-plain-'))
  try {
    const r = await createSessionWorktree({ repoRoot: plain, branch: 'feature' })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'not_a_repo')
    assert.match(r.message, /not a git repository/)
    assert.match(r.message, /Untick "Use worktree"/, 'tells the user how to proceed')
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

// ── removal ──────────────────────────────────────────────────────────────────

test('removeSessionWorktree: REFUSES while the worktree has uncommitted work', async () => {
  const root = await makeRepo()
  try {
    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
    assert.ok(r.ok)
    if (!r.ok) return
    writeFileSync(join(r.path, 'README.md'), 'unmerged agent work\n')

    const removed = await removeSessionWorktree(root, r.path)
    assert.equal(removed.ok, false)
    if (removed.ok) return
    assert.equal(removed.code, 'dirty')
    assert.ok(existsSync(r.path), 'the work is still on disk')
    assert.match(removed.message, /git worktree remove/, 'hands over the exact command to finish')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeSessionWorktree: removes a clean worktree but KEEPS its branch', async () => {
  // Committed agent work must survive deleting the session.
  const root = await makeRepo()
  try {
    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
    assert.ok(r.ok)
    if (!r.ok) return
    writeFileSync(join(r.path, 'new.txt'), 'agent output\n')
    await runGit(r.path, ['add', '-A'])
    await runGit(r.path, ['commit', '-qm', 'agent work'])

    const removed = await removeSessionWorktree(root, r.path)
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.ok(!existsSync(r.path), 'directory gone')

    const branches = await runGit(root, ['branch', '--list', 'feature'])
    assert.match(branches.stdout, /feature/, 'the branch — and the commit on it — survives')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runGit: a failing command resolves rather than throwing', async () => {
  const root = await makeRepo()
  try {
    const r = await runGit(root, ['definitely-not-a-git-command'])
    assert.equal(r.ok, false)
    assert.ok(r.stderr.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── every produced name must be a name git will actually accept ──────────────────────────────
// Found in the manual review pass that substituted for a non-delivering review agent: the
// trailing `[/.]` strip ran BEFORE the 80-char cap, so the cap could land mid-string and
// re-expose a character git rejects at the end of a ref. A 79-character task description followed
// by a `.` produced a branch git refuses outright — session creation would fail for nothing more
// than a long description.
//
// Asserted against `git check-ref-format` rather than a regex of my own: the authority on what git
// accepts is git, and a hand-written expectation is exactly what missed this the first time.
test('sanitizeBranchName: output always passes git check-ref-format', async () => {
  const cases = [
    'a'.repeat(79) + '. and then some more words to push past the cap',
    'a'.repeat(79) + '/ and then some more words to push past the cap',
    'a'.repeat(79) + '- and then some more words to push past the cap',
    'refactor the authentication module and split it into smaller files please',
    'Add login page',
    'fix: the thing~1',
    '~^:?*[]',
    'weird.lock',
    '/leading/and/trailing/',
    'a'.repeat(200),
  ]
  const root = await makeRepo()
  try {
    for (const raw of cases) {
      const name = sanitizeBranchName(raw)
      const r = await runGit(root, ['check-ref-format', '--branch', name])
      assert.equal(r.ok, true, `git rejected ${JSON.stringify(name)} (from ${JSON.stringify(raw.slice(0, 40))}…): ${r.stderr.trim()}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sanitizeBranchName: a long name is capped without ending in a separator', () => {
  const out = sanitizeBranchName('a'.repeat(79) + '. more')
  assert.ok(out.length <= 80)
  assert.ok(!/[-./]$/.test(out), `must not end in a separator, got ${JSON.stringify(out)}`)
})

// ── a directory that is already gone is SUCCESS, not failure ─────────────────────────────────
// Founder-reported: deleting a session whose folder no longer existed returned
// `worktreeNote: "spawn git ENOENT"` — git cannot even start when its cwd is missing. The delete
// itself had succeeded, but the raw Node error on the response made it look like it had failed.
// Nothing to remove is nothing to report.
test('removeSessionWorktree: a worktree that no longer exists is a clean success', async () => {
  const root = await makeRepo()
  try {
    const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
    assert.ok(r.ok)
    if (!r.ok) return
    // Someone removed it by hand, or deleted the folder.
    rmSync(r.path, { recursive: true, force: true })

    const removed = await removeSessionWorktree(root, r.path)
    assert.equal(removed.ok, true, `expected success, got ${JSON.stringify(removed)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeSessionWorktree: a base repo that no longer exists is also a clean success', async () => {
  // The whole project moved or was deleted, or its drive is unplugged. There is nothing to clean
  // and no way to run git — reporting `spawn git ENOENT` to the user helps nobody.
  const root = await makeRepo()
  const worktreePath = join(root, WORKTREES_SUBDIR, 'feature')
  rmSync(root, { recursive: true, force: true })
  const removed = await removeSessionWorktree(root, worktreePath)
  assert.equal(removed.ok, true, `expected success, got ${JSON.stringify(removed)}`)
})

test('removeSessionWorktree: a DIRTY worktree is still refused — the guard did not weaken that', () => {
  // Guarding on existence must not turn the "never destroy uncommitted work" rule into a no-op.
  return (async () => {
    const root = await makeRepo()
    try {
      const r = await createSessionWorktree({ repoRoot: root, branch: 'feature' })
      assert.ok(r.ok)
      if (!r.ok) return
      writeFileSync(join(r.path, 'README.md'), 'unmerged work\n')
      const removed = await removeSessionWorktree(root, r.path)
      assert.equal(removed.ok, false)
      if (!removed.ok) assert.equal(removed.code, 'dirty')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })()
})

// Worktree tests, run against REAL git in a throwaway repo.
//
// Deliberately not mocked: every fact this feature depends on is a behaviour of git itself — that
// a worktree may live inside its own repo, that it doesn't recursively contain itself, that
// `worktree remove` refuses while dirty, and that removing one leaves its branch intact. Mocking
// `runGit` would assert only that the code calls the commands it calls, which is exactly the class
// of test that passes while the feature is broken.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { copyBaseRepo } from '../test-support/git-repo'
import { tmpDir } from '../test-support/tmp'

/** A real git repo with one commit, in a folder of its own. Returned path is absolute. */
async function makeRepo(): Promise<string> {
  return copyBaseRepo(join(tmpDir('twt-'), 'repo'))
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
  // A leading `-` would reach the internal `git branch` as an option (`unknown switch`).
  assert.equal(sanitizeBranchName('- fix the login bug'), 'fix-the-login-bug')
})

// ── against real git ─────────────────────────────────────────────────────────

test('isGitRepo: true inside a repo, false outside one', async () => {
  const root = await makeRepo()
  const plain = tmpDir('twt-plain-')
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

test('REGRESSION: ensureLocalExclude: a base folder that is itself a linked worktree hides .turbollm/ too', async () => {
  // A linked worktree's own gitdir is <main>/.git/worktrees/<name>, whose info/exclude git never
  // reads: the line went there, the base checkout listed `?? .turbollm/`, and `git add -A` (the Git
  // dialog's commit-all) staged the session worktree as an embedded repo.
  const root = await makeRepo()
  const linked = join(root, '..', 'linked')
  try {
    assert.ok((await runGit(root, ['worktree', 'add', '-q', '-b', 'linked', linked])).ok)
    const r = await createSessionWorktree({ repoRoot: linked, branch: 'feat' })
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    assert.equal(r.path, join(linked, WORKTREES_SUBDIR, 'feat'))
    assert.equal((await runGit(linked, ['status', '--porcelain'])).stdout.trim(), '', 'no `?? .turbollm/` in the linked base')
    await runGit(linked, ['add', '-A', '--', '.'])
    assert.equal((await runGit(linked, ['diff', '--cached', '--name-only'])).stdout.trim(), '', 'commit-all stages no gitlink')
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\/\.turbollm\/$/m, 'written to the common dir')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
})

test('REGRESSION: ensureLocalExclude: a base folder reached through a symlink into a repo subfolder hides .turbollm/ too', async () => {
  // <tmp>/home/web -> <tmp>/repo/packages/web. git prints `--git-path info/exclude` relative to its
  // PHYSICAL cwd (../../.git/info/exclude); resolved against the symlink's own path it named
  // <tmp>/.git/info/exclude, outside any repo, and the base checkout listed `?? .turbollm/`.
  const root = await makeRepo()
  const tmp = join(root, '..')
  try {
    mkdirSync(join(root, 'packages', 'web'), { recursive: true })
    writeFileSync(join(root, 'packages', 'web', 'index.ts'), 'export {}\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'web'])
    mkdirSync(join(tmp, 'home'))
    const link = join(tmp, 'home', 'web')
    // 'junction' so this also runs on Windows without admin rights; ignored elsewhere.
    symlinkSync(join(root, 'packages', 'web'), link, 'junction')

    const r = await createSessionWorktree({ repoRoot: link, branch: 'feat' })
    assert.ok(r.ok, JSON.stringify(r))
    assert.equal((await runGit(root, ['status', '--porcelain'])).stdout.trim(), '', 'no `?? .turbollm/` in the base checkout')
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\/\.turbollm\/$/m)
    assert.ok(!existsSync(join(tmp, '.git')), 'no stray .git/info/exclude above the symlink')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
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
  const plain = tmpDir('twt-plain-')
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

/** Tasks and typed branch names that used to come out as names Git for Windows cannot create. */
const WINDOWS_UNSAFE_TASKS = [
  'Rename "foo" to "bar"',
  'Make <Button> accept a | separator',
  'con', 'NUL', 'aux', 'prn', 'com1', 'LPT9', 'com¹', 'conin$', 'CONOUT$',
  'con.txt', 'nul.tar.gz', 'turbo/con', 'turbo/aux/fix', 'con/con',
  'con -', 'con.lock', 'aux.lock/b',
  'a'.repeat(76) + '/console window',
  'v2./fix', 'x.lock./y',
]

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
    // Each of these used to come out as a name git refuses.
    '- fix the login bug',
    '-- refactor',
    'use @{upstream} config',
    'docs/.hidden notes',
    'a.lock/b',
    'a/x.lock.lock/.b',
    'tab\there\u0001bell\u007f',
    // The Windows-safe rewrites (next test) must keep the name valid for git too.
    ...WINDOWS_UNSAFE_TASKS,
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

// The branch is a loose ref file under .git/refs/heads/ and the folder .turbollm/worktrees/<branch>,
// and Git for Windows refuses ("Invalid argument") to create either when a path part holds `"<>|`,
// ends in `.`, or is a reserved device name. `git check-ref-format` accepts all of these, so the
// fuzz above could not catch it, and on Windows a session started from such a task (or a typed
// branch `con`) failed with git_failed. This mirrors Git for Windows' is_valid_win32_path
// (compat/mingw.c) for the characters the sanitizer can let through; on Linux and macOS git
// accepts every one of these names, so this is asserted on every platform, in pure code.
function windowsRefusal(name: string): string | null {
  if (/[<>:"|?*\\\x00-\x1f]/.test(name)) return 'a character Windows forbids'
  for (const part of name.split('/')) {
    if (/[. ]$/.test(part)) return `part ${JSON.stringify(part)} ends in a dot or space`
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?=[. :]|$)/i.test(part)) {
      return `part ${JSON.stringify(part)} is a reserved device name`
    }
  }
  return null
}

test('REGRESSION: sanitizeBranchName: output is a name Git for Windows can create', () => {
  for (const raw of WINDOWS_UNSAFE_TASKS) {
    const name = sanitizeBranchName(raw)
    assert.equal(windowsRefusal(name), null, `${JSON.stringify(name)} (from ${JSON.stringify(raw.slice(0, 40))})`)
  }
  // The rewrite keeps the words: a separator becomes `-`, a device name gets a `-` after it.
  assert.equal(sanitizeBranchName('Rename "foo" to "bar"'), 'rename-foo-to-bar')
  assert.equal(sanitizeBranchName('Make <Button> accept a | separator'), 'make-button-accept-a-separator')
  assert.equal(sanitizeBranchName('con'), 'con-')
  assert.equal(sanitizeBranchName('NUL'), 'nul-')
  assert.equal(sanitizeBranchName('con.txt'), 'con-.txt')
  assert.equal(sanitizeBranchName('turbo/con'), 'turbo/con-')
  assert.equal(sanitizeBranchName('v2./fix'), 'v2/fix')
  // Not device names: only the whole part (or the part before its extension) is reserved.
  assert.equal(sanitizeBranchName('console/connect'), 'console/connect')
  assert.equal(sanitizeBranchName('com10'), 'com10')
  assert.equal(sanitizeBranchName('icon'), 'icon')
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

test('REGRESSION: a worktree session started at a repo subfolder works in that subfolder of a worktree at the repo top level', async () => {
  // `git worktree add` checks out the whole repository and the exclude line is anchored at its top
  // level: placed under the picked subfolder, the agent worked across the whole repo and the base
  // repo listed `?? packages/web/.turbollm/` (which a commit-all then staged as an embedded repo).
  const root = await makeRepo()
  try {
    const sub = join(root, 'packages', 'web')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'a.ts'), 'a\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'package'])

    const r = await createSessionWorktree({ repoRoot: sub, branch: 'feat' })
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    assert.ok(existsSync(join(r.path, 'a.ts')), 'the session works in the package folder')
    assert.equal((await runGit(r.path, ['rev-parse', '--show-prefix'])).stdout.trim(), 'packages/web/')
    assert.equal((await runGit(r.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'feat')
    assert.ok(!existsSync(join(sub, '.turbollm')), 'nothing created inside the base package')
    assert.equal((await runGit(root, ['status', '--porcelain'])).stdout.trim(), '', 'base repo stays clean')

    const removed = await removeSessionWorktree(sub, r.path)
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.ok(!existsSync(r.path), 'worktree removed')
    assert.equal((await runGit(root, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('REGRESSION: removing a subfolder session\'s worktree whose folder is gone from it, or one in the old layout', async () => {
  const root = await makeRepo()
  try {
    const sub = join(root, 'web')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.ts'), 'a\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'package'])
    const worktreeCount = async () => (await runGit(root, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length

    // The session's folder is gone from the worktree (the agent removed the package): the worktree
    // itself is still removed, or reported dirty while the removal is uncommitted.
    const r = await createSessionWorktree({ repoRoot: sub, branch: 'drop-web' })
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    const top = join(root, '.turbollm', 'worktrees', 'drop-web')
    rmSync(r.path, { recursive: true })
    const dirty = await removeSessionWorktree(sub, r.path)
    assert.equal(dirty.ok, false, 'an uncommitted removal is work: left in place')
    if (!dirty.ok) assert.match(dirty.message, /drop-web" *$/)
    await runGit(top, ['commit', '-qam', 'remove the package'])
    assert.deepEqual(await removeSessionWorktree(sub, r.path), { ok: true })
    assert.ok(!existsSync(top), 'worktree removed')
    assert.equal(await worktreeCount(), 1)

    // Created before worktrees moved to the top level, on a branch named like the folder: its
    // stored path ends with the folder's prefix but is itself the worktree.
    const old = join(sub, '.turbollm', 'worktrees', 'web')
    assert.ok((await runGit(sub, ['worktree', 'add', '-q', '-b', 'web', old])).ok)
    assert.deepEqual(await removeSessionWorktree(sub, old), { ok: true })
    assert.ok(!existsSync(old), 'old-layout worktree removed')
    assert.equal(await worktreeCount(), 1)
    assert.deepEqual(await removeSessionWorktree(sub, old), { ok: true }, 'already gone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('REGRESSION: a subfolder session\'s worktree is removed even when its folder is gone from the base checkout', async () => {
  // The worktree lives under the repository's top level, so it outlives the base subfolder (here:
  // the base checks out a branch without it). Deleting the session reported success and left the
  // worktree registered, its branch checked out there and unusable anywhere else.
  const root = await makeRepo()
  try {
    assert.ok((await runGit(root, ['branch', 'old'])).ok, 'a branch without the package')
    const sub = join(root, 'packages', 'web')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'a.ts'), 'a\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'package'])
    const worktreeCount = async () => (await runGit(root, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length

    const r = await createSessionWorktree({ repoRoot: sub, branch: 'feat' })
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    const top = join(root, WORKTREES_SUBDIR, 'feat')
    assert.ok((await runGit(root, ['checkout', '-q', 'old'])).ok)
    assert.ok(!existsSync(sub), 'the base folder is gone')

    // Uncommitted work in it is still refused, not silently kept as "done".
    writeFileSync(join(r.path, 'a.ts'), 'unmerged work\n')
    const dirty = await removeSessionWorktree(sub, r.path)
    assert.equal(dirty.ok, false, JSON.stringify(dirty))
    if (!dirty.ok) assert.equal(dirty.code, 'dirty')
    await runGit(r.path, ['checkout', '--', 'a.ts'])

    assert.deepEqual(await removeSessionWorktree(sub, r.path), { ok: true })
    assert.ok(!existsSync(top), 'worktree removed')
    assert.equal(await worktreeCount(), 1)
    assert.ok((await runGit(root, ['checkout', '-q', 'feat'])).ok, 'its branch is free again')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('REGRESSION: a worktree is removed when the base was a link into a subfolder the base checkout no longer has', async () => {
  // <tmp>/home/web -> <tmp>/repo/packages/web, and the base checks out a branch without it: the link
  // dangles. Walking up from the link's own name stopped at <tmp>/home, in no repository, so
  // `git worktree remove` failed with "not a git repository" and the worktree stayed registered.
  const root = await makeRepo()
  const tmp = join(root, '..')
  try {
    assert.ok((await runGit(root, ['branch', 'old'])).ok, 'a branch without the package')
    mkdirSync(join(root, 'packages', 'web'), { recursive: true })
    writeFileSync(join(root, 'packages', 'web', 'a.ts'), 'a\n')
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'package'])
    mkdirSync(join(tmp, 'home'))
    const link = join(tmp, 'home', 'web')
    // 'junction' so this also runs on Windows without admin rights; ignored elsewhere.
    symlinkSync(join(root, 'packages', 'web'), link, 'junction')

    const r = await createSessionWorktree({ repoRoot: link, branch: 'feat' })
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    assert.ok((await runGit(root, ['checkout', '-q', 'old'])).ok)
    assert.ok(!existsSync(link), 'the link dangles')

    assert.deepEqual(await removeSessionWorktree(link, r.path), { ok: true })
    assert.ok(!existsSync(join(root, WORKTREES_SUBDIR, 'feat')), 'worktree removed')
    assert.equal((await runGit(root, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 1)
    assert.ok((await runGit(root, ['checkout', '-q', 'feat'])).ok, 'its branch is free again')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

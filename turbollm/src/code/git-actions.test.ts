// Unit tests for git-actions.ts — real git subprocesses against real throwaway repos (no mocking
// of child_process or the filesystem), matching this codebase's own testing discipline for
// process-lifecycle/exec code (see robust-bash.test.ts, revert.test.ts). Pushes are tested against
// a real local bare repo used as the "remote" — a plain filesystem path is a completely valid git
// remote, so this exercises the real push/rejection code paths without touching the network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGithubCompareUrl,
  commitGitChanges,
  getGithubCompareUrl,
  getGitStatus,
  GitError,
  pushGitBranch,
} from './git-actions'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true }).trim()
}

/** A real repo, one commit in, on a fixed branch name (explicit -b so tests never depend on the
 *  ambient init.defaultBranch config) with local test-only identity so commits work in any CI
 *  environment regardless of global git config. */
function initRepo(branch = 'main'): string {
  const dir = tmp('tllm-git-actions-')
  gitSync(['init', '-b', branch, '-q'], dir)
  gitSync(['config', 'user.email', 'test@example.com'], dir)
  gitSync(['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  gitSync(['add', 'README.md'], dir)
  gitSync(['commit', '-q', '-m', 'init'], dir)
  return dir
}

/** A real bare repo (a valid git remote — just a filesystem path) to push/pull against, so the
 *  push/diverged-push tests exercise the real network-shaped code path locally. HEAD is pointed
 *  at 'main' explicitly — a fresh bare repo's HEAD otherwise defaults to whatever
 *  init.defaultBranch resolves to locally (often 'master'), which doesn't exist once a push only
 *  ever creates 'main', so a later `git clone` of it fails to check anything out. */
function initBareRemote(): string {
  const dir = tmp('tllm-git-actions-remote-')
  gitSync(['init', '--bare', '-q'], dir)
  gitSync(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir)
  return dir
}

test('getGitStatus: a plain non-repo folder reports isRepo:false', async () => {
  const dir = tmp('tllm-git-actions-notrepo-')
  const status = await getGitStatus(dir)
  assert.equal(status.isRepo, false)
  assert.deepEqual(status.files, [])
})

test('getGitStatus: a brand-new repo with no commits (unborn HEAD) is still isRepo:true, with an empty branch', async () => {
  const dir = tmp('tllm-git-actions-unborn-')
  gitSync(['init', '-b', 'main', '-q'], dir)
  const status = await getGitStatus(dir)
  assert.equal(status.isRepo, true)
  assert.equal(status.branch, '')
  assert.equal(status.detached, false)
})

test('getGitStatus: a clean tree after a commit reports no files, and the real branch name', async () => {
  const dir = initRepo('main')
  const status = await getGitStatus(dir)
  assert.equal(status.isRepo, true)
  assert.equal(status.branch, 'main')
  assert.deepEqual(status.files, [])
  assert.equal(status.hasRemote, false)
})

test('getGitStatus: an untracked new file shows up with the real porcelain code', async () => {
  const dir = initRepo()
  writeFileSync(join(dir, 'new.txt'), 'new\n')
  const status = await getGitStatus(dir)
  assert.deepEqual(status.files, [{ code: '??', path: 'new.txt' }])
})

test('getGitStatus: a configured remote is reflected in hasRemote', async () => {
  const dir = initRepo()
  const remote = initBareRemote()
  gitSync(['remote', 'add', 'origin', remote], dir)
  const status = await getGitStatus(dir)
  assert.equal(status.hasRemote, true)
})

test('getGitStatus: after pushing with tracking, ahead/behind reflects an un-pushed local commit', async () => {
  const dir = initRepo()
  const remote = initBareRemote()
  gitSync(['remote', 'add', 'origin', remote], dir)
  gitSync(['push', '-u', 'origin', 'main'], dir)
  let status = await getGitStatus(dir)
  assert.equal(status.hasUpstream, true)
  assert.equal(status.ahead, 0)
  assert.equal(status.behind, 0)

  appendFileSync(join(dir, 'README.md'), 'more\n')
  gitSync(['commit', '-aq', '-m', 'second'], dir)
  status = await getGitStatus(dir)
  assert.equal(status.ahead, 1)
  assert.equal(status.behind, 0)
})

test('commitGitChanges: rejects an empty/whitespace-only message without touching git', async () => {
  const dir = initRepo()
  writeFileSync(join(dir, 'new.txt'), 'x\n')
  await assert.rejects(() => commitGitChanges(dir, '   '), GitError)
  // Nothing was staged/committed by the rejected call.
  const status = await getGitStatus(dir)
  assert.deepEqual(status.files, [{ code: '??', path: 'new.txt' }])
})

test('commitGitChanges: rejects when the working tree is clean (nothing to commit)', async () => {
  const dir = initRepo()
  await assert.rejects(() => commitGitChanges(dir, 'a message'), /Nothing to commit/)
})

test('commitGitChanges: default (no files given) stages and commits everything', async () => {
  const dir = initRepo()
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  const result = await commitGitChanges(dir, 'add a and b')
  assert.equal(result.filesCommitted, 2)
  assert.match(result.hash, /^[0-9a-f]{40}$/)
  const status = await getGitStatus(dir)
  assert.deepEqual(status.files, [])
})

test('commitGitChanges: an explicit file list stages ONLY those paths, leaving the rest untouched', async () => {
  const dir = initRepo()
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  const result = await commitGitChanges(dir, 'add only a', ['a.txt'])
  assert.equal(result.filesCommitted, 1)
  const status = await getGitStatus(dir)
  assert.deepEqual(status.files, [{ code: '??', path: 'b.txt' }])
})

test('commitGitChanges: refuses a path outside the repo root (containment), without staging anything', async () => {
  const dir = initRepo()
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  const outside = join(tmpdir(), 'not-in-repo.txt')
  await assert.rejects(
    () => commitGitChanges(dir, 'escape attempt', [outside]),
    /outside the repo/,
  )
  const status = await getGitStatus(dir)
  // a.txt is still untracked — the rejected call never ran `git add`.
  assert.deepEqual(status.files, [{ code: '??', path: 'a.txt' }])
})

test('pushGitBranch: no remote configured reports the no_remote reason, not a thrown error', async () => {
  const dir = initRepo()
  const result = await pushGitBranch(dir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'no_remote')
})

test('pushGitBranch: a detached HEAD is refused before ever attempting a push', async () => {
  const dir = initRepo()
  const remote = initBareRemote()
  gitSync(['remote', 'add', 'origin', remote], dir)
  const headSha = gitSync(['rev-parse', 'HEAD'], dir)
  gitSync(['checkout', '-q', headSha], dir) // detach
  const result = await pushGitBranch(dir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'detached_head')
})

test('pushGitBranch: a real push to a local bare remote succeeds and sets upstream on first push', async () => {
  const dir = initRepo()
  const remote = initBareRemote()
  gitSync(['remote', 'add', 'origin', remote], dir)
  const result = await pushGitBranch(dir)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.remote, 'origin')
    assert.equal(result.branch, 'main')
  }
  const status = await getGitStatus(dir)
  assert.equal(status.hasUpstream, true)
})

test('pushGitBranch: a diverged remote is rejected as "diverged", never force-pushed', async () => {
  const remote = initBareRemote()
  const a = initRepo()
  gitSync(['remote', 'add', 'origin', remote], a)
  const first = await pushGitBranch(a)
  assert.equal(first.ok, true)

  // A second, independent clone of the SAME remote — diverges by committing without ever
  // fetching a's later commit.
  const b = tmp('tllm-git-actions-clone-')
  gitSync(['clone', '-q', remote, '.'], b)
  gitSync(['config', 'user.email', 'test@example.com'], b)
  gitSync(['config', 'user.name', 'Test'], b)
  writeFileSync(join(b, 'from-b.txt'), 'b\n')
  gitSync(['add', 'from-b.txt'], b)
  gitSync(['commit', '-q', '-m', 'from b'], b)
  const pushedB = await pushGitBranch(b)
  assert.equal(pushedB.ok, true) // b pushes first, moving the remote ahead of a's local view

  // a is now behind the remote — its push must be rejected, not force-pushed.
  appendFileSync(join(a, 'README.md'), 'from a, unaware of b\n')
  gitSync(['commit', '-aq', '-m', 'from a'], a)
  const result = await pushGitBranch(a)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'diverged')

  // Confirm nothing was force-pushed: the remote's tip is still b's commit, not a rewritten
  // history discarding it.
  const remoteTip = gitSync(['log', '-1', '--format=%s', 'HEAD'], b)
  assert.equal(remoteTip, 'from b')
})

test('buildGithubCompareUrl: parses an https GitHub remote', () => {
  assert.equal(
    buildGithubCompareUrl('https://github.com/acme/widgets.git', 'feature/x'),
    'https://github.com/acme/widgets/compare/feature%2Fx?expand=1',
  )
})

test('buildGithubCompareUrl: parses an ssh GitHub remote', () => {
  assert.equal(
    buildGithubCompareUrl('git@github.com:acme/widgets.git', 'main'),
    'https://github.com/acme/widgets/compare/main?expand=1',
  )
})

test('buildGithubCompareUrl: a non-GitHub remote resolves to null, not an error', () => {
  assert.equal(buildGithubCompareUrl('https://gitlab.com/acme/widgets.git', 'main'), null)
  assert.equal(buildGithubCompareUrl('/local/bare/repo', 'main'), null)
})

test('getGithubCompareUrl: no origin remote resolves to null', async () => {
  const dir = initRepo()
  assert.equal(await getGithubCompareUrl(dir, 'main'), null)
})

test('getGithubCompareUrl: a GitHub-style origin resolves the real compare URL', async () => {
  const dir = initRepo()
  gitSync(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], dir)
  assert.equal(await getGithubCompareUrl(dir, 'main'), 'https://github.com/acme/widgets/compare/main?expand=1')
})

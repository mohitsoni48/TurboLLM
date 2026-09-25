import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyBaseRepo, tmpGitRepo } from './git-repo'
import { tmpDir } from './tmp'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('tmpGitRepo: is a clean repo on main with a single "init" commit holding README.md', () => {
  const repo = tmpGitRepo('git-repo-test-')

  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(git(repo, 'log', '--format=%s'), 'init')
  assert.equal(git(repo, 'status', '--porcelain'), '')
  assert.ok(existsSync(join(repo, 'README.md')))
})

test('tmpGitRepo: carries its own committer identity, so commits work under any global git config', () => {
  const repo = tmpGitRepo('git-repo-test-')

  assert.equal(git(repo, 'config', 'user.email'), 'test@example.com')
  assert.equal(git(repo, 'config', 'user.name'), 'Test')
})

test('tmpGitRepo: every call is an independent copy', () => {
  const first = tmpGitRepo('git-repo-test-')
  const second = tmpGitRepo('git-repo-test-')

  git(first, 'commit', '--allow-empty', '-q', '-m', 'only in the first')

  assert.equal(git(first, 'rev-list', '--count', 'HEAD'), '2')
  assert.equal(git(second, 'rev-list', '--count', 'HEAD'), '1')
})

test('tmpGitRepo: leaves out the sample hooks git copies into every new repo', () => {
  const repo = tmpGitRepo('git-repo-test-')

  assert.equal(existsSync(join(repo, '.git', 'hooks', 'pre-commit.sample')), false)
})

test('copyBaseRepo: puts the repo exactly where the test asks, so it can sit inside another folder', () => {
  const destination = join(tmpDir('git-repo-test-'), 'repo')

  const repo = copyBaseRepo(destination)

  assert.equal(repo, destination)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1')
})

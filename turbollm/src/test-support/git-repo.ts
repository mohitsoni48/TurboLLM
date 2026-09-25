// A git repo for tests that need one. Building a repo takes five git processes and leaves ~30
// files (14 of them sample hooks nobody reads), so it is built ONCE per process and every test
// gets a plain file copy of it. Copies are independent: a test may commit, branch or dirty its
// own without touching anyone else's.
import { execFileSync } from 'node:child_process'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from './tmp'

let baseRepo: string | null = null

/** A fresh directory holding its own copy of the base repo. */
export function tmpGitRepo(prefix: string): string {
  return copyBaseRepo(tmpDir(prefix))
}

/** Copies the base repo to `destination`, for tests that need it at a particular path. */
export function copyBaseRepo(destination: string): string {
  cpSync(sharedBaseRepo(), destination, { recursive: true })
  return destination
}

function sharedBaseRepo(): string {
  if (baseRepo === null) baseRepo = buildBaseRepo()
  return baseRepo
}

/** One commit ("init", holding README.md) on `main`. The branch is named explicitly so tests
 *  never depend on the ambient init.defaultBranch, and the identity is repo-local so commits
 *  work in any CI environment whatever the global git config says. */
function buildBaseRepo(): string {
  const repo = tmpDir('git-base-repo-')
  runGit(repo, 'init', '-q', '-b', 'main', `--template=${tmpDir('git-empty-template-')}`)
  runGit(repo, 'config', 'user.email', 'test@example.com')
  runGit(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  runGit(repo, 'add', 'README.md')
  runGit(repo, 'commit', '-q', '-m', 'init')
  return repo
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true })
}

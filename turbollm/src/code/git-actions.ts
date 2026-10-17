// Git commit/push + PR-link actions for Code sessions (Phase 3, ADR-259) — thin, safe wrappers
// around real `git` subprocess calls in a session's repoRoot. Every call uses execFile with an
// argv array (never a shell string), matching routes.ts's `/api/v1/fs/git-branch` route (the one
// existing precedent for shelling out to git in this codebase) — a command never passes through a
// shell, so there's no injection surface even from a user-supplied commit message or file path.
//
// Scope, deliberately narrow for this pass (see docs/decisions/decision-log.md ADR-259):
//  - Commit + push only; NO GitHub API call anywhere. "Open a PR" resolves to a GitHub compare URL
//    the UI opens in the user's own browser (parsed from the remote's own URL) — there is no
//    existing `gh` CLI / GitHub token precedent anywhere in this codebase to build real PR
//    creation on (grepped: zero matches outside docs/RELEASE.md's own release runbook, a
//    human-run script, not app code), and inventing auth handling for it from scratch is
//    explicitly out of scope for this task. Non-GitHub remotes (GitLab, Bitbucket, a bare local
//    path) just get `compareUrl: null` — a graceful miss, not an error.
//  - Push NEVER forces, ever. A rejected (non-fast-forward) push is surfaced as a typed result the
//    caller must react to, not silently retried with --force — this repo's own CLAUDE.md treats
//    force-push as something that requires explicit human authorization every time, and a Code
//    session pushing on a user's behalf gets no special exemption from that.
//  - A detached HEAD can commit (git allows it) but is refused for push — `git push` from a
//    detached HEAD needs an explicit `<remote> HEAD:<branch>` refspec, extra complexity/risk this
//    pass doesn't add; surfaced as a distinct, actionable error instead of a confusing generic one.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isInsideAny } from './containment'

const execFileAsync = promisify(execFile)

// Local, read-only/local-mutation ops (status, add, commit) — bounded short since nothing here
// touches the network.
const GIT_TIMEOUT_MS = 15_000
// Push touches the network — more headroom, but still bounded so a hung credential prompt can't
// wedge a daemon request forever. GIT_TERMINAL_PROMPT=0 (set on every call below) is the real fix
// for that case; this timeout is only the backstop if it doesn't work for the remote's exact auth
// setup (e.g. a credential helper that itself hangs instead of erroring).
const GIT_NETWORK_TIMEOUT_MS = 30_000
// The most a git call may print. execFile's default, 1 MiB, is only a few thousand paths: after a
// commit-all of a new folder of generated files (a build output, a vendored tree), `diff --cached
// --name-only` printed more than that and the call failed. Still bounded, so a runaway output
// can't take the daemon's memory; past it the call fails and the caller reports that failure.
const GIT_MAX_BUFFER = 64 * 1024 * 1024
// The most characters of paths one `git add` is given; a longer selection is staged in several
// calls. Every path went on one command line, and past the OS limit the spawn failed before git
// ran: Windows passes a program its arguments as one command line of at most 32,767 characters
// (libuv fails the spawn with ENAMETOOLONG), a few hundred paths, and Linux and macOS refuse an
// exec whose arguments pass ARG_MAX (E2BIG; 2 MiB and 1 MiB by default). Below Windows' limit with
// room for the quotes and separators it adds per path and for the rest of the command line.
const GIT_ADD_PATHS_BUDGET = 24_000

export class GitError extends Error {
  readonly stderr: string
  readonly exitCode: number | null
  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message)
    this.name = 'GitError'
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      // Never block on an interactive username/password/passphrase prompt — surface the auth
      // failure as a normal command error instead of hanging the request.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    // trimEnd, not trim: `status --porcelain` lines start with a significant space (' M path' =
    // unstaged change), and stripping the first one shifted that entry's code and path by a char.
    return stdout.trimEnd()
  } catch (e) {
    const failure = e as { stderr?: string; code?: number; killed?: boolean; message: string }
    if (failure.killed) throw new GitError(`git ${args[0]} timed out after ${timeoutMs}ms`, failure.stderr ?? '', null)
    throw new GitError((failure.stderr ?? '').trim() || failure.message, failure.stderr ?? '', failure.code ?? null)
  }
}

export interface GitFileStatus {
  path: string
  /** Raw two-character porcelain status code (e.g. 'M ', '??', ' D', 'AM') — the UI maps this to
   *  an icon/label; not re-interpreted here so no meaning is lost or guessed at. */
  code: string
}

export interface GitStatusResult {
  isRepo: boolean
  /** '' for an unborn HEAD (brand-new repo, no commits yet) or a detached HEAD. */
  branch: string
  detached: boolean
  files: GitFileStatus[]
  hasRemote: boolean
  /** Whether the current branch has an upstream tracking branch configured. */
  hasUpstream: boolean
  ahead: number
  behind: number
}

const EMPTY_STATUS: GitStatusResult = {
  isRepo: false, branch: '', detached: false, files: [], hasRemote: false, hasUpstream: false, ahead: 0, behind: 0,
}

/** Best-effort, read-only — a folder that isn't a git repo (or has no commits yet) just reports
 *  `isRepo: false` / empty fields rather than throwing, so callers can render "not tracked" state
 *  instead of an error screen. Mirrors `/api/v1/fs/git-branch`'s own best-effort convention. */
export async function getGitStatus(repoRoot: string): Promise<GitStatusResult> {
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'], repoRoot)) !== 'true') return EMPTY_STATUS
  } catch {
    return EMPTY_STATUS
  }

  let branch = ''
  let detached = false
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
    if (branch === 'HEAD') { detached = true; branch = '' }
  } catch { /* unborn HEAD — no commits yet, still a valid (empty) repo */ }

  let hasRemote = false
  try { hasRemote = (await git(['remote'], repoRoot)).length > 0 } catch { /* no remotes configured */ }

  let hasUpstream = false
  let ahead = 0
  let behind = 0
  if (!detached && branch) {
    try {
      await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot)
      hasUpstream = true
      const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], repoRoot)
      const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0)
      ahead = a ?? 0
      behind = b ?? 0
    } catch { /* branch has no upstream tracking configured yet */ }
  }

  // -z: these paths go back to `git add` for a selective commit, and without it git C-quotes any
  // path with a space or non-ASCII character ('"caf\303\251.txt"') and prints a rename as
  // 'old -> new' — none of which git accepts back. With -z each entry is 'XY path' NUL-terminated,
  // unquoted, and a rename/copy is followed by one more NUL-terminated field: its original path.
  // Porcelain prints every path relative to the repository's top level whatever the cwd, while
  // `git add` (and commitGitChanges' containment check) read one relative to the cwd. So a session
  // opened at a subfolder of a repo (a monorepo package) lists only its own folder (`-- .`), with
  // the folder's prefix taken off. An untracked session folder is listed as itself: '.'.
  let prefix = ''
  try { prefix = await git(['rev-parse', '--show-prefix'], repoRoot) } catch { /* at the top level */ }
  const raw = (await git(['status', '--porcelain=v1', '-z', '--', '.'], repoRoot)).split('\0')
  const files: GitFileStatus[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    files.push({ code, path: path.startsWith(prefix) ? path.slice(prefix.length) || '.' : path })
    if (/[RC]/.test(code)) i++ // skip the original path; the new one is what gets staged
  }

  return { isRepo: true, branch, detached, files, hasRemote, hasUpstream, ahead, behind }
}

export interface CommitResult {
  hash: string
  filesCommitted: number
}

/** Whether `git add -- <f>` run in `repoRoot` stages something inside it. Lexical on purpose, not
 *  containment.ts's write-tool guard (which follows links and applies pi's `~`/`@` reading): git
 *  stages a symlink as a link without following it, refuses a path through a symlinked directory
 *  itself ('beyond a symbolic link'), and with literal pathspecs reads '~/x' as an in-repo name. */
function isGitPathInside(f: unknown, repoRoot: string): boolean {
  if (typeof f !== 'string' || f.length === 0 || f.includes('\0')) return false
  const root = resolve(repoRoot)
  return isInsideAny(resolve(root, f), [root])
}

/** For a session opened at a repo subfolder, the repo paths (relative to the top level) already
 *  staged outside that folder: `git commit` commits the whole index, but getGitStatus lists only
 *  the folder, so these would go into the commit unseen. [] at the top level. Read from porcelain
 *  status (top-level-relative, unquoted with -z, unaffected by diff.relative); a staged rename
 *  counts by both of its paths, so one moved in from outside still counts by its old path. */
async function stagedOutsideFolder(repoRoot: string): Promise<string[]> {
  const prefix = await git(['rev-parse', '--show-prefix'], repoRoot).catch(() => '')
  if (!prefix) return []
  const raw = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=no'], repoRoot)).split('\0')
  const outside: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const paths = [entry.slice(3)]
    if (/[RC]/.test(code)) {
      const orig = raw[++i] ?? ''
      if (code[0] === 'R') paths.push(orig) // a copy leaves its original as it was
    }
    if (code[0] === ' ') continue // nothing staged for this entry
    for (const p of paths) if (p && !p.startsWith(prefix)) outside.push(p)
  }
  return outside
}

/** 'A merge' etc. while an operation that staged its own result is stopped: what concludes it (the
 *  commit, or `--continue` for a rebase or `git am`) needs that result.
 *  MERGE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD end with the commit, reset or --abort that ends
 *  the operation (rev-parse rather than a file check: only MERGE_HEAD is always a file in a
 *  reftable repo). REBASE_HEAD does not: git leaves it behind when a rebase that stopped on its
 *  last pick is continued, so a rebase is decided as `git status` decides it, by its per-worktree
 *  state directory: rebase-merge, or rebase-apply without `applying`. With `applying` it is a
 *  stopped `git am`, which stages its patch's changes the same way. */
async function operationInProgress(repoRoot: string): Promise<string | null> {
  const ops: Array<[string, string]> = [['MERGE_HEAD', 'A merge'], ['CHERRY_PICK_HEAD', 'A cherry-pick'], ['REVERT_HEAD', 'A revert']]
  for (const [ref, label] of ops) {
    if (await git(['rev-parse', '-q', '--verify', ref], repoRoot).then(() => true, () => false)) return label
  }
  // Relative to the cwd from a subfolder ('../../.git/rebase-merge'), absolute in a linked worktree.
  // Not resolve(): git counts that '..' from the real folder, so for a session folder reached
  // through a symlink only the filesystem resolves it right, not a lexical join.
  const dirs = await git(['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'], repoRoot)
    .then((out) => out.split(/\r?\n/), () => [])
  if (dirs.length !== 2) return null
  const [merge, apply] = dirs.map((p) => (isAbsolute(p) ? p : `${repoRoot}/${p}`))
  // rebase-apply first, as `git status` checks it (both exist when a rebase's exec stops in `git am`).
  if (existsSync(apply)) return existsSync(`${apply}/applying`) ? 'A patch application (git am)' : 'A rebase'
  return existsSync(merge) ? 'A rebase' : null
}

/** Stages then commits. `files`, when given, stages ONLY those paths (each containment-checked
 *  against `repoRoot` — the same boundary every other Code filesystem operation enforces, since a
 *  caller-supplied path list is exactly the input that boundary exists for); omitted stages
 *  everything in the session's folder (`git add -A -- .`), matching a plain "commit all my
 *  changes" affordance. Throws `GitError` for every failure case (no message, not a repo, nothing
 *  to commit/stage, containment violation, changes staged outside a subfolder session's folder, or
 *  the underlying `git commit` itself failing) — callers map `.message` to a route
 *  error, no silent partial-success. */
export async function commitGitChanges(repoRoot: string, message: string, files?: string[]): Promise<CommitResult> {
  const trimmedMessage = message.trim()
  if (!trimmedMessage) throw new GitError('A commit message is required.', '', null)

  const status = await getGitStatus(repoRoot)
  if (!status.isRepo) throw new GitError('Not a git repository.', '', null)
  if (status.files.length === 0) throw new GitError('Nothing to commit — the working tree is clean.', '', null)

  // Checked before staging anything. Typically the agent's own `git add -A`, run in the package
  // folder, which stages the whole repository. During a merge (cherry-pick, revert, rebase or git am stop)
  // the staged changes outside are that operation's result: unstaging them would make the commit
  // that concludes it drop them, so it is not advised there. `git reset --`, not `git restore
  // --staged`: the latter fails before the first commit.
  const outside = await stagedOutsideFolder(repoRoot)
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).join(', ') + (outside.length > 5 ? ` and ${outside.length - 5} more` : '')
    const op = await operationInProgress(repoRoot)
    throw new GitError(
      op
        ? `${op} is in progress, and its changes outside this folder are already staged (${shown}). `
          + 'Its commit needs them: finish it from the repository\'s top level.'
        : `Changes outside this folder are already staged (${shown}) and would be committed too. `
          + 'Unstage them at the repository\'s top level (git reset -- <path>) or commit from there.',
      '', null,
    )
  }

  if (files && files.length > 0) {
    for (const f of files) {
      if (!isGitPathInside(f, repoRoot)) throw new GitError(`Refusing to stage a path outside the repo: ${f}`, '', null)
    }
    // Literal: these are file names (from getGitStatus), so '[ab].txt' must not also match a.txt
    // as a glob, nor a leading ':' read as pathspec magic. In groups of GIT_ADD_PATHS_BUDGET
    // characters, each counted with a separator and the quotes Windows may put around it: the
    // Git dialog sends every path but the ones unticked, which after a formatter run over the
    // tree is more than one command line holds.
    let group: string[] = []
    let size = 0
    for (const f of files) {
      if (group.length > 0 && size + f.length + 3 > GIT_ADD_PATHS_BUDGET) {
        await git(['--literal-pathspecs', 'add', '--', ...group], repoRoot)
        group = []
        size = 0
      }
      group.push(f)
      size += f.length + 3
    }
    await git(['--literal-pathspecs', 'add', '--', ...group], repoRoot)
  } else {
    // `-- .`: without a pathspec `git add -A` stages the whole working tree, which for a session
    // opened at a repo subfolder includes changes outside the folder (getGitStatus lists only it).
    await git(['add', '-A', '--', '.'], repoRoot)
  }

  // Re-check what's actually staged rather than trusting `status.files` was non-empty for the
  // repo as a whole — a caller-supplied `files` list can point at paths with no real changes,
  // which `git add` silently no-ops on, leaving nothing staged. A failure of this call is its own
  // error, not an empty list: read as one, an output past the buffer answered "Nothing staged"
  // with every file staged.
  const staged = await git(['diff', '--cached', '--name-only', '--', '.'], repoRoot)
  const stagedList = staged.split('\n').filter(Boolean)
  if (stagedList.length === 0) throw new GitError('Nothing staged — the selected file(s) have no changes.', '', null)

  await git(['commit', '-m', trimmedMessage], repoRoot)
  const hash = await git(['rev-parse', 'HEAD'], repoRoot)
  return { hash, filesCommitted: stagedList.length }
}

export type PushResult =
  | { ok: true; remote: string; branch: string }
  | { ok: false; reason: 'not_a_repo' | 'no_remote' | 'detached_head'; message: string }
  | { ok: false; reason: 'diverged' | 'push_failed'; message: string }

/** Pushes the current branch to `origin`, setting the upstream on first push if none is
 *  configured yet. NEVER passes `--force`/`-f` under any circumstance — a rejected
 *  (non-fast-forward) push comes back as `{ reason: 'diverged' }` for the caller to surface, not
 *  retried automatically. */
export async function pushGitBranch(repoRoot: string): Promise<PushResult> {
  const status = await getGitStatus(repoRoot)
  if (!status.isRepo) return { ok: false, reason: 'not_a_repo', message: 'Not a git repository.' }
  if (status.detached) {
    return { ok: false, reason: 'detached_head', message: 'Cannot push from a detached HEAD — check out a branch first.' }
  }
  if (!status.hasRemote) return { ok: false, reason: 'no_remote', message: 'This repo has no configured remote.' }

  const args = status.hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', status.branch]
  try {
    await git(args, repoRoot, GIT_NETWORK_TIMEOUT_MS)
    return { ok: true, remote: 'origin', branch: status.branch }
  } catch (e) {
    const ge = e as GitError
    // Real git wording for a rejected non-fast-forward push, across the common remote hosts —
    // matched, never silently retried with --force.
    if (/\[rejected\]|non-fast-forward|fetch first|tip of your current branch is behind/i.test(ge.stderr)) {
      return {
        ok: false,
        reason: 'diverged',
        message: 'The remote has commits this branch doesn\'t have. Pull/rebase first — never force-pushed automatically.',
      }
    }
    return { ok: false, reason: 'push_failed', message: ge.message }
  }
}

/** Parses a GitHub remote URL (https://github.com/owner/repo[.git] or
 *  git@github.com:owner/repo[.git]) into a compare/PR-creation URL for `branch` against the
 *  repo's default base branch selection (GitHub's own compare UI lets the user change the base;
 *  omitting it here rather than guessing keeps this a pure, no-extra-request parse). Returns null
 *  for any non-GitHub remote — a graceful miss for GitLab/Bitbucket/local remotes, not an error,
 *  since PR-link support beyond GitHub is out of scope for this pass. */
export function buildGithubCompareUrl(remoteUrl: string, branch: string): string | null {
  const trimmed = remoteUrl.trim()
  const httpsMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/)
  const m = httpsMatch ?? sshMatch
  if (!m) return null
  const [, owner, repo] = m
  return `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(branch)}?expand=1`
}

/** Best-effort: reads the `origin` remote URL and resolves a compare link for `branch`. Returns
 *  null (never throws) when there's no `origin` remote or the remote isn't GitHub — same
 *  graceful-miss contract as {@link buildGithubCompareUrl}. */
export async function getGithubCompareUrl(repoRoot: string, branch: string): Promise<string | null> {
  let remoteUrl: string
  try {
    remoteUrl = await git(['remote', 'get-url', 'origin'], repoRoot)
  } catch {
    return null
  }
  return buildGithubCompareUrl(remoteUrl, branch)
}

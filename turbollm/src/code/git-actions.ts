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
import { promisify } from 'node:util'
import { isContainedFromRoot } from './containment'

const execFileAsync = promisify(execFile)

// Local, read-only/local-mutation ops (status, add, commit) — bounded short since nothing here
// touches the network.
const GIT_TIMEOUT_MS = 15_000
// Push touches the network — more headroom, but still bounded so a hung credential prompt can't
// wedge a daemon request forever. GIT_TERMINAL_PROMPT=0 (set on every call below) is the real fix
// for that case; this timeout is only the backstop if it doesn't work for the remote's exact auth
// setup (e.g. a credential helper that itself hangs instead of erroring).
const GIT_NETWORK_TIMEOUT_MS = 30_000

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
      windowsHide: true,
      // Never block on an interactive username/password/passphrase prompt — surface the auth
      // failure as a normal command error instead of hanging the request.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.trim()
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

  const raw = await git(['status', '--porcelain=v1'], repoRoot)
  const files: GitFileStatus[] = raw
    ? raw.split('\n').filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    : []

  return { isRepo: true, branch, detached, files, hasRemote, hasUpstream, ahead, behind }
}

export interface CommitResult {
  hash: string
  filesCommitted: number
}

/** Stages then commits. `files`, when given, stages ONLY those paths (each containment-checked
 *  against `repoRoot` — the same boundary every other Code filesystem operation enforces, since a
 *  caller-supplied path list is exactly the input that boundary exists for); omitted stages
 *  everything (`git add -A`), matching a plain "commit all my changes" affordance. Throws
 *  `GitError` for every failure case (no message, not a repo, nothing to commit/stage, containment
 *  violation, or the underlying `git commit` itself failing) — callers map `.message` to a route
 *  error, no silent partial-success. */
export async function commitGitChanges(repoRoot: string, message: string, files?: string[]): Promise<CommitResult> {
  const trimmedMessage = message.trim()
  if (!trimmedMessage) throw new GitError('A commit message is required.', '', null)

  const status = await getGitStatus(repoRoot)
  if (!status.isRepo) throw new GitError('Not a git repository.', '', null)
  if (status.files.length === 0) throw new GitError('Nothing to commit — the working tree is clean.', '', null)

  if (files && files.length > 0) {
    for (const f of files) {
      if (!isContainedFromRoot(f, repoRoot)) throw new GitError(`Refusing to stage a path outside the repo: ${f}`, '', null)
    }
    await git(['add', '--', ...files], repoRoot)
  } else {
    await git(['add', '-A'], repoRoot)
  }

  // Re-check what's actually staged rather than trusting `status.files` was non-empty for the
  // repo as a whole — a caller-supplied `files` list can point at paths with no real changes,
  // which `git add` silently no-ops on, leaving nothing staged.
  const staged = await git(['diff', '--cached', '--name-only'], repoRoot).catch(() => '')
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

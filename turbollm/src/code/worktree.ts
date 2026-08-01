// Real git worktrees for Code sessions.
//
// ── Why this exists (founder-reported, 2026-08-01) ──────────────────────────────────────────
// The composer has had a "Use worktree" toggle since Phase 1, with a tooltip promising "an
// isolated checkout on its own branch". Nothing implemented it: `code-routes.ts` stored
// `useWorktree`/`worktreeBranch`/`worktreeBase` in SQLite and never read them back, and there was
// no `git worktree` (nor `git checkout`, nor `git branch`) call anywhere in the codebase. Both
// agents took `run.repoRoot` verbatim as their cwd, so ticking the box changed nothing — the agent
// edited the user's real working tree, on whatever branch happened to be checked out. That is the
// exact outcome someone ticks the box to avoid, and it failed silently.
//
// ── Layout: <repoRoot>/.turbollm/worktrees/<branch> (founder's choice) ──────────────────────
// Self-contained and always writable when the repo is. The two hazards that come with living
// inside the repo are handled rather than assumed away, both verified against real git first:
//   • The directory shows up as `?? .turbollm/` in the BASE repo. Suppressed via
//     `.git/info/exclude`, NOT the user's `.gitignore` — that file is theirs and tracked, and
//     silently committing a line to it would be an edit they never asked for.
//   • A worktree nested in its own repo could in principle contain itself. It cannot here:
//     `.turbollm/` is untracked, so it is not part of any branch, so a checkout of that branch
//     never materialises it. Verified empirically, not reasoned about.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Where a repo's session worktrees live, relative to the repo root. */
export const WORKTREES_SUBDIR = join('.turbollm', 'worktrees')

/** The line added to `.git/info/exclude`. Anchored with a leading slash so it only ever matches
 *  the directory at the repo ROOT — a `.turbollm` folder nested somewhere in the user's own source
 *  tree is theirs and must keep showing up in `git status`. */
const EXCLUDE_LINE = '/.turbollm/'

/** Bound on the auto-suffix search when the requested branch name is taken. Small on purpose: past
 *  a handful the name is clearly being reused deliberately and a plain error is more useful than
 *  silently inventing `feature-47`. */
const MAX_BRANCH_SUFFIX = 20

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Run git with an ARGUMENT ARRAY and no shell. Branch names and paths are user-supplied, and this
 *  is the one place they reach a process boundary — no shell means no quoting rules to get wrong
 *  and no metacharacter can act (see util/shell-command.ts for what the shell path has to do
 *  instead). Never throws: a missing git binary comes back as ok:false like any other failure. */
export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: GitResult) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        done({ ok: false, stdout, stderr: stderr || `git ${args[0]} timed out after ${timeoutMs}ms` })
      }, timeoutMs)
      child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
      child.on('error', (e) => { clearTimeout(timer); done({ ok: false, stdout, stderr: (e as Error).message }) })
      child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, stdout, stderr }) })
    } catch (e) {
      done({ ok: false, stdout: '', stderr: (e as Error).message })
    }
  })
}

/** Whether `root` is inside a git working tree. */
export async function isGitRepo(root: string): Promise<boolean> {
  const r = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout.trim() === 'true'
}

/** Turn arbitrary user text into something `git branch` will accept: git refuses spaces, `~^:?*[`,
 *  `..`, a leading/trailing `/` or `.`, and a trailing `.lock`. Falls back to a fixed stem rather
 *  than returning '' so a name made entirely of illegal characters still produces a usable branch.
 *  Pure. */
export function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\]\\]/g, '')
    .replace(/\.\.+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[/.]+/, '')
    .replace(/\.lock$/, '')
    .replace(/-+/g, '-')
    .slice(0, 80)
    // Trailing `-`, `.` and `/` are stripped AFTER the length cap, not before it. Doing it first
    // was a real bug: the cap can land mid-string and re-expose a character git rejects at the end
    // of a ref. Verified against `git check-ref-format` — a 79-character task description followed
    // by a `.` produced `aaa….`, which git refuses ("is not a valid branch name"), so creating the
    // session failed outright for nothing more than a long description.
    .replace(/[-./]+$/, '')
  return cleaned || 'turbollm-session'
}

/** True when a ref by this name already exists (branch, tag, anything resolvable). */
async function refExists(repoRoot: string, name: string): Promise<boolean> {
  const r = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
  return r.ok && r.stdout.trim().length > 0
}

/** First free branch name at or after `desired`, suffixing `-2`, `-3`, … when taken.
 *
 *  Chosen over letting `git worktree add -b` fail and parsing "a branch named 'x' already exists":
 *  error text is localised and version-dependent, whereas asking whether the ref exists is a
 *  stable question. Returns null when everything up to the cap is taken. */
export async function findFreeBranchName(repoRoot: string, desired: string): Promise<string | null> {
  if (!(await refExists(repoRoot, desired))) return desired
  for (let n = 2; n <= MAX_BRANCH_SUFFIX; n++) {
    const candidate = `${desired}-${n}`
    if (!(await refExists(repoRoot, candidate))) return candidate
  }
  return null
}

/** Add `/.turbollm/` to the repo's LOCAL exclude file so the worktree directory doesn't show up as
 *  untracked noise in `git status`. Idempotent, and best-effort: failing to write it makes the
 *  repo untidy, never broken, so it must not abort a session launch. */
export async function ensureLocalExclude(repoRoot: string): Promise<void> {
  try {
    const gitDir = await resolveGitDir(repoRoot)
    if (!gitDir) return
    const infoDir = join(gitDir, 'info')
    const excludePath = join(infoDir, 'exclude')
    let current = ''
    try { current = await readFile(excludePath, 'utf8') } catch { /* absent — created below */ }
    if (current.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE)) return
    await mkdir(infoDir, { recursive: true })
    await appendFile(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_LINE}\n`, 'utf8')
  } catch {
    /* best-effort */
  }
}

/** Absolute path to the repo's .git directory (`git rev-parse --absolute-git-dir`), or null.
 *  Asked of git rather than assumed to be `<root>/.git`: it is a FILE, not a directory, when the
 *  repo is itself a worktree or a submodule. */
async function resolveGitDir(repoRoot: string): Promise<string | null> {
  const r = await runGit(repoRoot, ['rev-parse', '--absolute-git-dir'])
  const p = r.stdout.trim()
  return r.ok && p ? p : null
}

/** The directory a session's agent — and every operation on the files it edits — should act in.
 *
 *  The distinction is load-bearing and easy to get wrong in one place out of eight, which is why
 *  it lives here rather than being spelled out at each call site:
 *    • agent cwd, containment root, AGENTS.md lookup, revert, git status/diff/commit → the
 *      WORKTREE, because that is where the edits actually are.
 *    • `git worktree remove`, and the project shown in the UI → the BASE repo (`repoRoot`).
 *  Pure. */
export function agentCwd(run: { repoRoot?: string; worktreePath?: string }): string {
  return run.worktreePath ?? run.repoRoot ?? ''
}

export type WorktreeCreation =
  | { ok: true; path: string; branch: string }
  | { ok: false; code: 'not_a_repo' | 'branch_unavailable' | 'git_failed'; message: string }

/**
 * Create an isolated worktree for a Code session.
 *
 * `base` is the commit-ish to branch FROM (the composer's "base branch"); when omitted or
 * unresolvable, git's own HEAD is used — branching a session off whatever is checked out is a far
 * better outcome than refusing to start it because a stale base-branch name no longer exists.
 */
export async function createSessionWorktree(params: {
  repoRoot: string
  branch: string
  base?: string
}): Promise<WorktreeCreation> {
  const { repoRoot, base } = params

  if (!(await isGitRepo(repoRoot))) {
    return {
      ok: false,
      code: 'not_a_repo',
      message: `Cannot create a worktree: ${repoRoot} is not a git repository. Untick "Use worktree" to work in the folder directly, or run \`git init\` there first.`,
    }
  }

  const desired = sanitizeBranchName(params.branch)
  const branch = await findFreeBranchName(repoRoot, desired)
  if (!branch) {
    return {
      ok: false,
      code: 'branch_unavailable',
      message: `Cannot create a worktree: branches "${desired}" through "${desired}-${MAX_BRANCH_SUFFIX}" all already exist. Choose a different branch name.`,
    }
  }

  await ensureLocalExclude(repoRoot)

  const path = join(repoRoot, WORKTREES_SUBDIR, branch)
  // Only pass a base when it actually resolves — `git worktree add -b x <path> nope` is a hard
  // failure, and a session that won't start is a worse answer than one branched off HEAD.
  const baseArgs = base && (await refExists(repoRoot, base)) ? [base] : []
  const r = await runGit(repoRoot, ['worktree', 'add', '-b', branch, path, ...baseArgs], 120_000)
  if (!r.ok) {
    return {
      ok: false,
      code: 'git_failed',
      message: `Cannot create a worktree: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    }
  }
  return { ok: true, path, branch }
}

export type WorktreeRemoval =
  | { ok: true }
  | { ok: false; code: 'dirty' | 'git_failed'; message: string }

/**
 * Remove a session's worktree.
 *
 * Deliberately WITHOUT `--force`: git already refuses when the worktree contains modified or
 * untracked files ("use --force to delete it"), which is exactly the guarantee wanted here —
 * deleting a session must never silently destroy work the agent did but the user hadn't merged.
 * Committed work is safe regardless: removing a worktree does not delete its branch (verified).
 */
export async function removeSessionWorktree(repoRoot: string, worktreePath: string): Promise<WorktreeRemoval> {
  // Nothing to remove is SUCCESS, not failure. Either directory can legitimately be gone by the
  // time a session is deleted — the worktree removed with `git worktree remove` by hand, the whole
  // project moved or deleted, an external drive unplugged. Reporting that as an error produced a
  // raw `spawn git ENOENT` on the delete response (git cannot even start when its cwd is missing),
  // which told the user nothing and made a perfectly successful delete look like it had failed.
  if (!existsSync(worktreePath) || !existsSync(repoRoot)) return { ok: true }

  const r = await runGit(repoRoot, ['worktree', 'remove', worktreePath], 60_000)
  if (r.ok) return { ok: true }

  const err = (r.stderr || r.stdout).trim()
  if (/contains modified or untracked files|use --force/i.test(err)) {
    return {
      ok: false,
      code: 'dirty',
      message:
        `The worktree at ${worktreePath} still has uncommitted changes, so it was left in place. ` +
        `Commit or discard them, then remove it with: git worktree remove "${worktreePath}"`,
    }
  }
  return { ok: false, code: 'git_failed', message: err.slice(0, 400) }
}

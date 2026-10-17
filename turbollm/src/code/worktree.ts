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
// (<repoRoot> being the repository's top level: a session started at a subfolder of a repo works
// in the same subfolder of the worktree; see createSessionWorktree.)
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
import { appendFile, readFile, readlink, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

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

/** A branch path part Windows reads as a device: the names Git for Windows' is_valid_win32_path
 *  (compat/mingw.c) refuses, alone or followed by an extension, plus COM¹-³ and LPT¹-³, which
 *  Windows reserves too. The sanitizer lower-cases first and lets `$` and `¹²³` through, so the
 *  lower-case CONIN$/CONOUT$/COM¹ forms are what can reach it. */
const WINDOWS_RESERVED_PART = /(^|\/)(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?=[./]|$)/g

/** Turn arbitrary user text into something `git branch` will accept: git refuses spaces, control
 *  characters, `~^:?*[\`, `..`, `@{`, a leading `-`, a leading/trailing `/` or `.`, a path
 *  component starting with `.` or ending in `.lock`, and a trailing `.lock`. Falls back to a fixed
 *  stem rather than returning '' so a name made entirely of illegal characters still produces a
 *  usable branch.
 *
 *  The name must also be one Git for Windows can create, and is made so on every platform, so a
 *  branch stays usable wherever the repo is checked out. It is both a loose ref file under
 *  .git/refs/heads/ and the folder .turbollm/worktrees/<branch>, and Git for Windows refuses
 *  ("Invalid argument") any path part that contains `"<>|` (`:?*\` are stripped anyway), ends in
 *  `.`, or names a reserved device (WINDOWS_RESERVED_PART). `git check-ref-format` accepts all
 *  three, so on Windows a session whose task was `Rename "foo" to "bar"`, or whose typed branch was
 *  `con`, failed with git_failed and never started. Pure. */
export function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    // `|` and the quote/angle brackets read as separators in a task (`a | b`, `<Button>`), so they
    // become a `-` rather than vanishing and gluing two words together.
    .replace(/["<>|]/g, '-')
    .replace(/[\x00-\x1f\x7f~^:?*[\]\\]/g, '')
    .replace(/@\{/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/\/\.+/g, '/')
    // A part ending in `.` (`v2./fix`): git allows it, Git for Windows can't create the folder.
    // Before the `.lock` strip, so `x.lock./y` can't come out as `x.lock/y`.
    .replace(/\.+(?=\/)/g, '')
    .replace(/(?:\.lock)+(?=\/)/g, '')
    .replace(/\/+/g, '/')
    // A leading `-` matters beyond validity: `git worktree add -b` runs `git branch <name>`, which
    // parses `-fix-the-bug` (a task typed as a markdown bullet) as options and fails.
    .replace(/^[-/.]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 80)
    // Trailing `-`, `.` and `/` are stripped AFTER the length cap, not before it. Doing it first
    // was a real bug: the cap can land mid-string and re-expose a character git rejects at the end
    // of a ref. Verified against `git check-ref-format` — a 79-character task description followed
    // by a `.` produced `aaa….`, which git refuses ("is not a valid branch name"), so creating the
    // session failed outright for nothing more than a long description. A trailing `.lock` is part
    // of the same run, so stripping one can't re-expose another (`x.lock-` → `x.lock` → `x`).
    .replace(/(?:\.lock|[-./])+$/, '')
    // A reserved device name gets a `-` after it (`con` → `con-`, `nul.txt` → `nul-.txt`), which
    // Windows no longer reads as the device. Last, because both the cap and the trailing strip can
    // expose one (`console` cut to `con`, `con -` stripped to `con`); so this one case may come
    // out a few characters over the cap, which only bounds the name's length loosely anyway.
    .replace(WINDOWS_RESERVED_PART, '$1$2-')
  return cleaned || 'turbollm-session'
}

/** True when a ref by this name already exists (branch, tag, anything resolvable). */
async function refExists(repoRoot: string, name: string): Promise<boolean> {
  const r = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
  return r.ok && r.stdout.trim().length > 0
}

/** The commit `base` names — a local or remote-tracking branch, a tag, a commit, anything git
 *  resolves to one — or null. Asked as `<base>^{commit}`, so a tag is peeled to its commit and a
 *  tree or file name is no base. A leading `-` would reach rev-parse as an option: never a base. */
async function resolveBaseCommit(repoRoot: string, base: string): Promise<string | null> {
  if (base.startsWith('-')) return null
  const r = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  const sha = r.stdout.trim()
  return r.ok && sha ? sha : null
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
    const excludePath = await resolveExcludePath(repoRoot)
    if (!excludePath) return
    let current = ''
    try { current = await readFile(excludePath, 'utf8') } catch { /* absent — created below */ }
    if (current.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE)) return
    await mkdir(dirname(excludePath), { recursive: true })
    await appendFile(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_LINE}\n`, 'utf8')
  } catch {
    /* best-effort */
  }
}

/** Absolute path to the exclude file git actually reads for this repo, or null. Asked of git
 *  rather than assumed to be `<root>/.git/info/exclude`: .git is a FILE, not a directory, when the
 *  repo is itself a worktree or a submodule. And for a LINKED worktree (a base folder made with
 *  `git worktree add`), the repo's own gitdir, which `--absolute-git-dir` returns, is
 *  `<main>/.git/worktrees/<name>`, where git never reads an info/exclude: it reads the common
 *  dir's. Writing the line there left `?? .turbollm/` in the base checkout, and the Git dialog's
 *  commit-all (`git add -A`) then staged the session worktree as an embedded repo (a 160000
 *  gitlink). `--git-path info/exclude` answers with the file git reads in every layout. It prints
 *  a path relative to the cwd for a plain repo, hence the resolve; `--path-format=absolute` would
 *  avoid that but needs git 2.31. That cwd is the PHYSICAL one (git's getcwd), so the path is
 *  resolved against the base folder's realpath, not the name it was opened by: a base reached
 *  through a symlink into a repo subfolder (~/web -> ~/code/mono/packages/web) gets
 *  `../../.git/info/exclude`, which resolved against the symlink's own path would name a file two
 *  levels above it, outside any repo, instead of mono/.git/info/exclude. */
async function resolveExcludePath(repoRoot: string): Promise<string | null> {
  const r = await runGit(repoRoot, ['rev-parse', '--git-path', 'info/exclude'])
  const p = r.stdout.replace(/\r?\n$/, '')
  return r.ok && p ? resolve(await realpath(repoRoot), p) : null
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
  | { ok: false; code: 'not_a_repo' | 'branch_unavailable' | 'base_unavailable' | 'git_failed'; message: string }

/**
 * Create an isolated worktree for a Code session.
 *
 * `base` is the commit-ish to branch FROM (the composer's "base branch"): any branch, tag or commit
 * git resolves. Omitted (or blank), the session branches off what is checked out. One that does
 * not resolve is refused (`base_unavailable`). It used to count only as a local branch name, and
 * anything else, a tag, a remote-tracking branch, a commit or a name since deleted, was dropped
 * without a word: the session branched off the current checkout, not the base it was asked for.
 */
export async function createSessionWorktree(params: {
  repoRoot: string
  branch: string
  base?: string
}): Promise<WorktreeCreation> {
  const { repoRoot } = params
  const base = params.base?.trim()

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

  // The commit, not the name, goes to `git worktree add`: from a remote-tracking branch git would
  // also make it the new branch's upstream (branch.autoSetupMerge), and the Git dialog's plain
  // `git push` of a branch whose upstream has another name is refused under push.default=simple.
  const baseCommit = base ? await resolveBaseCommit(repoRoot, base) : null
  if (base && !baseCommit) {
    return {
      ok: false,
      code: 'base_unavailable',
      message: `Cannot create a worktree: the base "${base}" is not a branch, tag or commit in this repository. Pick another base branch.`,
    }
  }

  await ensureLocalExclude(repoRoot)

  // A session started at a SUBFOLDER of a repo (a monorepo package): `git worktree add` checks out
  // the whole repository, and the exclude line is anchored at its top level. So the worktree goes
  // under the repository's top level, and the session works in the same subfolder of it (the
  // returned path, which agentCwd uses; created if the base commit lacks it).
  let prefix = (await runGit(repoRoot, ['rev-parse', '--show-prefix'])).stdout.replace(/\r?\n$/, '')
  let top = repoRoot
  if (prefix) {
    const t = (await runGit(repoRoot, ['rev-parse', '--show-toplevel'])).stdout.replace(/\r?\n$/, '')
    if (t) top = t
    else prefix = ''
  }
  const worktreeTop = join(top, WORKTREES_SUBDIR, branch)
  const r = await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreeTop, ...(baseCommit ? [baseCommit] : [])], 120_000)
  if (!r.ok) {
    return {
      ok: false,
      code: 'git_failed',
      message: `Cannot create a worktree: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    }
  }
  const path = join(worktreeTop, ...prefix.split('/').filter(Boolean))
  if (prefix) await mkdir(path, { recursive: true }).catch(() => { /* the agent then reports the missing folder */ })
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
  //
  // A missing base folder is not "nothing to remove", though. A subfolder session's worktree lives
  // under the repository's TOP level, so it outlives the folder: deleted, renamed, or absent from
  // the branch now checked out in the base. Returning success then left the worktree registered,
  // its branch checked out there ("already used by worktree" on any other checkout of it), with no
  // note to the user. So git runs from the nearest folder above the base that still exists, and
  // the base's prefix is that folder's plus the missing path below it. When the repository itself
  // is gone, so is every worktree in it, and the loop below finds nothing left on disk.
  //
  // The first missing name can be a link whose target is gone: a base opened through a symlink
  // (or junction) into a repo subfolder, ~/web -> ~/code/mono/packages/web, after the checkout
  // dropped packages/web. The folder above the link (~) is in no repository, so git failed there
  // ("not a git repository") and the worktree stayed registered. The walk goes on from where the
  // link points instead, the way the base itself was reached.
  let gitCwd = resolve(repoRoot)
  let missing: string[] = []
  for (let hops = 0; ; hops++) {
    while (!existsSync(gitCwd)) {
      const up = dirname(gitCwd)
      if (up === gitCwd) return { ok: true }
      missing.unshift(basename(gitCwd))
      gitCwd = up
    }
    // 40: the kernel's own limit on links followed in one lookup, so a link loop ends here.
    const link = missing.length > 0 && hops < 40 ? await readlink(join(gitCwd, missing[0])).catch(() => null) : null
    if (link === null) break
    // A relative target is relative to the link's PHYSICAL folder, as the kernel resolves it.
    const from = await realpath(gitCwd).catch(() => gitCwd)
    gitCwd = resolve(from, link, ...missing.slice(1))
    missing = []
  }

  // A session started at a repo subfolder works in that subfolder of its worktree
  // (createSessionWorktree), but `git worktree remove` takes the worktree's own top level: the
  // stored path without that folder's prefix, tried first. The prefix is asked of the BASE repo,
  // never of the worktree: a broken one (its .git file gone) would answer for the repository around
  // it, which may itself be a linked worktree that a remove would then delete. A path that only
  // ends the same way (a subfolder session created before worktrees moved to the top level, whose
  // branch is named like the folder) is no worktree, which git says, so the stored path is tried
  // next. Each is tried only if it is still there: the session's folder inside the worktree can be
  // gone (deleted by the agent) while the worktree is not.
  const asked = await runGit(gitCwd, ['rev-parse', '--show-prefix'])
  const prefix = asked.stdout.replace(/\r?\n$/, '')
  // Outside any repository (rev-parse fails) the missing path is no prefix of anything.
  const parts = [...prefix.split('/').filter(Boolean), ...(asked.ok ? missing : [])]
  const tail = worktreePath.split(/[\\/]+/).filter(Boolean).slice(-parts.length)
  const targets = parts.length > 0 && tail.join('/') === parts.join('/')
    ? [resolve(worktreePath, ...parts.map(() => '..')), worktreePath]
    : [worktreePath]
  for (const [i, target] of targets.entries()) {
    if (!existsSync(target)) continue
    const r = await runGit(gitCwd, ['worktree', 'remove', target], 60_000)
    if (r.ok) return { ok: true }

    const err = (r.stderr || r.stdout).trim()
    if (i < targets.length - 1 && /is not a working tree/i.test(err)) continue
    if (/contains modified or untracked files|use --force/i.test(err)) {
      return {
        ok: false,
        code: 'dirty',
        message:
          `The worktree at ${target} still has uncommitted changes, so it was left in place. ` +
          `Commit or discard them, then remove it with: git worktree remove "${target}"`,
      }
    }
    return { ok: false, code: 'git_failed', message: err.slice(0, 400) }
  }
  return { ok: true } // nothing of it left on disk
}

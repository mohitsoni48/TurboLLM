// Code's own git calls (worktree.ts runGit, git-actions.ts) are tethered with SIGTERM first (util/tether.ts
// 'term-then-kill'), held in the 'daemon' scope, and run no automatic gc. Real git throughout.
//   - A helper git leaves running on purpose (the credential cache) stays while TurboLLM does and ends with it; the
//     call itself settles at git's exit.
//   - A timeout ends git's whole group (a hung credential helper or alias included) and holds nothing.
//   - A daemon killed mid-commit lets git drop its index.lock: a git killed outright left it, and the next git command
//     in that repository failed.
//   - `git commit` can start `git gc --auto`, which daemonizes (setsid) out of every group.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runGit } from './worktree'
import { commitGitChanges } from './git-actions'
import { releaseTetherScope } from '../util/tether'
import { descendantsOf, isGone, killRecorded, pidsWithArg, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpGitRepo } from '../test-support/git-repo'

const skip = process.platform === 'win32' ? 'POSIX process groups' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function pgidOf(pid: number): number {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
  return Number(String(r.stdout ?? '').trim())
}

async function waitFor<T>(probe: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() >= deadline) return null
    await sleep(25)
  }
}

const cacheAvailable = spawnSync('git', ['credential-cache', '--help'], { stdio: 'ignore' }).status !== null &&
  spawnSync('git', ['help', '-a'], { encoding: 'utf8' }).stdout?.includes('credential-cache')

/** The cache's socket: an absolute path (git requires one), which must fit a unix socket address (104 bytes on
 *  macOS, whose temp directory is long: there the test skips). */
function cacheSocket(repo: string): string | null {
  const sock = join(repo, 'c.sock')
  return Buffer.byteLength(sock) < 100 ? sock : null
}

test('runGit settles at git\'s exit while the credential cache it started is held, and the cache ends at the release', { skip: skip || (!cacheAvailable && 'git credential-cache is not built here') }, async (t) => {
  const repo = tmpGitRepo('g-')
  const sock = cacheSocket(repo)
  if (!sock) return t.skip('the temp directory is too long for a unix socket path')
  try {
    const t0 = Date.now()
    const r = await runGit(repo, ['credential-cache', '--socket', sock, '--timeout', '300', 'store'])
    assert.equal(r.ok, true, r.stderr)
    assert.ok(Date.now() - t0 < 2000, `settled at git's exit (${Date.now() - t0} ms)`)
    const daemon = await waitFor(() => pidsWithArg(sock)[0], 2000)
    assert.ok(daemon, 'the cache daemon runs')
    record(daemon)
    await sleep(200)
    assert.equal(isGone(daemon), false, 'held: it outlives the call')
    await releaseTetherScope('daemon')
    assert.deepEqual(await waitGone([daemon], 3000), [], 'and ends at the release')
  } finally {
    killRecorded()
  }
})

test('a daemon SIGKILLed while git\'s credential cache runs takes the cache with it', { skip: skip || (!cacheAvailable && 'git credential-cache is not built here') }, async (t) => {
  const repo = tmpGitRepo('g-')
  const sock = cacheSocket(repo)
  if (!sock) return t.skip('the temp directory is too long for a unix socket path')
  const d = await startStandInDaemon(`
import { runGit } from ${srcUrl('code/worktree.ts')}
const r = await runGit(${JSON.stringify(repo)}, ['credential-cache', '--socket', ${JSON.stringify(sock)}, '--timeout', '300', 'store'])
report({ ok: r.ok })
setInterval(() => {}, 1e9)
`)
  try {
    assert.deepEqual(await d.next(), { ok: true })
    const daemon = await waitFor(() => pidsWithArg(sock)[0], 2000)
    assert.ok(daemon)
    record(daemon)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([daemon], 3000), [])
  } finally {
    killRecorded(d.pid)
  }
})

test('a runGit timeout ends git\'s whole group, a TERM-ignoring child after the grace, and holds nothing', { skip }, async () => {
  const repo = tmpGitRepo('tllm-git-timeout-')
  const pidFile = join(repo, 'hang.pids')
  try {
    const t0 = Date.now()
    // The alias's shell and its sleep ignore SIGTERM, as a hung credential helper may.
    const r = await runGit(repo, ['-c', `alias.hang=!trap "" TERM; sleep 300 & echo "$$ $!" > ${pidFile}; wait`, 'hang'], 1000)
    const took = Date.now() - t0
    const pids = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split(' ').map(Number) : []
    record(...pids)
    assert.equal(r.ok, false)
    assert.match(r.stderr, /timed out after 1000ms/)
    assert.ok(took >= 900 && took < 2000, `at the timeout (${took} ms)`)
    assert.equal(pids.length, 2, 'the alias ran')
    assert.notEqual(pgidOf(pids[0]), pgidOf(process.pid), 'git leads a group of its own')
    assert.deepEqual(await waitGone(pids, 4000), [], 'the alias\'s sh and its sleep are gone after git\'s grace, with no release')
  } finally {
    killRecorded()
  }
})

test('a daemon SIGKILLed while `git commit -a` waits for its editor leaves no index.lock', { skip }, async () => {
  const repo = tmpGitRepo('tllm-git-lock-')
  writeFileSync(join(repo, 'README.md'), 'changed\n')
  const d = await startStandInDaemon(`
import { runGit } from ${srcUrl('code/worktree.ts')}
report({ started: true })
await runGit(${JSON.stringify(repo)}, ['commit', '-a'], 600_000)
`, { env: { GIT_EDITOR: 'sleep 300;:' } })
  try {
    await d.next()
    const lock = join(repo, '.git', 'index.lock')
    assert.ok(await waitFor(() => existsSync(lock), 5000), 'git holds index.lock while its editor runs')
    const editor = await waitFor(() => pidsWithArg(join(repo, '.git'))[0], 2000)
    if (editor) record(editor, ...descendantsOf(editor))
    await d.kill('SIGKILL')
    assert.ok(await waitFor(() => !existsSync(lock), 1500), 'git removed its lock on its SIGTERM')
    if (editor) assert.deepEqual(await waitGone([editor], 3000), [])
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    assert.equal(status.status, 0, 'the next git command in the repository works')
  } finally {
    killRecorded(d.pid)
  }
})

/** Processes running git's gc (`git gc`, `git maintenance`, its repack and pack-objects) whose cwd is under `repo`
 *  (Linux: /proc). */
function gcProcessesIn(repo: string): number[] {
  const out: number[] = []
  for (const d of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0')
      if (!cmd.some((a) => a === 'gc' || a === 'maintenance' || a === 'repack' || a === 'pack-objects')) continue
      if (readlinkSync(`/proc/${d}/cwd`).startsWith(repo) && !isGone(Number(d))) out.push(Number(d))
    } catch {
      /* gone meanwhile, or not ours to read */
    }
  }
  return out
}

test('a commit that would trigger git\'s automatic gc leaves no gc running behind it', { skip: skip || (!existsSync('/proc/self/cwd') && 'reads /proc') }, async () => {
  const repo = tmpGitRepo('tllm-git-gc-')
  spawnSync('git', ['config', 'gc.auto', '1'], { cwd: repo })
  for (let i = 0; i < 3000; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
  const seen = new Set<number>()
  try {
    assert.ok(await commitGitChanges(repo, 'many files'))
    // A detached gc over 3000 small objects is done in about half a second: look for one the whole time.
    const until = Date.now() + 1500
    while (Date.now() < until) {
      for (const p of gcProcessesIn(repo)) seen.add(p)
      await sleep(20)
    }
    record(...seen)
    assert.deepEqual([...seen], [], 'no detached `git gc --auto` ran')
  } finally {
    killRecorded()
  }
})

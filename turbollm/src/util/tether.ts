// Every process the daemon starts that is not trivially short is started through this module, which ties the child
// to the daemon's life with the strongest mechanism the OS has. The owner's rule: "there should never be stray
// processes, so make sure that the litertlm or llama server or anything else are connected to the main Daemon in a
// way that they are immediately killed when the Daemon closes." A graceful stop already stopped most children, but
// nothing covered a daemon that died without running its handlers (SIGKILL, a V8 or kernel out-of-memory kill, a
// crash past 'exit', the desktop app or a terminal killing it): an engine, a routine's `claude`, a git command or a
// Code agent's background server then ran on, parented to init, holding VRAM, a port or a lock.
//
// ── Linux and macOS: the lifeline wrapper ───────────────────────────────────────────────────────────────────────
// The program runs behind `/bin/sh -c <script> <program> <args…>`, with one extra stdio pipe appended after the
// caller's own entries: the lifeline, a SOCK_CLOEXEC socketpair whose other end only this daemon holds. The script
// double-forks a small watcher, `( ( watcher ) & )`, and then `exec`s the program in place, so:
//   - the program keeps the shell's pid, stdio and exit status (child.pid is the program's own pid, signals reach it
//     directly, and Node reports its real exit code or signal);
//   - the program is a process-group leader (`detached`), and the watcher is a member of that group, which pins the
//     group id while it lives;
//   - the watcher is NOT the program's child: its parent exits at once, so init (or the nearest subreaper) adopts
//     it. A watcher forked straight from the shell was the program's child, and a program that waits for all of its
//     children (Python's os.wait() loop, Perl's `1 while wait != -1`, Ruby's Process.waitall) waited for it until the
//     daemon closed the lifeline;
//   - the watcher closes fds 0-2 and the caller's extra fds 3..L-1 (Chrome's CDP pipes), and the program never sees
//     fd L, so no extra holder hides an EOF from the daemon.
// The watcher blocks reading the lifeline. Whenever the daemon dies, however it dies, the kernel closes the
// daemon's end, the read sees EOF (a sticky EOF: a daemon that dies before the watcher's first read is caught too),
// and the watcher ends the group by its end mode: 'kill' sends SIGKILL to the whole group; 'term-then-kill' (git)
// sends SIGTERM, waits GIT_GRACE_S, then SIGKILL, so git can drop its index.lock from its signal handler; 'term'
// (package managers under sudo) sends SIGTERM to the program alone, which stays in the daemon's own group so sudo
// keeps the terminal's ticket. A `q` line written before the daemon closes its end lets the watcher leave without
// firing: a term-mode program that exited by itself, or a held group that has emptied.
//
// The wrapper is generated per spawn with literal fd numbers (no eval). dash and mksh refuse redirections of fd 10 or
// above (`exec: 12: not found`), so a spawn whose lifeline would land past fd 9 throws. On macOS, SIP strips every
// DYLD_* variable from /bin/sh's environment, so each one in the child's env travels as TURBOLLM_TETHER_<name> and is
// restored just before the exec. dash, mksh and busybox ash pass on only the variables whose names are shell
// identifiers, so a child's `spring.profiles.active`, npm's `npm_config_//registry.npmjs.org/:_authToken` or an
// exported bash function (`BASH_FUNC_f%%`) never reached the program. When the env holds such a name, the wrapper
// runs under bash instead (/bin/bash, or /bin/sh where it is bash: NixOS), which passes every name on at its exec, so
// no value travels anywhere: `bash --norc -p`. --norc: a `bash -c` whose stdin is a socket, as Node's stdio pipes
// are, takes itself for one started by rshd and runs ~/.bashrc when SHLVL is unset (a daemon started by systemd or a
// desktop session). -p: no BASH_ENV, and no exported function is defined, so none stands in for the watcher's `read`
// or `kill`, and each BASH_FUNC_* value is passed on byte for byte. Like /bin/sh on macOS and Fedora, it passes
// bash's own special variables on as bash keeps them, where dash passes on what it was given: an exported PS1, PS2,
// RANDOM, HISTCMD or BASH_COMMAND, among others (or an OLDPWD that is no directory), is dropped, BASH_VERSION and
// OPTERR, among others, are bash's, and SHLVL is set when unset. A newer one is treated so only by a bash that has it:
// BASHPID (bash 4.0), BASH_ARGV0 and EPOCHSECONDS (5.0) and SRANDOM (5.1) pass on as given through macOS's 3.2.
// (An exported PPID reaches the program from none of them: bash drops it, and dash and mksh set it to their own
// parent's pid.) Where there is no bash (Android, Alpine), or the env exports SHELLOPTS or BASHOPTS (bash would pass
// on its own options under those names), each such value travels as TURBOLLM_TETHER_V<i> (with the DYLD_* ones), and
// the script execs the program through `env`, which sets each name from its carrier and drops the carriers. No value
// is in sh's argv then, but each is in env's from env's exec to the program's, and /proc/<pid>/cmdline is
// world-readable: a loop reading every /proc/*/cmdline caught it for about half of 300 such spawns (Linux). Android
// hides an app's processes from other apps. A file the kernel does not run itself (llamafile, a script with no
// shebang) keeps sh's own exec, which runs such a file as a script (env with toybox, Android's, or with musl has no
// such fallback: exit 126), and so do a program path holding '=' (env would take it for one more pair) and a system
// with no env. Those names are then left in the env, and the daemon warns: where /bin/sh is bash (macOS, Fedora) they
// still reach the program, while dash, mksh and busybox ash drop them.
// bash, under its own name or as /bin/sh (macOS, Fedora, RHEL, Arch), reads two exported variables that changed the
// watcher, and dash and mksh read neither. Its `read` takes TMOUT for a timeout, so on a host that exports one (CIS
// hardening sets TMOUT=900) the watcher's loop ended TMOUT seconds after the spawn and fired while the daemon lived:
// the watcher unsets it, and the program keeps it. bash also takes options from an exported SHELLOPTS, which an
// interactive shell's `export SHELLOPTS` fills with `monitor`, and job control puts each background job in a process
// group of its own. As /bin/sh, the watcher's subshell got one, so the watcher pinned no group, and a held group with
// one job left counted as down to its watcher and was killed at its command's exit. As the program (a Code bash
// command, which runs under bash wherever there is one), each `cmd &` got one on every host, as dash and mksh pass
// SHELLOPTS on as it is, and no watcher ended it: not at the command's exit, a scope's release or the daemon's death.
// So the child's env has SHELLOPTS without `monitor`, the rest as it was: neither the wrapper nor a bash program has
// job control. (`bash --norc -p` never sees one: an exported SHELLOPTS sends the wrapper through sh. bash as /bin/sh
// exports it again with its own options, `posix` among them, so a bash program runs in POSIX mode there.)
//
// ── Finding the program ────────────────────────────────────────────────────────────────────────────────────────
// resolveLikeExec mirrors what the child's own exec would do (a name with a slash is taken relative to the CHILD's
// cwd, a bare name is searched on the CHILD's PATH, libc's default path when that env has none, an empty entry
// meaning the cwd, non-executable entries and directories skipped), so the wrapper runs exactly the program an
// unwrapped spawn would have. When nothing is found, the program is spawned unwrapped (detached, as callers asked
// for before) and Node reports its usual ENOENT or EACCES with no pid, byte for byte. If an unwrapped spawn still
// gets a pid (a lookup this resolver got wrong), it is registered for the shutdown and exit kills and logged.
// `args === null` is the command-string form `{ shell: true }` uses: on POSIX it becomes `sh -c <command>` inside
// the wrapper, so an unresolved `claude` still prints `sh: 1: claude: not found` and exits 127.
//
// ── Held lifelines (Code bash commands, git) ───────────────────────────────────────────────────────────────────
// A HeldTether names a scope ('daemon' or `code-session:<id>`). When such a program exits and its group still has a
// member besides the watcher (a background job, git's credential-cache daemon), its lifeline is kept in that scope
// until the scope is released (releaseTetherScope: SIGTERM to the group, then the lifeline closes), the daemon
// stops (stopTethered), or the daemon dies (the kernel closes it). A held group whose members have all ended is
// closed by a re-count, right after each new hold and every RECOUNT_MS. The lifeline is one of child.stdio, so a held
// one holds Node's 'close' back until the release: only spawnHeld and tetheredExecFile can take a hold (the types
// say so), and both settle on 'exit' plus the end of stdout and stderr, or STDIO_IDLE_MS without data after the exit
// (pi's waitForChildProcess rule), never on 'close'. A timeout or an abort never leaves a group held.
//
// ── Code terminals ─────────────────────────────────────────────────────────────────────────────────────────────
// node-pty forks a terminal's shell itself, so it gets a stand-alone watcher instead (tetherTerminal, PTY_WATCH):
// closing the terminal, its shell exiting, or the daemon ending, however it ends, ends everything started in it.
//
// ── Android ────────────────────────────────────────────────────────────────────────────────────────────────────
// The app ships libtether_exec.so, which arms PR_SET_PDEATHSIG(SIGKILL) and execs the program in place. A boot
// self-test (tetherReady) must see a program running under the helper, then see it die when the helper's parent
// exits; only then does the helper replace the wrapper. Otherwise (no helper, or it failed either proof) the wrapper
// runs under /system/bin/sh. The helper ties the program alone (no group: what it forks is reparented to init when
// the daemon dies, and a graceful stop signals the pid only), so only the kinds whose program starts nothing, an
// engine and a probe, run under it; every other kind (an MCP stdio server, which may start children of its own)
// keeps the /system/bin/sh lifeline, a group kill and one watcher each. system_server's cgroup kill also applies to
// the app.
//
// ── Windows ────────────────────────────────────────────────────────────────────────────────────────────────────
// A child is spawned as it is today (never detached: libuv's kill-on-close job, whose only handle the daemon holds,
// kills the direct children however the daemon dies), and is registered. libuv's job allows breakaway, and Git for
// Windows breaks every child it creates away from such a job, so the job sentinel (win-job-sentinel.ts, .ps1) also
// puts each child, and what it has started, in a kill-on-close job of its own that allows none, whose only handle it
// hands to the daemon: `add` right after the spawn, with the time window around it for the sentinel's pid-reuse guard.
// An answer is kept whenever it arrives. When the program exits (or the answer comes after its exit) its job is
// ended (`end`: what it left dies, as POSIX's group kill does at exit), or, for a hold, closed if it has no live
// member and held otherwise (`idle`). A graceful stop ends each job, an atomic kill of the whole tree; without one
// it ends each tree with `taskkill /T /F` while its root is still alive (a SIGTERM there is a TerminateProcess of the
// root alone, which cut the root's children loose). The exit handler ends the rest in one `taskkill`, and the jobs
// close with the daemon's handles. A handle is given to `end` or a closing `idle` at most once: a value the OS has
// since reused for something else is never closed. Nothing more is sent for a handle while an `idle` of it is
// unanswered: the idle may close it, and the daemon's handle table can give the value out at once to the next job a
// child is added in, which an `end` sent behind the idle (a release, the shutdown, the keeper) would kill.
//
// This module imports only child_process, fs, path and url (and win-job-sentinel.ts's types), so it stays in the
// Android bundle (Node 18.20.4).
import { execFile, spawn, spawnSync, type ChildProcess, type ExecFileOptions, type SpawnOptions, type StdioOptions } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import type { Socket } from 'node:net'
import { basename, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddReply, JobSentinel } from './win-job-sentinel'

export type TetherKind = 'engine' | 'tunnel' | 'routine-cli' | 'code-bash' | 'agent-install' | 'mcp' | 'lsp' | 'build'
  | 'install' | 'provision' | 'extract' | 'usage' | 'chrome' | 'git' | 'probe'
export type TetherEnd = 'kill' | 'term-then-kill' | 'term'
export interface Tether {
  kind: TetherKind
  /** What the watcher does when the daemon dies. 'kill' (default): group SIGKILL. 'term-then-kill': group SIGTERM,
   *  then SIGKILL after GIT_GRACE_S (git releases its locks from its signal handler). 'term': SIGTERM to the program
   *  only; the child stays in the daemon's process group and keeps the caller's `detached` (package managers under
   *  sudo, which must only ever get SIGTERM from TurboLLM). */
  end?: TetherEnd
}
/** Keep the lifeline after the program exits while its group still has members, until this scope is released
 *  ('daemon' | `code-session:${id}`). Only spawnHeld and tetheredExecFile take it: a held lifeline is one of
 *  child.stdio, so Node's 'close' fires only at the release, and no caller may wait for it. */
export interface HeldTether extends Tether {
  hold: string
}

/** The watcher's grace between git's SIGTERM and the SIGKILL of its group. */
export const GIT_GRACE_S = 2
/** dash and mksh reject redirections of fd 10 or above, so the lifeline must land at or below this. */
export const MAX_LIFELINE_FD = 9
/** After the exit, how long stdout and stderr may stay idle before a held spawn settles anyway (pi's
 *  EXIT_STDIO_GRACE_MS, robust-bash.ts): a background job can hold the pipes open for as long as it runs. */
const STDIO_IDLE_MS = 100
/** How often held groups are re-counted, so a held watcher whose jobs have all ended does not stay. */
const RECOUNT_MS = 60_000
const ANDROID_HELPER_NAME = 'libtether_exec.so'

const noop = () => { /* deliberately empty */ }

/** How long a Windows spawnHeld waits, at most, for its tie (robust-bash's gate holds the command until then). */
const TIE_WAIT_MS = 2000

let platformOverride: NodeJS.Platform | null = null
/** The platform the tether acts for: process.platform, or a test's stand-in (its Windows protocol runs on every OS). */
export function tetherPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform
}
/** Test-only: act as if on `platform` (null: the real one). */
export function _setTetherPlatform(platform: NodeJS.Platform | null): void {
  platformOverride = platform
}

/** The Windows job sentinel, once cli.ts has started it (tests: a stand-in). */
let sentinel: JobSentinel | null = null
export function setJobSentinel(s: JobSentinel | null): void {
  sentinel = s
}

// ── The shell, and finding the program ─────────────────────────────────────────────────────────────────────────

/** The shell Node itself uses for `shell: true` (lib/child_process.js normalizeSpawnArguments). */
function nodeShell(): string {
  return process.platform === 'android' ? '/system/bin/sh' : '/bin/sh'
}
let wrapperShellOverride: string | null = null
function wrapperShell(): string {
  return wrapperShellOverride ?? nodeShell()
}
/** Test-only: run the wrapper under another POSIX shell (bash, mksh), as the tests do for each one they find. */
export function _setTetherShell(sh: string | null): void {
  wrapperShellOverride = sh
}

/** bionic's _PATH_DEFPATH (NDK 27's paths.h), which its execvp searches when PATH is unset. Older Android releases
 *  list fewer of these directories, or others first (/sbin); a directory a device lacks is simply not found. */
const BIONIC_DEFPATH = '/product/bin:/apex/com.android.runtime/bin:/apex/com.android.art/bin:/system_ext/bin:/system/bin:/system/xbin:/odm/bin:/vendor/bin:/vendor/xbin'

/** The path searched for a bare name when the child's env has no PATH. On Linux and Android libuv calls execvp in
 *  the child, so it is libc's own: glibc's /bin:/usr/bin, musl's /usr/local/bin:/bin:/usr/bin (where Alpine's node
 *  images keep node), or bionic's _PATH_DEFPATH. On macOS libuv walks _PATH_DEFPATH, /usr/bin:/bin, itself. The
 *  order matters where two directories hold a program of one name (/bin and /usr/bin when /bin is not a link, or
 *  /product/bin and /system/bin): the wrapper must run the one exec would have, and a name only libc's path finds
 *  must not be left unwrapped. */
let linuxDefaultPath: string | null = null
function defaultSearchPath(): string {
  if (process.platform === 'android') return BIONIC_DEFPATH
  if (process.platform !== 'linux') return '/usr/bin:/bin'
  linuxDefaultPath ??= isMusl() ? '/usr/local/bin:/bin:/usr/bin' : '/bin:/usr/bin'
  return linuxDefaultPath
}

/** Whether this Node runs on musl: its own mappings say, as musl's libc is its loader, ld-musl-<arch>.so.1 (Alpine
 *  also names it libc.musl-<arch>.so.1). glibc when /proc cannot tell. Not process.report.getReport(), which lists
 *  the same objects but first looks up every TCP handle's endpoints by reverse DNS, synchronously, on the daemon's
 *  event loop: seconds, with LAN or tunnel clients connected and a slow resolver. */
function isMusl(): boolean {
  try {
    const maps = readFileSync('/proc/self/maps', 'utf8')
    return maps.includes('/ld-musl-') || maps.includes('/libc.musl-')
  } catch {
    return false
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The file the child's own exec would run for `file`, or null when it would fail (ENOENT, EACCES). The rules are
 *  execvp's, as libuv applies them in the child, after its chdir and with the child's environment:
 *   - a name containing a slash is taken relative to `cwd` (the child's directory), else the daemon's;
 *   - a bare name is searched on the child's PATH (`env ?? process.env`), libc's default path when there is none;
 *     an empty entry means the cwd, and a relative entry is relative to it;
 *   - an entry that exists but is not executable, or is a directory, is skipped and the search goes on.
 *  util/resolve-executable.ts answers a different question (which form a Windows .cmd shim needs) and resolves
 *  against the daemon's cwd: `./x` with a cwd of its own named the wrong program. */
export function resolveLikeExec(file: string, opts: { cwd?: string | URL; env?: NodeJS.ProcessEnv } = {}): string | null {
  const base = opts.cwd === undefined ? process.cwd() : resolvePath(opts.cwd instanceof URL ? fileURLToPath(opts.cwd) : opts.cwd)
  if (file === '') return null
  if (file.includes('/')) {
    const p = resolvePath(base, file)
    return isExecutableFile(p) ? p : null
  }
  const env = opts.env ?? process.env
  const searchPath = env.PATH ?? defaultSearchPath()
  for (const dir of searchPath.split(':')) {
    const p = resolvePath(base, dir === '' ? '.' : dir, file)
    if (isExecutableFile(p)) return p
  }
  return null
}

let resolverOverride: typeof resolveLikeExec | null = null
/** Test-only: replace the resolver, so a lookup it gets wrong (a miss whose spawn still starts) can be shown. */
export function _setTetherResolver(resolver: typeof resolveLikeExec | null): void {
  resolverOverride = resolver
}

/** A name dash, mksh and busybox ash take from their environment and pass on: any other is dropped at the exec. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `s` as one single-quoted shell word. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The `env` the wrapper execs through when names must be carried (toybox's on Android), or null when none is
 *  found. */
let envBin: string | null | undefined
function envProgram(): string | null {
  if (envBin === undefined) {
    envBin = (process.platform === 'android' ? ['/system/bin/env'] : ['/usr/bin/env', '/bin/env']).find(isExecutableFile)
      ?? resolveLikeExec('env')
  }
  return envBin
}
/** Test-only: the env to carry names through (null: none; undefined: look it up again). */
export function _setTetherEnvProgram(p: string | null | undefined): void {
  envBin = p
}

/** The bash the wrapper runs under when the env holds names the shell would drop, or null: /bin/bash, else /bin/sh
 *  where that is bash (NixOS has no /bin/bash). A file whose real name is not bash's (busybox's `bash` applet, which
 *  is ash) is not taken. None on Android. */
let bashBin: string | null | undefined
function bashProgram(): string | null {
  if (bashBin === undefined) {
    bashBin = process.platform === 'android' ? null : ['/bin/bash', '/usr/bin/bash', '/bin/sh'].find((p) => {
      try {
        return isExecutableFile(p) && basename(realpathSync(p)).startsWith('bash')
      } catch {
        return false
      }
    }) ?? null
  }
  return bashBin
}
/** Test-only: the bash to pass names through (null: none, so env carries them; undefined: look it up again). */
export function _setTetherBash(p: string | null | undefined): void {
  bashBin = p
}
/** bash's flags for the wrapper (the header): no ~/.bashrc as for rshd, no BASH_ENV, no exported function. */
const BASH_FLAGS = ['--norc', '-p']

/** The first four bytes of a file the kernel runs itself: ELF, and Mach-O's thin and fat forms in either order. */
const BINARY_MAGIC = new Set([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])

/** Whether `file` (a regular file, from resolveLikeExec) is a `#!` script or an ELF or Mach-O binary, or one this
 *  process cannot read: a binary then, as no shell could run it as a script either. Any other file (llamafile, a
 *  shebang-less script) runs only through sh's own fallback, which runs a file the kernel refuses (ENOEXEC) as a
 *  script: env has that fallback with glibc and macOS, but not toybox's (Android) or with musl (Alpine's busybox),
 *  where it fails with exit 126. */
function kernelRuns(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const b = Buffer.alloc(4)
    const n = readSync(fd, b, 0, 4, 0)
    if (n >= 2 && b[0] === 0x23 && b[1] === 0x21) return true
    return n === 4 && BINARY_MAGIC.has(b.readUInt32BE(0))
  } catch {
    return true
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The program's arguments, in the portable form. bash as /bin/sh takes `set -u` from an exported SHELLOPTS holding
 *  `nounset` (startTethered takes only `monitor` out of it), and bash 4.0 then took an empty `"$@"` for an unbound
 *  variable: a program run with no arguments never started ("$@: unbound variable", exit 127). bash 3.2 (macOS) and
 *  4.1 on do not; `${1+"$@"}` is `"$@"` in every shell. */
const ARGS = '${1+"$@"}'

/** The wrapper script for a lifeline on fd `fd`. `extra`: the caller's own fds 3..fd-1, which the watcher closes.
 *  `dyldKeys`: the DYLD_* names to restore before the exec (macOS). `carried`: the names whose values travel as
 *  TURBOLLM_TETHER_V<i> (the i-th name), set by `env` as it execs the program; DYLD_* names are among them then, as
 *  macOS's /usr/bin/env is SIP-protected too. Exported for its tests. */
export function wrapperScript(o: { fd: number; extra: number[]; end: TetherEnd; dyldKeys?: string[]; carried?: { env: string; names: string[] } }): string {
  if (!Number.isInteger(o.fd) || o.fd < 3 || o.fd > MAX_LIFELINE_FD) throw new RangeError(`lifeline fd must be 3..${MAX_LIFELINE_FD}, got ${o.fd}`)
  const close = o.extra.map((n) => ` ${n}<&-`).join('')
  const fire = o.end === 'kill' ? 'kill -s KILL -- -$$'
    : o.end === 'term-then-kill' ? `kill -s TERM -- -$$; sleep ${GIT_GRACE_S}; kill -s KILL -- -$$`
      // The program alone: it stays in the daemon's group. Inside the subshells $$ is still the original shell's
      // pid, which the exec below gives to the program.
      : 'kill -s TERM $$'
  const dyld = (o.dyldKeys ?? []).map((k) => `${k}=$TURBOLLM_TETHER_${k}; export ${k}; unset TURBOLLM_TETHER_${k}; `).join('')
  // `unset TMOUT` in the watcher alone: bash's read would take it for a timeout (the header), and the program keeps
  // it.
  const watcher = `unset TMOUT; trap '' HUP INT TERM; exec </dev/null >/dev/null 2>&1${close}; ` +
    `while read -r l; do [ "$l" = q ] && exit 0; done <&${o.fd}; ${fire}`
  // The outer subshell starts the watcher in the background and exits at once, and sh waits for that foreground
  // subshell before it execs: the watcher's parent is init (or the nearest subreaper), never the program. With job
  // control off (startTethered takes `monitor` out of SHELLOPTS: the header), the watcher is in the program's group.
  const head = `( ( ${watcher} ) & ); `
  const names = o.carried?.names ?? []
  if (o.carried && names.length > 0) {
    // env execs in place too (same pid, stdio and status). `--` before the pairs: a name may start with '-'.
    const unset = names.map((_, i) => ` -u TURBOLLM_TETHER_V${i}`).join('')
    const pairs = names.map((k, i) => ` ${shQuote(k)}="$TURBOLLM_TETHER_V${i}"`).join('')
    return `${head}exec ${shQuote(o.carried.env)}${unset} --${pairs} "$0" ${ARGS} ${o.fd}<&-`
  }
  return `${head}${dyld}exec "$0" ${ARGS} ${o.fd}<&-`
}

/** Node's own reading of `stdio`, as an array of at least 3 entries (lib/internal/child_process.js getValidStdio:
 *  a missing or nullish entry below 3 is 'pipe', from 3 on 'ignore'). */
function normalizeStdio(stdio: StdioOptions | undefined): Exclude<StdioOptions, string> {
  if (stdio === undefined || stdio === null) return ['pipe', 'pipe', 'pipe']
  if (typeof stdio === 'string') return [stdio, stdio, stdio]
  const out = [...stdio]
  while (out.length < 3) out.push(undefined)
  return out.map((s, i) => (s === null || s === undefined ? (i < 3 ? 'pipe' : 'ignore') : s))
}

// ── The live set ───────────────────────────────────────────────────────────────────────────────────────────────

interface Entry {
  child: ChildProcess
  kind: TetherKind
  end: TetherEnd
  /** The daemon's end of the lifeline: the POSIX wrapper only. */
  socket: Socket | null
  /** The lifeline is still open on our side (and the watcher may still be waiting on it). */
  lifelineOpen: boolean
  /** child.pid leads a process group of its own, so the group can be signalled as a whole. */
  group: boolean
  hold?: string
  /** A timeout, an abort, a scope release or the shutdown: this one is never held. */
  noHold: boolean
  exited: boolean
  /** A graceful stop or a release is ending it (endGroups): its exit leaves the lifeline to that. */
  stopping: boolean
  /** 'deciding': exited, its group being counted. 'held': exited, kept in its scope. */
  state: 'live' | 'deciding' | 'held' | 'closed'
  /** Windows: its job from the sentinel. */
  job?: JobTie
  /** spawnHeld's `tied`. */
  tied?: Promise<void>
}

/** A Windows child's job. 'pending': `add` not answered yet. 'tied': the daemon holds the job's handle. 'ended' or
 *  'closed': the handle was given back (at most once). 'untied': no job (gone, refused, no sentinel). 'lost': the
 *  sentinel died before it answered an `idle`, which may have closed the handle already: it is never used again, and
 *  what is left in the job (if anything) ends with the daemon. */
interface JobTie {
  state: 'pending' | 'tied' | 'ended' | 'closed' | 'untied' | 'lost'
  handle: string | null
  /** An end was asked for while the answer to `add`, or to an `idle`, was pending: carried out when it comes (for an
   *  idle, unless it closed the job, which then had nothing left to end). */
  endWanted: boolean
  /** A tied job's `idle` is unanswered (settles once it is answered and acted on): no `end` or second `idle` is sent
   *  for the handle meanwhile (see the header). */
  idling: Promise<void> | null
}

function jobOpen(e: { job?: JobTie }): boolean {
  return e.job !== undefined && (e.job.state === 'pending' || e.job.state === 'tied')
}

/** Every entry whose program runs or whose lifeline is still open. */
const entries = new Set<Entry>()
const byChild = new WeakMap<ChildProcess, Entry>()

function forgetIfDone(e: Entry): void {
  if (e.exited && !e.lifelineOpen && !jobOpen(e)) {
    e.state = 'closed'
    entries.delete(e)
  }
}

/** Close the lifeline: the watcher fires its end mode on whatever is left of the group. */
function closeLifeline(e: Entry): void {
  if (!e.lifelineOpen) return
  e.lifelineOpen = false
  e.socket?.destroy()
  forgetIfDone(e)
}

/** Tell the watcher to leave without firing, then close. */
function quitLifeline(e: Entry): void {
  if (!e.lifelineOpen) return
  e.lifelineOpen = false
  // A watcher that is already gone makes this an EPIPE, which the socket's 'error' listener swallows: without one
  // it was an unhandled 'error' that crashed the daemon (measured).
  e.socket?.end('q\n')
  forgetIfDone(e)
}

function signalGroup(e: Entry, sig: NodeJS.Signals): void {
  const pid = e.child.pid
  if (!pid) return
  if (e.exited || e.child.exitCode !== null || e.child.signalCode !== null) {
    // Node has reaped the program, so its pid may name another process by now, and once its group has ended so may
    // the group id: every tethered program leads its group. Only the watcher, a member while the lifeline is open,
    // still pins that id (a held group, a group being counted). Never the bare pid, as child.kill() would not.
    if (e.group && e.lifelineOpen) {
      try {
        process.kill(-pid, sig)
      } catch {
        /* the group has ended */
      }
    }
    return
  }
  if (e.group) {
    try {
      process.kill(-pid, sig)
      return
    } catch {
      /* no such group any more: the pid alone, below */
    }
  }
  try {
    process.kill(pid, sig)
  } catch {
    /* already gone */
  }
}

function register(e: Entry): void {
  entries.add(e)
  byChild.set(e.child, e)
  const socket = e.socket
  if (socket) {
    socket.on('error', noop)
    socket.on('close', () => {
      // The watcher left (it fired, or saw `q`), or we closed our end.
      e.lifelineOpen = false
      forgetIfDone(e)
    })
    // Read our end, so the watcher's own death (its group was killed) is seen as an EOF. It never writes.
    socket.resume()
  }
  e.child.once('exit', () => onProgramExit(e))
}

function onProgramExit(e: Entry): void {
  e.exited = true
  if (e.job) {
    // Windows. An answer still pending acts on the exit when it comes (onJobReply).
    if (e.job.state === 'tied') actOnJobAtExit(e)
    else forgetIfDone(e)
    return
  }
  if (!e.lifelineOpen) return forgetIfDone(e)
  if (e.stopping) return // endGroups closes it once the group is down to the watcher, or at its grace
  if (e.end === 'term') return quitLifeline(e) // it ended by itself: no SIGTERM for it
  if (e.hold !== undefined && !e.noHold && e.group) {
    e.state = 'deciding'
    const pid = e.child.pid as number
    void countGroupMembers().then((counts) => {
      if (e.state !== 'deciding') return // a release, the shutdown or closeAllLifelines got there first
      const members = counts.get(pid) ?? 0 // the watcher is always one of them
      if (!e.noHold && members > 1) {
        e.state = 'held'
        void recountHeld()
        armRecount()
      } else if (e.end === 'term-then-kill' && members <= 1 && !e.noHold) {
        quitLifeline(e) // nothing is left for git's grace to wait on
      } else {
        closeLifeline(e)
      }
    })
    return
  }
  // Whatever the program left in its group dies with it.
  closeLifeline(e)
}

// ── Windows jobs ───────────────────────────────────────────────────────────────────────────────────────────────

/** The sentinel's answer to `add`, whenever it comes: kept, and acted on as the program's exit would have been when
 *  the program has exited meanwhile (a Code bash `nohup srv &`, or `cmd /c start srv`, returns within milliseconds
 *  and leaves srv running). The pid-reuse guard already makes a wrong tie all but impossible. */
function onJobReply(e: Entry, r: AddReply): void {
  const j = e.job as JobTie
  if (r.kind === 'ok') {
    j.handle = r.handle
    j.state = 'tied'
    if (j.endWanted) endJob(e)
    else if (e.exited) actOnJobAtExit(e)
    return
  }
  j.state = 'untied'
  if (r.kind === 'refused') {
    console.warn(`[tether] ${e.child.spawnfile}: the windows job sentinel refused pid ${e.child.pid} (${r.reason}); its children are tied by libuv's job only`)
  }
  // 'gone': it exited and its handle was closed before the sentinel opened it; what it started is tied only as
  // libuv's job ties it (Known). 'unavailable': no sentinel.
  forgetIfDone(e)
}

/** Kill the job's whole tree and give its handle back, at most once. False when there is no job to end (no sentinel,
 *  untied, already ended), or the sentinel cannot be reached now: the caller falls back to a tree kill. While the
 *  answer to its `add` or to an `idle` of it is pending, the end is carried out when it comes. `s`: the sentinel to
 *  send it to (an idle's answer goes to the one it was sent to, which the keeper has let go of by then). */
function endJob(e: { job?: JobTie }, s: JobSentinel | null = sentinel): boolean {
  const j = e.job
  if (!j) return false
  if (j.state === 'pending' || (j.state === 'tied' && j.idling)) {
    j.endWanted = true
    return true
  }
  if (j.state !== 'tied' || !j.handle || !s || !s.end(j.handle)) return false
  j.state = 'ended'
  forgetIfDone(e as Entry)
  return true
}

/** The sentinel died before it answered an `idle` of this job, so its handle may be closed already and may since name
 *  another job of the daemon's: it is never sent again (an `end` or `idle` on it could close that other job), and what
 *  is left in the job, if anything, ends with the daemon (Known). */
function loseJob(e: Entry): void {
  ;(e.job as JobTie).state = 'lost'
  console.warn(`[tether] ${e.child.spawnfile}: the windows job sentinel died before it said whether pid ${e.child.pid}'s job is empty; what is left in it ends with the daemon`)
  forgetIfDone(e)
}

/** The program has exited and its job is tied: what it left dies (`end`), or for a hold, the job is closed when it
 *  has no live member and held in its scope otherwise (`idle`). */
function actOnJobAtExit(e: Entry): void {
  if (e.hold === undefined || e.noHold || e.stopping || !sentinel) {
    endJob(e)
    return
  }
  e.state = 'deciding'
  void idleJob(e, sentinel).then((r) => {
    if (r !== 'held') return
    // The job is the daemon's until it is released or the daemon ends.
    e.state = 'held'
    armRecount()
  })
}

/** Send a tied job's `idle` to `s` and act on the answer. 'closed': it had no live member, and the sentinel closed the
 *  handle, so nothing more is sent for it (an end asked for meanwhile included: the value may name another job by
 *  now). 'lost': loseJob. 'held', or the sentinel is down: it stays the daemon's, unless an end was asked for
 *  meanwhile or it may no longer be held (a release, the shutdown, the keeper), and then it is ended now. */
function idleJob(e: Entry, s: JobSentinel): Promise<'closed' | 'lost' | 'ended' | 'held'> {
  const j = e.job as JobTie
  let answered = noop
  j.idling = new Promise<void>((resolve) => { answered = resolve })
  return s.idle(j.handle as string).then((r) => {
    j.idling = null
    try {
      if (j.state !== 'tied') return 'ended'
      if (r === 'closed') {
        j.state = 'closed'
        forgetIfDone(e)
        return 'closed'
      }
      if (r === 'lost') {
        loseJob(e)
        return 'lost'
      }
      if ((j.endWanted || e.noHold) && endJob(e, s)) return 'ended'
      return 'held'
    } finally {
      answered()
    }
  })
}

// ── Group counts ───────────────────────────────────────────────────────────────────────────────────────────────

/** Live (non-zombie) members of every process group. Linux and Android: one pass over /proc/<pid>/stat (field 5 is
 *  the group). macOS and the rest: one `ps -A -o pgid=,stat=`. A zombie is not counted: it holds nothing. */
function countGroupMembers(): Promise<Map<number, number>> {
  if (existsSync('/proc/self/stat')) return Promise.resolve(procGroupCounts())
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,stat='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = new Map<number, number>()
      if (!err) {
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*(\d+)\s+(\S+)/.exec(line)
          if (!m || m[2].startsWith('Z')) continue
          const pg = Number(m[1])
          out.set(pg, (out.get(pg) ?? 0) + 1)
        }
      }
      resolve(out)
    })
  })
}

function procGroupCounts(): Map<number, number> {
  const out = new Map<number, number>()
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return out
  }
  for (const d of names) {
    const c = d.charCodeAt(0)
    if (c < 48 || c > 57) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${d}/stat`, 'utf8')
    } catch {
      continue
    }
    // `pid (comm) state ppid pgrp …`: comm may hold spaces and parentheses, so split after the last ')'.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (f[0] === 'Z' || f[0] === 'X') continue
    const pg = Number(f[2])
    out.set(pg, (out.get(pg) ?? 0) + 1)
  }
  return out
}

let recountTimer: ReturnType<typeof setInterval> | null = null
function armRecount(): void {
  if (recountTimer) return
  recountTimer = setInterval(() => void recountHeld(), RECOUNT_MS)
  recountTimer.unref()
}

/** Close every held group that is down to its watcher (Windows: every held job with no live member). Returns how
 *  many were closed. Also run by the tests. */
export async function recountHeld(): Promise<number> {
  const all = [...entries].filter((e) => e.state === 'held')
  if (all.length === 0) {
    if (recountTimer) clearInterval(recountTimer)
    recountTimer = null
    return 0
  }
  let closed = 0
  const jobs = all.filter((e) => e.job)
  const held = all.filter((e) => !e.job)
  if (jobs.length > 0 && sentinel) {
    const s = sentinel
    await Promise.all(jobs.map(async (e) => {
      const j = e.job as JobTie
      if (j.state !== 'tied' || !j.handle || j.idling) return // an idle of it is unanswered: one at a time
      if ((await idleJob(e, s)) === 'closed') {
        e.state = 'closed'
        closed++
      }
    }))
  }
  const counts = held.length > 0 ? await countGroupMembers() : new Map<number, number>()
  for (const e of held) {
    if (e.state !== 'held') continue
    if ((counts.get(e.child.pid as number) ?? 0) <= 1) {
      if (e.end === 'term-then-kill') quitLifeline(e)
      else closeLifeline(e)
      closed++
    }
  }
  if (![...entries].some((e) => e.state === 'held') && recountTimer) {
    clearInterval(recountTimer)
    recountTimer = null
  }
  return closed
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Once every promise in `list` has settled, or after `ms`, whichever is first; the timer never outlives the wait. */
async function settledWithin(list: Promise<void>[], ms: number): Promise<void> {
  if (list.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(list), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  clearTimeout(timer)
}

/** End these groups gracefully: SIGTERM to each (term mode: to the program alone), then close each lifeline once
 *  its program has exited and only the watcher is left, or after `graceMs` (the watcher then fires its end mode: a
 *  group SIGKILL, or git's TERM and grace). A term-mode lifeline is never closed here: it gets `q` once its program
 *  has exited, and otherwise stays for the daemon's own exit. Resolves once the groups are gone (bounded), so a
 *  caller that removes a directory next (the Code session delete) finds nothing running in it. */
async function endGroups(list: Entry[], graceMs: number): Promise<void> {
  const open = list.filter((e) => e.lifelineOpen || !e.exited)
  if (open.length === 0) return
  for (const e of open) {
    e.noHold = true
    e.stopping = true // its exit no longer closes the lifeline: this loop does
    if (e.state === 'deciding') e.state = 'live' // its count is moot now
    signalGroup(e, 'SIGTERM')
  }
  const deadline = Date.now() + graceMs
  let pending = open
  const settle = (counts: Map<number, number>) => {
    for (const e of pending) {
      if (!e.exited) continue
      if (e.end === 'term') quitLifeline(e)
      else if ((counts.get(e.child.pid as number) ?? 0) <= 1) {
        // Down to the watcher: git's has nothing left to give its grace to.
        if (e.end === 'term-then-kill') quitLifeline(e)
        else closeLifeline(e)
      }
    }
    pending = pending.filter((e) => e.lifelineOpen || !e.exited)
  }
  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())))
    settle(await countGroupMembers())
  }
  for (const e of pending) {
    if (e.end === 'term') continue
    if (e.socket) closeLifeline(e)
    else if (!e.exited) signalGroup(e, 'SIGKILL') // the Android helper's children, and a resolver miss
  }
  const until = Date.now() + 1000 + (open.some((e) => e.end === 'term-then-kill') ? GIT_GRACE_S * 1000 : 0)
  const grouped = open.filter((e) => e.group && e.end !== 'term')
  for (;;) {
    const counts = await countGroupMembers()
    if (grouped.every((e) => (counts.get(e.child.pid as number) ?? 0) === 0) || Date.now() >= until) return
    await sleep(50)
  }
}

// ── Spawning ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The helper the Android self-test passed, or null (no helper, not Android, or it failed). */
let androidHelper: string | null = null

/** Set by refuseNewTetheredSpawns: this process is a restart keeper, and starts nothing more. */
let refusing = false

/** For the restart keeper (cli.ts becomeKeeper), after closeAllLifelines: every later tethered spawn throws, and a
 *  terminal gets no tie. The keeper is the old daemon's process, and whatever of its work was still in flight (an
 *  engine install's extraction, a build step) would otherwise start children tied to the keeper alone, which the
 *  replacement neither sees nor stops. */
export function refuseNewTetheredSpawns(): void {
  refusing = true
}

function startTethered(file: string, args: readonly string[] | null, options: SpawnOptions, tether: Tether & { hold?: string }): Entry {
  if (refusing) throw new Error(`spawnTethered(${file}): this process is a restart keeper and starts nothing more`)
  const end = tether.end ?? 'kill'
  if (tetherPlatform() === 'win32') {
    // A detached child is outside libuv's kill-on-close job: nothing would end it with the daemon.
    if (options.detached) throw new TypeError(`spawnTethered(${file}): a detached child escapes the daemon's job on Windows`)
    // The window around the spawn() call: the sentinel's pid-reuse guard checks the child's creation time against it.
    const startMs = Date.now()
    const child = args === null ? spawn(file, options) : spawn(file, [...args], options)
    const endMs = Date.now()
    const e: Entry = { child, kind: tether.kind, end, socket: null, lifelineOpen: false, group: false, hold: tether.hold, noHold: false, exited: false, stopping: false, state: 'live' }
    if (child.pid !== undefined) {
      if (sentinel?.available()) {
        e.job = { state: 'pending', handle: null, endWanted: false, idling: null }
        const reply = sentinel.add(child.pid, startMs, endMs).then((r) => onJobReply(e, r))
        e.tied = Promise.race([reply, new Promise<void>((resolve) => setTimeout(resolve, TIE_WAIT_MS).unref())])
      }
      register(e)
    }
    return e
  }
  const { shell, ...opts } = options
  let program = file
  let argv: readonly string[] = args ?? []
  if (args === null && shell) {
    program = typeof shell === 'string' ? shell : nodeShell()
    argv = ['-c', file]
  }
  const resolved = (resolverOverride ?? resolveLikeExec)(program, { cwd: opts.cwd, env: opts.env })
  if (resolved === null) return startUnwrapped(program, argv, opts, tether, end)
  // The helper ties the program alone, so only a program that starts nothing runs under it (the Android header).
  if (androidHelper && (tether.kind === 'engine' || tether.kind === 'probe')) return startUnderHelper(androidHelper, program, resolved, argv, opts, tether, end)

  const stdio = normalizeStdio(opts.stdio)
  const fd = stdio.length
  if (fd > MAX_LIFELINE_FD) {
    throw new RangeError(`spawnTethered(${program}): ${fd} stdio entries leave no lifeline fd at or below ${MAX_LIFELINE_FD}`)
  }
  const extra: number[] = []
  for (let i = 3; i < fd; i++) extra.push(i)
  let env = opts.env
  const source = opts.env ?? process.env
  let dyldKeys: string[] = []
  if (process.platform === 'darwin') {
    dyldKeys = Object.keys(source).filter((k) => /^DYLD_[A-Za-z0-9_]+$/.test(k) && source[k] !== undefined)
  }
  // Names the shell would drop (not identifiers): bash passes them on; without it they are carried past the shell
  // with the DYLD_* ones, and env sets them again (the header).
  let wrapper = wrapperShell()
  let flags: string[] = []
  let carried: { env: string; names: string[] } | undefined
  const unnamed = Object.keys(source).filter((k) => k !== '' && !SHELL_NAME.test(k) && source[k] !== undefined)
  const bash = unnamed.length > 0 && source.SHELLOPTS === undefined && source.BASHOPTS === undefined ? bashProgram() : null
  if (bash !== null) {
    wrapper = bash
    flags = BASH_FLAGS
  } else if (unnamed.length > 0) {
    const envPath = envProgram()
    // env would take a program path holding '=' for one more NAME=VALUE pair. A file the kernel does not run itself
    // keeps sh's exec, whose fallback runs it as a script (kernelRuns); dash, mksh and busybox ash running it would
    // not pass the names on either. Not carried, the names stay in sh's env: bash passes them on, the others do not.
    const why = envPath === null ? 'no env program found' : resolved.includes('=') ? 'its path holds "="'
      : kernelRuns(resolved) ? null : 'it has no shebang and runs through sh'
    if (envPath === null || why !== null) {
      console.warn(`[tether] ${program}: ${why}, so ${unnamed.length} variable(s) whose names are not shell identifiers may not reach it (dash, mksh and busybox ash drop them)`)
    } else {
      carried = { env: envPath, names: [...unnamed, ...dyldKeys] }
    }
  }
  const moved = carried?.names ?? dyldKeys
  // An exported SHELLOPTS holding `monitor` turns job control on in bash, as the wrapper or as the program, and puts
  // the watcher, or a bash program's `cmd &`, in a process group no watcher ends (the header).
  const shellOpts = source.SHELLOPTS?.split(':')
  const noMonitor = shellOpts?.includes('monitor') ? shellOpts.filter((o) => o !== 'monitor').join(':') : undefined
  if (moved.length > 0 || noMonitor !== undefined) {
    const next: NodeJS.ProcessEnv = { ...source }
    if (noMonitor !== undefined) next.SHELLOPTS = noMonitor
    for (const [i, k] of moved.entries()) {
      next[carried ? `TURBOLLM_TETHER_V${i}` : `TURBOLLM_TETHER_${k}`] = next[k]
      delete next[k]
    }
    env = next
  }
  const child = spawn(wrapper, [...flags, '-c', wrapperScript({ fd, extra, end, dyldKeys, carried }), resolved, ...argv], {
    ...opts,
    env,
    stdio: [...stdio, 'pipe'],
    detached: end === 'term' ? !!opts.detached : true,
  })
  nameTheProgram(child, program, argv)
  const socket = (child.stdio[fd] as Socket | null) ?? null
  const e: Entry = {
    child, kind: tether.kind, end, socket, lifelineOpen: socket !== null, group: end !== 'term' || !!opts.detached,
    hold: tether.hold, noHold: false, exited: false, stopping: false, state: 'live',
  }
  if (child.pid === undefined) {
    // sh itself could not start (EAGAIN): Node emits the 'error'; there is nothing to tie.
    socket?.destroy()
    e.lifelineOpen = false
    return e
  }
  register(e)
  return e
}

/** spawnfile and spawnargs name the program, not the wrapper: they are what Node's own errors and every log
 *  line built from them show. */
function nameTheProgram(child: ChildProcess, program: string, argv: readonly string[]): void {
  const c = child as { spawnfile: string; spawnargs: string[] }
  c.spawnfile = program
  c.spawnargs = [program, ...argv]
}

function startUnwrapped(program: string, argv: readonly string[], opts: SpawnOptions, tether: Tether & { hold?: string }, end: TetherEnd): Entry {
  const detached = end === 'term' ? !!opts.detached : true
  const child = spawn(program, [...argv], { ...opts, detached })
  const e: Entry = { child, kind: tether.kind, end, socket: null, lifelineOpen: false, group: detached, hold: tether.hold, noHold: false, exited: false, stopping: false, state: 'live' }
  if (child.pid !== undefined) {
    // A lookup this resolver got wrong: still stopped and killed with the rest, but nothing kills it if the
    // daemon dies.
    console.warn(`[tether] ${program}: started without a lifeline (resolver miss); it is stopped with the daemon but not tied to it`)
    register(e)
  }
  return e
}

function startUnderHelper(helper: string, program: string, resolved: string, argv: readonly string[], opts: SpawnOptions, tether: Tether & { hold?: string }, end: TetherEnd): Entry {
  // The helper arms PR_SET_PDEATHSIG(SIGKILL) and execs the program in place (same pid, stdio and status). The
  // signal follows the forking thread, and libuv forks on the Node thread, which lives as long as the daemon.
  const child = spawn(helper, [String(process.pid), resolved, ...argv], { ...opts, detached: false })
  nameTheProgram(child, program, argv)
  const e: Entry = { child, kind: tether.kind, end, socket: null, lifelineOpen: false, group: false, hold: tether.hold, noHold: false, exited: false, stopping: false, state: 'live' }
  if (child.pid !== undefined) register(e)
  return e
}

/** spawn() tied to the daemon. `args === null` is the command-string form (`shell: true`). No hold. */
export function spawnTethered(file: string, args: readonly string[] | null, options: SpawnOptions, tether: Tether): ChildProcess {
  return startTethered(file, args, options, { kind: tether.kind, end: tether.end }).child
}

/** 'exit' plus the end (or destruction) of stdout and stderr, or STDIO_IDLE_MS without data after the exit. Never
 *  'close', which a held lifeline holds back. Attaches 'data' listeners, so the caller's own readers must be
 *  attached in the same tick (they are: every caller attaches them right after the spawn). */
function settleOnExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let outDone = child.stdout === null
    let errDone = child.stderr === null
    let idle: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = () => {
      if (done || !exit) return
      done = true
      if (idle) clearTimeout(idle)
      resolve(exit)
    }
    const check = () => { if (exit && outDone && errDone) finish() }
    const arm = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(finish, STDIO_IDLE_MS)
    }
    const onData = () => { if (exit && !done) arm() }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    for (const [stream, mark] of [[child.stdout, () => { outDone = true }], [child.stderr, () => { errDone = true }]] as const) {
      if (!stream) continue
      const ended = () => { mark(); check() }
      stream.once('end', ended)
      stream.once('close', ended)
    }
    child.once('error', (err) => {
      if (child.pid === undefined && !done) {
        done = true
        reject(err)
      }
    })
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      check()
      if (!done) arm()
    })
  })
}

/** A tethered spawn that may be held. `settled` resolves on 'exit' plus the end of stdout and stderr, or 100 ms
 *  without data after the exit, never on 'close', and rejects with the spawn's error when it did not start.
 *  `tied` resolves once the child is tied: at once on POSIX and Android; on Windows once the job sentinel has
 *  answered for it, or after TIE_WAIT_MS, at once when there is no sentinel (libuv's job is in place the moment
 *  spawn returns). robust-bash holds a command until then, so whatever it starts is born in its job. */
export function spawnHeld(file: string, args: readonly string[] | null, options: SpawnOptions, tether: HeldTether):
  { child: ChildProcess; tied: Promise<void>; settled: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const e = startTethered(file, args, options, tether)
  const settled = settleOnExit(e.child)
  settled.catch(noop) // a caller that only wants `child` must not get an unhandled rejection
  return { child: e.child, tied: e.tied ?? Promise.resolve(), settled }
}

/** An execFile-shaped rejection: an Error with execFile's extra fields. */
interface ExecError extends Error {
  [field: string]: unknown
}

/** The options tetheredExecFile takes: execFile's, with a text encoding. */
export type TetheredExecFileOptions = Omit<ExecFileOptions, 'encoding' | 'shell'> & { encoding?: BufferEncoding }

/** Drop-in for promisify(execFile): the same arguments, result and rejection shapes (`code`, `signal`, `killed`,
 *  `cmd`, `stdout`, `stderr`; AbortError; the maxBuffer RangeError; a spawn error as Node reports it). `cmd` and
 *  `message` name the real program, not the wrapper. It settles as spawnHeld does, never on 'close'. A timeout,
 *  an abort or an overrun maxBuffer marks the entry no-hold and closes its lifeline, so the watcher ends the whole
 *  group by its end mode, and nothing of it is held. stdin stays an open pipe, as execFile leaves it. */
export function tetheredExecFile(tether: Tether | HeldTether): (file: string, args?: readonly string[], options?: TetheredExecFileOptions) => Promise<{ stdout: string; stderr: string }> {
  return (file, args = [], options = {}) => new Promise((resolve, reject) => {
    const { timeout = 0, maxBuffer = 1024 * 1024, killSignal = 'SIGTERM', encoding = 'utf8', signal, ...rest } = options
    const cmd = args.length > 0 ? `${file} ${args.join(' ')}` : file
    if (signal?.aborted) {
      reject(Object.assign(abortError(signal), { cmd, stdout: '', stderr: '' }))
      return
    }
    let e: Entry
    try {
      e = startTethered(file, args, {
        cwd: rest.cwd, env: rest.env, uid: rest.uid, gid: rest.gid, windowsHide: !!rest.windowsHide,
        windowsVerbatimArguments: !!rest.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'],
      }, tether)
    } catch (err) {
      reject(err)
      return
    }
    const child = e.child
    let stdout = ''
    let stderr = ''
    let stdoutLen = 0
    let stderrLen = 0
    let ex: ExecError | null = null
    let killed = false
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (!ex && code === 0 && sig === null) return resolve({ stdout, stderr })
      const err = ex ?? Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`) as ExecError, {
        code, killed: child.killed || killed, signal: sig,
      })
      err.cmd = cmd
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    }
    /** execFile's kill(): stop reading, kill the program, and here also end its group without holding it. */
    const kill = () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      killed = true
      e.noHold = true
      try {
        child.kill(killSignal)
      } catch (err) {
        ex = err as ExecError
      }
      closeLifeline(e)
    }
    const onAbort = () => {
      if (finished) return
      ex = abortError(signal as AbortSignal)
      kill()
      finish(null, null) // execFile settles at the abort, not at the exit
    }
    if (timeout > 0) timer = setTimeout(kill, timeout)
    signal?.addEventListener('abort', onAbort, { once: true })
    const collect = (which: 'stdout' | 'stderr') => (chunk: string) => {
      const length = Buffer.byteLength(chunk, encoding)
      const before = which === 'stdout' ? stdoutLen : stderrLen
      if (which === 'stdout') stdoutLen += length
      else stderrLen += length
      let piece = chunk
      if (before + length > maxBuffer) {
        piece = chunk.slice(0, Math.max(0, maxBuffer - before))
        if (!ex) ex = Object.assign(new RangeError(`${which} maxBuffer length exceeded`) as ExecError, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
        kill()
      }
      if (which === 'stdout') stdout += piece
      else stderr += piece
    }
    child.stdout?.setEncoding(encoding)
    child.stderr?.setEncoding(encoding)
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    settleOnExit(child).then(({ code, signal: sig }) => finish(code, sig), (err: Error) => {
      // Did not start: Node's own error (ENOENT, EACCES), with execFile's cmd, stdout and stderr added.
      ex = err as ExecError
      finish(null, null)
    })
  })
}

function abortError(signal: AbortSignal): ExecError {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }) as ExecError, { name: 'AbortError', code: 'ABORT_ERR' })
}

// ── Ending them ────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `child` was started here as the leader of a process group of its own (for a pidfile's `group`). */
export function isTetheredGroupLeader(child: ChildProcess): boolean {
  return byChild.get(child)?.group === true
}

/** For a caller's own timeout or abort of a spawnHeld child: never hold its group, and close its lifeline now, so the
 *  watcher ends the whole group by its end mode (git: SIGTERM, the grace, SIGKILL). A hung credential helper must not
 *  stay held until TurboLLM stops. (tetheredExecFile does this itself.) */
export function endTetheredGroup(child: ChildProcess): void {
  const e = byChild.get(child)
  if (!e) return
  e.noHold = true
  closeLifeline(e)
}

/** Force path for one tethered child. POSIX: kill(-pid, sig), else the pid; once the program has exited, its group
 *  only while its watcher still pins the id, and never the pid, which Node has reaped (an engine whose stdio an
 *  escaped worker holds open is force-killed after its exit). Windows: its job ended (the whole tree at once), else
 *  taskkill /T /F while the program runs, never once Node has seen it exit (libuv has then closed its handle, which
 *  kept the pid from being reused). */
export function killTetheredTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  if (tetherPlatform() === 'win32') {
    const e = byChild.get(child)
    if (e?.job?.state === 'tied' && endJob(e)) return // the whole tree at once
    if (e) endJob(e) // an answer still pending ends the job when it comes; the tree kill below does not wait for it
    // A taskkill /T of a pid Node has seen exit could end another process tree that got the number.
    if (child.exitCode !== null || child.signalCode !== null) return
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, noop)
    return
  }
  const e = byChild.get(child)
  if (e) return signalGroup(e, signal)
  // Not started here: as child.kill() does, nothing once Node has reaped it (its pid may name another process).
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

/** Release a hold scope: SIGTERM each held group, then close its lifeline once only its watcher is left, or after
 *  `graceMs`. A command of that scope still running is not held when it exits. Resolves once those groups are gone
 *  (bounded), so a caller can remove the directory they ran in next. A group still being counted at its program's
 *  exit ('deciding') is ended as a held one is: its count (through `ps` on macOS, tens of milliseconds) used to come
 *  back after this had returned, and only then ended it. */
export async function releaseTetherScope(scope: string, graceMs = 3000): Promise<void> {
  const held: Entry[] = []
  const idles: Promise<void>[] = []
  for (const e of entries) {
    if (e.hold !== scope) continue
    e.noHold = true
    if (e.state === 'held' || e.state === 'deciding') held.push(e)
    if (e.job?.idling) idles.push(e.job.idling)
  }
  const jobs = held.filter((e) => e.job)
  if (jobs.length > 0 || idles.length > 0) {
    // Windows: each held job ended at once, no SIGTERM step (there it would be a TerminateProcess of one process);
    // one whose idle is unanswered is ended at the answer (unless that idle closed it), which is waited for, bounded.
    // A moment for its processes to be gone, so a caller that removes their directory next can.
    for (const e of jobs) endJob(e)
    await settledWithin(idles, graceMs)
    await sleep(200)
  }
  await endGroups(held.filter((e) => !e.job), graceMs)
}

/** For the restart keeper: every lifeline closed now, held or not, so each watcher fires its end mode, and every
 *  Code terminal released. Windows: every job ended, held ones included; a running child whose job cannot be ended
 *  now (its sentinel is restarting) has its tree killed while its root lives, as stopTethered does, rather than
 *  living on in the keeper. `deps` is for the tests: the Windows tree kill. */
export function closeAllLifelines(deps: { treeKill?: (pids: number[]) => void } = {}): void {
  const roots: number[] = []
  for (const e of [...entries]) {
    e.noHold = true
    closeLifeline(e)
    if (!endJob(e) && e.job?.state === 'tied' && !e.exited && e.child.pid) roots.push(e.child.pid)
  }
  if (roots.length > 0) (deps.treeKill ?? win32TreeKill)(roots)
  for (const t of [...terminals]) releaseTerminal(t)
  // Windows: the keeper's replacement starts a sentinel of its own. One whose idle is unanswered is stopped once it is
  // answered (bounded), so that a held job's end, sent at the answer, still reaches it.
  if (sentinel) {
    const s = sentinel
    sentinel = null
    const idles = [...entries].map((e) => e.job?.idling).filter((p): p is Promise<void> => !!p)
    if (idles.length === 0) s.stop()
    else void settledWithin(idles, 3000).then(() => s.stop())
  }
}

/** The default Windows tree kill: one taskkill for every root, sent while they are alive. */
function win32TreeKill(pids: number[]): void {
  if (pids.length === 0) return
  execFile('taskkill', ['/F', '/T', ...pids.flatMap((p) => ['/PID', String(p)])], { windowsHide: true }, noop)
}

/** Graceful shutdown, for every tethered child except engines and tunnels, which their owners stop:
 *   - POSIX: SIGTERM to each group (term mode: to the program alone), and every held scope is released; after
 *     `graceMs` the lifelines still open are closed, a group SIGKILL, though never for term mode (the daemon's exit
 *     sends that one its SIGTERM again). Every Code terminal is released: its shell is hung up, and what is left of
 *     its session is killed 1 s later;
 *   - Windows: each job is ended (the sentinel's `end`, an atomic kill of the whole tree), held ones and Code
 *     terminals' included; a child with no job has its tree ended while its root is alive (taskkill /T /F). No
 *     SIGTERM step: there it would be a TerminateProcess of the root alone, and the root's children cut loose.
 *  `deps` is for the tests: the platform, and the Windows tree kill. */
export async function stopTethered(graceMs = 3000, deps: { platform?: NodeJS.Platform; treeKill?: (pids: number[]) => void } = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  const all = [...entries]
  for (const e of all) e.noHold = true // shutting down: nothing new is held
  const live = all.filter((e) => !e.exited && e.kind !== 'engine' && e.kind !== 'tunnel')
  if (platform === 'win32') {
    // Each job ended (its whole tree at once); a child with none, or whose answer is still pending (it is ended when
    // the answer comes), its tree with taskkill while its root lives.
    const roots: number[] = []
    for (const e of live) {
      if (e.job?.state === 'tied' && endJob(e)) continue
      endJob(e)
      if (e.child.pid) roots.push(e.child.pid)
    }
    for (const e of all) if (e.exited) endJob(e) // held jobs, and jobs still being decided
    for (const t of [...terminals]) releaseTerminal(t)
    if (roots.length > 0) (deps.treeKill ?? win32TreeKill)(roots)
    await Promise.race([
      Promise.all(live.map((e) => (e.exited ? undefined : new Promise<void>((resolve) => e.child.once('exit', () => resolve()))))),
      sleep(graceMs),
    ])
    return
  }
  const tied = all.filter((e) => e.exited && e.lifelineOpen && !e.stopping) // held, or being counted
  await Promise.all([endGroups([...live, ...tied], graceMs), releaseTerminals(graceMs)])
}

/** The 'exit' handler's belt, synchronous. POSIX, by end mode: kill → group SIGKILL; term-then-kill → group
 *  SIGTERM (its watcher finishes the job once the daemon's end of the lifeline closes); term → SIGTERM to the
 *  program. Held groups included. Windows: one `taskkill /F /T /PID a /PID b …` for the children still running
 *  that are not in a job of their own (those die with the daemon's handles to their jobs). */
export function killTetheredSync(): void {
  const all = [...entries]
  if (tetherPlatform() === 'win32') {
    // A child in a job of its own dies with the daemon's handle to it, as this process exits.
    const pids = all.filter((e) => !e.exited && e.job?.state !== 'tied').map((e) => e.child.pid).filter((p): p is number => typeof p === 'number')
    if (pids.length === 0) return
    try {
      spawnSync('taskkill', ['/F', '/T', ...pids.flatMap((p) => ['/PID', String(p)])], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    } catch {
      /* best-effort */
    }
    return
  }
  for (const e of all) {
    if (e.end === 'term') {
      if (!e.exited && e.child.pid) {
        try {
          process.kill(e.child.pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
      continue
    }
    if (e.exited && !e.lifelineOpen) continue
    signalGroup(e, e.end === 'kill' ? 'SIGKILL' : 'SIGTERM')
  }
}

// ── Code terminals ─────────────────────────────────────────────────────────────────────────────────────────────

/** A Code terminal's stand-alone watcher. node-pty forks the shell itself, so the shell cannot be given a lifeline
 *  fd; it is a session leader (node-pty calls setsid), so its pid names its session and its own process group.
 *  The watcher blocks on fd 3, whose other end only the daemon holds. When the daemon closes it (the terminal was
 *  closed, its shell exited, a graceful stop) or dies, it hangs up the shell's group: the shell, which forwards the
 *  hangup to its jobs, while it runs, and its group's other members. After 1 s it kills the shell's group (a
 *  launched agent CLI that ignores the hangup) and every process left in the session: background jobs in their own
 *  job-control groups, `nohup` jobs, a `(trap "" HUP; …) &`. A shell that exited has been reaped by node-pty by
 *  then, so its pid may name another process, one that may lead a group and a session of that id (a job-control job,
 *  a daemon): so the watcher reads the shell's start time as it starts (field 22 of /proc/<pid>/stat, else ps's
 *  lstart), and once the pid names a process started at another time it signals nothing, checked before the hangup
 *  and again before the kill and the sweep. While no process has the pid, no new group or session can take that id,
 *  so what is left of them is the terminal's (the terminal's own jobs). Linux and
 *  Termux read the session from /proc/<pid>/stat (field 6). macOS has neither /proc nor a pkill or ps that knows
 *  sessions (Apple's pkill refuses -s as an illegal option, and its ps's sess is always 0), and once the shell has
 *  exited nothing else ties its jobs to it (xnu clears the session's terminal then, and launchd adopts them): only
 *  getsid(2) still names their session. So there perl asks it, through syscall() (xnu's getsid is 310), for each
 *  pid `ps -A` lists, under `env -i` (no PERL5OPT or PERL5LIB); /usr/bin/perl ships with macOS, the PATH's perl is
 *  the fallback. perl first checks that getsid gives its own session as the watcher's pid (the watcher leads its
 *  session), so a getsid that does not work is never read as "no member". A watcher that cannot sweep exits 3 (no
 *  perl) or 4 (getsid failed that check), and the daemon logs it. Before, macOS ran `pkill -s`, which ended
 *  nothing: every job in a group of its own outlived the terminal and the daemon. The watcher is detached, a
 *  session of its own, so its sweep never reaches itself. A program that starts a session of its own (`setsid`)
 *  escapes the sweep (Known); git's automatic gc, the common case, runs in the foreground in a terminal
 *  (util/git-gc.ts). It unsets TMOUT first: where /bin/sh is bash (macOS, Fedora), bash's read takes an exported
 *  TMOUT for a timeout, and the terminal was ended TMOUT seconds after it opened. */
export const PTY_WATCH = 'SID=$1; unset TMOUT; trap "" HUP INT TERM; exec </dev/null >/dev/null 2>&1; ' +
  'st() { if [ -r "/proc/$SID/stat" ]; then read -r s < "/proc/$SID/stat" && set -- ${s##*) } && echo "${20}"; ' +
  'else ps -o lstart= -p "$SID" 2>/dev/null; fi; }; ST=$(st); ours() { NOW=$(st); [ -z "$NOW" ] || [ "$NOW" = "$ST" ]; }; ' +
  'while read -r _; do :; done <&3; ' +
  'ours || exit 0; kill -s HUP -- -"$SID"; sleep 1; ours || exit 0; kill -s KILL -- -"$SID"; ' +
  'if [ -d /proc/self ]; then for d in /proc/[0-9]*; do read -r s < "$d/stat" || continue; ' +
  'set -- ${s##*) }; [ "$4" = "$SID" ] && kill -s KILL "${d#/proc/}"; done; ' +
  'else P=/usr/bin/perl; [ -x "$P" ] || P=$(command -v perl) || exit 3; ' +
  "ps -A -o pid= | /usr/bin/env -i \"$P\" -e '($s, $w, $n) = @ARGV; syscall($n + 0, 0) == $w or exit 4; " +
  "while (<STDIN>) { $p = int; kill 9, $p if $p > 1 && syscall($n + 0, $p) == $s }' \"$SID\" \"$$\" 310 || exit 4; fi"

/** Test-only: run `script` as every terminal's watcher instead of PTY_WATCH (null: PTY_WATCH), to run the branch
 *  macOS takes on Linux. */
let ptyWatchOverride: string | null = null
export function _setPtyWatch(script: string | null): void {
  ptyWatchOverride = script
}

/** Why a watcher that exited with `code` could not sweep its terminal's session, or null (it swept, or was killed). */
function sweepFailure(code: number | null): string | null {
  if (code === 3) return 'no perl to read the session ids with (macOS: /usr/bin/perl)'
  if (code === 4) return 'perl\'s getsid, through syscall(), did not give its own session'
  return null
}

interface TerminalTie {
  socket: Socket | null
  released: boolean
  /** Resolves when the watcher has exited: it fired, or never started (Windows: at once). */
  gone: Promise<void>
  /** Windows: the shell's job. */
  job?: JobTie
}
const terminals = new Set<TerminalTie>()

function releaseTerminal(t: TerminalTie): void {
  if (t.released) return
  t.released = true
  t.socket?.destroy()
  if (t.job) {
    endJob(t)
    terminals.delete(t)
  }
}

/** Tie a Code terminal's shell, and everything started in it, to the daemon (decision a: what a terminal started
 *  ends when the terminal is closed or the daemon ends, `nohup` and background jobs included). `release()` ends
 *  them now: call it when the terminal is closed or its shell exits. A graceful stop (stopTethered) and the
 *  restart keeper (closeAllLifelines) release every terminal; a daemon that dies releases them by itself. On
 *  Windows the shell (ConPTY creates it in the daemon's own process, so the daemon is its parent) gets a job of its
 *  own from the sentinel, with no breakaway: everything started in it, GUI programs included, is born in that job,
 *  and release() ends it. `spawnWindow`: the time around the pty's spawn, for the sentinel's pid-reuse guard. */
export function tetherTerminal(shellPid: number, spawnWindow?: { startMs: number; endMs: number }): { release(): void } {
  if (refusing || !Number.isInteger(shellPid) || shellPid <= 0) return { release: noop }
  if (tetherPlatform() === 'win32') {
    if (!sentinel?.available()) return { release: noop } // today's: the 'exit' handler's taskkill /T
    const t: TerminalTie = { socket: null, released: false, gone: Promise.resolve(), job: { state: 'pending', handle: null, endWanted: false, idling: null } }
    terminals.add(t)
    const window = spawnWindow ?? { startMs: 0, endMs: Date.now() }
    void sentinel.add(shellPid, window.startMs, window.endMs).then((r) => {
      const j = t.job as JobTie
      if (r.kind === 'ok') {
        j.handle = r.handle
        j.state = 'tied'
        if (j.endWanted) endJob(t)
        return
      }
      j.state = 'untied'
      terminals.delete(t)
      if (r.kind === 'refused') console.warn(`[tether] terminal ${shellPid}: the windows job sentinel refused it (${r.reason}); what it starts is tied by the 'exit' handler's taskkill /T only`)
    })
    return { release: () => releaseTerminal(t) }
  }
  let watcher: ChildProcess
  try {
    watcher = spawn(nodeShell(), ['-c', ptyWatchOverride ?? PTY_WATCH, 'sh', String(shellPid)], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  } catch (err) {
    console.warn(`[tether] terminal ${shellPid}: no watcher (${(err as Error).message}); what it starts is not tied to the daemon`)
    return { release: noop }
  }
  const socket = (watcher.stdio[3] as Socket | null) ?? null
  socket?.on('error', noop)
  const t: TerminalTie = {
    socket,
    released: false,
    gone: new Promise<void>((resolve) => {
      watcher.once('exit', (code) => {
        const why = sweepFailure(code)
        if (why) console.warn(`[tether] terminal ${shellPid}: its watcher could not end what was left in the terminal's session (${why}); jobs started in it outside the shell's group may still be running`)
        resolve()
      })
      watcher.once('error', (err) => {
        console.warn(`[tether] terminal ${shellPid}: no watcher (${err.message}); what it starts is not tied to the daemon`)
        resolve()
      })
    }),
  }
  terminals.add(t)
  void t.gone.then(() => {
    terminals.delete(t)
    socket?.destroy()
  })
  return { release: () => releaseTerminal(t) }
}

/** Release every terminal, and wait (at most `ms`) for their watchers to finish their sweep. */
async function releaseTerminals(ms: number): Promise<void> {
  const all = [...terminals]
  if (all.length === 0) return
  for (const t of all) releaseTerminal(t)
  await Promise.race([Promise.all(all.map((t) => t.gone)), sleep(ms)])
}

// ── Android: the helper and its self-test ──────────────────────────────────────────────────────────────────────

function procStat(pid: number): { state: string; ppid: number } | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return { state: f[0], ppid: Number(f[1]) }
  } catch {
    return null
  }
}

function procCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return null
  }
}

/** The positive-proof self-test of a libtether_exec.so: under a `sh` whose stdin the daemon holds, the helper
 *  runs `sleep 30`. Step 1: within 1.5 s the program must be seen running under the helper (its cmdline is the
 *  sleep's, so the helper's exec took place; not a zombie; its parent is that sh). Step 2: once the sh's stdin is
 *  ended and the sh exits, the program must be gone (or a zombie) within 1 s, so the death signal was armed. A
 *  helper that is missing, has no exec bit, exits at once or is refused by SELinux fails step 1; one that execs
 *  without arming the signal fails step 2. Whatever is left is killed by pid. Exported for the tests, which run it
 *  against host builds. */
export async function selfTestHelper(helper: string, o: { sh?: string; sleep?: string } = {}): Promise<{ ok: true; ms: number } | { ok: false; reason: string }> {
  const sh = o.sh ?? '/system/bin/sh'
  const sleepBin = o.sleep ?? '/system/bin/sleep'
  const t0 = Date.now()
  let stderr = ''
  let proc: ChildProcess
  try {
    proc = spawn(sh, ['-c', `"$0" "$$" ${sleepBin} 30 & echo "$!"; read -r _`, helper], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    return { ok: false, reason: `step 1: could not start ${sh}: ${(err as Error).message}` }
  }
  proc.on('error', noop)
  proc.stdin?.on('error', noop)
  proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
  const shExited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
  const tail = () => (stderr.trim() ? `; sh said: ${stderr.trim().split('\n').slice(0, 2).join(' / ')}` : '')
  const p = await new Promise<number>((resolve) => {
    let buf = ''
    const timer = setTimeout(() => resolve(0), 1500)
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      if (buf.includes('\n')) {
        clearTimeout(timer)
        resolve(Number(buf.trim()) || 0)
      }
    })
    proc.once('exit', () => { clearTimeout(timer); resolve(Number(buf.trim()) || 0) })
  })
  const killP = () => { if (p > 0) try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
  const killSh = () => { try { proc.kill('SIGKILL') } catch { /* gone */ } }
  if (!p) {
    killSh()
    return { ok: false, reason: `step 1: the test program's pid never arrived${tail()}` }
  }
  const want = `${sleepBin}\0${'30'}\0`
  let seen = false
  while (!seen && Date.now() - t0 < 1500) {
    const st = procStat(p)
    if (!st || st.state === 'Z') break
    if (st.ppid === proc.pid && procCmdline(p) === want) seen = true
    else await sleep(20)
  }
  if (!seen) {
    killP()
    killSh()
    return { ok: false, reason: `step 1: the program never ran under the helper${tail()}` }
  }
  proc.stdin?.end()
  await Promise.race([shExited, sleep(1000)])
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const st = procStat(p)
    if (!st || st.state === 'Z') return { ok: true, ms: Date.now() - t0 }
    await sleep(20)
  }
  killP()
  killSh()
  return { ok: false, reason: 'step 2: the program outlived its parent sh, so the death signal was never armed (killed by pid)' }
}

/** Use `nativeLibDir`'s libtether_exec.so for every later tethered spawn when it passes selfTestHelper, else the
 *  POSIX wrapper. Logs the outcome (the device checklist reads it from the daemon log). Exported for the tests. */
export async function initAndroidTether(o: { nativeLibDir: string; sh?: string; sleep?: string; log?: (line: string) => void }): Promise<boolean> {
  const log = o.log ?? ((line: string) => console.log(line))
  androidHelper = null
  const helper = join(o.nativeLibDir, ANDROID_HELPER_NAME)
  if (!existsSync(helper)) {
    log(`tether: ${ANDROID_HELPER_NAME} not found in ${o.nativeLibDir}; tethered spawns use the ${o.sh ?? '/system/bin/sh'} lifeline instead`)
    return false
  }
  const result = await Promise.race([
    selfTestHelper(helper, { sh: o.sh, sleep: o.sleep }),
    sleep(3000).then(() => ({ ok: false as const, reason: 'it did not finish within 3 s' })),
  ])
  if (result.ok) {
    androidHelper = helper
    log(`tether: ${ANDROID_HELPER_NAME} self-test passed (${result.ms} ms)`)
    return true
  }
  log(`tether: ${ANDROID_HELPER_NAME} self-test failed: ${result.reason}; tethered spawns use the ${o.sh ?? '/system/bin/sh'} lifeline instead`)
  return false
}

/** Test-only: stop using the helper a test's initAndroidTether set. */
export function _resetAndroidTether(): void {
  androidHelper = null
}

let ready: Promise<void> | null = null
/** Awaited once at boot, before anything is spawned. On the Android app (TURBOLLM_ANDROID_NATIVE_LIB_DIR set) it
 *  runs the helper's self-test, at most 3 s; everywhere else it resolves at once. */
export function tetherReady(): Promise<void> {
  if (!ready) {
    const dir = process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
    ready = process.platform === 'android' && dir ? initAndroidTether({ nativeLibDir: dir }).then(noop, noop) : Promise.resolve()
  }
  return ready
}

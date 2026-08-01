// Building a shell command line safely, for the two places that must spawn through a shell.
//
// ── Why this exists (founder-reported, 2026-08-01) ──────────────────────────────────────────
// Node 25 deprecated passing an ARGS ARRAY together with `shell: true` (DEP0190):
//
//   DeprecationWarning: Passing args to a child process with shell option true can lead to
//   security vulnerabilities, as the arguments are not escaped, only concatenated.
//
// It surfaced in two places, and the second is the one that actually hurt: `turbollm launch`
// prints it straight into the Code session's PTY, immediately under the "Launching Claude Code"
// banner, so it lands in the user's agent terminal as unexplained noise.
//
// The warning is also literally true, and fixing it fixes a real latent bug rather than just
// silencing a message. Node joins the args with spaces and NO quoting, so today any argument
// containing a space is already split into two arguments by the shell — and this repo's own
// model keys contain `|`, which cmd.exe reads as a pipe (a hazard `realRunCommand` in
// cli-launch.ts already documents and avoids by refusing to use a shell at all).
//
// A shell can't simply be dropped on Windows: `claude` is typically a PATHEXT shim (`claude.cmd`)
// rather than a directly-executable binary, and Node refuses to spawn a `.cmd` without one. So
// the supported non-deprecated form is used instead: ONE fully-quoted command string.

// Characters that need no quoting. Deliberately a strict allow-list rather than a denylist of
// metacharacters — a denylist that misses one character is a quoting bug, whereas an allow-list
// that is too strict only ever produces unnecessary (harmless) quotes.
//
// The two lists differ in exactly one character, and it matters: a backslash is an ordinary path
// separator to cmd.exe but an ESCAPE character to a POSIX shell. Windows arguments are very often
// plain paths (`C:\Users\me\repo`), so treating `\` as safe there keeps the common case unquoted
// and readable; treating it as safe on POSIX would corrupt the argument.
const SAFE_UNQUOTED_WIN = /^[A-Za-z0-9_@%+=:,./\\-]+$/
const SAFE_UNQUOTED_POSIX = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Quote one argument for `cmd.exe`, such that the spawned program's own command-line parser
 *  (CommandLineToArgvW) recovers it byte-for-byte.
 *
 *  Backslash handling is the fiddly part and is the documented Windows rule: a run of backslashes
 *  is literal on its own, but doubles when it immediately precedes a quote — so `a\` becomes
 *  `"a\\"` and `a\"b` becomes `"a\\\"b"`.
 *
 *  Known limitation, stated rather than silently ignored: cmd.exe still expands `%VAR%` inside
 *  double quotes, and there is no in-line escape for `%` that works outside a batch file. No
 *  argument TurboLLM itself generates contains `%`; a user's own passthrough argument could, and
 *  would expand. That is strictly better than today, where such an argument is not quoted at all. */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""'
  if (SAFE_UNQUOTED_WIN.test(arg)) return arg

  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      // Double the run of backslashes, then escape the quote itself.
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  // Trailing backslashes double, so the closing quote isn't escaped by them.
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

/** Quote one argument for a POSIX shell: single quotes make everything literal, and the only
 *  character that cannot appear inside them is `'` itself, which is closed, escaped, reopened. */
export function quotePosixArg(arg: string): string {
  if (arg === '') return "''"
  if (SAFE_UNQUOTED_POSIX.test(arg)) return arg
  return `'${arg.split("'").join(`'\\''`)}'`
}

/** Quote one argument for **PowerShell**, which is a different problem from cmd.exe: PowerShell
 *  parses the string first, so `$var`, backticks and `"` are all live in a double-quoted string.
 *  A single-quoted PowerShell string is fully literal — the ONLY character needing an escape is
 *  `'` itself, which is written twice.
 *
 *  Needed because a terminal-agent launch goes through TWO shells: `pty-session.ts` runs
 *  `powershell -Command "<launch command>"`, and that command then re-spawns through cmd.exe. Text
 *  that reaches the CLI as an argument (the session's first message) has to survive both. */
export function quotePowerShellArg(arg: string): string {
  return `'${arg.split("'").join("''")}'`
}

/** Quote a value for the shell `pty-session.ts` actually spawns — PowerShell on Windows, bash
 *  everywhere else. Always quotes, even when the text looks safe: this is arbitrary user prose,
 *  not one of our own flag values, so "looks safe" is not a judgement worth making per-message. */
export function quotePtyShellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return quotePowerShellArg(arg)
  // Deliberately NOT quotePosixArg: that returns simple words unquoted, which is right for our own
  // flag values but wrong here — always wrapping keeps one predictable shape for prose.
  return `'${arg.split("'").join(`'\\''`)}'`
}

/** Join a binary and its arguments into a single, fully-quoted command line for the given
 *  platform's shell — the form `child_process.spawn(command, { shell: true })` expects, and the
 *  one that is not deprecated. `platform` defaults to the running one and exists for tests, so
 *  both quoting rules are covered wherever the suite happens to run. */
export function buildShellCommand(
  bin: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = platform === 'win32' ? quoteWindowsArg : quotePosixArg
  return [bin, ...args].map(quote).join(' ')
}

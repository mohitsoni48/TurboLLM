// Resolving a command to a real file on PATH, so it can be spawned WITHOUT a shell.
//
// ── Why this exists (pre-release review, 2026-08-01, CRITICAL) ───────────────────────────────
// `spawn(cmd, args, { shell: true })` on Windows routes through cmd.exe, and cmd.exe's parser is
// NOT the one every "escape arguments for Windows" recipe targets. CommandLineToArgvW treats `\"`
// as a literal quote; cmd.exe does not — it sees the `"` and CLOSES the quoted region. So an
// argument containing a double quote escapes its own quoting, and everything after it is parsed as
// shell syntax. Reproduced live before this fix, with a marker file proving a second command ran:
//
//     arg      : a" & echo x > MARKER & rem "
//     quoted   : "a\" & echo x > MARKER & rem \""
//     cmd.exe  : argv = ["a\" "]   + MARKER created  ← a chained command executed
//
// That argument is reachable from a Code session's FIRST MESSAGE — arbitrary user prose. Measured
// across nine hostile inputs: the shell path injected on 1 and corrupted 1 (`%CD%` expanded);
// spawning the resolved executable directly with an args array injected on 0 and corrupted 0,
// because Node builds the child's command line itself and no shell ever parses it.
//
// A shell genuinely cannot be dropped everywhere: Node refuses to spawn a `.cmd`/`.bat` without
// one (EINVAL — confirmed on Node v25.2.1, and it is a deliberate mitigation, not a bug). So the
// rule is: resolve the command first, take the no-shell path whenever it is a real executable, and
// keep the shell only for the shim case that requires it.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

/** Extensions that MUST go through a shell — they are scripts interpreted by cmd.exe, not
 *  executables the OS can launch directly. Everything else (notably `.exe`) spawns directly. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat'])

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isExecutableFile(p: string): boolean {
  if (!isFile(p)) return false
  if (process.platform === 'win32') return true // no x-bit on Windows; PATHEXT decides
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Find `command` on PATH the way the OS would, honouring PATHEXT on Windows.
 *
 *  Returns the absolute path, or null when it can't be found — callers then fall back to their
 *  previous behaviour rather than failing the launch, since "not found" here is not proof the
 *  command is unusable (an exotic PATHEXT, a shell builtin, a shell alias). */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!command) return null

  const win32 = platform === 'win32'
  // PATHEXT is the list of extensions Windows appends when the command has none. Its documented
  // default is used when the variable is missing, rather than assuming only `.exe`.
  const exts = win32
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : ['']

  // An explicit extension is honoured as-is; only an extension-less command gets PATHEXT applied.
  //
  // ── The bare name is NOT a candidate on Windows (founder-reported, 2026-08-18) ──────────────
  // Symptom: a Code session on `pi` died instantly with "pi is not installed or not on your PATH",
  // followed by a ConPTY abort (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), even
  // though pi WAS installed and `C:\Users\<u>\AppData\Roaming\npm` was on PATH.
  //
  // Cause: npm installs THREE files per global bin — an extension-less Unix shell script (`pi`),
  // plus `pi.cmd` and `pi.ps1`. Listing `base` first meant the extension-less shim won, and
  // `isExecutableFile` returns true for ANY file on Windows (there is no x-bit), so it looked like
  // a hit. `requiresShell` then saw no extension, concluded "real executable, no shell needed", and
  // spawned a bash script as a Windows process — ENOENT, every time. `pi.cmd`, sitting right beside
  // it and perfectly launchable, was never tried.
  //
  // Windows only executes files whose extension is in PATHEXT, so on win32 an extension-less
  // command must resolve ONLY through PATHEXT. `claude` was unaffected purely because it ships a
  // real `claude.exe`, which is why this survived until pi/opencode became launchable.
  const candidates = (base: string): string[] =>
    extname(base) ? [base] : win32 ? exts.map((e) => base + e) : [base]

  // An absolute or explicitly-relative command is not looked up on PATH — same as the OS.
  if (isAbsolute(command) || command.startsWith('./') || command.startsWith('.\\')) {
    return candidates(command).find(isExecutableFile) ?? null
  }

  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    // Windows PATH entries are sometimes quoted; the quotes are not part of the directory name.
    const clean = dir.replace(/^"|"$/g, '')
    const hit = candidates(join(clean, command)).find(isExecutableFile)
    if (hit) return hit
  }
  return null
}

/** Whether a resolved path has to be run through a shell (a cmd/bat shim), or can be spawned
 *  directly with an args array. Pure. */
export function requiresShell(resolvedPath: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (!resolvedPath) return true // unknown — keep the old, shell-based behaviour
  if (platform !== 'win32') return false
  return SHIM_EXTENSIONS.has(extname(resolvedPath).toLowerCase())
}

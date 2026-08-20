// Spec 20 §6's "CLI not authenticated/available" precondition: a CLI-flavor Code Routine must
// be SKIPPED and FLAGGED, never crash and never silently no-op, when the terminal-agent CLI
// isn't installed. `claude --version` is the cheapest possible probe — it exits 0 whether or
// not the CLI is authenticated against a real gateway, but a missing binary (ENOENT) is by far
// the common real-world case this guards (a fresh install, or a routine created on one machine
// and the daemon later run on another). Authentication itself isn't separately probe-able here:
// the CLI is pointed at TurboLLM's OWN local gateway, which enforces no auth (cli-launch.ts's
// AUTH_TOKEN comment: "No auth is enforced on the local gateway; the CLI just needs a non-empty
// token") — so "installed" is the only real precondition failure mode for THIS gateway, unlike
// a real cloud Anthropic account which could also be unauthenticated.
//
// `realRunCommand` spawns WITHOUT a shell (cli-launch.ts:436-449), which raised a fair worry for
// this probe specifically: resolve-executable.ts's own header notes `claude` is "typically a
// PATHEXT shim (`claude.cmd`) rather than a directly-executable binary, and Node refuses to spawn
// a `.cmd` without one". Measured on a real Windows 11 box before adopting it here:
// `spawn('claude', ['--version'], { stdio: 'ignore' })` exits 0 — libuv does its own PATHEXT
// resolution, and Node's EINVAL guard only fires on a filename that literally ends in `.cmd`/
// `.bat`, which a bare `claude` does not. So the no-shell probe is correct on Windows too, and
// keeps the probe free of any shell-quoting surface.
import { realRunCommand, type RunCommand } from '../cli-launch'

/** `<bin> --version` — the cheapest "is it installed" probe, per harness. Every CLI TurboLLM can
 *  launch supports it (verified: claude 2.1.232, pi 0.82.1, opencode 1.18.9 all exit 0 and print a
 *  version), so this needs no per-harness special-casing. */
export async function isCliAvailable(bin: string, run: RunCommand = realRunCommand): Promise<boolean> {
  return run(bin, ['--version'])
}

/** Back-compat alias for the claude-only call sites. Prefer `isCliAvailable(bin)`. */
export async function isClaudeCliAvailable(run: RunCommand = realRunCommand): Promise<boolean> {
  return isCliAvailable('claude', run)
}

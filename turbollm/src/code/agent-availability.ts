// Which terminal-agent CLIs are actually installed on THIS machine, and how to install one that
// isn't (founder-reported live, 2026-08-18).
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
// The Code-agent picker used to offer every harness unconditionally and only discover a missing one
// at session-open, where the failure surfaces as a wall of CLI text inside a terminal that then
// sits there dead ("pi is not installed or not on your PATH", plus a ConPTY abort). That is the
// same class of failure ADR-239 already rules out for the engine catalog — never offer what isn't
// actually available — but the right fix here is NOT to hide the harness: an uninstalled CLI is one
// `npm i -g` away, so hiding it just makes the product look like it doesn't support the tool.
// Instead the picker shows it, refuses to SELECT it, and offers to install it.
//
// Probing is `<bin> --version` (cli-preflight.ts), the same check the Routines preflight uses, so
// the picker and a scheduled run can never disagree about whether a harness is usable.
import { spawn } from 'node:child_process'
import { cliSpecInfo } from '../cli-launch'
import { isCliAvailable } from '../routines/cli-preflight'

/** The launch targets a Code session can use. `turbollm` is the built-in in-process agent and has
 *  no CLI at all, so it is deliberately absent — callers treat it as always available. */
export const TERMINAL_AGENT_IDS = ['claude', 'pi', 'opencode'] as const
export type TerminalAgentId = (typeof TERMINAL_AGENT_IDS)[number]

export interface AgentAvailability {
  id: string
  installed: boolean
  /** The exact command that installs it — taken from the launcher's own registry so this can never
   *  drift from the hint `turbollm launch <cli>` prints on ENOENT. */
  installCommand: string
  /** An install of it is running in this daemon right now (installAgent), whichever page or tab
   *  started it — so a page reloaded mid-install shows it as installing instead of offering a
   *  second Install. */
  installing: boolean
}

// A probe spawns a process per harness, so a naive implementation would fire three spawns every
// time the Settings screen re-rendered. Cached briefly rather than for the daemon's lifetime: the
// answer genuinely CHANGES when the user installs one (that is the whole point of the install
// button), so a permanent cache would leave the UI insisting the CLI is still missing.
const TTL_MS = 5_000
type Probed = Omit<AgentAvailability, 'installing'>
let cache: { at: number; value: Probed[] } | null = null
// Bumped by every invalidation, so a probe can tell that an install ended while it ran.
let generation = 0

/** Drop the cache — called right after an install so the UI reflects it immediately instead of
 *  waiting out the TTL. */
export function invalidateAvailabilityCache(): void {
  cache = null
  generation++
}

/** `probe` is `isCliAvailable` but for a test, which needs a probe still running when an install
 *  ends. */
export async function agentAvailability(
  now = () => Date.now(),
  probe = isCliAvailable,
): Promise<AgentAvailability[]> {
  let probed = cache && now() - cache.at < TTL_MS ? cache.value : null
  if (!probed) {
    const probeAll = () => Promise.all(
      TERMINAL_AGENT_IDS.map(async (id): Promise<Probed> => {
        const spec = cliSpecInfo(id)
        // An unknown id can't be probed OR installed; report it uninstalled with no command rather
        // than throwing, so one bad entry can't take down the whole picker.
        if (!spec) return { id, installed: false, installCommand: '' }
        return { id, installed: await probe(spec.bin), installCommand: spec.install }
      }),
    )
    // An install that ended while this probe ran (its end invalidates the cache) may have been
    // probed before its CLI existed. That answer used to be cached over the invalidation, and
    // returned with `installing` already false: GET /code/agents said "not installed" for 5 s
    // after the install succeeded, so a page polling for the install's end (useAgentAvailability)
    // stopped on it and kept offering Install, and the page that ran it could get the same answer
    // right after its "installed" toast. Such a probe is run again, and only an answer no install
    // ended under is cached.
    let gen = generation
    probed = await probeAll()
    if (gen !== generation) {
      gen = generation
      probed = await probeAll()
    }
    if (gen === generation) cache = { at: now(), value: probed }
  }
  // Read on every call, never cached: it changes the moment an install starts or ends.
  return probed.map((a) => ({ ...a, installing: installsInFlight.has(a.id) }))
}

export type InstallResult = { ok: true } | { ok: false; message: string }

/** One install per agent id at a time: the install running for each id. Without it a page could
 *  hold hundreds of concurrent npm processes open (each up to `timeoutMs`), which is a trivial
 *  local resource-exhaustion vector. A call while one runs JOINS it and gets its result, rather
 *  than an error: the install outlives the page that asked for it (nothing aborts it), so a page
 *  reloaded mid-install, or a second tab, that asks again is waiting for the same install. The
 *  entry is claimed before the first await — it used to be added only after two dynamic imports,
 *  so a double click passed the check twice and ran two `npm install -g` side by side. */
const installsInFlight = new Map<string, Promise<InstallResult>>()

/** Run a harness's own documented install command.
 *
 *  Deliberately parsed from the registry string rather than accepting a command from the client:
 *  the ONLY thing a caller controls is which known agent id to install, so there is no path from a
 *  request body to an arbitrary shell command. The parsed argv is spawned WITHOUT a shell for the
 *  same reason cli-launch.ts does — no shell means no metacharacter surface at all.
 *
 *  `npm` itself is a `.cmd` shim on Windows, which Node refuses to spawn without a shell, so that
 *  one case resolves the shim explicitly instead of reaching for `shell: true`. */
export function installAgent(
  id: string,
  _spawn: typeof spawn = spawn,
  timeoutMs = 180_000,
): Promise<InstallResult> {
  // Restricted to the ids the picker actually OFFERS, not everything in the launcher registry —
  // `cliSpecInfo` also knows kilo/openclaw/hermes, which no UI surfaces, so accepting them widened
  // the reachable install set for no benefit.
  if (!(TERMINAL_AGENT_IDS as readonly string[]).includes(id)) {
    return Promise.resolve({ ok: false, message: `Unknown coding agent "${id}".` })
  }
  const running = installsInFlight.get(id)
  if (running) return running
  // Dropped before the result reaches any caller, so one that re-reads availability on it sees
  // the install over.
  const install = runInstall(id, _spawn, timeoutMs).finally(() => { installsInFlight.delete(id) })
  installsInFlight.set(id, install)
  return install
}

async function runInstall(id: string, _spawn: typeof spawn, timeoutMs: number): Promise<InstallResult> {
  const spec = cliSpecInfo(id)
  if (!spec) return { ok: false, message: `Unknown coding agent "${id}".` }

  const parts = spec.install.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return { ok: false, message: `No install command is registered for "${id}".` }
  const [bin, ...args] = parts

  const { resolveExecutable, requiresShell } = await import('../util/resolve-executable')
  const { buildShellCommand } = await import('../util/shell-command')
  const resolved = resolveExecutable(bin)
  const needsShell = requiresShell(resolved)

  return await new Promise<InstallResult>((resolve) => {
    let stderr = ''
    let settled = false
    const done = (r: InstallResult) => { if (!settled) { settled = true; invalidateAvailabilityCache(); resolve(r) } }
    try {
      // Same call shape as cli-launch.ts's realRunCommand, and for the same reason. The previous
      // version passed an ARGS ARRAY together with `shell: true`, which Node joins with plain
      // spaces and no quoting (DEP0190) — so a resolved path containing a space broke apart.
      // Measured on this machine, where the official Node installer puts npm at
      // "C:/Program Files/nodejs/npm.cmd" (a path containing a space):
      //     'C:Program' is not recognized as an internal or external command
      // i.e. the Install button failed 100% of the time on a default Windows install. The shell is
      // needed at all only for a .cmd/.bat shim, which Node refuses to spawn without one;
      // `buildShellCommand` quotes each argument, which is what makes that path safe.
      const child = needsShell
        ? _spawn(buildShellCommand(bin, args), { stdio: ['ignore', 'ignore', 'pipe'], shell: true })
        : _spawn(resolved ?? bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        done({ ok: false, message: `"${spec.install}" did not finish within ${Math.round(timeoutMs / 1000)}s.` })
      }, timeoutMs)
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
      child.on('error', (e: Error) => {
        clearTimeout(timer)
        done({ ok: false, message: `Could not run "${spec.install}": ${e.message}` })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) return done({ ok: true })
        // npm's real diagnostic is far more useful than "exit 1" — surface its tail, capped so a
        // huge log can't be pushed into a toast.
        const tail = stderr.trim().split('\n').slice(-4).join('\n').slice(0, 600)
        done({ ok: false, message: tail || `"${spec.install}" failed with exit code ${code}.` })
      })
    } catch (e) {
      done({ ok: false, message: `Could not run "${spec.install}": ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

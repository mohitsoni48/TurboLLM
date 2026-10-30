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
// the picker and a scheduled run agree on every probe that answers. One that has not answered by
// VERSION_PROBE_DEADLINE_MS is where they differ, on purpose (isCliAvailable's `onTimeout`): the
// picker counts that CLI as installed (it was found and started), and a routine skips its run as
// 'cli_unavailable' before it touches the model or the gate.
import type { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { cliSpecInfo } from '../cli-launch'
import { spawnTethered } from '../util/tether'
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
// The probe round running now, and the generation it started at. Each request used to run a round of its own, so
// requests that came while one ran (a reload, another tab or device, an Install's refetch; the page's own focus
// refetches and 2 s polls wait on its request in flight) each started one more `<bin> --version` per harness: with
// a CLI whose probe never answered, they piled up.
let round: { gen: number; probed: Promise<Probed[]> } | null = null

/** Drop the cache — called right after an install so the UI reflects it immediately instead of
 *  waiting out the TTL. */
export function invalidateAvailabilityCache(): void {
  cache = null
  generation++
}

/** The running round when no install has ended since it started, else a new one. Its answer is cached when no install
 *  ended while it ran. */
function probeRound(now: () => number, probe: (bin: string) => Promise<boolean>): Promise<Probed[]> {
  if (round && round.gen === generation) return round.probed
  const gen = generation
  const probed = Promise.all(
    TERMINAL_AGENT_IDS.map(async (id): Promise<Probed> => {
      const spec = cliSpecInfo(id)
      // An unknown id can't be probed OR installed; report it uninstalled with no command rather
      // than throwing, so one bad entry can't take down the whole picker.
      if (!spec) return { id, installed: false, installCommand: '' }
      return { id, installed: await probe(spec.bin), installCommand: spec.install }
    }),
  ).then((value) => {
    if (gen === generation) cache = { at: now(), value }
    return value
  }).finally(() => {
    if (round?.probed === probed) round = null
  })
  round = { gen, probed }
  return probed
}

/** `probe` is `isCliAvailable` but for a test, which needs a probe still running when an install
 *  ends. A call that joins a running round gets that round's answers, whichever `probe` it passed. */
export async function agentAvailability(
  now = () => Date.now(),
  probe: (bin: string) => Promise<boolean> = isCliAvailable,
): Promise<AgentAvailability[]> {
  const cached = () => (cache && now() - cache.at < TTL_MS ? cache.value : null)
  let probed = cached()
  if (!probed) {
    // An install that ended while this probe ran (its end invalidates the cache) may have been
    // probed before its CLI existed. That answer used to be cached over the invalidation, and
    // returned with `installing` already false: GET /code/agents said "not installed" for 5 s
    // after the install succeeded, so a page polling for the install's end (useAgentAvailability)
    // stopped on it and kept offering Install, and the page that ran it could get the same answer
    // right after its "installed" toast. Such a probe is run again, and only an answer no install
    // ended under is cached. The run again is the round of the new generation, which a request
    // that came after the install's end may have started already.
    const gen = generation
    probed = await probeRound(now, probe)
    if (gen !== generation) probed = cached() ?? await probeRound(now, probe)
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

/** spawn() for an install, tethered (util/tether.ts): `npm install -g`, and the postinstall scripts it runs, end the
 *  moment the daemon does. Its 180 s timeout is a daemon timer, so a killed daemon left the install running. Both of
 *  spawn's forms runInstall uses: (command, options) with `shell: true`, and (file, args, options). */
const tetheredInstallSpawn = ((file: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) =>
  Array.isArray(argsOrOptions)
    ? spawnTethered(file, argsOrOptions, options ?? {}, { kind: 'agent-install' })
    : spawnTethered(file, null, (argsOrOptions as SpawnOptions | undefined) ?? {}, { kind: 'agent-install' })) as unknown as typeof spawn

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
  _spawn: typeof spawn = tetheredInstallSpawn,
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

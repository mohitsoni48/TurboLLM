// Applying an app update, and knowing whether we're even allowed to try (spec 29 B.1).
//
// `app-update.ts` answers "is a newer TurboLLM published?". This module answers the two
// questions that have to come next before a button can exist:
//
//   1. HOW is this daemon installed? A global npm install, an `npx` cache run, the
//      packaged Electron desktop app, a Docker container, the Android app, or a source
//      checkout. The correct action differs for every one of them, and a WRONG guess is
//      worse than no button at all — `npm i -g turbollm@latest` inside a Docker container
//      or against a source checkout does not update the thing the user is running, it
//      installs a second copy somewhere else and leaves them convinced they upgraded.
//   2. Is it SAFE to apply right now? An update restarts the daemon, so an in-flight
//      model load, download, engine build or Code session must block it with a clear
//      reason rather than being silently destroyed.
//
// Same shape as the rest of the update code: the DECISION is a pure, unit-tested function
// over explicitly-passed signals (`classifyInstall`, `checkApplyBlockers`), and the I/O
// that gathers those signals is a thin shell around it (`detectInstall`). That's what
// makes install-method detection testable at all — none of the six cases can be
// reproduced by running the test suite in the environment it happens to run in.

import { execFile, spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** How this daemon was installed. `unknown` is a real, expected answer (an embedding we
 *  don't recognise) and is treated exactly like the refuse-to-self-update methods. */
export type InstallMethod = 'npm_global' | 'npx' | 'electron' | 'docker' | 'android' | 'source' | 'unknown'

/** Every install methods there is, in classification order. Exported so the telemetry
 *  enum is derived from this list rather than being a second hand-maintained copy. */
export const INSTALL_METHODS: readonly InstallMethod[] = [
  'npm_global',
  'npx',
  'electron',
  'docker',
  'android',
  'source',
  'unknown',
]

/** The raw environment facts `classifyInstall` decides from. Passed in rather than read,
 *  so a test can present any of the six installs without being one. */
export interface InstallSignals {
  /** `process.platform` — 'android' is its own install method (the Play Store app). */
  platform: string
  /** The entry script actually running (`process.argv[1]`), resolved. */
  entry: string
  /** The desktop wrapper sets `TURBOLLM_DESKTOP=1` when it spawns the daemon. The
   *  primary desktop signal; `resources/daemon` in the path is the fallback for a
   *  wrapper older than that env var. */
  desktopEnv: boolean
  /** True when a container marker was found (`/.dockerenv`, or 'docker'/'containerd'
   *  in /proc/1/cgroup). */
  inContainer: boolean
  /** `npm root -g`, or null when it couldn't be resolved (no npm on PATH — itself a
   *  strong hint this is not an npm install). */
  npmGlobalRoot: string | null
  /** A repo marker (`.git`, or the monorepo's own `turbollm/src`) sits above the entry
   *  script — i.e. this is `tsx src/cli.ts` in a checkout, not an installed package. */
  sourceCheckout: boolean
}

/** What the UI may offer for this install. `command` is ALWAYS a usable manual path, even
 *  when `canSelfUpdate` is false — spec 29 B.3's "never a dead end" rule: a user on Docker
 *  or a source checkout still gets told exactly what to run. */
export interface InstallInfo {
  method: InstallMethod
  /** May the daemon apply this update itself (POST /api/v1/app/update)? */
  canSelfUpdate: boolean
  /** The command to run by hand, or '' when there is no command (desktop/Android, where
   *  the update is a download or a store release rather than a shell line). */
  command: string
  /** One sentence for the dialog explaining what to do instead. '' when self-update is
   *  offered and no explanation is needed. */
  note: string
}

/** Pure: which install is this, and what may we offer for it?
 *
 *  Order matters and is most-specific-first. Android before container (the Android app is
 *  not a Docker deployment even where a cgroup marker exists); desktop before npx/global
 *  (the packaged daemon lives inside a `node_modules`-shaped tree of its own and would
 *  otherwise be misread as an npm install — the single most damaging misclassification
 *  here, since it would run `npm i -g` and update a completely different copy). */
export function classifyInstall(s: InstallSignals): InstallInfo {
  // Lower-cased and forward-slashed, so every path test below is one spelling rather
  // than a Windows branch and a POSIX branch (and so a test can present either shape).
  const entry = s.entry.toLowerCase().replace(/\\/g, '/')

  if (s.platform === 'android') {
    return {
      method: 'android',
      canSelfUpdate: false,
      command: '',
      note: 'TurboLLM for Android updates through the Play Store.',
    }
  }

  if (s.desktopEnv || entry.includes('/resources/daemon/')) {
    return {
      method: 'electron',
      canSelfUpdate: false,
      command: '',
      note: 'The TurboLLM desktop app downloads updates in the background and installs them when you quit.',
    }
  }

  if (s.inContainer) {
    return {
      method: 'docker',
      canSelfUpdate: false,
      command: 'docker compose build --pull',
      note: 'This TurboLLM runs in a container — rebuild the image to update it.',
    }
  }

  // `npx turbollm` unpacks into npm's `_npx` cache. There is nothing persistent to
  // upgrade: the fix is to re-run with `@latest`, which fetches a fresh copy.
  if (entry.includes('/_npx/')) {
    return { method: 'npx', canSelfUpdate: true, command: 'npx turbollm@latest', note: '' }
  }

  if (s.npmGlobalRoot && isUnder(s.entry, s.npmGlobalRoot, s.platform === 'win32')) {
    return { method: 'npm_global', canSelfUpdate: true, command: 'npm i -g turbollm@latest', note: '' }
  }

  if (s.sourceCheckout) {
    return {
      method: 'source',
      canSelfUpdate: false,
      command: 'git pull',
      note: 'This TurboLLM runs from a source checkout — pull and rebuild to update it.',
    }
  }

  return {
    method: 'unknown',
    canSelfUpdate: false,
    command: 'npm i -g turbollm@latest',
    note: "TurboLLM couldn't tell how it was installed, so it won't update itself. Run the command above in the same place you installed it.",
  }
}

/** Path containment, case-insensitively when asked (Windows). Compares whole segments (a
 *  trailing separator is appended before the prefix test) so `/usr/lib/node_modules-old`
 *  is not "under" `/usr/lib/node_modules`. Separators are normalised to `/` so a test can
 *  present a Windows-shaped path on Linux and vice versa — the classifier is pure over its
 *  signals, and "which OS is the test running on" is not one of them. */
function isUnder(child: string, parent: string, ignoreCase: boolean): boolean {
  const norm = (p: string) => {
    const r = p.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    return ignoreCase ? r.toLowerCase() : r
  }
  return norm(child).startsWith(norm(parent))
}

// ─── The I/O shell: gather the signals ────────────────────────────────────────

/** Is this process inside a container? Best-effort and Linux-only by nature; any read
 *  failure means "no marker found", never a throw. */
function detectContainer(): boolean {
  try {
    if (existsSync('/.dockerenv')) return true
  } catch {
    /* best-effort */
  }
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8')
    if (/docker|containerd|kubepods|podman/.test(cgroup)) return true
  } catch {
    /* not Linux, or not readable — no marker */
  }
  return false
}

/** Does a repo marker sit at or above the entry script's directory? Walks up a bounded
 *  number of levels (a checkout is always shallow relative to the entry file). */
function detectSourceCheckout(entry: string): boolean {
  let dir = dirname(entry)
  for (let i = 0; i < 6; i++) {
    try {
      if (existsSync(join(dir, '.git'))) return true
    } catch {
      /* best-effort */
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return false
}

/** `npm root -g`, or null when npm isn't reachable. Cached for the process lifetime —
 *  it cannot change without a restart, and spawning npm on every status poll would be
 *  absurd. Never throws. */
let npmRootCache: { value: string | null } | null = null
export async function npmGlobalRoot(): Promise<string | null> {
  if (npmRootCache) return npmRootCache.value
  const value = await new Promise<string | null>((res) => {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFile(cmd, ['root', '-g'], { timeout: 10_000, windowsHide: true }, (e, stdout) => {
      if (e) return res(null)
      const out = String(stdout).trim()
      res(out || null)
    })
  }).catch(() => null)
  npmRootCache = { value }
  return value
}

/** Reset the `npm root -g` memo. Tests only. */
export function resetNpmRootCache(): void {
  npmRootCache = null
}

/** Classify the running daemon. Async only because `npm root -g` is a subprocess; every
 *  other signal is a cheap local read. Never throws. */
export async function detectInstall(): Promise<InstallInfo> {
  const entry = resolve(process.argv[1] ?? '')
  return classifyInstall({
    platform: process.platform,
    entry,
    desktopEnv: process.env.TURBOLLM_DESKTOP === '1',
    inContainer: detectContainer(),
    npmGlobalRoot: await npmGlobalRoot(),
    sourceCheckout: detectSourceCheckout(entry),
  })
}

// ─── Blocking an unsafe apply ─────────────────────────────────────────────────

/** The live facts an apply must not run on top of. All booleans so the check itself
 *  stays pure — the route gathers them from `Deps`. */
export interface ApplyBlockers {
  /** A model is loading right now (manager state 'starting'). */
  modelLoading: boolean
  /** At least one download is queued or in flight (the standing "check
   *  GET /api/v1/downloads before a restart" rule — a hard kill mid-write can corrupt a
   *  download, not merely pause it). */
  downloadActive: boolean
  /** A Code session has a live or queued turn. */
  codeSessionActive: boolean
  /** A compile-from-source engine build is running. */
  engineBuildActive: boolean
  /** An engine archive is being downloaded/extracted (ProvisionState). */
  engineProvisionActive: boolean
}

/** Pure: the reason an update must not be applied right now, or null when it may.
 *  One reason, not a list — the dialog shows a sentence, and the first blocker found is
 *  as actionable as all of them. Ordered by how destructive interrupting it would be. */
export function checkApplyBlockers(b: ApplyBlockers): string | null {
  if (b.downloadActive) return 'A download is in progress. Wait for it to finish (or pause it) before updating.'
  if (b.engineBuildActive) return 'An engine is being built from source. Wait for the build to finish before updating.'
  if (b.engineProvisionActive) return 'An engine is being installed. Wait for it to finish before updating.'
  if (b.codeSessionActive) return 'A Code session is running. Stop it before updating.'
  if (b.modelLoading) return 'A model is loading. Wait for it to finish before updating.'
  return null
}

// ─── Progress + the cross-restart result handshake ────────────────────────────

/** Where an apply has got to. `downloading` is npm/electron fetching the package;
 *  `installing` is it being written; `restarting` is the daemon coming back. `done` and
 *  `failed` are terminal and are what the RESTARTED daemon reports, read from the result
 *  file the helper wrote — the process that started the update is gone by then. */
export type AppUpdateState = 'idle' | 'downloading' | 'installing' | 'restarting' | 'done' | 'failed'

export interface AppUpdateProgress {
  state: AppUpdateState
  /** The version being installed, when known. */
  target: string | null
  /** The version the daemon was on when the apply started. */
  from: string | null
  method: InstallMethod | null
  /** Human-readable failure text — set only in `failed`. */
  error: string | null
  /** ISO timestamp of the last transition. */
  at: string
}

/** The file the detached helper writes when it finishes, in the data dir, and the
 *  restarted daemon reads exactly once on boot (spec 29 B.1 step 5: "failure is loud").
 *  A crashed helper leaves no file, which reads as "nothing happened" — the old version
 *  is still running and untouched, which is the honest state. */
export const UPDATE_RESULT_FILE = 'update-result.json'
/** The daemon's own launch identity, written at boot so the helper relaunches it EXACTLY
 *  as it was started rather than guessing (spec 29 B.1 step 3). */
export const RUN_STATE_FILE = 'run-state.json'
/** Where the detached helper's own stdout/stderr goes. */
export const UPDATE_LOG_FILE = 'update.log'

/** What the helper writes into {@link UPDATE_RESULT_FILE}. */
export interface UpdateResult {
  ok: boolean
  from: string
  to: string
  method: InstallMethod
  error?: string
  at: string
}

/** Parse a result file's contents into a progress record, or null when it is missing or
 *  unreadable. Pure over the text so the boot path is unit-testable. */
export function progressFromResult(text: string): AppUpdateProgress | null {
  let r: Partial<UpdateResult>
  try {
    r = JSON.parse(text) as Partial<UpdateResult>
  } catch {
    return null
  }
  if (typeof r !== 'object' || r === null || typeof r.ok !== 'boolean') return null
  return {
    state: r.ok ? 'done' : 'failed',
    target: typeof r.to === 'string' && r.to ? r.to : null,
    from: typeof r.from === 'string' && r.from ? r.from : null,
    method: (INSTALL_METHODS as readonly string[]).includes(r.method as string) ? (r.method as InstallMethod) : null,
    error: !r.ok && typeof r.error === 'string' ? r.error : null,
    at: typeof r.at === 'string' && r.at ? r.at : new Date().toISOString(),
  }
}

/** Map the helper's free-text failure into the closed telemetry vocabulary
 *  (`APP_UPDATE_FAIL_REASONS`, telemetry/events/app-update.ts). Pure and unit-tested: the
 *  telemetry rule is that a failure may never carry an arbitrary string, so the string has
 *  to be classified somewhere, and doing it here keeps the mapping testable instead of
 *  inline in a boot path. Anything unrecognised is honestly `other` — never guessed. */
export function classifyUpdateFailure(error: string | null): 'daemon_did_not_exit' | 'install_failed' | 'helper_spawn_failed' | 'other' {
  const e = (error ?? '').toLowerCase()
  if (e.includes('did not shut down')) return 'daemon_did_not_exit'
  if (e.includes('exited with code') || e.includes('enoent') || e.includes('eperm') || e.includes('ebusy')) return 'install_failed'
  if (e.includes('spawn')) return 'helper_spawn_failed'
  return 'other'
}

/** Process-lifetime progress of an in-flight (or just-completed) app update.
 *
 *  In-memory on purpose, with ONE exception: the terminal `done`/`failed` state is seeded
 *  from the helper's result file at boot, because the process that ran the update is by
 *  definition dead by the time there is anything to report. */
export class AppUpdateProgressState {
  private p: AppUpdateProgress = { state: 'idle', target: null, from: null, method: null, error: null, at: new Date().toISOString() }

  get(): AppUpdateProgress {
    return { ...this.p }
  }

  /** True while an apply is under way — a second POST must not start another one. */
  isRunning(): boolean {
    return this.p.state === 'downloading' || this.p.state === 'installing' || this.p.state === 'restarting'
  }

  set(state: AppUpdateState, patch: Partial<Omit<AppUpdateProgress, 'state' | 'at'>> = {}): void {
    this.p = { ...this.p, ...patch, state, at: new Date().toISOString() }
  }

  /** Seed a terminal state from the helper's result file (boot path). */
  adopt(p: AppUpdateProgress): void {
    this.p = p
  }
}

// ─── Launch identity + the detached helper ────────────────────────────────────

/** What the daemon records at boot so the helper can bring it back EXACTLY as it was
 *  started, rather than reconstructing a plausible command line (spec 29 B.1 step 3).
 *  `argv` is `process.argv.slice(1)` — the script path plus its flags, i.e. what to pass
 *  to `execPath` — matching what cli.ts's own `spawnReplacement` re-execs with. */
export interface RunState {
  pid: number
  execPath: string
  argv: string[]
  cwd: string
  version: string
  startedAt: string
}

/** This daemon's launch identity, read straight off the live process. */
export function currentRunState(version: string): RunState {
  return {
    pid: process.pid,
    execPath: process.execPath,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    version,
    startedAt: new Date().toISOString(),
  }
}

/** Record this daemon's launch identity into the data dir at boot.
 *
 *  The apply path itself does NOT read this file back — it is the live process, so it
 *  builds the identity directly ({@link currentRunState}). The file exists for the case
 *  the live process can't cover: diagnosing a relaunch that went wrong (the helper's log
 *  says what it ran; this says what it was told to run), and any future out-of-process
 *  recovery. Best-effort — a failure here costs a diagnostic, not the daemon's boot. */
export function writeRunState(dataDir: string, version: string): void {
  try {
    writeFileSync(join(dataDir, RUN_STATE_FILE), JSON.stringify(currentRunState(version), null, 2))
  } catch {
    /* best-effort */
  }
}

/** Read back the helper's result exactly once and delete the file, so the "update
 *  applied" / "update failed" toast fires on the boot after the update and never again.
 *  Returns null when there was no update (the overwhelmingly common boot). */
export function consumeUpdateResult(dataDir: string): AppUpdateProgress | null {
  const path = join(dataDir, UPDATE_RESULT_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null // no update ran — the normal case
  }
  try {
    unlinkSync(path)
  } catch {
    /* best-effort: a stale file would only re-show one toast */
  }
  return progressFromResult(text)
}

/** Where the helper script lives. Resolved as a sibling of THIS module in both worlds:
 *  `src/update-helper.mjs` next to `src/app-update-apply.ts` under tsx, and
 *  `dist/update-helper.mjs` next to the bundled `dist/cli.js` once built (package.json's
 *  build step copies it there). Same arrangement, and the same reason, as
 *  `tools/builtin.ts`'s WORKER_PATH. */
export function helperPath(): string {
  return fileURLToPath(new URL('./update-helper.mjs', import.meta.url))
}

/** Spawn the detached updater and return true when it was launched.
 *
 *  `detached: true` + `unref()` is what makes it outlive the daemon that spawned it — the
 *  whole point. stdio goes to `~/.turbollm/update.log`, NEVER to the parent's streams:
 *  the parent is about to exit, and inheriting handles from a dying (possibly itself
 *  detached) process breaks the child's output immediately. */
export function spawnUpdateHelper(opts: {
  dataDir: string
  method: InstallMethod
  from: string
  to: string
  run: RunState
}): boolean {
  let out: number | 'ignore' = 'ignore'
  try {
    out = openSync(join(opts.dataDir, UPDATE_LOG_FILE), 'a')
  } catch {
    out = 'ignore'
  }
  const payload = JSON.stringify({
    pid: opts.run.pid,
    dataDir: opts.dataDir,
    method: opts.method,
    from: opts.from,
    to: opts.to,
    execPath: opts.run.execPath,
    argv: opts.run.argv,
    cwd: opts.run.cwd,
  })
  try {
    const child = spawn(process.execPath, [helperPath(), payload], {
      cwd: opts.dataDir,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

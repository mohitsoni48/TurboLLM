// Mapping TurboLLM's Code mode (auto / plan / ask) onto the agent CLI's own permission mode, so a
// terminal-agent session starts in the mode the founder actually picked instead of always landing
// in the CLI's default (founder, 2026-07-29: "if auto is selected, launch in auto, if plan then
// plan").
//
// Every harness here has been probed against a REAL installed binary — the rule AGENT_SESSION_ID_FLAGS
// already followed, now applied per harness rather than only to claude:
//   claude   2.1.232   `--permission-mode <value>`, value list read from its own --help
//   opencode 1.18.9    `--auto` (boolean) and `--agent plan` (a real built-in agent)
//   pi       0.84.2    no permission-mode concept at all; only tool allow/deny lists
// An unprobed harness gets NOTHING rather than a guess that would fail the launch outright
// (ADR-293: a bad flag value is a hard startup failure the daemon cannot even diagnose, because
// reading the child's stderr aborts the process inside ConPTY).
//
// ── Why a preference list and not one hardcoded flag value ──────────────────────────────────
// Measured against the installed CLI (Claude Code 2.1.220, `claude --permission-mode <x> --version`
// per value, invalid values genuinely exit 1 — verified with a nonsense value first, so the probe
// means something):
//   accepted: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan   (its advertised set)
//   also accepted, though NOT advertised: default   (kept as a legacy alias)
// Older Claude Code advertised `acceptEdits | bypassPermissions | default | plan` — `auto` and
// `manual` did not exist. Passing a name the installed CLI doesn't know is a hard startup failure
// (commander rejects the choice before anything paints), and `cli-launch.ts` deliberately cannot
// read the child's stderr to tell that apart from any other failure — piping it aborts the process
// natively inside a ConPTY (ADR-293). So instead of betting on one vocabulary, each TurboLLM mode
// lists its modern name first and its long-standing name second, and we pick whichever the
// installed binary actually advertises.

export type CodeModeId = 'auto' | 'plan' | 'ask'

/** Per TurboLLM mode: the claude permission mode to use, modern name first, legacy fallback last.
 *  - auto  ("plans and edits end-to-end, asks only when blocked") → claude's own classifier-driven
 *          `auto`; on an older CLI, `acceptEdits` (edits go through, riskier tools still prompt).
 *  - plan  ("shows a plan for approval before touching files")    → `plan`, identical concept.
 *  - ask   ("approval gate on every file edit and command")       → `manual`; `default` on an
 *          older CLI, where that WAS the prompt-for-everything mode.
 *  Deliberately absent: `bypassPermissions`/`dontAsk`. Neither corresponds to a mode TurboLLM
 *  offers, and silently disabling every permission check because someone picked "Auto" would be a
 *  security decision the founder never made. */
const CLAUDE_MODE_PREFERENCE: Record<CodeModeId, readonly string[]> = {
  auto: ['auto', 'acceptEdits'],
  plan: ['plan'],
  ask: ['manual', 'default'],
}

const CODE_MODES = new Set<string>(['auto', 'plan', 'ask'])

/** Pull the accepted `--permission-mode` values out of `claude --help`. The help text wraps the
 *  list across lines and quotes each entry:
 *
 *      --permission-mode <mode>   Permission mode to use for the session
 *                                 (choices: "acceptEdits", "auto",
 *                                 "bypassPermissions", "manual",
 *                                 "dontAsk", "plan")
 *
 *  Returns [] for help text that doesn't advertise the option at all (an ancient CLI, or output
 *  that changed shape) — callers treat that as "unknown", not as "supports nothing". */
export function parsePermissionModeChoices(helpText: string): string[] {
  const m = helpText.match(/--permission-mode[\s\S]{0,400}?\(choices:([^)]*)\)/)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter((s) => /^[A-Za-z]+$/.test(s))
}

/** The `--permission-mode` value to launch `claude` with for a given TurboLLM mode, or null when
 *  there's nothing safe to pass (unknown mode). `choices` is what the installed CLI advertises;
 *  pass [] when that couldn't be determined — the legacy name is used then, since it's the one
 *  that has been valid across every version we know of. */
export function resolveClaudePermissionMode(mode: string, choices: readonly string[]): string | null {
  if (!CODE_MODES.has(mode)) return null
  const prefs = CLAUDE_MODE_PREFERENCE[mode as CodeModeId]
  if (choices.length === 0) return prefs[prefs.length - 1]
  return prefs.find((p) => choices.includes(p)) ?? null
}

/** Runs `claude --help` and returns its output ('' on any failure). Injectable for tests. */
export type HelpRunner = () => Promise<string>

const realHelpRunner: HelpRunner = async () => {
  const { spawn } = await import('node:child_process')
  const { buildShellCommand } = await import('../util/shell-command')
  const { requiresShell, resolveExecutable } = await import('../util/resolve-executable')
  return await new Promise<string>((resolve) => {
    let out = ''
    let settled = false
    const done = (v: string) => { if (!settled) { settled = true; resolve(v) } }
    try {
      // `shell` on Windows for the same reason cli-launch.ts spawns the CLI that way: `claude` is
      // a PATHEXT shim there, not a directly-executable binary. Piping stdout is fine HERE — this
      // runs in the daemon, not inside the session's ConPTY, and nothing is respawned after it.
      //
      // Under a shell the command is passed as ONE pre-quoted string rather than as an args array:
      // Node 25 deprecates the array form with `shell: true` (DEP0190), and the daemon printed
      // that warning to its own stderr on every Code-session open. Without a shell the args array
      // is correct and needs no quoting.
      // Same rule as cli-launch.ts's realSpawn: resolve the binary and skip the shell whenever
      // it is a real executable, falling back to a shell only for a .cmd/.bat shim (which Node
      // refuses to spawn without one). These arguments are static and safe either way — this is
      // for consistency, so there is ONE way the CLI gets spawned rather than two to audit.
      const resolved = resolveExecutable('claude')
      const stdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore']
      const child = requiresShell(resolved)
        ? spawn(buildShellCommand('claude', ['--help']), { shell: true, stdio })
        : spawn(resolved ?? 'claude', ['--help'], { stdio })
      const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } ; done('') }, 5000)
      child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8') })
      child.on('error', () => { clearTimeout(timer); done('') })
      child.on('close', () => { clearTimeout(timer); done(out) })
    } catch {
      done('')
    }
  })
}

// One probe per daemon lifetime — the installed CLI can't change under a running daemon in any way
// worth re-checking, and a terminal open shouldn't pay a process spawn every time. The PROMISE is
// cached (not just the result) so concurrent first opens share the single probe.
let cachedChoices: Promise<string[]> | null = null

export async function claudePermissionModeChoices(run: HelpRunner = realHelpRunner): Promise<string[]> {
  if (!cachedChoices) cachedChoices = run().then(parsePermissionModeChoices).catch(() => [])
  return await cachedChoices
}

/** Test-only: drop the cached probe so a test can supply its own runner. */
export function resetPermissionModeChoicesCache(): void {
  cachedChoices = null
}

// ── Per-harness mode ARGUMENTS ──────────────────────────────────────────────────────────────────
//
// Generalising `resolveClaudePermissionMode` to other harnesses cannot return a bare VALUE, because
// the harnesses do not share a flag shape — that is the whole reason this is a separate function
// rather than a wider lookup table:
//   claude   → one flag with a value:  `--permission-mode auto`
//   opencode → a boolean, or a whole different flag: `--auto`, or `--agent plan`
//   pi       → no permission concept;  only `--exclude-tools`
// So the contract is "give me the ARGS for this mode", and each harness answers in its own shape.

/** opencode's mode mapping, measured against 1.18.9 (`opencode --help`, `opencode agent list`):
 *  - auto → `--auto` — its own "auto-approve permissions that are not explicitly denied".
 *  - plan → `--agent plan` — `plan (primary)` is a REAL built-in agent (confirmed in `agent list`),
 *    and its permission set is what makes it a planning mode, so this is opencode's own concept
 *    rather than something invented here.
 *  - ask  → nothing. opencode's DEFAULT is to prompt for permission, which is exactly what "ask"
 *    means, so the honest mapping is to pass no flag at all. */
function opencodeModeArgs(mode: CodeModeId): string[] {
  if (mode === 'auto') return ['--auto']
  if (mode === 'plan') return ['--agent', 'plan']
  return []
}

/** pi's mode mapping, measured against 0.84.2 (`pi --help`).
 *
 *  ⚠️ pi has NO permission-mode concept — no auto-approve flag, no per-call approval gate, and
 *  `--plan` is explicitly documented as coming from an OPTIONAL extension ("Extensions can register
 *  additional flags (e.g. --plan from plan-mode extension)"), so it cannot be relied on.
 *
 *  What pi does have is verified tool allow/deny lists. For `plan` we use `--exclude-tools
 *  edit,write` — a real, documented flag — which removes pi's file-MUTATING tools while leaving
 *  reading and shell exploration intact.
 *
 *  **This is an approximation, and the limitation is deliberate and load-bearing:** it stops the
 *  `edit`/`write` tools, but pi keeps `bash`, and a shell can obviously still write files
 *  (`echo … > f`). So plan mode for pi is "the editing tools are gone", NOT claude's enforced
 *  "nothing is touched until you approve a plan". It is strictly better than ignoring the user's
 *  chosen mode outright (which is what passing nothing would do, silently running plan mode as
 *  auto), and it is built only from flags that actually exist. Anything stronger requires pi's
 *  plan-mode extension, which TurboLLM does not install.
 *
 *  `auto` and `ask` both map to no args: pi's own default is to run its tools, so `auto` is already
 *  its behaviour, and there is no gate to switch on for `ask`. */
function piModeArgs(mode: CodeModeId): string[] {
  if (mode === 'plan') return ['--exclude-tools', 'edit,write']
  return []
}

/** The launch arguments that put `agent` into TurboLLM's `mode`, or `[]` when this harness has no
 *  confirmed mapping (which launches it in its own default, exactly as before any of this existed).
 *
 *  `choices` is what the installed claude binary advertises — ignored by every other harness, and
 *  safely passed as [] for them. */
export function permissionModeArgs(agent: string, mode: string, choices: readonly string[] = []): string[] {
  if (!CODE_MODES.has(mode)) return []
  const m = mode as CodeModeId
  if (agent === 'claude') {
    const resolved = resolveClaudePermissionMode(m, choices)
    return resolved ? ['--permission-mode', resolved] : []
  }
  if (agent === 'opencode') return opencodeModeArgs(m)
  if (agent === 'pi') return piModeArgs(m)
  return []
}

/** Whether a harness can genuinely ENFORCE TurboLLM's `plan` mode (nothing is written until the
 *  user approves). Only claude can today — see piModeArgs for why pi's is an approximation, and
 *  note opencode's `--agent plan` is its own agent whose enforcement we have not measured.
 *
 *  Exists so a surface that wants to be honest with the user ("plan mode is approximate on this
 *  harness") has one place to ask, instead of each re-deriving it. */
export function enforcesPlanMode(agent: string): boolean {
  // opencode included on measured evidence, not assumption: its bundled `plan` agent is a
  // `native` PRIMARY agent declaring `permission: { edit: { "*": "deny" } }` — a hard denial of
  // every edit tool, read out of the 1.18.9 binary. That is strictly stronger than pi's
  // `--exclude-tools` approximation, and at least as strong as claude's own mode.
  //
  // pi remains false, and correctly so: `--exclude-tools edit,write` removes the editing tools but
  // leaves bash, which can still write files (see piModeArgs).
  return agent === 'claude' || agent === 'opencode'
}

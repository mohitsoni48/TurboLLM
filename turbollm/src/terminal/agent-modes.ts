// Mapping TurboLLM's Code mode (auto / plan / ask) onto the agent CLI's own permission mode, so a
// terminal-agent session starts in the mode the founder actually picked instead of always landing
// in the CLI's default (founder, 2026-07-29: "if auto is selected, launch in auto, if plan then
// plan").
//
// Only `claude` is mapped. Same rule AGENT_SESSION_ID_FLAGS already follows: an agent whose flag
// syntax hasn't been confirmed against a real binary gets nothing rather than a guess that would
// fail the launch outright (pi/opencode are withdrawn from the picker anyway, ADR-295).
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
      const useShell = process.platform === 'win32'
      const child = useShell
        ? spawn(buildShellCommand('claude', ['--help']), {
            shell: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
        : spawn('claude', ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] })
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

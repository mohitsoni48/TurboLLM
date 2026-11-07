// The terminal service: what a SERVER-SIDE caller needs to run a terminal-agent session without going through the
// HTTP routes (terminal-routes.ts): the launch command and its first-message seeding rules, the one TerminalManager
// (the PTY registry), whether this install has a terminal backend, and createAgentTerminal. The routines
// (routines/execute.ts, routines/cli-interactive-runner.ts) and boot.ts take these from here, so a service module no
// longer imports a route module (scalability review 5.4).

import type { Deps } from '../deps'
import type { AgentRun } from '../chat/db'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { sessionAuth } from '../code/session-auth'
import { claudePermissionModeChoices, permissionModeArgs } from './agent-modes'
import { TerminalManager } from './terminal-manager'
import { quotePtyShellArg } from '../util/shell-command'
import { agentCwd } from '../code/worktree'

const require = createRequire(import.meta.url)

// ── terminal-agent auto-resume across a daemon restart ──────────────────
// REVISED (founder-reported live bug): the first version of this used claude's `--continue`
// ("resume the most recent conversation in the CURRENT DIRECTORY"), which is ambiguous the
// moment two Code sessions share a repoRoot — whichever session happened to relaunch later
// would silently inherit whatever OTHER session's conversation was most recently active in
// that folder, reported live as "randomly resuming old conversations". Fixed by keying
// resumption on TurboLLM's OWN Code session id instead of directory-recency: `--session-id
// <id>` on a genuinely first-ever launch REGISTERS that fixed id with the CLI; `--resume <id>`
// on every later launch resumes that EXACT session, never anyone else's. TurboLLM's own
// agent_run id is already a real UUID (randomUUID() at creation) — reused directly as the
// CLI's session id, so no separate id-mapping table is needed; the existing row IS the map.
// Only agents with CONFIRMED flag syntax are listed — an unlisted agent still starts fresh
// every time (today's behavior for all of them) rather than guessing unverified CLI syntax.
// Three shapes exist among real harnesses, so this is a tagged union rather than a flag pair:
//
//   'pair'   claude 2.1.232 — two mutually exclusive flags, and passing the wrong one is a hard
//            startup failure. cli-launch.ts's spawnWithSessionRecovery swaps them on a fast death.
//   'single' pi 0.84.2 — `--session-id <id>` is documented as "Use exact project session ID,
//            CREATING IT IF MISSING". One flag both registers and resumes, so there is nothing to
//            mismatch and no recovery needed. Strictly better than claude's arrangement.
//   absent   opencode 1.18.9 — offers NO way to register a caller-chosen id. `-s/--session` is
//            "session id to continue", and `opencode session` exposes only `list` and `delete`
//            (probed) — there is no create. Its ids are its own, not our run.id.
//            Deliberately NOT falling back to `-c/--continue`: that resumes "the last session"
//            by directory recency, which is the exact ambiguity ADR-293 fixed — two Code sessions
//            sharing a repoRoot would silently steal each other's conversation. So an opencode
//            session starts fresh after a daemon restart. That is a real, measured limitation, and
//            a fresh session is far better than the wrong one.
type SessionIdFlags =
  | { kind: 'pair'; first: string; resume: string }
  | { kind: 'single'; flag: string }

const AGENT_SESSION_ID_FLAGS: Partial<Record<string, SessionIdFlags>> = {
  claude: { kind: 'pair', first: '--session-id', resume: '--resume' },
  pi: { kind: 'single', flag: '--session-id' },
}

/** The session-id argument for this launch, or '' when the harness supports none. */
function sessionIdArg(agent: string, sessionId: string, launchedOnce: boolean): string {
  const flags = AGENT_SESSION_ID_FLAGS[agent]
  if (!flags) return ''
  if (flags.kind === 'single') return ` ${flags.flag} ${sessionId}`
  return ` ${launchedOnce ? flags.resume : flags.first} ${sessionId}`
}

// ── Web tools are permission-gated, and "auto" did not cover them ───────────────────────
// Measured live (founder-reported "web search fails"): with `--permission-mode acceptEdits`, a
// terminal-agent turn asking for a web lookup came back
// `permission_denials: [{tool_name:"WebSearch", tool_input:{query:"hono npm package latest
// version"}}]` — the model composed a perfectly good search and the CLI refused to run it. Claude
// Code's auto/acceptEdits modes auto-approve EDITS; a web read is not an edit, so it still wants a
// prompt, and a Code session that is meant to run unattended has nobody to answer it.
//
// Scoped to auto only, and to these two tools only. Both are strictly READ-ONLY — they touch no
// file and run no command — so pre-allowing them takes nothing away from the gates plan and ask
// exist to enforce: every edit and every shell command still prompts exactly as before. Notably
// this is NOT `bypassPermissions`, which would disable every check at once (the same reason
// agent-modes.ts deliberately refuses to map any TurboLLM mode onto it).
// Per harness, because the tool NAMES differ and a wrong one is either ignored or a hard error:
//   claude 2.1.232 — PascalCase `WebSearch`/`WebFetch`, passed via variadic `--allowedTools`.
//   opencode 1.18.9 — lowercase permission strings (`websearch`, `webfetch`), and its `--auto`
//     already auto-approves everything not explicitly denied, so there is nothing left to
//     pre-allow: an extra list would be redundant at best. Deliberately absent.
//   pi 0.84.2 — has no permission gate to pre-allow past (see agent-modes.ts's piModeArgs), and
//     its `--tools` is an ALLOWLIST that would *restrict* pi to only those two tools if passed.
//     Passing it here would be actively harmful. Deliberately absent.
const AUTO_MODE_ALLOWED_TOOLS: Partial<Record<string, readonly string[]>> = {
  claude: ['WebSearch', 'WebFetch'],
}

/** How a harness takes an opening prompt on its own command line.
 *   - 'positional' — claude 2.1.232 (`claude [options] [prompt]`) and pi 0.84.2
 *     (`pi [options] [@files...] [messages...]`), both auto-SUBMIT it.
 *   - 'flag'       — opencode 1.18.9's TUI takes `--prompt <string>`, which is safer than a
 *     positional because it can never be swallowed by a preceding variadic option.
 *   - absent       — no verified mechanism; the message is not seeded and the user retypes it,
 *     exactly as before seeding existed. */
const AGENT_PROMPT_STYLE: Partial<Record<string, 'positional' | 'flag'>> = {
  claude: 'positional',
  pi: 'positional',
  opencode: 'flag',
}

// ── Seeding the session's FIRST message (founder-reported, 2026-08-01) ────────────────────────
// Symptom: in a fresh Code session with the Claude CLI selected, typing the first message opened
// the CLI but the message never arrived — it had to be retyped.
//
// The first attempt at this POSTed the message to the gateway's own `/v1/messages`. That could
// never have worked: `/v1/messages` is the MODEL API, and the CLI is a *client* of it, not a
// server — it exposes nothing the daemon can push a turn into. So the POST ran a real generation
// on the engine, returned the reply to the daemon's own `fetch`, threw it away, and left the CLI's
// conversation untouched (while logging that it had succeeded).
//
// Claude Code takes an initial prompt as a positional argument — `claude [options] [prompt]`,
// which "starts an interactive session by default". Verified against the real CLI in a real PTY:
// the prompt is auto-SUBMITTED, not merely pre-filled (the model answered it and the context meter
// moved). That makes the CLI itself responsible for delivery, so there is no readiness race to
// lose — which a "write it to the PTY once the TUI looks ready" approach would have had, since the
// launch can sit in a 180s model load first.
//
// Claude only: a positional prompt is that CLI's documented syntax, and passing one to an agent
// whose syntax hasn't been verified is the same guess AGENT_SESSION_ID_FLAGS refuses to make.

/** Upper bound on a seeded first message on Windows. Windows caps a command line near 8191 chars
 *  and this one is nested inside another (`powershell -Command "turbollm launch … 'prompt'"`), so
 *  the budget is shared. 4000 leaves ample room for the flags either side while covering any
 *  realistic opening message. Over the cap the prompt is omitted rather than truncated — a silently
 *  half-sent instruction is worse than a message the user can see was not sent. */
export const MAX_SEEDED_MESSAGE_CHARS = 4000

/** The same bound everywhere else, where pty-session.ts runs the launch command as bash's one
 *  `-lc` argument and `turbollm launch` hands the prompt on as one argument again: Linux holds a
 *  single argument to 128 KiB (MAX_ARG_STRLEN), macOS all of them together to 1 MiB. It bounds
 *  the prompt's UTF-8 as quotePtyShellArg writes it into that `-lc` argument, where each `'`
 *  takes four bytes: a 40,000-byte prompt of apostrophes is a 160 KB command, which bash cannot
 *  be started with (E2BIG). 64 KiB of it leaves room for the flags around it. The Windows cap
 *  held a routine's prompt to 4000 characters on every platform, and an opencode or pi routine
 *  over it opened an idle CLI that nobody typed into. */
export const MAX_SEEDED_MESSAGE_BYTES_POSIX = 64 * 1024

/** Characters that do not survive the trip to the CLI intact on Windows even after normalization
 *  (below), so a message containing one is not seeded there at all.
 *
 *  Measured, not assumed (pre-release review, 2026-08-01). The launch command is parsed by
 *  PowerShell before `turbollm launch` ever re-spawns the CLI, and PowerShell 5.1 does not escape
 *  arguments correctly when it hands them to a native executable:
 *    `rename "foo" to "bar"`  arrives as  `rename foo to bar`     (quotes silently eaten)
 *    `look in C:\repo\`       arrives as  `look in C:\repo"`      (trailing \ becomes a quote)
 *  Single-quoting the argument stops any INJECTION — that was verified separately across ten
 *  hostile inputs, zero of which escaped — but it cannot stop this mangling, which happens inside
 *  PowerShell's own native-argument marshalling. The `.cmd` shim a Windows npm install leaves
 *  (cli-launch.ts realSpawn) then goes through cmd.exe, where a quote would escape its quoting.
 *
 *  Not seeding is the honest outcome: the user retypes the message (exactly the behaviour before
 *  seeding existed), rather than the agent silently acting on a corrupted version of it.
 *
 *  Windows only. Elsewhere the launch command is bash's `-lc` argument, where quotePtyShellArg's
 *  single quotes keep every character literal (only `'` itself is closed, escaped and reopened),
 *  and `turbollm launch` spawns the CLI with an argument array and no shell: a quote and a trailing
 *  backslash arrive as typed. Refusing them there too opened an idle CLI for any opencode or pi
 *  routine whose prompt quoted a name, and the run held the routine's model for 30 minutes. */
const UNSEEDABLE_WINDOWS = /"/

/** What no platform can seed. Deliberately narrower than "every C0 control code"
 *  (founder-reported, 2026-08-07: a fresh Code session's first message silently never reached the
 *  CLI). The composer's own hint text advertises "Shift+Enter for newline", so a multi-line task
 *  description is the NORMAL case, not an edge case — and the original `\u0000-\u001f` range
 *  caught `\n`/`\r`/`\t` right along with the genuinely dangerous control bytes, so almost any
 *  multi-sentence task silently produced an empty terminal. Line breaks and tabs are folded to
 *  spaces by `normalizeSeededMessage` instead of being rejected — measured safe (they cannot
 *  smuggle a `"` or a trailing `\` past the fold). What's still blocked here is the genuine
 *  remainder: any other non-printable control byte (NUL, ESC, …) that has no safe single-line form
 *  and could otherwise inject a terminal escape sequence once it reaches the PTY. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the escape-injection blocklist; see the comment above
const UNSEEDABLE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

/** Fold a message's own line breaks and tabs into plain spaces before it crosses the PowerShell
 *  `-Command "…"` boundary — see UNSEEDABLE_CONTROL's own comment for why a literal one can't
 *  survive that trip today. Collapses a run of them to ONE space (so a blank line between paragraphs
 *  doesn't read as a stutter) and re-trims the result, since folding can expose new leading/
 *  trailing whitespace (e.g. a message ending in `\n`). Pure/exported so both the eligibility
 *  check and the actual quoted text agree on exactly what "the message" is. */
export function normalizeSeededMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, ' ').trim()
}

/** Why this message cannot be handed to the CLI as a launch argument, or null when it can. Tests
 *  the NORMALIZED text (line breaks/tabs already folded) — a message that's only "unseedable"
 *  because of a newline is seedable once folded; every limit applies to that same text. `platform`
 *  names the shell pty-session.ts runs the launch command in: PowerShell on Windows, bash elsewhere.
 *  The reason reads after "it cannot be handed over because …" (cli-interactive-runner.ts says it
 *  to a routine's owner). */
export function firstMessageSeedProblem(message: string, agent: string, platform: NodeJS.Platform = process.platform): string | null {
  // Gated on the harness having a VERIFIED way to take an opening prompt (AGENT_PROMPT_STYLE), not
  // on it being claude. The character restrictions below still apply to every harness without
  // exception: the mangling they guard against happens in the shell wrapper pty-session.ts spawns,
  // OUTSIDE the CLI, so it is identical no matter which CLI is inside — even for opencode, whose
  // `--prompt` flag is otherwise the safest of the three.
  if (!AGENT_PROMPT_STYLE[agent]) return `${agent} has no verified way to take an opening prompt`
  const normalized = normalizeSeededMessage(message)
  if (normalized.length === 0) return 'it is empty'
  if (UNSEEDABLE_CONTROL.test(normalized)) return 'it contains a control character'
  if (platform === 'win32') {
    if (normalized.length > MAX_SEEDED_MESSAGE_CHARS) return `it is over ${MAX_SEEDED_MESSAGE_CHARS} characters, the most a Windows launch command can carry`
    if (UNSEEDABLE_WINDOWS.test(normalized)) return 'it contains a double quote, which a Windows launch command cannot carry'
    // A trailing backslash is mangled into a quote by the same marshalling.
    if (normalized.endsWith('\\')) return 'it ends in a backslash, which a Windows launch command cannot carry'
    return null
  }
  if (Buffer.byteLength(quotePtyShellArg(normalized, platform)) > MAX_SEEDED_MESSAGE_BYTES_POSIX) {
    return `it is over ${MAX_SEEDED_MESSAGE_BYTES_POSIX / 1024} KiB as the launch command quotes it, the most that command can carry`
  }
  return null
}

/** Whether this message can be handed to the CLI as a launch argument: see {@link firstMessageSeedProblem}. */
export function canSeedFirstMessage(message: string, agent: string, platform: NodeJS.Platform = process.platform): boolean {
  return firstMessageSeedProblem(message, agent, platform) === null
}

/** Pure/exported so the resume-flag decision is unit-testable without a live PTY/daemon (mirrors
 *  code-session.ts's codeEventToFrame pattern). `sessionId` is always TurboLLM's own Code
 *  session id (run.id) — passed as the CLI's OWN session id too, so "which conversation to
 *  resume" is never ambiguous even when two Code sessions share a repoRoot.
 *
 *  `permissionMode` carries the session's TurboLLM mode (auto/plan/ask) across to the CLI's own —
 *  already resolved by agent-modes.ts's `permissionModeArgs` into the FULL argument text this
 *  harness needs (`--permission-mode auto`, `--auto`, `--agent plan`, `--exclude-tools edit,write`),
 *  which is why it arrives as an opaque string rather than being mapped here: the harnesses do not
 *  share a flag shape. Null/undefined appends nothing, so an agent with no confirmed mapping
 *  launches in its own default, exactly as before.
 *  Everything after `launch <agent>` that isn't one of our own flags is forwarded to the CLI
 *  verbatim by cli.ts's passthrough filter — `--permission-mode` included.
 *
 *  `firstMessage` seeds the CLI's opening turn — see the block comment above. `platform` picks the
 *  shell the command is quoted for and the limits it can carry (firstMessageSeedProblem); tests
 *  pass it, the daemon runs with its own. */
export function buildTerminalLaunchCommand(
  agent: string,
  port: number,
  token: string,
  sessionId: string,
  launchedOnce: boolean,
  permissionMode?: string | null,
  mode?: string | null,
  firstMessage?: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const sessionArg = sessionIdArg(agent, sessionId, launchedOnce)
  // `permissionMode` now arrives as the harness's ALREADY-RESOLVED argument list (agent-modes.ts's
  // permissionModeArgs), because the harnesses do not share a flag shape — claude takes
  // `--permission-mode <value>`, opencode takes a bare `--auto` or a different flag entirely
  // (`--agent plan`), and pi takes `--exclude-tools <list>`. Joining a pre-resolved list here is
  // what lets all three be expressed without a branch per harness.
  const modeArg = permissionMode ? ` ${permissionMode}` : ''
  const allowed = mode === 'auto' ? AUTO_MODE_ALLOWED_TOOLS[agent] : undefined
  const allowedArg = allowed?.length ? ` --allowedTools ${allowed.join(',')}` : ''
  // Quoting matters more than usual here — this is arbitrary user prose reaching a command line,
  // where an apostrophe in "don't" would otherwise terminate the string.
  const seedable = firstMessage && canSeedFirstMessage(firstMessage, agent, platform)
  const quotedPrompt = seedable ? quotePtyShellArg(normalizeSeededMessage(firstMessage), platform) : ''
  // A POSITIONAL prompt goes FIRST, before any flag. Position is load-bearing, not stylistic:
  // `--allowedTools, --allowed-tools <tools...>` is VARIADIC in claude's own `--help`, so it
  // consumes every token that follows it. Placed at the end, the prompt was silently eaten as one
  // more tool name and the session opened empty — measured, after the first version of this did
  // exactly that (ctx stayed 0%, no turn ran). Leading it keeps it clear of that and of any future
  // variadic option. A FLAG-style prompt (opencode's `--prompt`) is immune to that by construction,
  // so it is appended at the end where it reads naturally.
  const style = AGENT_PROMPT_STYLE[agent]
  const leadingPrompt = seedable && style === 'positional' ? ` ${quotedPrompt}` : ''
  const trailingPrompt = seedable && style === 'flag' ? ` --prompt ${quotedPrompt}` : ''
  // `--code-session-id` is OUR id, always passed, and is what the launcher reports back on exit
  // (cli.ts). It is deliberately separate from `sessionArg`, which is the HARNESS's own session flag
  // and does not exist for every harness — keying the exit report off that left opencode sessions
  // permanently stranded. cli.ts filters this flag out of the passthrough, so no harness ever sees it.
  return `turbollm launch ${agent}${leadingPrompt} --port ${port} --token ${token} --code-session-id ${sessionId}${sessionArg}${modeArg}${allowedArg}${trailingPrompt}`
}

// ── manager singleton (lazy, same pattern as CodeRunManager) ───────────

let terminalManager: TerminalManager | null = null

/** Whether this install actually has a terminal backend.
 *
 *  `node-pty` is an OPTIONAL dependency (it is a native module, and TurboLLM's whole pitch is
 *  "no compiling, no Python" — a failed node-gyp build must not fail the install for everyone).
 *  npm therefore skips it silently when no prebuild fits the platform/ABI, which means a perfectly
 *  healthy install can have no way to spawn a PTY. Exported so the UI can be told BEFORE offering
 *  a terminal-only agent, rather than letting someone pick `claude` and discover at session-open
 *  that this machine can't run it (same rule as the engine catalog: never offer what isn't
 *  actually available, ADR-239).
 *
 *  Cached — the answer can't change for the life of the daemon process. */
let backendAvailable: boolean | null = null

export function isTerminalBackendAvailable(): boolean {
  if (backendAvailable === null) {
    try {
      require.resolve('node-pty')
      backendAvailable = true
    } catch {
      backendAvailable = false
    }
  }
  return backendAvailable
}

/** Same manager every REST/WS handler in this file uses — exported so a server-side caller that
 *  isn't a Hono handler (cli-interactive-runner.ts, spawning a routine's live terminal at fire
 *  time rather than waiting for a browser to open one) reaches the SAME PTY registry instead of
 *  a second, disconnected instance. */
export function getTerminalManager(d: Deps): TerminalManager {
  return getManager(d)
}

export type CreateAgentTerminalResult =
  | { ok: true; terminalId: string }
  | { ok: false; status: 400 | 409 | 501 | 500; code: string; message: string }

/** The "spawn a fresh terminal" core of `POST /api/v1/code/sessions/:sessionId/terminal`,
 *  factored out so a server-side caller can start the SAME kind of terminal-agent session a
 *  human clicking into a fresh Code session would, without a self-referential HTTP round-trip.
 *
 *  Deliberately excludes the REST route's reuse-existing/kill-stale-shell branches: those exist
 *  for a session a human can reopen many times (remounting a tab, reconnecting a dropped WS).
 *  A caller of this function is expected to be creating a terminal for a BRAND-NEW `run` that has
 *  never had one before (routines: a fresh AgentRun per fire, never resumed) — reuse logic would
 *  be dead code there, since `findByCodeSessionId` can only ever miss for an id nothing has seen.
 *  The REST route still owns that prefix itself and calls this for the "actually create one" tail.
 *
 *  `mode`/`firstMessage` are passed explicitly rather than re-derived from the conversation (as
 *  the REST route does for a human's session): a routine-created session's opening prompt IS its
 *  `routine.prompt`, seeded on the one and only launch, never re-read from message history. */
export async function createAgentTerminal(
  d: Deps,
  run: AgentRun,
  opts: { cols?: number; rows?: number; mode?: string; firstMessage?: string; signal?: AbortSignal; idleTtlMs?: number } = {},
): Promise<CreateAgentTerminalResult> {
  if (!run.repoRoot) return { ok: false, status: 400, code: 'invalid_input', message: 'Session has no repo root.' }
  const agent = run.codeAgent ?? 'turbollm'
  if (agent === 'turbollm') {
    return { ok: false, status: 400, code: 'invalid_input', message: 'This session uses the built-in chat UI, not a terminal agent.' }
  }
  const cwd = agentCwd(run)
  if (!existsSync(cwd)) {
    const isWorktree = !!run.worktreePath && cwd === run.worktreePath
    return {
      ok: false, status: 400, code: 'cwd_missing',
      message: isWorktree
        ? `This session's worktree is gone: ${cwd}. It was probably removed outside TurboLLM ` +
          `(\`git worktree remove\`, or deleting the folder). The session's branch and any commits ` +
          `on it are unaffected — delete this session and start a new one on the same repo.`
        : `This session's folder no longer exists: ${cwd}. It may have been moved, renamed or ` +
          `deleted, or it lives on a drive that isn't connected. Reconnect or restore it, or ` +
          `delete this session.`,
    }
  }
  const cols = opts.cols && opts.cols > 0 ? Math.floor(opts.cols) : 80
  const rows = opts.rows && opts.rows > 0 ? Math.floor(opts.rows) : 24
  const m = getManager(d)
  try {
    // The port really bound, not daemon.port: under `--port`/`--addr` the agent would otherwise
    // dial the configured port, where this daemon is not listening.
    const port = d.bindPort ?? d.store.snapshot().daemon.port
    const token = sessionAuth.mint(run.id)
    const mode = opts.mode ?? d.db.getConversation(run.convId)?.agentMode ?? 'auto'
    // Only claude's mapping needs the `--help` probe (its accepted value list changed across
    // versions); every other harness's mapping is static, so it is not paid for them.
    const modeArgs = permissionModeArgs(agent, mode, agent === 'claude' ? await claudePermissionModeChoices() : [])
    const launchCommand = buildTerminalLaunchCommand(
      agent, port, token, run.id, !!run.terminalLaunchedOnce,
      modeArgs.length > 0 ? modeArgs.join(' ') : null,
      mode,
      opts.firstMessage,
    )
    // A routine kickoff abandoned while the probe above was in flight (execute.ts's kickoff bound)
    // must not launch the CLI at all — see cli-interactive-runner.ts's `kickoffSignal`.
    if (opts.signal?.aborted) {
      sessionAuth.revoke(run.id)
      return { ok: false, status: 409, code: 'aborted', message: 'Starting the terminal was cancelled.' }
    }
    const terminalId = m.create(cwd, run.id, cols, rows, launchCommand, opts.idleTtlMs)
    if (!run.terminalLaunchedOnce) d.db.updateAgentRun(run.id, { terminalLaunchedOnce: true })
    return { ok: true, terminalId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to create terminal session.'
    console.error('[terminal] create failed for session', run.id, ':', e)
    if (msg.includes('node-pty not available')) return { ok: false, status: 501, code: 'not_available', message: msg }
    return { ok: false, status: 500, code: 'create_failed', message: msg }
  }
}

export function getManager(_d: Deps): TerminalManager {
  if (!terminalManager) {
    // Force the resolve here (via the shared check above) so tests can run without node-pty
    // installed, and so the UI's availability flag and this construction can never disagree.
    if (isTerminalBackendAvailable()) {
      terminalManager = new TerminalManager(_d.store.dir())
    }
  }
  return terminalManager ?? {
    create: () => { throw new Error('node-pty not available — install with: npm install node-pty --save') },
    isActive: () => false,
    getInfo: () => undefined,
    listIds: () => [],
    kill: () => {},
    registerWsListener: () => {},
    unregisterWsListener: () => {},
    cleanupIdle: () => {},
    findByCodeSessionId: () => null,
  } as unknown as TerminalManager
}

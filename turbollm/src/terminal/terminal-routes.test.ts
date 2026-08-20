// Regression coverage for terminal-agent auto-resume across a daemon restart.
//
// V1 of this used claude's `--continue` ("resume the most recent conversation in the CURRENT
// DIRECTORY"), which turned out to be a real, live-reported bug: two Code sessions pointed at
// the same repoRoot can't be told apart by directory alone, so whichever one relaunched later
// would silently inherit whatever conversation was most recently active in that folder —
// "randomly resuming old conversations". Fixed by keying resumption on TurboLLM's OWN Code
// session id: `--session-id <id>` registers that fixed id with the CLI on a genuinely
// first-ever launch, `--resume <id>` resumes that EXACT session on every later one.
// buildTerminalLaunchCommand is the pure decision extracted from the POST .../terminal handler
// so it's testable without a live PTY/daemon (mirrors code-session.ts's codeEventToFrame).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTerminalLaunchCommand, canSeedFirstMessage, normalizeSeededMessage, MAX_SEEDED_MESSAGE_CHARS } from './terminal-routes'
import { quotePtyShellArg } from '../util/shell-command'
import { enforcesPlanMode, permissionModeArgs } from './agent-modes'

test('buildTerminalLaunchCommand: a genuinely first-ever launch registers this session\'s own id', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', false)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --code-session-id session-abc --session-id session-abc')
})

test('buildTerminalLaunchCommand: a relaunch resumes the SAME session id, not "most recent in this directory"', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', true)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --code-session-id session-abc --resume session-abc')
})

test('buildTerminalLaunchCommand: two different sessions never collide, first or relaunch', () => {
  const first = buildTerminalLaunchCommand('claude', 6996, 'tok-1', 'session-A', false)
  const second = buildTerminalLaunchCommand('claude', 6996, 'tok-2', 'session-B', false)
  assert.notEqual(first, second)
  assert.ok(first.includes('--session-id session-A'))
  assert.ok(second.includes('--session-id session-B'))

  const relaunchA = buildTerminalLaunchCommand('claude', 6996, 'tok-3', 'session-A', true)
  const relaunchB = buildTerminalLaunchCommand('claude', 6996, 'tok-4', 'session-B', true)
  assert.ok(relaunchA.includes('--resume session-A'))
  assert.ok(relaunchB.includes('--resume session-B'))
})

test('buildTerminalLaunchCommand: an agent with no confirmed session-id flags still starts fresh every time', () => {
  // opencode/kilo/openclaw/hermes/pi have no CONFIRMED --session-id/--resume equivalent yet —
  // must not guess unverified syntax, so neither flag pair is ever added.
  const first = buildTerminalLaunchCommand('opencode', 6996, 'tok-123', 'session-abc', false)
  const relaunch = buildTerminalLaunchCommand('opencode', 6996, 'tok-123', 'session-abc', true)
  assert.equal(first, 'turbollm launch opencode --port 6996 --token tok-123 --code-session-id session-abc')
  assert.equal(relaunch, 'turbollm launch opencode --port 6996 --token tok-123 --code-session-id session-abc')
})

// ── mode inheritance (founder, 2026-07-29) ────────────────────────────────────
// The session's TurboLLM mode has to reach the CLI, or picking "Plan first" and then launching
// claude silently gave you whatever the CLI defaults to. The VALUE is resolved by agent-modes.ts
// (which knows what the installed binary accepts); this only has to append it correctly.

// `permissionMode` now carries the harness's FULL pre-resolved argument text rather than a bare
// value, because the harnesses do not share a flag shape (claude `--permission-mode <v>`, opencode
// `--auto` / `--agent plan`, pi `--exclude-tools edit,write`). The mapping itself moved to
// agent-modes.ts's permissionModeArgs; see the end-to-end test below, which pins that the COMPOSED
// claude command is byte-identical to what this file asserted before that move.

test('buildTerminalLaunchCommand: the session\'s permission mode rides along, after the session flag', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', false, '--permission-mode plan')
  assert.equal(
    cmd,
    'turbollm launch claude --port 6996 --token tok-123 --code-session-id session-abc --session-id session-abc --permission-mode plan',
  )
})

test('buildTerminalLaunchCommand: a relaunch keeps carrying the mode', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', true, '--permission-mode auto')
  assert.ok(cmd.includes('--resume session-abc'))
  assert.ok(cmd.endsWith('--permission-mode auto'))
})

test('claude\'s composed launch command is byte-identical to before the per-harness refactor', () => {
  // The guard that the generalisation changed no behaviour for the one harness that already worked.
  // Both values come from claude 2.1.232's own advertised choice list.
  for (const [mode, expected] of [['plan', 'plan'], ['auto', 'auto'], ['ask', 'manual']] as const) {
    const args = permissionModeArgs('claude', mode, ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, args.join(' '), mode)
    assert.ok(cmd.includes(`--permission-mode ${expected}`), `${mode} -> ${cmd}`)
  }
})

test('permissionModeArgs: opencode uses its own flag shapes, not claude\'s', () => {
  // Measured against opencode 1.18.9: `--auto` is a boolean, and `plan (primary)` is a real
  // built-in agent (`opencode agent list`). Neither is a `--permission-mode` value.
  assert.deepEqual(permissionModeArgs('opencode', 'auto'), ['--auto'])
  assert.deepEqual(permissionModeArgs('opencode', 'plan'), ['--agent', 'plan'])
  // opencode's DEFAULT is to prompt, which IS "ask" — so the honest mapping is no flag at all.
  assert.deepEqual(permissionModeArgs('opencode', 'ask'), [])
})

test('permissionModeArgs: pi approximates plan by removing its file-mutating tools', () => {
  // pi 0.84.2 has no permission-mode concept and `--plan` needs an optional extension, so plan is
  // approximated with the verified `--exclude-tools`. See piModeArgs for the limitation (bash can
  // still write) — this test pins the approximation, it does not claim enforcement.
  assert.deepEqual(permissionModeArgs('pi', 'plan'), ['--exclude-tools', 'edit,write'])
  assert.deepEqual(permissionModeArgs('pi', 'auto'), [])
  assert.deepEqual(permissionModeArgs('pi', 'ask'), [])
})

test('permissionModeArgs: an unknown harness or unknown mode gets nothing, never a guess', () => {
  assert.deepEqual(permissionModeArgs('someNewCli', 'auto'), [])
  assert.deepEqual(permissionModeArgs('claude', 'nonsense', ['plan']), [])
})

test('enforcesPlanMode: claude and opencode enforce it; pi only approximates', () => {
  assert.equal(enforcesPlanMode('claude'), true)
  // opencode's bundled `plan` agent is a native primary agent declaring
  // `permission: { edit: { "*": "deny" } }` — read out of the 1.18.9 binary. A hard denial, so
  // claiming it was merely approximate told opencode users something untrue about their own safety.
  assert.equal(enforcesPlanMode('opencode'), true)
  // pi's `--exclude-tools edit,write` removes the edit tools but leaves bash, which can still write.
  assert.equal(enforcesPlanMode('pi'), false)
})

test('pi uses ONE session flag for both register and resume — no swap, ever', () => {
  // `pi --help` (0.84.2): "--session-id <id>  Use exact project session ID, creating it if missing."
  // So unlike claude there is no register/resume pair to mismatch.
  const first = buildTerminalLaunchCommand('pi', 6996, 'tok', 'sess-1', false)
  const again = buildTerminalLaunchCommand('pi', 6996, 'tok', 'sess-1', true)
  assert.ok(first.includes('--session-id sess-1'))
  assert.equal(first, again, 'a relaunch must use the identical flag')
  assert.ok(!again.includes('--resume'))
})

test('opencode carries NO session id — it cannot register a caller-chosen one', () => {
  // Probed: `-s/--session` is "session id to continue", and `opencode session` exposes only
  // list/delete — there is no create. Deliberately NOT falling back to `--continue`, which resumes
  // by directory recency and is the exact ambiguity ADR-293 fixed.
  for (const launchedOnce of [false, true]) {
    const cmd = buildTerminalLaunchCommand('opencode', 6996, 'tok', 'sess-1', launchedOnce)
    // No HARNESS session flag of any kind...
    assert.ok(!cmd.includes('--continue'), cmd)
    assert.ok(!cmd.includes('--session '), cmd)
    assert.ok(!cmd.includes('-s '), cmd)
    // ...but TurboLLM's OWN id is still passed, and must be: it is how `turbollm launch` reports
    // the agent exiting (cli.ts). Keying that report off the harness flag left opencode sessions
    // permanently stranded on a dead shell, since opencode never gets one.
    assert.ok(cmd.includes('--code-session-id sess-1'), cmd)
  }
})

test('buildTerminalLaunchCommand: no mode resolved means the flag is absent entirely, not empty', () => {
  // An unmapped agent, or a CLI whose accepted values we couldn't determine, must launch exactly
  // as it did before — never `--permission-mode` with a missing/blank value, which would make
  // commander swallow the NEXT token as the mode.
  for (const mode of [undefined, null, '']) {
    const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, mode as string | null | undefined)
    assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok --code-session-id sess --session-id sess')
  }
})

// ── read-only web tools are pre-allowed in auto mode (founder: "web search fails") ────────────
// Measured live before this: with `--permission-mode acceptEdits`, a turn that needed a web
// lookup came back `permission_denials: [{tool_name:"WebSearch", tool_input:{query:"hono npm
// package latest version"}}]` — the model composed a good search and the CLI refused to run it,
// because auto/acceptEdits auto-approves EDITS and a web read is not an edit. An unattended Code
// session has nobody to answer that prompt.

test('buildTerminalLaunchCommand: auto mode pre-allows the two read-only web tools', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, '--permission-mode acceptEdits', 'auto')
  assert.equal(
    cmd,
    'turbollm launch claude --port 6996 --token tok --code-session-id sess --session-id sess --permission-mode acceptEdits --allowedTools WebSearch,WebFetch',
  )
})

test('buildTerminalLaunchCommand: plan and ask keep their approval gates untouched', () => {
  // Deliberately auto-only. plan/ask exist to gate work, and silently pre-approving anything in
  // them would be a security decision the founder never made — the same reasoning agent-modes.ts
  // uses to refuse to map any mode onto `bypassPermissions`.
  for (const mode of ['plan', 'ask']) {
    const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, `--permission-mode ${mode}`, mode)
    assert.ok(!cmd.includes('--allowedTools'), `${mode} must not pre-allow anything`)
  }
})

test('buildTerminalLaunchCommand: only claude gets --allowedTools; other CLIs are unchanged', () => {
  // The flag is Claude Code's own spelling. Passing it to a CLI whose syntax hasn't been verified
  // is the same guess AGENT_SESSION_ID_FLAGS deliberately refuses to make — and a bad flag is a
  // hard startup failure, not a degraded launch.
  const cmd = buildTerminalLaunchCommand('opencode', 6996, 'tok', 'sess', false, null, 'auto')
  assert.equal(cmd, 'turbollm launch opencode --port 6996 --token tok --code-session-id sess')
})

test('buildTerminalLaunchCommand: omitting the mode argument keeps the pre-change command exactly', () => {
  // Every existing caller/test that never passed a mode must be byte-identical.
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, 'plan')
  assert.ok(!cmd.includes('--allowedTools'))
})

// ── seeding the session's first message (founder-reported, 2026-08-01) ────────────────────────
// Symptom: a fresh Code session on the Claude CLI opened the terminal but the first message never
// arrived, so it had to be retyped. The prior attempt POSTed it to the gateway's /v1/messages,
// which could not work — that is the MODEL API, and the CLI is a client of it, not a server. The
// prompt is now handed to the CLI as its documented positional argument, which the real CLI
// auto-SUBMITS (verified in a real PTY, not just from --help).

test('buildTerminalLaunchCommand: the first message leads the command, as a quoted prompt', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, 'acceptEdits', 'auto', 'Hi')
  // Must come BEFORE the flags: --allowedTools is variadic and would otherwise swallow it.
  assert.ok(cmd.startsWith(`turbollm launch claude ${quotePtyShellArg('Hi')} --port `), cmd)
  assert.ok(cmd.endsWith('--allowedTools WebSearch,WebFetch'), cmd)
})

test('buildTerminalLaunchCommand: an apostrophe in the message cannot break out of the quoting', () => {
  // "don't" is an entirely ordinary thing to type, and it terminates a single-quoted string in
  // both shells this command passes through.
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, null, null, "don't stop")
  const expected = process.platform === 'win32' ? `'don''t stop'` : `'don'\\''t stop'`
  assert.ok(cmd.includes(` ${expected} --port `), `${cmd}\nexpected to contain ${expected}`)
})

test('buildTerminalLaunchCommand: a RESUME never re-sends the first message', () => {
  // The turn is already in the CLI's own transcript; re-seeding it would duplicate it. The route
  // passes undefined on resume, so this pins that the flag itself is what suppresses it.
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', true, 'acceptEdits', 'auto', undefined)
  assert.ok(cmd.endsWith('--allowedTools WebSearch,WebFetch'), cmd)
})

// Seeding is now gated on the harness having a VERIFIED way to take an opening prompt, not on it
// being claude. The underlying rule is unchanged — never guess an unverified CLI's argument syntax
// — but three harnesses have since been probed, so the rule now admits them by measurement:
//   claude 2.1.232  positional  `claude [options] [prompt]`
//   pi     0.84.2   positional  `pi [options] [@files...] [messages...]`
//   opencode 1.18.9 flag        `--prompt <string>` on the TUI

test('a POSITIONAL-prompt harness leads with the prompt, clear of any variadic option', () => {
  // Position is load-bearing: claude's `--allowedTools` is variadic and ate a trailing prompt.
  const cmd = buildTerminalLaunchCommand('pi', 6996, 'tok', 'sess', false, null, 'auto', 'Hi')
  assert.ok(cmd.startsWith("turbollm launch pi 'Hi' --port 6996"), cmd)
})

test('a FLAG-prompt harness passes --prompt instead of a positional', () => {
  const cmd = buildTerminalLaunchCommand('opencode', 6996, 'tok', 'sess', false, null, 'auto', 'Hi')
  assert.ok(cmd.includes("--prompt 'Hi'"), cmd)
  // and never as a bare positional, which opencode's TUI would read as a project path
  assert.ok(!cmd.startsWith("turbollm launch opencode 'Hi'"), cmd)
})

test('a harness with NO verified prompt syntax is still never seeded', () => {
  const cmd = buildTerminalLaunchCommand('kilo', 6996, 'tok', 'sess', false, null, 'auto', 'Hi')
  assert.equal(cmd, 'turbollm launch kilo --port 6996 --token tok --code-session-id sess')
  assert.equal(canSeedFirstMessage('Hi', 'kilo'), false)
})

test('the unseedable-character rules apply to EVERY harness, not just claude', () => {
  // The mangling they guard against happens in the `powershell -Command "…"` wrapper, outside the
  // CLI — so it is identical whichever CLI is inside, including opencode's safer --prompt flag.
  for (const agent of ['claude', 'pi', 'opencode']) {
    assert.equal(canSeedFirstMessage('rename "foo"', agent), false, `${agent}: a literal quote cannot survive`)
    assert.equal(canSeedFirstMessage('look in C:\\repo\\', agent), false, `${agent}: a trailing backslash becomes a quote`)
    assert.equal(canSeedFirstMessage('x'.repeat(MAX_SEEDED_MESSAGE_CHARS + 1), agent), false, `${agent}: over the cap`)
    assert.equal(canSeedFirstMessage('multi\nline task', agent), true, `${agent}: newlines fold to spaces`)
  }
})

test('canSeedFirstMessage: blank and over-long messages are skipped, not truncated', () => {
  assert.equal(canSeedFirstMessage('Hi', 'claude'), true)
  assert.equal(canSeedFirstMessage('   ', 'claude'), false, 'whitespace-only is not a message')
  assert.equal(canSeedFirstMessage('', 'claude'), false)
  assert.equal(canSeedFirstMessage('x'.repeat(MAX_SEEDED_MESSAGE_CHARS), 'claude'), true, 'exactly at the cap is fine')
  // Truncating would send a half-instruction the user believes was delivered in full.
  assert.equal(canSeedFirstMessage('x'.repeat(MAX_SEEDED_MESSAGE_CHARS + 1), 'claude'), false)
})

test('buildTerminalLaunchCommand: an over-long message is omitted rather than half-sent', () => {
  const long = 'x'.repeat(MAX_SEEDED_MESSAGE_CHARS + 1)
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, 'acceptEdits', 'auto', long)
  assert.ok(!cmd.includes('xxx'), 'no fragment of the message may leak into the command')
  assert.ok(cmd.startsWith('turbollm launch claude --port '), cmd)
})

// ── what may NOT be seeded (pre-release review, 2026-08-01) ──────────────────────────────────
// The launch command is parsed by PowerShell before `turbollm launch` re-spawns the CLI, and
// PowerShell 5.1 mangles native arguments: measured, `rename "foo" to "bar"` arrives as
// `rename foo to bar` and `look in C:\repo\` arrives as `look in C:\repo"`. Single-quoting stops
// INJECTION (verified across ten hostile inputs, none escaped) but cannot stop that mangling.
// Not seeding is the honest outcome — the user retypes, rather than the agent acting on a
// silently corrupted version of their instruction.

test('canSeedFirstMessage: refuses a message containing a double quote', () => {
  assert.equal(canSeedFirstMessage('rename "foo" to "bar"', 'claude'), false)
  assert.equal(canSeedFirstMessage('rename foo to bar', 'claude'), true)
})

test('canSeedFirstMessage: refuses a message ending in a backslash', () => {
  // A raw template literal cannot END in a backslash (it would escape the closing backtick), so
  // the trailing-backslash case is written with an ordinary escaped string.
  const BS = '\\'
  assert.equal(canSeedFirstMessage(`look in C:${BS}repo${BS}`, 'claude'), false)
  assert.equal(canSeedFirstMessage(`look in C:${BS}repo`, 'claude'), true, 'an interior backslash is fine')
})

// Founder-reported, 2026-08-07: a fresh Code session's first message silently never reached the
// CLI. Root cause: the composer's own hint text advertises "Shift+Enter for newline", so a
// multi-line task description is the NORMAL case — but the ORIGINAL UNSEEDABLE range (every
// control byte from U+0000 through U+001F) refused newline/CR/tab right along with the genuinely
// dangerous control bytes, so almost any multi-sentence task silently produced an empty terminal.
// Line breaks/tabs are now folded to spaces instead of being rejected.

test('canSeedFirstMessage: a message containing newlines or tabs is now seedable (folded, not rejected)', () => {
  assert.equal(canSeedFirstMessage('line one\nline two', 'claude'), true)
  assert.equal(canSeedFirstMessage('tab\there', 'claude'), true)
  assert.equal(canSeedFirstMessage('para one\r\n\r\npara two', 'claude'), true, 'CRLF and blank lines fold too')
})

test('canSeedFirstMessage: still refuses a genuinely dangerous control byte (not just any control byte)', () => {
  assert.equal(canSeedFirstMessage('drop a bell\x07here', 'claude'), false)
  assert.equal(canSeedFirstMessage('nul\x00byte', 'claude'), false)
})

test('normalizeSeededMessage: folds line breaks and tabs to single spaces and re-trims', () => {
  assert.equal(normalizeSeededMessage('line one\nline two'), 'line one line two')
  assert.equal(normalizeSeededMessage('tab\there'), 'tab here')
  assert.equal(normalizeSeededMessage('para one\n\npara two'), 'para one para two', 'a run of breaks collapses to ONE space, not a stutter')
  assert.equal(normalizeSeededMessage('trailing newline\n'), 'trailing newline', 'folding can expose new trailing whitespace — must still trim')
})

test('buildTerminalLaunchCommand: a multi-line first message reaches the CLI as one folded, quoted line', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, undefined, 'auto', 'fix the bug\nand add a test')
  assert.ok(cmd.includes(quotePtyShellArg('fix the bug and add a test')), cmd)
  assert.ok(!cmd.includes('\n'), 'the launch command itself must never contain a literal newline')
})

test('buildTerminalLaunchCommand: an unseedable message is omitted, never mangled onto the line', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, 'acceptEdits', 'auto', 'rename "foo"')
  assert.ok(!cmd.includes('rename'), 'no fragment of the message may reach the command line')
  assert.ok(cmd.startsWith('turbollm launch claude --port '), cmd)
})

test('canSeedFirstMessage: an apostrophe is still fine — quoting handles it', () => {
  // The common case must keep working; only the two genuinely unconveyable classes are refused.
  assert.equal(canSeedFirstMessage("don't break this", 'claude'), true)
})

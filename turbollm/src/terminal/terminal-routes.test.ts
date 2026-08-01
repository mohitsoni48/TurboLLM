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
import { buildTerminalLaunchCommand, canSeedFirstMessage, MAX_SEEDED_MESSAGE_CHARS } from './terminal-routes'
import { quotePtyShellArg } from '../util/shell-command'

test('buildTerminalLaunchCommand: a genuinely first-ever launch registers this session\'s own id', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', false)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --session-id session-abc')
})

test('buildTerminalLaunchCommand: a relaunch resumes the SAME session id, not "most recent in this directory"', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', true)
  assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok-123 --resume session-abc')
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
  assert.equal(first, 'turbollm launch opencode --port 6996 --token tok-123')
  assert.equal(relaunch, 'turbollm launch opencode --port 6996 --token tok-123')
})

// ── mode inheritance (founder, 2026-07-29) ────────────────────────────────────
// The session's TurboLLM mode has to reach the CLI, or picking "Plan first" and then launching
// claude silently gave you whatever the CLI defaults to. The VALUE is resolved by agent-modes.ts
// (which knows what the installed binary accepts); this only has to append it correctly.

test('buildTerminalLaunchCommand: the session\'s permission mode rides along, after the session flag', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', false, 'plan')
  assert.equal(
    cmd,
    'turbollm launch claude --port 6996 --token tok-123 --session-id session-abc --permission-mode plan',
  )
})

test('buildTerminalLaunchCommand: a relaunch keeps carrying the mode', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok-123', 'session-abc', true, 'auto')
  assert.ok(cmd.includes('--resume session-abc'))
  assert.ok(cmd.endsWith('--permission-mode auto'))
})

test('buildTerminalLaunchCommand: no mode resolved means the flag is absent entirely, not empty', () => {
  // An unmapped agent, or a CLI whose accepted values we couldn't determine, must launch exactly
  // as it did before — never `--permission-mode` with a missing/blank value, which would make
  // commander swallow the NEXT token as the mode.
  for (const mode of [undefined, null, '']) {
    const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, mode as string | null | undefined)
    assert.equal(cmd, 'turbollm launch claude --port 6996 --token tok --session-id sess')
  }
})

// ── read-only web tools are pre-allowed in auto mode (founder: "web search fails") ────────────
// Measured live before this: with `--permission-mode acceptEdits`, a turn that needed a web
// lookup came back `permission_denials: [{tool_name:"WebSearch", tool_input:{query:"hono npm
// package latest version"}}]` — the model composed a good search and the CLI refused to run it,
// because auto/acceptEdits auto-approves EDITS and a web read is not an edit. An unattended Code
// session has nobody to answer that prompt.

test('buildTerminalLaunchCommand: auto mode pre-allows the two read-only web tools', () => {
  const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, 'acceptEdits', 'auto')
  assert.equal(
    cmd,
    'turbollm launch claude --port 6996 --token tok --session-id sess --permission-mode acceptEdits --allowedTools WebSearch,WebFetch',
  )
})

test('buildTerminalLaunchCommand: plan and ask keep their approval gates untouched', () => {
  // Deliberately auto-only. plan/ask exist to gate work, and silently pre-approving anything in
  // them would be a security decision the founder never made — the same reasoning agent-modes.ts
  // uses to refuse to map any mode onto `bypassPermissions`.
  for (const mode of ['plan', 'ask']) {
    const cmd = buildTerminalLaunchCommand('claude', 6996, 'tok', 'sess', false, mode, mode)
    assert.ok(!cmd.includes('--allowedTools'), `${mode} must not pre-allow anything`)
  }
})

test('buildTerminalLaunchCommand: only claude gets --allowedTools; other CLIs are unchanged', () => {
  // The flag is Claude Code's own spelling. Passing it to a CLI whose syntax hasn't been verified
  // is the same guess AGENT_SESSION_ID_FLAGS deliberately refuses to make — and a bad flag is a
  // hard startup failure, not a degraded launch.
  const cmd = buildTerminalLaunchCommand('opencode', 6996, 'tok', 'sess', false, null, 'auto')
  assert.equal(cmd, 'turbollm launch opencode --port 6996 --token tok')
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

test('buildTerminalLaunchCommand: only claude is seeded — other CLIs take no positional prompt', () => {
  // Same rule AGENT_SESSION_ID_FLAGS follows: never guess an unverified CLI's argument syntax.
  const cmd = buildTerminalLaunchCommand('opencode', 6996, 'tok', 'sess', false, null, 'auto', 'Hi')
  assert.equal(cmd, 'turbollm launch opencode --port 6996 --token tok')
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

// Regression coverage for shell-command quoting (DEP0190).
//
// Founder-reported live (2026-08-01): a Node 25 DeprecationWarning was printed on every Code
// session open — once by the daemon (agent-modes.ts's `claude --help` probe) and, worse, once
// straight into the session's PTY by `turbollm launch`, landing under its own "Launching Claude
// Code" banner as unexplained noise in the agent terminal.
//
// The warning is also literally true: Node joins args with spaces and NO quoting under
// `shell: true`, so these tests pin the actual behaviour being fixed — an argument containing a
// space or a shell metacharacter must survive as ONE argument.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildShellCommand, quotePosixArg, quotePowerShellArg, quoteWindowsArg } from './shell-command'

// ── the ordinary case: nothing gets quoted that doesn't need it ───────────────

test('the flags TurboLLM actually generates stay unquoted and unchanged', () => {
  // Every argument buildTerminalLaunchCommand produces. If this starts quoting things, the
  // launch command in the UI and in tests becomes needlessly unreadable.
  const cmd = buildShellCommand('claude', [
    '--session-id', '30a21f77-9ef9-4cea-9170-1ca967501ed2',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'WebSearch,WebFetch',
  ], 'win32')
  assert.equal(
    cmd,
    'claude --session-id 30a21f77-9ef9-4cea-9170-1ca967501ed2 --permission-mode acceptEdits --allowedTools WebSearch,WebFetch',
  )
})

// ── the bug the warning was pointing at ──────────────────────────────────────

test('an argument containing a space survives as ONE argument', () => {
  // Node's own concatenation splits this into two arguments today.
  assert.equal(buildShellCommand('claude', ['--model', 'My Model'], 'win32'), 'claude --model "My Model"')
  assert.equal(buildShellCommand('claude', ['--model', 'My Model'], 'linux'), "claude --model 'My Model'")
})

test('a model key containing `|` is not read as a cmd.exe pipe', () => {
  // This repo's model keys look exactly like this, and cli-launch.ts's realRunCommand already
  // documents the hazard — unquoted, cmd.exe would treat `|` as a pipe and mangle the command.
  const key = 'qwen3.6-35b-a3b|IQ3_XXS|13211155424'
  assert.equal(buildShellCommand('turbollm', ['--model', key], 'win32'), `turbollm --model "${key}"`)
  assert.equal(buildShellCommand('turbollm', ['--model', key], 'linux'), `turbollm --model '${key}'`)
})

test('other shell metacharacters are quoted on both platforms', () => {
  for (const arg of ['a&b', 'a>b', 'a<b', 'a;b', 'a$b', 'a`b', 'a(b)']) {
    assert.notEqual(quoteWindowsArg(arg), arg, `win32 must quote ${arg}`)
    assert.notEqual(quotePosixArg(arg), arg, `posix must quote ${arg}`)
  }
})

// ── quoting correctness ──────────────────────────────────────────────────────

test('quoteWindowsArg: embedded quotes and backslashes follow the CommandLineToArgvW rule', () => {
  // A backslash run is literal on its own, but doubles when it immediately precedes a quote.
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"')
  assert.equal(quoteWindowsArg('a\\b c'), '"a\\b c"', 'a lone backslash not before a quote stays single')
  assert.equal(quoteWindowsArg('a\\'), 'a\\', 'a backslash alone is an ordinary cmd.exe character')
  assert.equal(
    quoteWindowsArg('C:\\Users\\me\\repo'), 'C:\\Users\\me\\repo',
    'a plain Windows path is the common case and must stay unquoted and readable',
  )
  assert.equal(quotePosixArg('a\\b'), "'a\\b'", 'but on POSIX a backslash escapes, so it must be quoted')
  assert.equal(quoteWindowsArg('a b\\'), '"a b\\\\"', 'a TRAILING backslash doubles so it cannot escape the closing quote')
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"', 'backslash before a quote doubles, then the quote is escaped')
})

test('quotePosixArg: a single quote is closed, escaped and reopened', () => {
  assert.equal(quotePosixArg("it's"), `'it'\\''s'`)
})

test('an empty argument is preserved, not dropped', () => {
  // Unquoted, an empty arg vanishes entirely when the shell re-splits the line — silently
  // shifting every argument after it.
  assert.equal(quoteWindowsArg(''), '""')
  assert.equal(quotePosixArg(''), "''")
  assert.equal(buildShellCommand('x', ['a', '', 'b'], 'win32'), 'x a "" b')
})

test('the binary itself is quoted too when its path needs it', () => {
  assert.equal(
    buildShellCommand('C:\\Program Files\\nodejs\\node.exe', ['--version'], 'win32'),
    '"C:\\Program Files\\nodejs\\node.exe" --version',
  )
})

test('buildShellCommand with no args is just the quoted binary', () => {
  assert.equal(buildShellCommand('claude', [], 'win32'), 'claude')
})

// PowerShell's tokenizer treats U+2018–U+201B as single quotes (both to end a string and in the
// doubled-quote escape), so a smart apostrophe in pasted prose ended the string early and ran the
// rest of the first message as script. Each must be doubled exactly like ASCII `'`.
test('quotePowerShellArg: typographic single quotes are doubled like the ASCII one', () => {
  assert.equal(quotePowerShellArg("it's"), "'it''s'")
  assert.equal(quotePowerShellArg('Don\u2019t touch'), "'Don\u2019\u2019t touch'")
  assert.equal(
    quotePowerShellArg('\u2018a\u2019 \u201Ab\u201B'),
    "'\u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B'",
  )
  // Double quotes are literal inside a single-quoted PowerShell string and stay untouched.
  assert.equal(quotePowerShellArg('say \u201Chi\u201D'), "'say \u201Chi\u201D'")
})

// Regression coverage: a launched agent CLI must never inherit the identity of the agent session
// that happened to start the daemon.
//
// Founder-reported live (2026-08-01), while testing a Code terminal on a daemon that had been
// started from INSIDE a Claude Code session: the CLI rendered all-white instead of its normal
// colours, and printed "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
// `launchCli` spread `...process.env` into the child, so every marker the outer session had set on
// the daemon reached the CLI, which correctly concluded it was a nested child of another run and
// degraded itself. A terminal-agent launch is a NEW, top-level session.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inheritedEnv } from './cli-launch.js'

/** The exact set observed leaking from a real Claude Code session into a child process. */
const REAL_LEAKED_ENV: NodeJS.ProcessEnv = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  CLAUDE_CODE_SESSION_ID: 'ce67ae47-bfcc-4147-99d3-7f491f89281e',
  CLAUDE_CODE_HOST_SESSION_ID: 'host-abc',
  CLAUDE_CODE_EXECPATH: 'C:/Users/x/.local/bin/claude.exe',
  CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
  CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  CLAUDE_AGENT_SDK_VERSION: '1.2.3',
  CLAUDE_PID: '4242',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-reach-the-child',
  PATH: '/usr/bin',
  HOME: '/home/tester',
}

test('inheritedEnv: strips every parent-agent identity marker', () => {
  const env = inheritedEnv(REAL_LEAKED_ENV)
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_OAUTH_SCOPES',
    'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
    'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_PID',
  ]) {
    assert.equal(env[key], undefined, `${key} must not reach the launched CLI`)
  }
})

test('inheritedEnv: drops an inherited ANTHROPIC_API_KEY', () => {
  // Not cosmetic: we set our own session-scoped ANTHROPIC_AUTH_TOKEN, and an inherited API key can
  // take precedence — which silently breaks the token the gateway resolves per-session overrides
  // and usage attribution from (session-auth.ts). It also means a real cloud key would be sent to
  // a local process that has no use for it.
  assert.equal(inheritedEnv(REAL_LEAKED_ENV).ANTHROPIC_API_KEY, undefined)
})

test('inheritedEnv: keeps everything the CLI genuinely needs', () => {
  const env = inheritedEnv(REAL_LEAKED_ENV)
  assert.equal(env.PATH, '/usr/bin', 'stripping PATH would make the CLI unlaunchable')
  assert.equal(env.HOME, '/home/tester')
})

test('inheritedEnv: a user\'s own CLAUDE_CODE_* settings survive — this is not a blanket wipe', () => {
  // A hand-run `turbollm launch claude` from a normal shell is entitled to the user's deliberate
  // settings. Those share the prefix with the provenance markers, so the strip must be a targeted
  // list rather than a `CLAUDE_*` sweep.
  const env = inheritedEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  })
  assert.equal(env.CLAUDECODE, undefined, 'the provenance marker still goes')
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192', 'a deliberate user setting must survive')
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
})

test('inheritedEnv: does not mutate the environment it was given', () => {
  const source: NodeJS.ProcessEnv = { CLAUDECODE: '1', PATH: '/usr/bin' }
  inheritedEnv(source)
  assert.equal(source.CLAUDECODE, '1', 'the daemon\'s own process.env must be left intact')
})

test('inheritedEnv: a clean shell environment passes through untouched', () => {
  const clean: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/tester', TERM: 'xterm-256color' }
  assert.deepEqual(inheritedEnv(clean), clean)
})

// ── engine slot count caps the CLI's background-agent fan-out ─────────────────────────────────
// Claude Code spawns subagents in parallel and each is a full, independent gateway request.
// Against a `--parallel 1` llama-server they don't merely queue — they evict each other's cached
// prompt prefix, so every one re-prefills from scratch. `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
// (read by the CLI as `env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? <its own default>`) lets the
// CLI queue the excess itself. The gateway enforces the same ceiling independently.

test('inheritedEnv leaves the concurrency cap alone — it is set by launchCli, not inherited', () => {
  // Guards against a future addition to PARENT_AGENT_ENV_MARKERS accidentally stripping the very
  // variable we set two lines later.
  const env = inheritedEnv({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4', CLAUDECODE: '1' })
  assert.equal(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '4')
  assert.equal(env.CLAUDECODE, undefined)
})

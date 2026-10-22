// The runtime dependencies that can start a process, pinned by name and VERSION with the number of
// `child_process` references in each of their files. raw-spawn-guard.test.ts keeps TurboLLM's own spawns tied to
// the daemon; a dependency's spawn is outside it, so each one is a reviewed decision recorded here. A dependency
// that starts spawning, a new dependency that spawns, or a pinned one whose version or per-file counts change fails
// this test until a reviewer re-pins it: a pin by name alone let an upgrade add a long-lived spawn unseen.
//
// Read from package-lock.json's non-dev packages, as installed under node_modules. An optional package for another
// platform (pi's clipboard binaries) is not installed here and is skipped.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url))

interface Pin {
  version: string
  /** How TurboLLM handles what the package spawns. */
  reason: string
  /** `child_process` references per file (path inside the package). */
  files: Record<string, number>
}

/** Keyed by the package's path in package-lock.json without its leading `node_modules/`. */
const SPAWNING_DEPENDENCIES: Record<string, Pin> = {
  '@earendil-works/pi-coding-agent': {
    version: '0.80.6',
    reason: 'bash: replaced by code/robust-bash.ts. rg and fd (grep, find): raw, until TurboLLM runs its own. ' +
      'Extension exec, clipboard, editors, browser, rpc: interactive-mode and extension paths TurboLLM does not run.',
    files: {
      'dist/core/exec.js': 1, 'dist/core/footer-data-provider.js': 1, 'dist/core/resolve-config-value.js': 1,
      'dist/core/tools/bash.js': 1, 'dist/core/tools/find.js': 1, 'dist/core/tools/grep.js': 1,
      'dist/modes/interactive/components/extension-editor.js': 2, 'dist/modes/interactive/components/session-selector.js': 1,
      'dist/modes/interactive/interactive-mode.js': 2, 'dist/modes/rpc/rpc-client.js': 1, 'dist/utils/child-process.js': 1,
      'dist/utils/clipboard-image.js': 1, 'dist/utils/clipboard.js': 1, 'dist/utils/open-browser.js': 1,
      'dist/utils/shell.js': 1, 'dist/utils/tools-manager.js': 1, 'examples/extensions/doom-overlay/doom/build/doom.js': 1,
    },
  },
  '@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core': {
    version: '0.80.6', reason: 'its Node harness environment: not used by TurboLLM, which runs pi through createAgentSession', files: { 'dist/harness/env/nodejs.js': 1 },
  },
  '@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui': {
    version: '0.80.6', reason: 'terminal UI autocomplete and images: interactive mode only', files: { 'dist/autocomplete.js': 1, 'dist/terminal-image.js': 1 },
  },
  '@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard': {
    version: '0.3.9', reason: 'the clipboard: interactive mode only', files: { 'index.js': 1 },
  },
  '@earendil-works/pi-coding-agent/node_modules/marked': {
    version: '18.0.5', reason: 'its command-line bin: never run', files: { 'bin/main.js': 1 },
  },
  '@puppeteer/browsers': {
    version: '3.2.4', reason: 'Chrome through launch(), which artifacts/screenshot.ts calls; its CLI and installer are not run',
    files: { 'lib/CLI.js': 1, 'lib/browser-data/chrome.js': 1, 'lib/fileUtil.js': 1, 'lib/install.js': 1, 'lib/launch.js': 2 },
  },
  'cross-spawn': { version: '7.0.6', reason: 'a spawn wrapper pi uses on interactive paths', files: { 'index.js': 1 } },
  'gaxios': {
    version: '7.3.0', reason: 'its own browser and system tests: never run',
    files: {
      'build/cjs/browser-test/browser-test-runner.js': 1, 'build/cjs/system-test/test.install.js': 1,
      'build/esm/browser-test/browser-test-runner.js': 1, 'build/esm/system-test/test.install.js': 1,
    },
  },
  'google-auth-library': {
    version: '10.9.1', reason: 'gcloud and pluggable-executable credential helpers for Vertex: short-lived (Known)',
    files: { 'build/src/auth/googleauth.js': 1, 'build/src/auth/pluggable-auth-handler.js': 1 },
  },
  '@aws-sdk/credential-provider-process': {
    version: '3.972.67', reason: 'a user-configured credential_process for Bedrock: short-lived (Known)',
    files: { 'dist-cjs/index.js': 1, 'dist-es/resolveProcessCredentials.js': 1 },
  },
  'node-addon-api': {
    version: '7.1.1', reason: 'build tools: never run', files: { 'tools/check-napi.js': 1, 'tools/clang-format.js': 1, 'tools/eslint-format.js': 1 },
  },
  'node-pty': {
    version: '1.1.0', reason: 'conpty_console_list_agent (Windows): short-lived, run only when a terminal is killed; its scripts are build tools',
    files: { 'lib/conpty_console_list_agent.js': 1, 'lib/windowsPtyAgent.js': 1, 'scripts/gen-compile-commands.js': 1, 'scripts/increment-version.js': 1 },
  },
  'openai': { version: '6.26.0', reason: 'its audio helpers (play and record): never used', files: { 'helpers/audio.js': 1, 'helpers/audio.mjs': 1 } },
  'puppeteer-core': { version: '25.13.0', reason: 'ffmpeg for ScreenRecorder: never used', files: { 'lib/puppeteer/node/ScreenRecorder.js': 1 } },
}

function childProcessRefs(dir: string): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!/^(test|tests|__tests__)$/.test(e.name)) walk(join(d, e.name), r)
        continue
      }
      if (!/\.(js|mjs|cjs)$/.test(e.name) || /\.(test|spec)\.[cm]?js$/.test(e.name)) continue
      const n = (readFileSync(join(d, e.name), 'utf8').match(/\bchild_process\b/g) ?? []).length
      if (n > 0) out[r] = n
    }
  }
  walk(dir, '')
  return out
}

test('the runtime dependencies that can spawn are exactly the pinned ones, at the pinned versions and counts', () => {
  const lock = JSON.parse(readFileSync(join(PKG_ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string; dev?: boolean; optional?: boolean }>
  }
  const actual: Record<string, { version: string; files: Record<string, number> }> = {}
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (!path || meta.dev) continue
    const dir = join(PKG_ROOT, path)
    if (!existsSync(dir)) {
      assert.ok(meta.optional, `${path} is a runtime dependency in package-lock.json but is not installed`)
      continue
    }
    const files = childProcessRefs(dir)
    if (Object.keys(files).length > 0) actual[path.replace(/^node_modules\//, '')] = { version: meta.version ?? '', files }
  }
  const pinned = Object.fromEntries(Object.entries(SPAWNING_DEPENDENCIES).map(([k, p]) => [k, { version: p.version, files: p.files }]))
  assert.deepEqual(actual, pinned,
    'a runtime dependency\'s spawning changed. Check what it now starts and whether it can outlive the daemon, then ' +
    're-pin it in SPAWNING_DEPENDENCIES (version, per-file counts, reason).')
})

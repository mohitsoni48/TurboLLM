// Install-method detection, the apply pre-checks, and the cross-restart result handshake
// (spec 29 B.1).
//
// These are unit tests over PURE functions on purpose, and that purpose is not stylistic:
// there is no way to exercise six install methods by running the suite, because the suite
// runs in exactly one of them. A misclassification is the most damaging bug this feature
// can have — classifying a Docker container or a source checkout as a global npm install
// would run `npm i -g turbollm@latest`, which "succeeds" while updating a completely
// different copy of TurboLLM than the one the user is running — so every case gets an
// explicit test rather than being covered by whichever environment CI happens to be.
//
// Deliberately NOT tested here: an end-to-end apply. That path kills and relaunches a real
// daemon, and the machine this suite runs on may be running the user's own TurboLLM with
// live Code sessions in it. The mechanism is verified by testing the decisions it is built
// out of; the real end-to-end run is a manual step against a throwaway global install
// (spec 29's test plan), with `~/.turbollm` backed up first.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INSTALL_METHODS,
  checkApplyBlockers,
  classifyInstall,
  classifyUpdateFailure,
  progressFromResult,
  AppUpdateProgressState,
  type InstallSignals,
} from './app-update-apply'
import { APP_INSTALL_METHODS } from './telemetry/events/app-update'

/** A plausible-but-unclassifiable baseline, so each test states ONLY the signal it is
 *  about. Defaults are the "none of the special cases apply" answer. */
function signals(over: Partial<InstallSignals> = {}): InstallSignals {
  return {
    platform: 'linux',
    entry: '/opt/somewhere/turbollm/bin/turbollm.mjs',
    desktopEnv: false,
    inContainer: false,
    npmGlobalRoot: null,
    sourceCheckout: false,
    ...over,
  }
}

test('classifyInstall: a global npm install offers the self-update', () => {
  const info = classifyInstall(
    signals({
      entry: '/usr/lib/node_modules/turbollm/bin/turbollm.mjs',
      npmGlobalRoot: '/usr/lib/node_modules',
    }),
  )
  assert.equal(info.method, 'npm_global')
  assert.equal(info.canSelfUpdate, true)
  assert.equal(info.command, 'npm i -g turbollm@latest')
})

test('classifyInstall: global detection is case-insensitive and separator-agnostic on Windows', () => {
  const info = classifyInstall(
    signals({
      platform: 'win32',
      entry: 'C:\\Users\\Owner\\AppData\\Roaming\\npm\\node_modules\\turbollm\\bin\\turbollm.mjs',
      npmGlobalRoot: 'C:\\Users\\owner\\AppData\\Roaming\\npm\\node_modules',
    }),
  )
  assert.equal(info.method, 'npm_global')
})

test('classifyInstall: a sibling directory that merely shares a prefix is NOT the global root', () => {
  // The whole-segment check. Without it `/usr/lib/node_modules-old/...` reads as being
  // under `/usr/lib/node_modules`, and a stale second copy gets "updated" instead.
  const info = classifyInstall(
    signals({
      entry: '/usr/lib/node_modules-old/turbollm/bin/turbollm.mjs',
      npmGlobalRoot: '/usr/lib/node_modules',
    }),
  )
  assert.notEqual(info.method, 'npm_global')
})

test('classifyInstall: an npx cache run relaunches at @latest rather than installing', () => {
  const info = classifyInstall(signals({ entry: '/home/u/.npm/_npx/8a3f/node_modules/turbollm/bin/turbollm.mjs' }))
  assert.equal(info.method, 'npx')
  assert.equal(info.canSelfUpdate, true)
  assert.equal(info.command, 'npx turbollm@latest')
})

test('classifyInstall: the packaged desktop daemon is never treated as an npm install', () => {
  // The dangerous case. The packaged daemon lives inside a node_modules-shaped tree of its
  // own, so without the desktop check winning FIRST it can look like an npm install and
  // `npm i -g` would update a different copy entirely, leaving the desktop app unchanged.
  const info = classifyInstall(
    signals({
      entry: '/Applications/TurboLLM.app/Contents/Resources/daemon/bin/turbollm.mjs',
      npmGlobalRoot: '/Applications',
    }),
  )
  assert.equal(info.method, 'electron')
  assert.equal(info.canSelfUpdate, false)
})

test('classifyInstall: the desktop env var alone is enough (wrapper-set, path-independent)', () => {
  const info = classifyInstall(signals({ desktopEnv: true, entry: '/anything/at/all/cli.js' }))
  assert.equal(info.method, 'electron')
})

test('classifyInstall: a container refuses and shows a rebuild command', () => {
  const info = classifyInstall(signals({ inContainer: true }))
  assert.equal(info.method, 'docker')
  assert.equal(info.canSelfUpdate, false)
  assert.ok(info.command.length > 0, 'must still offer a command — never a dead end')
})

test('classifyInstall: Android refuses and beats every other signal', () => {
  // Even with signals that would otherwise read as a global npm install.
  const info = classifyInstall(
    signals({
      platform: 'android',
      inContainer: true,
      entry: '/data/data/dev.turbollm/files/node_modules/turbollm/bin/turbollm.mjs',
      npmGlobalRoot: '/data/data/dev.turbollm/files/node_modules',
    }),
  )
  assert.equal(info.method, 'android')
  assert.equal(info.canSelfUpdate, false)
})

test('classifyInstall: a source checkout refuses and says to pull', () => {
  const info = classifyInstall(signals({ sourceCheckout: true, entry: '/home/u/code/TurboLLM/turbollm/src/cli.ts' }))
  assert.equal(info.method, 'source')
  assert.equal(info.canSelfUpdate, false)
  assert.equal(info.command, 'git pull')
})

test('classifyInstall: an unrecognised install refuses honestly, but still offers a command', () => {
  const info = classifyInstall(signals())
  assert.equal(info.method, 'unknown')
  assert.equal(info.canSelfUpdate, false)
  assert.ok(info.command.length > 0)
  assert.ok(info.note.length > 0)
})

test('every install method is covered by INSTALL_METHODS', () => {
  // Guards the telemetry enum and the UI's method union against a method being added to
  // the classifier and nowhere else.
  const produced = new Set([
    classifyInstall(signals({ entry: '/n/turbollm/x', npmGlobalRoot: '/n' })).method,
    classifyInstall(signals({ entry: '/a/_npx/b/c' })).method,
    classifyInstall(signals({ desktopEnv: true })).method,
    classifyInstall(signals({ inContainer: true })).method,
    classifyInstall(signals({ platform: 'android' })).method,
    classifyInstall(signals({ sourceCheckout: true })).method,
    classifyInstall(signals()).method,
  ])
  assert.deepEqual([...produced].sort(), [...INSTALL_METHODS].sort())
})

test('the telemetry install-method enum matches the classifier exactly', () => {
  // events/app-update.ts writes this list out by hand rather than importing it, because
  // importing app-update-apply.ts would drag node:child_process/node:fs into the
  // telemetry Worker's bundle. This test is what closes the drift that copy creates.
  assert.deepEqual([...APP_INSTALL_METHODS], [...INSTALL_METHODS])
})

// ─── pre-checks ───────────────────────────────────────────────────────────────

const idle = {
  modelLoading: false,
  downloadActive: false,
  codeSessionActive: false,
  engineBuildActive: false,
  engineProvisionActive: false,
}

test('checkApplyBlockers: an idle daemon may update', () => {
  assert.equal(checkApplyBlockers(idle), null)
})

test('checkApplyBlockers: every in-flight activity blocks, with a reason naming it', () => {
  for (const [key, word] of [
    ['downloadActive', 'download'],
    ['engineBuildActive', 'built'],
    ['engineProvisionActive', 'installed'],
    ['codeSessionActive', 'Code session'],
    ['modelLoading', 'model'],
  ] as const) {
    const reason = checkApplyBlockers({ ...idle, [key]: true })
    assert.ok(reason, `${key} must block`)
    assert.match(reason, new RegExp(word, 'i'), `${key}'s reason must say what is blocking`)
  }
})

test('checkApplyBlockers: a download outranks everything else', () => {
  // The standing rule (ADR-240): a hard kill mid-write can corrupt a download rather than
  // pause it, so when several things are in flight that is the one the user is told about.
  const reason = checkApplyBlockers({ ...idle, downloadActive: true, codeSessionActive: true, modelLoading: true })
  assert.match(String(reason), /download/i)
})

// ─── the cross-restart handshake ──────────────────────────────────────────────

test('progressFromResult: a successful result becomes a done state', () => {
  const p = progressFromResult(JSON.stringify({ ok: true, from: '1.12.7', to: '1.12.8', method: 'npm_global', at: '2026-09-09T00:00:00.000Z' }))
  assert.equal(p?.state, 'done')
  assert.equal(p?.target, '1.12.8')
  assert.equal(p?.from, '1.12.7')
  assert.equal(p?.method, 'npm_global')
  assert.equal(p?.error, null)
})

test('progressFromResult: a failed result carries the reason through', () => {
  const p = progressFromResult(JSON.stringify({ ok: false, from: '1.12.7', to: '1.12.8', method: 'npm_global', error: 'npm.cmd exited with code 1', at: 'x' }))
  assert.equal(p?.state, 'failed')
  assert.equal(p?.error, 'npm.cmd exited with code 1')
})

test('progressFromResult: garbage is null, never a fabricated outcome', () => {
  // A truncated/corrupt file must read as "no update ran", not as a success — reporting a
  // version bump that did not happen is worse than reporting nothing.
  assert.equal(progressFromResult('not json'), null)
  assert.equal(progressFromResult('{}'), null)
  assert.equal(progressFromResult('{"ok":"yes"}'), null)
})

test('progressFromResult: an unrecognised method degrades to null rather than passing through', () => {
  const p = progressFromResult(JSON.stringify({ ok: true, from: 'a', to: 'b', method: 'carrier-pigeon', at: 'x' }))
  assert.equal(p?.state, 'done')
  assert.equal(p?.method, null, 'telemetry enums are closed — an unknown value must not reach one')
})

test('classifyUpdateFailure: maps helper text into the closed telemetry vocabulary', () => {
  assert.equal(classifyUpdateFailure('The running TurboLLM did not shut down in time, so the update was not applied.'), 'daemon_did_not_exit')
  assert.equal(classifyUpdateFailure('npm.cmd exited with code 1'), 'install_failed')
  assert.equal(classifyUpdateFailure('EPERM: operation not permitted'), 'install_failed')
  assert.equal(classifyUpdateFailure('spawn npm ENOENT'), 'install_failed')
  assert.equal(classifyUpdateFailure('something nobody predicted'), 'other')
  assert.equal(classifyUpdateFailure(null), 'other')
})

test('AppUpdateProgressState: only the in-flight states count as running', () => {
  const s = new AppUpdateProgressState()
  assert.equal(s.get().state, 'idle')
  assert.equal(s.isRunning(), false)
  s.set('installing', { target: '1.12.8' })
  assert.equal(s.isRunning(), true)
  assert.equal(s.get().target, '1.12.8')
  s.set('done')
  assert.equal(s.isRunning(), false, 'a finished update must not block the next one')
  // The target survives a transition that does not restate it — the dialog reads it after
  // the restart to confirm which version it landed on.
  assert.equal(s.get().target, '1.12.8')
})

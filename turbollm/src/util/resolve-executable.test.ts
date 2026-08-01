// Regression coverage for the CRITICAL found in pre-release review (2026-08-01).
//
// `spawn(cmd, args, {shell:true})` on Windows routes through cmd.exe, whose parser does NOT honour
// the `\"` escape that CommandLineToArgvW does — so an argument containing a double quote escapes
// its own quoting and everything after it is parsed as shell syntax. Reproduced live with a marker
// file proving a chained command executed. The fix is to resolve the command and spawn it with an
// args array and NO shell, which these tests pin.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requiresShell, resolveExecutable } from './resolve-executable'

function sandbox(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rex-'))
  mkdirSync(dir, { recursive: true })
  for (const f of files) {
    const p = join(dir, f)
    writeFileSync(p, '')
    try { chmodSync(p, 0o755) } catch { /* windows */ }
  }
  return dir
}

test('resolveExecutable: finds a bare command on PATH via PATHEXT (win32)', () => {
  const dir = sandbox(['claude.exe'])
  try {
    const hit = resolveExecutable('claude', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')
    assert.equal(hit, join(dir, 'claude.exe'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveExecutable: PATHEXT order decides which shim wins', () => {
  const dir = sandbox(['claude.cmd', 'claude.exe'])
  try {
    // .EXE before .CMD -> the real executable is preferred, which is what keeps us off the shell.
    assert.equal(resolveExecutable('claude', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32'), join(dir, 'claude.exe'))
    assert.equal(resolveExecutable('claude', { PATH: dir, PATHEXT: '.CMD;.EXE' }, 'win32'), join(dir, 'claude.cmd'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveExecutable: missing PATHEXT falls back to the documented Windows default', () => {
  const dir = sandbox(['claude.exe'])
  try {
    assert.equal(resolveExecutable('claude', { PATH: dir }, 'win32'), join(dir, 'claude.exe'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveExecutable: quoted PATH entries are handled', () => {
  const dir = sandbox(['claude.exe'])
  try {
    assert.equal(resolveExecutable('claude', { PATH: `"${dir}"`, PATHEXT: '.EXE' }, 'win32'), join(dir, 'claude.exe'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveExecutable: null when not on PATH — callers keep their old behaviour', () => {
  const dir = sandbox([])
  try {
    assert.equal(resolveExecutable('definitely-not-here', { PATH: dir, PATHEXT: '.EXE' }, 'win32'), null)
    assert.equal(resolveExecutable('', { PATH: dir }, 'win32'), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('requiresShell: only cmd/bat shims need one', () => {
  // This is the whole point: an .exe takes the no-shell path, where no quoting rules apply and
  // the injection is structurally impossible.
  assert.equal(requiresShell(String.raw`C:\x\claude.exe`, 'win32'), false)
  assert.equal(requiresShell(String.raw`C:\x\claude.com`, 'win32'), false)
  assert.equal(requiresShell(String.raw`C:\x\claude.cmd`, 'win32'), true)
  assert.equal(requiresShell(String.raw`C:\x\claude.bat`, 'win32'), true)
  assert.equal(requiresShell(String.raw`C:\x\CLAUDE.CMD`, 'win32'), true, 'extension check is case-insensitive')
})

test('requiresShell: an unresolved command keeps the shell (no behaviour change)', () => {
  // "not found" is not proof the command is unusable — an exotic PATHEXT, an alias. Falling back
  // to the previous behaviour is strictly safer than refusing to launch.
  assert.equal(requiresShell(null, 'win32'), true)
})

test('requiresShell: never on POSIX, where there is no shim problem', () => {
  assert.equal(requiresShell('/usr/bin/claude', 'linux'), false)
  assert.equal(requiresShell('/usr/bin/x.cmd', 'linux'), false)
})

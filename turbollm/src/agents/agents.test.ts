// Agents+Skills Phase 1 tests: guard containment, skill store, config normalize
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, symlinkSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInsideAny, makeToolCallGuard, type ToolCallGuardResult } from './fs-guard'
import { SkillStore, isBuiltinSkill } from './skills'

// Narrowing helpers for the ToolCallGuardResult union (the guard returns
// { allow: true } | { block: true; reason }). Keeps assertions terse.
const blocked = (r: ToolCallGuardResult): boolean => 'block' in r
const allowed = (r: ToolCallGuardResult): boolean => 'allow' in r
const reasonOf = (r: ToolCallGuardResult): string => ('block' in r ? r.reason : '')

// ── isInsideAny ────────────────────────────────────────────────────────────────

test('isInsideAny: exact root match', () => {
  assert.ok(isInsideAny('/home/user/project', ['/home/user/project']))
})

test('isInsideAny: nested path', () => {
  assert.ok(isInsideAny('/home/user/project/src/index.ts', ['/home/user/project']))
})

test('isInsideAny: outside all roots', () => {
  assert.ok(!isInsideAny('/tmp/malicious', ['/home/user/project']))
})

test('isInsideAny: directory traversal', () => {
  assert.ok(!isInsideAny('/home/user/project/../../etc/passwd', ['/home/user/project']))
})

test('isInsideAny: multiple roots — matches second', () => {
  assert.ok(isInsideAny('/data/safe/file.md', ['/home/user/project', '/data/safe']))
})

// ── makeToolCallGuard — built-in deny ─────────────────────────────────────────

test('guard: blocks pi built-ins', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(),
  )
  const res = guard('bash', { command: 'ls' })
  assert.ok(blocked(res))
  assert.match(reasonOf(res), /built-in/)
})

test('guard: blocks write built-in', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(),
  )
  assert.ok(blocked(guard('write', { path: '/data/file.txt' })))
})

test('guard: blocks edit built-in', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(),
  )
  assert.ok(blocked(guard('edit', { file: '/data/file.txt' })))
})

// ── makeToolCallGuard — FS tools containment ──────────────────────────────────

test('guard: allows read_file inside root', () => {
  // Use a REAL tmp dir so realpathSync can canonicalize (matches production, where
  // dataDir/roots are always real absolute paths). Fictional paths hit the no-parent
  // fallback which is platform-dependent and not representative.
  const root = mkdtempSync(join(tmpdir(), 'guard-read-'))
  try {
    const guard = makeToolCallGuard(
      { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [root], writeRoots: [], callableAgents: [] },
      root,
      new Set(),
    )
    assert.equal(allowed(guard('read_file', { path: join(root, 'file.txt') })), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('guard: blocks read_file outside root', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: ['/data'], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(),
  )
  const res = guard('read_file', { path: '/tmp/secret.txt' })
  assert.ok(blocked(res))
  assert.match(reasonOf(res), /outside/)
})

test('guard: blocks write_file outside write roots', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: ['/data'], writeRoots: ['/data/out'], callableAgents: [] },
    '/data',
    new Set(),
  )
  const res = guard('write_file', { path: '/data/other/file.txt' })
  assert.ok(blocked(res))
  assert.match(reasonOf(res), /write/)
})

test('guard: allows write_file inside write root', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-write-'))
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  try {
    const guard = makeToolCallGuard(
      { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [root], writeRoots: [out], callableAgents: [] },
      root,
      new Set(),
    )
    assert.equal(allowed(guard('write_file', { path: join(out, 'output.txt') })), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── makeToolCallGuard — bridged tools ─────────────────────────────────────────

test('guard: allows bridged tools', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(['web_search', 'run_code']),
  )
  assert.equal(allowed(guard('web_search', { query: 'test' })), true)
  assert.equal(allowed(guard('run_code', { code: '1+1' })), true)
})

test('guard: default-deny unknown tools', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(),
  )
  const res = guard('unknown_tool', {})
  assert.ok(blocked(res))
  assert.match(reasonOf(res), /unrecognized/)
})

// ── makeToolCallGuard — action tools ──────────────────────────────────────────

test('guard: allows action tools (call_agent, complete_task, update_doc)', () => {
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [], writeRoots: [], callableAgents: [] },
    '/data',
    new Set(),
  )
  assert.equal(allowed(guard('call_agent', { agent: 'other' })), true)
  assert.equal(allowed(guard('complete_task', {})), true)
  assert.equal(allowed(guard('update_doc', { doc: 'progress' })), true)
})

// ── SkillStore ────────────────────────────────────────────────────────────────

test('isBuiltinSkill: known builtins', () => {
  assert.ok(isBuiltinSkill('filesystem'))
  assert.ok(isBuiltinSkill('web'))
  assert.ok(isBuiltinSkill('code'))
  assert.ok(isBuiltinSkill('task-tracking'))
  assert.ok(isBuiltinSkill('compose'))
})

test('isBuiltinSkill: non-builtin', () => {
  assert.ok(!isBuiltinSkill('custom-skill'))
})

test('SkillStore: lists builtins when no skills dir', () => {
  const store = new SkillStore('/tmp/nonexistent-turbollm-test')
  const skills = store.list()
  assert.ok(skills.length >= 5, 'should have at least 5 builtins')
})

// ── Guard — readRoots with dataDir placeholder ────────────────────────────────

test('guard: dataDir placeholder resolves in roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-datadir-'))
  try {
    const guard = makeToolCallGuard(
      { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: ['<dataDir>'], writeRoots: [], callableAgents: [] },
      root,
      new Set(),
    )
    // read_file inside the dataDir (resolved from <dataDir>) should be allowed
    assert.equal(allowed(guard('read_file', { path: join(root, 'file.txt') })), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Symlink escape BLOCKER test ───────────────────────────────────────────────

test('guard: blocks symlink escape out of root', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'symlink-test-'))
  const inside = join(tmp, 'inside')
  const outside = '/etc' // or use a real outside path

  // Create inside directory
  mkdirSync(inside, { recursive: true })

  // Create symlink inside -> outside
  const symlinkPath = join(inside, 'escape_link')
  if (process.platform === 'win32') {
    // Windows requires elevated privileges for symlinks — skip on CI
    console.log('Skipping symlink test on Windows (requires admin)')
    return
  }
  symlinkSync(outside, symlinkPath)

  // Guard with inside as read root
  const guard = makeToolCallGuard(
    { id: 'default', name: 'Default Agent', description: '', skills: [], readRoots: [inside], writeRoots: [], callableAgents: [] },
    tmp,
    new Set(),
  )

  // Try to read through the symlink
  const result = guard('read_file', { path: symlinkPath })
  assert.ok(blocked(result), 'symlink escape should be blocked')
  assert.match(reasonOf(result), /outside/)

  // Cleanup
  rmSync(tmp, { recursive: true, force: true })
})

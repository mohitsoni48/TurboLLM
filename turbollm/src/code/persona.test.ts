// Unit tests for persona.ts's AGENTS.md injection (agentsMdBlock/buildAppendPrompt) — the
// OpenCode-style convention: <repoRoot>/AGENTS.md (project) + <globalDir>/agents.md (global),
// appended to the system prompt automatically, no per-session setup required.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentsMdBlock, agentsMdPresence, buildAppendPrompt } from './persona'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('agentsMdBlock: returns "" when neither file exists', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  assert.equal(agentsMdBlock(repoRoot, globalDir), '')
})

test('agentsMdBlock: includes only the project file when only it exists', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  writeFileSync(join(repoRoot, 'AGENTS.md'), 'Use pnpm, not npm, in this repo.')
  const block = agentsMdBlock(repoRoot, globalDir)
  assert.match(block, /Use pnpm, not npm, in this repo\./)
  assert.doesNotMatch(block, /Global instructions/)
  assert.match(block, /Project instructions/)
})

test('agentsMdBlock: includes only the global file when only it exists', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  writeFileSync(join(globalDir, 'agents.md'), 'Always write commit messages in present tense.')
  const block = agentsMdBlock(repoRoot, globalDir)
  assert.match(block, /Always write commit messages in present tense\./)
  assert.match(block, /Global instructions/)
  assert.doesNotMatch(block, /Project instructions/)
})

test('agentsMdBlock: includes BOTH, global before project', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  writeFileSync(join(globalDir, 'agents.md'), 'GLOBAL_MARKER')
  writeFileSync(join(repoRoot, 'AGENTS.md'), 'PROJECT_MARKER')
  const block = agentsMdBlock(repoRoot, globalDir)
  const globalIdx = block.indexOf('GLOBAL_MARKER')
  const projectIdx = block.indexOf('PROJECT_MARKER')
  assert.ok(globalIdx !== -1 && projectIdx !== -1)
  assert.ok(globalIdx < projectIdx, 'global instructions come before project instructions')
})

test('agentsMdBlock: a whitespace-only file counts as absent', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  writeFileSync(join(repoRoot, 'AGENTS.md'), '   \n\n  ')
  assert.equal(agentsMdBlock(repoRoot, globalDir), '')
})

test('agentsMdBlock: a path that is a directory, not a file, is silently skipped (not a crash)', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  mkdirSync(join(repoRoot, 'AGENTS.md')) // a directory named AGENTS.md, not a file
  assert.doesNotThrow(() => agentsMdBlock(repoRoot, globalDir))
  assert.equal(agentsMdBlock(repoRoot, globalDir), '')
})

// ── agentsMdPresence (ADR-262 loaded-resources header) — the boolean-per-file existence check,
// same lookup + whitespace-counts-as-absent rule as agentsMdBlock so "shown loaded" == "injected".

test('agentsMdPresence: both false when neither file exists', () => {
  assert.deepEqual(agentsMdPresence(tmp('tllm-amp-repo-'), tmp('tllm-amp-global-')), { project: false, global: false })
})

test('agentsMdPresence: detects a project AGENTS.md only', () => {
  const repoRoot = tmp('tllm-amp-repo-')
  const globalDir = tmp('tllm-amp-global-')
  writeFileSync(join(repoRoot, 'AGENTS.md'), 'Use pnpm here.')
  assert.deepEqual(agentsMdPresence(repoRoot, globalDir), { project: true, global: false })
})

test('agentsMdPresence: detects a global agents.md only', () => {
  const repoRoot = tmp('tllm-amp-repo-')
  const globalDir = tmp('tllm-amp-global-')
  writeFileSync(join(globalDir, 'agents.md'), 'Always present tense.')
  assert.deepEqual(agentsMdPresence(repoRoot, globalDir), { project: false, global: true })
})

test('agentsMdPresence: detects both when both exist', () => {
  const repoRoot = tmp('tllm-amp-repo-')
  const globalDir = tmp('tllm-amp-global-')
  writeFileSync(join(repoRoot, 'AGENTS.md'), 'project')
  writeFileSync(join(globalDir, 'agents.md'), 'global')
  assert.deepEqual(agentsMdPresence(repoRoot, globalDir), { project: true, global: true })
})

test('agentsMdPresence: a whitespace-only file counts as absent (matches agentsMdBlock)', () => {
  const repoRoot = tmp('tllm-amp-repo-')
  const globalDir = tmp('tllm-amp-global-')
  writeFileSync(join(repoRoot, 'AGENTS.md'), '   \n\n  ')
  assert.deepEqual(agentsMdPresence(repoRoot, globalDir), { project: false, global: false })
})

test('buildAppendPrompt: omitting agentsMd (existing call sites) keeps output unchanged — no AGENTS.md block', () => {
  const blocks = buildAppendPrompt('auto')
  assert.ok(!blocks.some((b) => b.includes('standing instructions')))
})

test('buildAppendPrompt: passing agentsMd with real files appends the block last', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  writeFileSync(join(repoRoot, 'AGENTS.md'), 'REPO_RULE_MARKER')
  const blocks = buildAppendPrompt('auto', [], { repoRoot, globalDir })
  const last = blocks.at(-1)!
  assert.match(last, /REPO_RULE_MARKER/)
})

test('buildAppendPrompt: passing agentsMd with no files present adds nothing extra', () => {
  const repoRoot = tmp('tllm-agentsmd-repo-')
  const globalDir = tmp('tllm-agentsmd-global-')
  const withAgents = buildAppendPrompt('auto', [], { repoRoot, globalDir })
  const without = buildAppendPrompt('auto')
  assert.deepEqual(withAgents, without)
})

test('buildAppendPrompt: hasWebTools=false (default) omits anti-fallback and dependency-discipline guidance', () => {
  const blocks = buildAppendPrompt('auto')
  assert.ok(!blocks.some((b) => b.includes('do NOT quietly substitute')))
  assert.ok(!blocks.some((b) => b.includes('STRICT RULE, no exceptions')))
})

test('buildAppendPrompt: hasWebTools=true appends both anti-fallback and dependency-discipline blocks', () => {
  const blocks = buildAppendPrompt('auto', [], undefined, true)
  assert.ok(blocks.some((b) => b.includes('do NOT quietly substitute')))
  assert.ok(blocks.some((b) => b.includes('STRICT RULE, no exceptions')))
})

test('buildAppendPrompt: plan mode with hasWebTools=true still omits edit guidance but keeps web-tool guidance', () => {
  const blocks = buildAppendPrompt('plan', [], undefined, true)
  assert.ok(!blocks.some((b) => b.includes('first read the file, then copy')))
  assert.ok(blocks.some((b) => b.includes('STRICT RULE, no exceptions')))
})

test('buildAppendPrompt: LSP guidance appears in auto/ask but not plan mode (no edit tool there)', () => {
  const auto = buildAppendPrompt('auto')
  const plan = buildAppendPrompt('plan')
  assert.ok(auto.some((b) => b.includes('LSP diagnostics for')))
  assert.ok(!plan.some((b) => b.includes('LSP diagnostics for')))
})

test('buildAppendPrompt: todo-tracker guidance (update_todos) appears in auto/ask but not plan mode', () => {
  assert.ok(buildAppendPrompt('auto').some((b) => b.includes('call update_todos')))
  assert.ok(buildAppendPrompt('ask').some((b) => b.includes('call update_todos')))
  // Plan mode's deliverable is already a written step list, so no live checklist guidance there.
  assert.ok(!buildAppendPrompt('plan').some((b) => b.includes('call update_todos')))
})

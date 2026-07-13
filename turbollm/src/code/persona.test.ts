// Unit tests for persona.ts's AGENTS.md injection (agentsMdBlock/buildAppendPrompt) — the
// OpenCode-style convention: <repoRoot>/AGENTS.md (project) + <globalDir>/agents.md (global),
// appended to the system prompt automatically, no per-session setup required.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentsMdBlock, buildAppendPrompt } from './persona'

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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  customSourceIsLive,
  customSourceKey,
  engineGroupKey,
  groupEngines,
  latestMemberId,
  memberToActivate,
  parseLlamaBuild,
  repoSlug,
  variantLabel,
} from './engine-groups'
import type { Engine } from './types'

function eng(over: Partial<Engine> & { id: string }): Engine {
  return {
    name: over.id,
    binPath: '',
    version: '',
    capabilities: { kvTypes: [], flags: [] },
    ...over,
  }
}

// Use a POSIX-style and a Windows-style path to confirm both separators parse.
const llamaCuda9608 = eng({ id: 'a', binPath: '/root/.turbollm/engines/llama.cpp-b9608-cuda/llama-server' })
const llamaCuda9736 = eng({ id: 'b', binPath: 'C:\\Users\\x\\.turbollm\\engines\\llama.cpp-b9736-cuda\\llama-server.exe' })
const turboquant = eng({ id: 'c', binPath: '/root/.turbollm/engines/turboquant/llama-server', version: 'tq1' })
const mlx = eng({ id: 'd', kind: 'mlx', binPath: '/usr/bin/mlx_lm.server' })
const userFork = eng({ id: 'e', name: 'My Fork', binPath: '/opt/ik_llama/server', kind: 'llama-server' })

test('engineGroupKey groups official llama.cpp per backend; same backend collapses across tags', () => {
  // Each backend is its own engine; multiple builds of the SAME backend still collapse.
  assert.equal(engineGroupKey(llamaCuda9608), 'official-llama-cuda')
  assert.equal(engineGroupKey(llamaCuda9736), 'official-llama-cuda')
  // A different backend gets a distinct key (its own dropdown entry).
  const llamaRocm = eng({ id: 'r', binPath: '/root/.turbollm/engines/llama.cpp-b9736-rocm/llama-server' })
  assert.equal(engineGroupKey(llamaRocm), 'official-llama-rocm')
  assert.notEqual(engineGroupKey(llamaCuda9608), engineGroupKey(llamaRocm))
})

test('engineGroupKey maps pip engines to their kind', () => {
  assert.equal(engineGroupKey(mlx), 'mlx')
  assert.equal(engineGroupKey(eng({ id: 'v', kind: 'vllm' })), 'vllm')
  assert.equal(engineGroupKey(eng({ id: 'k', kind: 'koboldcpp' })), 'koboldcpp')
  assert.equal(engineGroupKey(eng({ id: 'rm', kind: 'rapid-mlx' })), 'rapid-mlx')
  assert.equal(engineGroupKey(eng({ id: 'mv', kind: 'mlx-vlm' })), 'mlx-vlm')
})

test('engineGroupKey detects TurboQuant by path', () => {
  assert.equal(engineGroupKey(turboquant), 'turboquant')
})

test('engineGroupKey detects a self-service ("Add via git repo") TurboQuant build by sourceRepo, not just path', () => {
  // Real shape from ADR-186's git-build flow: engines/build/<repo-name>/build/bin/…, which the
  // binPath-only regex never matches (that only recognizes the auto-download layout).
  const gitBuiltTurboQuant = eng({
    id: 'tq2',
    name: 'TurboQuant',
    binPath: 'C:\\Users\\x\\.turbollm\\engines\\build\\atomic-llama-cpp-turboquant\\build\\bin\\llama-server.exe',
    sourceRepo: 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant',
  })
  assert.equal(engineGroupKey(gitBuiltTurboQuant), 'turboquant')
  // Both install paths collapse into the SAME group so a rebuild doesn't spawn a second row.
  assert.equal(engineGroupKey(gitBuiltTurboQuant), engineGroupKey(turboquant))
})

test('repoSlug normalizes full URL, .git suffix, and bare owner/repo the same way', () => {
  assert.equal(repoSlug('https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant'), 'atomicbot-ai/atomic-llama-cpp-turboquant')
  assert.equal(repoSlug('https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant.git'), 'atomicbot-ai/atomic-llama-cpp-turboquant')
  assert.equal(repoSlug('AtomicBot-ai/atomic-llama-cpp-turboquant'), 'atomicbot-ai/atomic-llama-cpp-turboquant')
  assert.equal(repoSlug(undefined), undefined)
})

test('engineGroupKey gives user-added engines a distinct, unmerged key', () => {
  assert.equal(engineGroupKey(userFork), 'user:e')
  assert.notEqual(engineGroupKey(userFork), engineGroupKey(eng({ id: 'f', binPath: '/opt/other/server' })))
})

test('parseLlamaBuild extracts tag + backend from both separators', () => {
  assert.deepEqual(parseLlamaBuild(llamaCuda9608.binPath), { tag: 'b9608', backend: 'cuda' })
  assert.deepEqual(parseLlamaBuild(llamaCuda9736.binPath), { tag: 'b9736', backend: 'cuda' })
})

test('parseLlamaBuild returns null for non-official layouts', () => {
  assert.equal(parseLlamaBuild(turboquant.binPath), null)
  assert.equal(parseLlamaBuild(userFork.binPath), null)
})

test('variantLabel formats official builds as "<tag> · <BACKEND>"', () => {
  assert.equal(variantLabel(llamaCuda9736), 'b9736 · CUDA')
})

test('variantLabel falls back to version then name for non-official engines', () => {
  assert.equal(variantLabel(turboquant), 'tq1')
  assert.equal(variantLabel(userFork), 'My Fork')
})

test('latestMemberId picks the highest llama.cpp build number', () => {
  assert.equal(latestMemberId([llamaCuda9608, llamaCuda9736]), 'b')
  assert.equal(latestMemberId([llamaCuda9736, llamaCuda9608]), 'b')
})

test('latestMemberId is null when no tags parse', () => {
  assert.equal(latestMemberId([turboquant, mlx]), null)
})

test('groupEngines collapses two same-backend llama builds into one group, others stay separate', () => {
  const groups = groupEngines([llamaCuda9608, llamaCuda9736, turboquant, mlx])
  const official = groups.find((g) => g.key === 'official-llama-cuda')
  assert.ok(official)
  assert.equal(official!.members.length, 2)
  assert.equal(official!.label, 'llama.cpp (CUDA)')
  assert.equal(official!.latestId, 'b')
  assert.equal(groups.length, 3)
})

test('memberToActivate prefers the active member, then latest, then first', () => {
  const groups = groupEngines([llamaCuda9608, llamaCuda9736])
  const g = groups[0]
  assert.equal(memberToActivate(g, 'a')?.id, 'a') // active member kept
  assert.equal(memberToActivate(g, null)?.id, 'b') // none active → latest
  const noTags = groupEngines([turboquant, mlx]).find((x) => x.key === 'turboquant')!
  assert.equal(memberToActivate(noTags, null)?.id, 'c') // no latest → first
})

// customSourceKey MUST mirror the backend's registry.ts version exactly — it's used to match a
// "Forget" request against the same record the backend keyed it under (GitHub: custom-engine
// parity for disable/enable/rebuild).

test('customSourceKey: matches the backend registry.ts test vectors byte-for-byte', () => {
  const a = { binPath: '/build/a/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' }
  const b = { binPath: '/build/b/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' }
  assert.equal(customSourceKey(a), customSourceKey(b)) // rebuild → different binPath, same key
  const forms = [
    { binPath: 'x', sourceRepo: 'https://github.com/User/Fork', sourceBranch: '' },
    { binPath: 'x', sourceRepo: 'https://github.com/user/fork.git', sourceBranch: '' },
    { binPath: 'x', sourceRepo: 'https://github.com/user/fork/', sourceBranch: '' },
  ]
  assert.ok(forms.every((f) => customSourceKey(f) === customSourceKey(forms[0])))
  assert.notEqual(
    customSourceKey({ binPath: 'x', sourceRepo: 'r', sourceBranch: 'main' }),
    customSourceKey({ binPath: 'x', sourceRepo: 'r', sourceBranch: 'main', sourceCommit: 'abc' }),
  )
  assert.equal(customSourceKey({ binPath: '/opt/my-server' }), '/opt/my-server')
})

test('customSourceIsLive: true when a live engine shares the same identity, false otherwise', () => {
  const source = { name: 'My Fork', binPath: '/build/v1/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main', addedAt: '', binPathExists: true }
  const liveSameRepo = eng({ id: 'live', binPath: '/build/v2/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' })
  assert.equal(customSourceIsLive(source, [liveSameRepo]), true)
  assert.equal(customSourceIsLive(source, [userFork]), false)
  assert.equal(customSourceIsLive(source, []), false)
})

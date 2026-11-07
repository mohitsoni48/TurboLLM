import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANDROID_CPU_SERVER_NAME,
  BUNDLED_ENGINE_TITLES,
  SDK_ENGINE_TITLES,
  isSdkLitertRow,
  isSdkRow,
  readsOnlyLitert,
  bundledTitles,
  engineLabel,
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
  assert.equal(engineGroupKey(eng({ id: 'ly', kind: 'laya' })), 'laya')
})

test('groupLabel reads Laya engines as "Laya", same as any other pip engine group', () => {
  const laya = eng({ id: 'ly', kind: 'laya' })
  const groups = groupEngines([laya])
  assert.equal(groups[0].label, 'Laya')
})

// The Android app's own engines are user-added groups, whose label was the registered name: the selector read
// "litert-lm-android", and the selector is where an engine is picked.
test('groupLabel reads the Android app\'s own engines by name, not by their registered names', () => {
  const groups = groupEngines([
    eng({ id: 'a1', name: 'llama-server-android', kind: 'llama-server', binPath: '/data/app/lib/arm64/libllama_server.so' }),
    eng({ id: 'a2', name: 'llama-server-android-vulkan', kind: 'llama-server', binPath: '/data/app/lib/arm64/libllama_server_vk.so' }),
    eng({ id: 'a3', name: 'litert-lm-android', kind: 'litert-lm', binPath: '/data/app/lib/arm64/liblitertlm_server.so' }),
  ])
  // ADR-462: the spawned servers are named as servers, so none shares a label with an in-app SDK engine.
  assert.deepEqual(groups.map((g) => g.label), ['llama.cpp server (CPU)', 'llama.cpp server (Vulkan GPU)', 'LiteRT-LM server'])
  // Any other user-added engine still reads as its own name.
  assert.equal(groupEngines([userFork])[0].label, 'My Fork')
})

test('BUNDLED_ENGINE_TITLES knows only the Android app\'s engines, not names Object.prototype holds', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(BUNDLED_ENGINE_TITLES[name], undefined, name)
  }
  assert.equal(BUNDLED_ENGINE_TITLES['litert-lm-android']?.label, 'LiteRT-LM server')
})

const sdkRow = (id: string, sdkId: string, name: string) =>
  eng({ id, name, kind: 'turbollm-sdk', sdkEngine: { id: sdkId, kind: sdkId, formats: [], backends: ['cpu'] } })
const sdkLitert = sdkRow('s1', 'litert-lm', 'LiteRT-LM')
const sdkLlama = sdkRow('s2', 'llama.cpp-cpu', 'llama.cpp (CPU)')
const serverAndroid = eng({ id: 'a1', name: 'llama-server-android', kind: 'llama-server', binPath: '/data/app/lib/arm64/libllama_server.so' })

// Q-1 (stage-6 review): "is this the LiteRT-LM row" is asked two ways, and each has one helper. By format
// (readsOnlyLitert) for what loads on it, by identity (isSdkLitertRow) for which card it is. A second LiteRT SDK row
// (a future NPU one) reads like LiteRT-LM but is not the LiteRT-LM row.
const npuRow = eng({
  id: 's3', name: 'LiteRT-LM (NPU)', kind: 'turbollm-sdk', formats: ['litertlm'],
  sdkEngine: { id: 'litert-npu', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu'] },
})

test('Q-1: the LiteRT-LM predicates, by format and by identity', () => {
  const table: [string, Engine, { sdk: boolean; litertRow: boolean; readsOnlyLitert: boolean }][] = [
    ['SDK LiteRT-LM', { ...sdkLitert, formats: ['litertlm'] }, { sdk: true, litertRow: true, readsOnlyLitert: true }],
    ['hypothetical SDK NPU row', npuRow, { sdk: true, litertRow: false, readsOnlyLitert: true }],
    ['SDK llama.cpp', { ...sdkLlama, formats: ['gguf'] }, { sdk: true, litertRow: false, readsOnlyLitert: false }],
    ['M1 legacy SDK row', eng({ id: 'm1', kind: 'turbollm-sdk', formats: ['gguf', 'litertlm'] }), { sdk: true, litertRow: false, readsOnlyLitert: false }],
    ['desktop LiteRT-LM', eng({ id: 'd', kind: 'litert-lm', formats: ['litertlm'] }), { sdk: false, litertRow: false, readsOnlyLitert: true }],
    ['llama-server', eng({ id: 'l', kind: 'llama-server', formats: ['gguf'] }), { sdk: false, litertRow: false, readsOnlyLitert: false }],
  ]
  for (const [label, e, expected] of table) {
    assert.deepEqual(
      { sdk: isSdkRow(e), litertRow: isSdkLitertRow(e), readsOnlyLitert: readsOnlyLitert(e.formats ?? []) },
      expected,
      label,
    )
  }
})

test('Q-16: the spawned CPU server\'s titles are keyed by its one named constant', () => {
  assert.equal(ANDROID_CPU_SERVER_NAME, 'llama-server-android')
  assert.equal(BUNDLED_ENGINE_TITLES[ANDROID_CPU_SERVER_NAME]?.label, 'llama.cpp server (CPU)')
})

test('W-1: the in-app SDK engines are titled by their SDK engine id', () => {
  assert.deepEqual(SDK_ENGINE_TITLES['litert-lm'], { title: 'LiteRT-LM', detail: 'CPU · GPU', label: 'LiteRT-LM' })
  assert.deepEqual(SDK_ENGINE_TITLES['llama.cpp-cpu'], { title: 'llama.cpp', detail: 'CPU', label: 'llama.cpp (CPU)' })
  assert.deepEqual(bundledTitles(sdkLitert), SDK_ENGINE_TITLES['litert-lm'])
  assert.deepEqual(bundledTitles(sdkLlama), SDK_ENGINE_TITLES['llama.cpp-cpu'])
})

test('W-1: an SDK engine this web build does not know reads as its row name', () => {
  const vulkan = sdkRow('s3', 'llama.cpp-vulkan', 'llama.cpp (Vulkan GPU)')
  assert.deepEqual(bundledTitles(vulkan), { title: 'llama.cpp (Vulkan GPU)', detail: '', label: 'llama.cpp (Vulkan GPU)' })
  assert.equal(engineLabel(vulkan), 'llama.cpp (Vulkan GPU)')
})

test('W-1: an SDK id or engine name that Object.prototype holds finds no title', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(SDK_ENGINE_TITLES[name], undefined, name)
    assert.equal(bundledTitles(eng({ id: 'x', name })), undefined, name)
    assert.equal(engineLabel(eng({ id: 'x', name })), name)
  }
})

test('W-1: the spawned Android servers are titled as servers', () => {
  assert.deepEqual(BUNDLED_ENGINE_TITLES['llama-server-android'], {
    title: 'llama.cpp server', detail: 'CPU · tools, images', label: 'llama.cpp server (CPU)',
  })
  assert.equal(BUNDLED_ENGINE_TITLES['llama-server-android-vulkan']?.label, 'llama.cpp server (Vulkan GPU)')
  assert.equal(BUNDLED_ENGINE_TITLES['litert-lm-android']?.label, 'LiteRT-LM server')
})

test('W-1: each SDK engine is its own group, keyed by its SDK id', () => {
  assert.equal(engineGroupKey(sdkLitert), 'sdk:litert-lm')
  assert.equal(engineGroupKey(sdkLlama), 'sdk:llama.cpp-cpu')
  const groups = groupEngines([sdkLitert, sdkLlama, serverAndroid])
  assert.deepEqual(groups.map((g) => g.label), ['LiteRT-LM', 'llama.cpp (CPU)', 'llama.cpp server (CPU)'])
})

test('W-1: engineLabel names one row: SDK, bundled, or its own name', () => {
  assert.equal(engineLabel(sdkLitert), 'LiteRT-LM')
  assert.equal(engineLabel(serverAndroid), 'llama.cpp server (CPU)')
  assert.equal(engineLabel(userFork), 'My Fork')
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

test('customSourceKey: a repo URL ending ".git/" keys like the daemon (slashes stripped before ".git")', () => {
  // Exact daemon output (registry.ts customSourceKey → build-runner.ts normRepoUrl) for this input;
  // the web used to strip ".git" first and produce "ikawrakow/ik_llama.cpp.git#main#", so "Forget"
  // on an engine built from such a URL silently matched nothing.
  assert.equal(
    customSourceKey({ binPath: 'x', sourceRepo: 'https://github.com/ikawrakow/ik_llama.cpp.git/', sourceBranch: 'main' }),
    'ikawrakow/ik_llama.cpp#main#',
  )
  assert.equal(
    customSourceKey({ binPath: 'x', sourceRepo: 'https://github.com/user/fork.git//', sourceBranch: '' }),
    customSourceKey({ binPath: 'x', sourceRepo: 'https://github.com/user/fork', sourceBranch: '' }),
  )
})

test('customSourceIsLive: true when a live engine shares the same identity, false otherwise', () => {
  const source = { name: 'My Fork', binPath: '/build/v1/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main', addedAt: '', binPathExists: true }
  const liveSameRepo = eng({ id: 'live', binPath: '/build/v2/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' })
  assert.equal(customSourceIsLive(source, [liveSameRepo]), true)
  assert.equal(customSourceIsLive(source, [userFork]), false)
  assert.equal(customSourceIsLive(source, []), false)
})

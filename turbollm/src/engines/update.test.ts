import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBuildTag,
  compareBuildTags,
  parsePipVersion,
  comparePipVersions,
  compareVersions,
  decideAutoUpdate,
  normalizeUpdatePolicy,
  resolveUpdateSource,
  tagFromManagedBinPath,
  tagFromVersionString,
  versionFromPipString,
  parseGitRepo,
  commitFromVersionString,
  computeUpdateStatus,
  UpdateChecker,
  type ResolvedSource,
} from './update'
import { GithubRateLimitError } from './download'
import { latestTagForInstalled } from './update'
import type { Engine } from '../config/config'
import { engineIsIdle } from './update-scheduler'
import type { Manager } from './manager'

// ─── build-tag comparison ────────────────────────────────────────────────────

test('parseBuildTag: parses b<number>, tolerates case/whitespace/leading v', () => {
  assert.equal(parseBuildTag('b9608'), 9608)
  assert.equal(parseBuildTag('B9761'), 9761)
  assert.equal(parseBuildTag('  b42 '), 42)
  assert.equal(parseBuildTag('vb1234'), 1234)
})

test('parseBuildTag: returns null for non-build-tag shapes', () => {
  assert.equal(parseBuildTag('1.2.3'), null)
  assert.equal(parseBuildTag('latest'), null)
  assert.equal(parseBuildTag('b'), null)
  assert.equal(parseBuildTag('bxyz'), null)
  assert.equal(parseBuildTag(''), null)
})

test('compareBuildTags: equal / newer / older', () => {
  assert.equal(compareBuildTags('b9608', 'b9608'), 'equal')
  assert.equal(compareBuildTags('b9608', 'b9761'), 'newer') // latest is ahead
  assert.equal(compareBuildTags('b9761', 'b9608'), 'older') // latest is behind
})

test('compareBuildTags: malformed on either side → unknown', () => {
  assert.equal(compareBuildTags('b9608', 'latest'), 'unknown')
  assert.equal(compareBuildTags('1.2.3', 'b9761'), 'unknown')
  assert.equal(compareBuildTags('', ''), 'unknown')
})

test('compareBuildTags: falls back to semver for non-build GitHub tags (KoboldCpp/llamafile)', () => {
  // KoboldCpp tags vX.Y.Z; llamafile tags X.Y.Z — neither is a b<number> build tag,
  // so the comparison falls back to semver ordering instead of returning unknown.
  assert.equal(compareBuildTags('v1.115.1', 'v1.115.2'), 'newer') // latest ahead
  assert.equal(compareBuildTags('v1.115.2', 'v1.115.1'), 'older')
  assert.equal(compareBuildTags('1.115.2', '1.115.2'), 'equal')
  assert.equal(compareBuildTags('0.10.2', '0.10.3'), 'newer')
  assert.equal(compareBuildTags('0.10.3', '0.10.3'), 'equal')
})

// ─── pip version comparison ──────────────────────────────────────────────────

test('parsePipVersion: leading dotted-integer release, ignores suffixes', () => {
  assert.deepEqual(parsePipVersion('0.11.2'), [0, 11, 2])
  assert.deepEqual(parsePipVersion('1.2.3rc1+cu124'), [1, 2, 3])
  assert.deepEqual(parsePipVersion('v2.0'), [2, 0])
  assert.equal(parsePipVersion('not-a-version'), null)
})

test('comparePipVersions: equal (incl. trailing-zero), newer, older', () => {
  assert.equal(comparePipVersions('0.11.0', '0.11'), 'equal')
  assert.equal(comparePipVersions('0.11.2', '0.12.0'), 'newer')
  assert.equal(comparePipVersions('0.31.2', '0.31.1'), 'older')
  assert.equal(comparePipVersions('1.0', '2.0'), 'newer')
})

test('comparePipVersions: unparseable side → unknown', () => {
  assert.equal(comparePipVersions('0.11.2', 'unknown'), 'unknown')
  assert.equal(comparePipVersions('weird', '0.1'), 'unknown')
})

test('compareVersions: routes by source', () => {
  assert.equal(compareVersions('github-release', 'b1', 'b2'), 'newer')
  assert.equal(compareVersions('pip', '0.1.0', '0.2.0'), 'newer')
  assert.equal(compareVersions('pip', '0.2.0', '0.1.0'), 'older')
})

// ─── decideAutoUpdate truth table ────────────────────────────────────────────

test('decideAutoUpdate: only auto && hasUpdate && idle applies', () => {
  // auto
  assert.equal(decideAutoUpdate({ policy: 'auto', hasUpdate: true, idle: true }), true)
  assert.equal(decideAutoUpdate({ policy: 'auto', hasUpdate: true, idle: false }), false) // busy waits
  assert.equal(decideAutoUpdate({ policy: 'auto', hasUpdate: false, idle: true }), false) // nothing to do
  // notify never applies
  assert.equal(decideAutoUpdate({ policy: 'notify', hasUpdate: true, idle: true }), false)
  assert.equal(decideAutoUpdate({ policy: 'notify', hasUpdate: true, idle: false }), false)
  // off never applies
  assert.equal(decideAutoUpdate({ policy: 'off', hasUpdate: true, idle: true }), false)
  assert.equal(decideAutoUpdate({ policy: 'off', hasUpdate: true, idle: false }), false)
})

test('normalizeUpdatePolicy: defaults to notify, preserves off/auto', () => {
  assert.equal(normalizeUpdatePolicy(undefined), 'notify')
  assert.equal(normalizeUpdatePolicy('garbage'), 'notify')
  assert.equal(normalizeUpdatePolicy('notify'), 'notify')
  assert.equal(normalizeUpdatePolicy('off'), 'off')
  assert.equal(normalizeUpdatePolicy('auto'), 'auto')
})

// ─── installed-version extraction ────────────────────────────────────────────

test('tagFromManagedBinPath: extracts the build tag from a tag-keyed dir', () => {
  assert.equal(
    tagFromManagedBinPath('/home/u/.turbollm/engines/llama.cpp-b9608-cuda/llama-server'),
    'b9608',
  )
  assert.equal(
    tagFromManagedBinPath('C:\\Users\\u\\.turbollm\\engines\\llama.cpp-b9761-vulkan\\llama-server.exe'),
    'b9761',
  )
  assert.equal(tagFromManagedBinPath('/some/user/path/llama-server'), '')
})

test('tagFromVersionString: pulls a b<number> tag out of a probe string', () => {
  assert.equal(tagFromVersionString('version: 1.2.3 (b9608)'), 'b9608')
  assert.equal(tagFromVersionString('llama-server build b9761 commit abc'), 'b9761')
  assert.equal(tagFromVersionString('no build tag here'), '')
})

test('versionFromPipString: strips the package label', () => {
  assert.equal(versionFromPipString('mlx-lm 0.31.2'), '0.31.2')
  assert.equal(versionFromPipString('vllm 0.11.2'), '0.11.2')
  assert.equal(versionFromPipString('0.9.0'), '0.9.0')
})

// ─── resolveUpdateSource ─────────────────────────────────────────────────────

function eng(partial: Partial<Engine>): Engine {
  return {
    id: 'e1',
    name: 'x',
    binPath: '/p/llama-server',
    kind: 'llama-server',
    version: '',
    capabilities: { kvTypes: [], flags: [] },
    addedAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

test('resolveUpdateSource: managed official llama.cpp → ggml-org repo + tag from path', () => {
  const src = resolveUpdateSource(
    eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server', version: 'version: b9608' }),
  )
  assert.deepEqual(src, { source: 'github-release', ref: 'ggml-org/llama.cpp', installed: 'b9608' })
})

test('resolveUpdateSource: turboquant fork → fork repo + tag from version', () => {
  const src = resolveUpdateSource(
    eng({ binPath: '/root/engines/turboquant/llama-server', version: 'build b9000' }),
  )
  assert.equal(src?.source, 'github-release')
  assert.equal(src?.ref, 'AtomicBot-ai/atomic-llama-cpp-turboquant')
  assert.equal(src?.installed, 'b9000')
})

test('resolveUpdateSource: mlx/vllm → PyPI package + stripped version', () => {
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'mlx', version: 'mlx-lm 0.31.2' })), {
    source: 'pip',
    ref: 'mlx-lm',
    installed: '0.31.2',
  })
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'vllm', version: 'vllm 0.11.2' })), {
    source: 'pip',
    ref: 'vllm',
    installed: '0.11.2',
  })
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'mlx-vlm', version: 'mlx-vlm 0.6.4' })), {
    source: 'pip',
    ref: 'mlx-vlm',
    installed: '0.6.4',
  })
})

test('resolveUpdateSource: koboldcpp/llamafile → GitHub repo + stored tag (Phase 4)', () => {
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'koboldcpp', version: 'v1.115.2' })), {
    source: 'github-release',
    ref: 'LostRuins/koboldcpp',
    installed: 'v1.115.2',
  })
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'llamafile', version: '0.10.3' })), {
    source: 'github-release',
    ref: 'Mozilla-Ocho/llamafile',
    installed: '0.10.3',
  })
})

test('computeUpdateStatus: koboldcpp semver update is detected end-to-end (Phase 4)', async () => {
  const e = eng({ kind: 'koboldcpp', version: 'v1.115.1' })
  const st = await computeUpdateStatus(e, async () => 'v1.115.2')
  assert.equal(st.installed, 'v1.115.1')
  assert.equal(st.latest, 'v1.115.2')
  assert.equal(st.hasUpdate, true)
  assert.equal(st.comparable, true)
})

test('resolveUpdateSource: user-added arbitrary binary → null (no honest source)', () => {
  assert.equal(resolveUpdateSource(eng({ binPath: '/opt/my/llama-server', version: 'b9608' })), null)
})

// ─── computeUpdateStatus: no false latest on error ───────────────────────────

test('computeUpdateStatus: hasUpdate true when latest is newer', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => 'b9761')
  assert.equal(st.installed, 'b9608')
  assert.equal(st.latest, 'b9761')
  assert.equal(st.hasUpdate, true)
  assert.equal(st.comparable, true)
  assert.equal(st.error, undefined)
})

test('computeUpdateStatus: up to date → hasUpdate false', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9761-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => 'b9761')
  assert.equal(st.hasUpdate, false)
  assert.equal(st.latest, 'b9761')
  assert.equal(st.comparable, true)
})

test('computeUpdateStatus: network failure NEVER fabricates a latest', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  })
  assert.equal(st.latest, null)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.error, 'offline')
  assert.ok(st.checkedAt) // timestamp always present
})

test('computeUpdateStatus: a b-tag install compares against the newest BUILD tag, not releases/latest', async () => {
  // Regression: llama.cpp tags every build `b#####` but also cuts semver releases (`v0.4.0`),
  // and GitHub marks the semver one as "latest". Comparing b10455 against v0.4.0 is
  // incomparable, so the engine reported "update status unavailable" forever despite being
  // hundreds of builds behind. The fetcher below mimics the real resolver's choice.
  const e = eng({ binPath: '/root/engines/llama.cpp-b10455-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async (src) => {
    assert.equal(src.installed, 'b10455')
    return 'b10818'
  })
  assert.equal(st.latest, 'b10818')
  assert.equal(st.hasUpdate, true)
  assert.equal(st.comparable, true)
})

test('computeUpdateStatus: a semver-tagged engine is unaffected by the build-tag path', async () => {
  const e = eng({ kind: 'koboldcpp', version: '1.99.2' })
  const st = await computeUpdateStatus(e, async () => '1.99.3')
  assert.equal(st.latest, '1.99.3')
  assert.equal(st.hasUpdate, true)
})

test('computeUpdateStatus: an exhausted GitHub quota reports rate_limited, NOT offline', async () => {
  // Regression: a spent rate limit used to surface as 'offline', which told the user their
  // machine had no network when it was online and the real fix was to add a GitHub token.
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => {
    throw new GithubRateLimitError('ggml-org/llama.cpp')
  })
  assert.equal(st.error, 'rate_limited')
  assert.equal(st.latest, null)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.comparable, false)
})

test('computeUpdateStatus: a non-rate-limit failure still reports offline', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => {
    throw new Error('socket hang up')
  })
  assert.equal(st.error, 'offline')
})

test('computeUpdateStatus: empty latest treated as offline (no false up-to-date)', async () => {
  const e = eng({ kind: 'vllm', version: 'vllm 0.11.2' })
  const st = await computeUpdateStatus(e, async () => '')
  assert.equal(st.latest, null)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.error, 'offline')
})

test('computeUpdateStatus: unparseable latest → comparable false, not hasUpdate', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => 'mystery-tag')
  assert.equal(st.latest, 'mystery-tag')
  assert.equal(st.hasUpdate, false)
  assert.equal(st.comparable, false)
})

test('computeUpdateStatus: no source → no_source error, no false latest', async () => {
  const e = eng({ binPath: '/opt/my/llama-server', version: 'b9608' })
  const st = await computeUpdateStatus(e, async () => 'b9999')
  assert.equal(st.latest, null)
  assert.equal(st.error, 'no_source')
  assert.equal(st.hasUpdate, false)
})

// ─── UpdateChecker cache: keeps last good answer over a later offline ─────────

test('UpdateChecker: an offline re-check keeps the prior successful status', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  let mode: 'ok' | 'fail' = 'ok'
  const checker = new UpdateChecker(async () => {
    if (mode === 'fail') throw new Error('offline')
    return 'b9761'
  })
  const first = await checker.check(e)
  assert.equal(first.latest, 'b9761')
  assert.equal(first.hasUpdate, true)

  mode = 'fail'
  const second = await checker.check(e)
  // Keeps the last real answer rather than flapping to "couldn't check".
  assert.equal(second.latest, 'b9761')
  assert.equal(second.hasUpdate, true)
  assert.equal(checker.get(e.id)?.latest, 'b9761')
})

test('UpdateChecker: offline with no prior success caches the offline state', async () => {
  const e = eng({ kind: 'mlx', version: 'mlx-lm 0.31.2' })
  const checker = new UpdateChecker(async () => {
    throw new Error('offline')
  })
  const st = await checker.check(e)
  assert.equal(st.error, 'offline')
  assert.equal(st.latest, null)
})

// ─── scheduler idle gate (auto-apply only when not generating) ───────────────

/** Minimal Manager stub exposing only the surface engineIsIdle reads. */
function managerStub(state: string, activeRequests = 0): Manager {
  return {
    status: () => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    sessionStats: () => ({
      requests: 0, inputTokens: 0, outputTokens: 0, avgPromptTps: 0, avgGenTps: 0, sinceMs: 0, activeRequests,
    }),
  } as unknown as Manager
}

test('engineIsIdle: stopped/running-idle are idle; starting/stopping/generating are not', () => {
  assert.equal(engineIsIdle(managerStub('stopped')), true)
  assert.equal(engineIsIdle(managerStub('error')), true)
  assert.equal(engineIsIdle(managerStub('running', 0)), true)
  assert.equal(engineIsIdle(managerStub('running', 2)), false) // mid-generation
  assert.equal(engineIsIdle(managerStub('starting')), false)
  assert.equal(engineIsIdle(managerStub('stopping')), false)
})

// ─── source-built engines (ADR-088): commit-hash update detection ─────────────

test('parseGitRepo: https / .git / trailing-slash variants → owner/repo', () => {
  assert.equal(parseGitRepo('https://github.com/owner/repo'), 'owner/repo')
  assert.equal(parseGitRepo('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseGitRepo('https://github.com/owner/repo/'), 'owner/repo')
  assert.equal(parseGitRepo('http://github.com/owner/repo'), 'owner/repo')
  assert.equal(parseGitRepo('https://www.github.com/owner/repo'), 'owner/repo')
  assert.equal(parseGitRepo('github.com/owner/repo'), 'owner/repo')
  assert.equal(parseGitRepo('  https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant  '), 'AtomicBot-ai/atomic-llama-cpp-turboquant')
})

test('parseGitRepo: non-GitHub or malformed → null', () => {
  assert.equal(parseGitRepo('https://gitlab.com/owner/repo'), null)
  assert.equal(parseGitRepo('https://github.com/owner'), null) // no repo
  assert.equal(parseGitRepo('not a url'), null)
  assert.equal(parseGitRepo(''), null)
})

test('commitFromVersionString: pulls the first 7+ hex token, else empty', () => {
  assert.equal(commitFromVersionString('1 (0a635dc)'), '0a635dc')
  assert.equal(commitFromVersionString('version: x (abcdef1234)'), 'abcdef1234')
  assert.equal(commitFromVersionString('b9608'), '') // numeric build tag (too short / no commit)
  assert.equal(commitFromVersionString(''), '')
  assert.equal(commitFromVersionString('no hash here just words'), '')
})

test('resolveUpdateSource: sourceRepo takes precedence → source mode with branch + commit', () => {
  const src = resolveUpdateSource(
    eng({
      kind: 'llama-server',
      binPath: '/opt/my/llama-server',
      version: 'build (0a635dc)',
      sourceRepo: 'https://github.com/owner/repo.git',
      sourceBranch: 'main',
    }),
  )
  assert.deepEqual(src, { source: 'source', ref: 'owner/repo', branch: 'main', installed: '0a635dc' })
})

test('resolveUpdateSource: sourceRepo with no branch → empty branch (default branch)', () => {
  const src = resolveUpdateSource(
    eng({ binPath: '/opt/my/llama-server', version: '1 (0a635dc)', sourceRepo: 'https://github.com/owner/repo' }),
  )
  assert.equal(src?.source, 'source')
  assert.equal(src?.branch, '')
  assert.equal(src?.installed, '0a635dc')
})

test('resolveUpdateSource: non-GitHub sourceRepo falls through to existing behavior', () => {
  // A turboquant fork engine with a non-parseable sourceRepo keeps the fork release source.
  const src = resolveUpdateSource(
    eng({ binPath: '/root/engines/turboquant/llama-server', version: 'build b9000', sourceRepo: 'not-a-repo' }),
  )
  assert.equal(src?.source, 'github-release')
  assert.equal(src?.ref, 'AtomicBot-ai/atomic-llama-cpp-turboquant')
})

test('computeUpdateStatus: source mode — different sha → hasUpdate + rebuild', async () => {
  const e = eng({ binPath: '/opt/my/llama-server', version: 'build (0a635dc)', sourceRepo: 'https://github.com/owner/repo' })
  const st = await computeUpdateStatus(e, async () => '9f8e7d6c5b4a392817')
  assert.equal(st.installed, '0a635dc')
  assert.equal(st.latest, '9f8e7d6') // 7-char short sha
  assert.equal(st.hasUpdate, true)
  assert.equal(st.rebuild, true)
  assert.equal(st.comparable, true)
  assert.equal(st.error, undefined)
})

test('computeUpdateStatus: source mode — same short sha → up to date', async () => {
  const e = eng({ binPath: '/opt/my/llama-server', version: '1 (0a635dc)', sourceRepo: 'https://github.com/owner/repo' })
  const st = await computeUpdateStatus(e, async () => '0a635dcffffffff')
  assert.equal(st.hasUpdate, false)
  assert.equal(st.rebuild, true)
  assert.equal(st.comparable, true)
  assert.equal(st.latest, '0a635dc')
})

test('computeUpdateStatus: source mode — empty installed commit → no_source', async () => {
  // version carries only a numeric build tag → no commit hash to compare.
  const e = eng({ binPath: '/opt/my/llama-server', version: 'b9608', sourceRepo: 'https://github.com/owner/repo' })
  const st = await computeUpdateStatus(e, async () => '9f8e7d6c5b4a')
  assert.equal(st.installed, '')
  assert.equal(st.hasUpdate, false)
  assert.equal(st.error, 'no_source')
  assert.equal(st.comparable, false)
})

test('computeUpdateStatus: source mode — fetch throw → offline, no fabricated latest', async () => {
  const e = eng({ binPath: '/opt/my/llama-server', version: '1 (0a635dc)', sourceRepo: 'https://github.com/owner/repo' })
  const st = await computeUpdateStatus(e, async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  })
  assert.equal(st.latest, null)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.error, 'offline')
})

test('UpdateChecker.checkAll + prune', async () => {
  const a = eng({ id: 'a', kind: 'mlx', version: 'mlx-lm 0.1.0' })
  const b = eng({ id: 'b', kind: 'vllm', version: 'vllm 0.1.0' })
  const checker = new UpdateChecker(async (src: ResolvedSource) => (src.ref === 'mlx-lm' ? '0.2.0' : '0.1.0'))
  const all = await checker.checkAll([a, b])
  assert.equal(all.a.hasUpdate, true)
  assert.equal(all.b.hasUpdate, false)
  checker.prune(new Set(['a']))
  assert.equal(checker.get('a') !== undefined, true)
  assert.equal(checker.get('b'), undefined)
})


// ─── latestTagForInstalled: one resolver for BOTH check and apply ─────────────
// Regression: the check learned about build tags while the applier still asked for
// `releases/latest`, so the UI offered b10455 -> b10818 and the download then 404'd
// against v0.4.0 (a semver release that publishes no per-backend assets).

test('latestTagForInstalled: a b-tag install resolves the newest BUILD tag', async () => {
  const calls: string[] = []
  global.fetch = (async (url: string) => {
    calls.push(String(url))
    if (String(url).includes('/releases?')) {
      // Deliberately NOT in build-number order — releases come back newest-by-date.
      return new Response(JSON.stringify([
        { tag_name: 'v0.4.0' }, { tag_name: 'b10818' }, { tag_name: 'b10817' }, { tag_name: 'b9999' },
      ]), { status: 200 })
    }
    return new Response(JSON.stringify({ tag_name: 'v0.4.0' }), { status: 200 })
  }) as unknown as typeof fetch
  const tag = await latestTagForInstalled('ggml-org/llama.cpp', 'b10455')
  assert.equal(tag, 'b10818')
  assert.ok(calls.some((u) => u.includes('/releases?')), 'must list releases, not releases/latest')
})

test('latestTagForInstalled: a semver install still uses releases/latest', async () => {
  global.fetch = (async () =>
    new Response(JSON.stringify({ tag_name: '1.99.3' }), { status: 200 })) as unknown as typeof fetch
  assert.equal(await latestTagForInstalled('LostRuins/koboldcpp', '1.99.2'), '1.99.3')
})

test('latestTagForInstalled: falls back to releases/latest when no build tag exists', async () => {
  global.fetch = (async (url: string) => {
    if (String(url).includes('/releases?')) return new Response(JSON.stringify([{ tag_name: 'v1.0.0' }]), { status: 200 })
    return new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 })
  }) as unknown as typeof fetch
  assert.equal(await latestTagForInstalled('some/repo', 'b1'), 'v1.0.0')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GithubRateLimitError } from './download'
import {
  assetKey,
  newestMatchingRelease,
  ReleaseNotFoundError,
  releaseByTag,
  resolveInstallableRelease,
  type HostProfile,
} from './release-assets'
import type { ReleaseProvenance } from './release-install'

const WIN_HOST: HostProfile = {
  platform: 'win32',
  arch: 'x64',
  gpuVendor: 'unknown',
  hasGpu: false,
  amdApuOnly: false,
  driverMaxCuda: null,
}

interface FakeReply {
  status: number
  json?: unknown
  headers?: Record<string, string>
}

interface FakeGithub {
  fetchImpl: typeof fetch
  calls: { url: string; headers: Headers }[]
}

function fakeGithub(replies: Record<string, FakeReply>): FakeGithub {
  const calls: FakeGithub['calls'] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    const reply = replies[url]
    if (!reply) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status, headers: reply.headers })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const API = 'https://api.github.com/repos/o/r'

function release(tag: string, names: string[], extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    published_at: '2026-09-01T00:00:00Z',
    prerelease: false,
    draft: false,
    ...extra,
    assets: names.map((name) => ({ name, browser_download_url: `https://cdn.example/${tag}/${name}`, size: 10 })),
  }
}

const WIN_CPU = 'llama-bin-win-cpu-x64.zip'
const LINUX_CPU = 'llama-bin-ubuntu-x64.tar.gz'

test('resolveInstallableRelease: releases/latest with a compatible asset is returned in one call', async () => {
  const gh = fakeGithub({ [`${API}/releases/latest`]: { status: 200, json: release('b1', [WIN_CPU]) } })
  const resolved = await resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl)
  assert.equal(resolved.tag, 'b1')
  assert.equal(resolved.fellBack, false)
  assert.equal(resolved.assets[0]!.size, 10)
  assert.equal(gh.calls.length, 1)
})

test('resolveInstallableRelease: a 404 on latest walks the release list, skipping drafts', async () => {
  const gh = fakeGithub({
    [`${API}/releases/latest`]: { status: 404 },
    [`${API}/releases?per_page=30`]: {
      status: 200,
      json: [
        release('draft', [WIN_CPU], { draft: true }),
        release('pre', [WIN_CPU], { prerelease: true }),
        release('old', [WIN_CPU]),
      ],
    },
  })
  const resolved = await resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl)
  assert.equal(resolved.tag, 'pre')
  assert.equal(resolved.prerelease, true)
  assert.equal(resolved.fellBack, true)
  assert.equal(gh.calls.length, 2)
})

test('resolveInstallableRelease: a latest release with no compatible asset falls back to the walk', async () => {
  const gh = fakeGithub({
    [`${API}/releases/latest`]: { status: 200, json: release('mac-only', ['llama-bin-macos-arm64.tar.gz']) },
    [`${API}/releases?per_page=30`]: {
      status: 200,
      json: [release('mac-only', ['llama-bin-macos-arm64.tar.gz']), release('win-one', [WIN_CPU])],
    },
  })
  const resolved = await resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl)
  assert.equal(resolved.tag, 'win-one')
  assert.equal(resolved.fellBack, true)
})

test('resolveInstallableRelease: 404 on latest and on the list is repo_not_found', async () => {
  const gh = fakeGithub({})
  await assert.rejects(
    resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl),
    (e: unknown) => e instanceof ReleaseNotFoundError && e.code === 'repo_not_found',
  )
})

test('resolveInstallableRelease: an empty release list is no_releases', async () => {
  const gh = fakeGithub({ [`${API}/releases?per_page=30`]: { status: 200, json: [] } })
  await assert.rejects(
    resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl),
    (e: unknown) => e instanceof ReleaseNotFoundError && e.code === 'no_releases',
  )
})

test('resolveInstallableRelease: nothing compatible anywhere is no_compatible_asset', async () => {
  const gh = fakeGithub({
    [`${API}/releases/latest`]: { status: 200, json: release('b1', [LINUX_CPU]) },
    [`${API}/releases?per_page=30`]: { status: 200, json: [release('b1', [LINUX_CPU])] },
  })
  await assert.rejects(
    resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl),
    (e: unknown) =>
      e instanceof ReleaseNotFoundError &&
      e.code === 'no_compatible_asset' &&
      e.assets.map((a) => a.name).join() === LINUX_CPU,
  )
})

test('resolveInstallableRelease: 403 with an exhausted quota is a GithubRateLimitError', async () => {
  const gh = fakeGithub({
    [`${API}/releases/latest`]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
  })
  await assert.rejects(resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl), GithubRateLimitError)
})

test('resolveInstallableRelease: a 403 without the quota header is a plain Error', async () => {
  const gh = fakeGithub({ [`${API}/releases/latest`]: { status: 403 } })
  await assert.rejects(
    resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl),
    (e: unknown) => e instanceof Error && !(e instanceof GithubRateLimitError) && !(e instanceof ReleaseNotFoundError),
  )
})

test('releaseByTag: URL-encodes the tag and returns the release facts', async () => {
  const gh = fakeGithub({
    [`${API}/releases/tags/prism-b10770-6684606`]: { status: 200, json: release('prism-b10770-6684606', [WIN_CPU]) },
    [`${API}/releases/tags/feature%2Fx`]: { status: 200, json: release('feature/x', [WIN_CPU]) },
  })
  const plain = await releaseByTag('o/r', 'prism-b10770-6684606', undefined, gh.fetchImpl)
  assert.equal(plain.publishedAt, '2026-09-01T00:00:00Z')
  assert.equal(plain.repo, 'o/r')
  const slashed = await releaseByTag('o/r', 'feature/x', undefined, gh.fetchImpl)
  assert.equal(slashed.tag, 'feature/x')
})

const KEY = 'llama-bin-win-cuda-13.3-x64.zip'
const T0 = '2026-09-01T00:00:00Z'
const INSTALLED: ReleaseProvenance = {
  repo: 'o/r',
  tag: 'b100',
  asset: 'llama-b100-bin-win-cuda-13.3-x64.zip',
  assetKey: KEY,
  publishedAt: T0,
  prerelease: false,
  companions: [],
}

function listing(...releases: unknown[]) {
  return fakeGithub({ [`${API}/releases?per_page=30`]: { status: 200, json: releases } })
}

test('newestMatchingRelease: picks the newest stable release carrying the asset key', async () => {
  const gh = listing(
    release('b300', ['llama-b300-bin-win-cuda-13.3-x64.zip'], { prerelease: true, published_at: '2026-09-04T00:00:00Z' }),
    release('b250', ['llama-b250-bin-win-cuda-13.3-x64.zip'], { draft: true, published_at: '2026-09-03T00:00:00Z' }),
    release('b200', ['llama-b200-bin-win-cuda-13.3-x64.zip'], { published_at: '2026-09-02T00:00:00Z' }),
    release('b50', ['llama-b50-bin-win-cuda-13.3-x64.zip'], { published_at: '2026-08-01T00:00:00Z' }),
  )
  const found = await newestMatchingRelease(INSTALLED, undefined, gh.fetchImpl)
  assert.deepEqual(found, {
    tag: 'b200',
    asset: 'llama-b200-bin-win-cuda-13.3-x64.zip',
    publishedAt: '2026-09-02T00:00:00Z',
  })
  assert.equal(gh.calls.length, 1)
})

test('newestMatchingRelease: allows prereleases when the install came from one', async () => {
  const gh = listing(
    release('b300', ['llama-b300-bin-win-cuda-13.3-x64.zip'], { prerelease: true, published_at: '2026-09-04T00:00:00Z' }),
  )
  const found = await newestMatchingRelease({ ...INSTALLED, prerelease: true }, undefined, gh.fetchImpl)
  assert.equal(found?.tag, 'b300')
})

test('newestMatchingRelease: null when no release at or after the install has the key', async () => {
  const gh = listing(
    release('b50', ['llama-b50-bin-win-cuda-13.3-x64.zip'], { published_at: '2026-08-01T00:00:00Z' }),
    release('b200', ['llama-b200-bin-win-vulkan-x64.zip'], { published_at: '2026-09-02T00:00:00Z', }),
    release('b210', ['llama-b210-bin-win-cpu-x64.zip', 'llama-b210-bin-win-hip-x64.zip'], {
      published_at: '2026-09-03T00:00:00Z',
    }),
  )
  assert.equal(await newestMatchingRelease(INSTALLED, undefined, gh.fetchImpl), null)
})

test('newestMatchingRelease: falls back to an identical classification when exactly one asset qualifies', async () => {
  const gh = listing(
    release('b200', ['llama-renamed-b200-win-x64-cuda-13.3.zip', 'llama-b200-bin-win-cpu-x64.zip'], {
      published_at: '2026-09-02T00:00:00Z',
    }),
    // GitHub's listing still carries the installed release, whose own asset matches the recorded key.
    release('b100', ['llama-b100-bin-win-cuda-13.3-x64.zip'], { published_at: T0 }),
  )
  const found = await newestMatchingRelease(INSTALLED, undefined, gh.fetchImpl)
  assert.equal(found?.tag, 'b200')
  assert.equal(found?.asset, 'llama-renamed-b200-win-x64-cuda-13.3.zip')
})

test('newestMatchingRelease: a newer release that renamed hip-radeon to rocm wins over the listed installed release', async () => {
  const gh = listing(
    release('b200', ['llama-b200-bin-win-rocm-7.1-x64.zip', 'llama-b200-bin-win-cpu-x64.zip'], {
      published_at: '2026-09-02T00:00:00Z',
    }),
    release('b100', ['llama-b100-bin-win-hip-radeon-x64.zip'], { published_at: T0 }),
  )
  const installed = { ...INSTALLED, asset: 'llama-b100-bin-win-hip-radeon-x64.zip', assetKey: 'llama-bin-win-hip-radeon-x64.zip' }
  assert.equal((await newestMatchingRelease(installed, undefined, gh.fetchImpl))?.asset, 'llama-b200-bin-win-rocm-7.1-x64.zip')
})

test('newestMatchingRelease: an ambiguous newest release is skipped, not a stop; an older keyed one still wins', async () => {
  const gh = listing(
    release('b300', ['a-b300-win-x64-cuda-13.3.zip', 'b-b300-win-x64-cuda-13.3.zip'], {
      published_at: '2026-09-03T00:00:00Z',
    }),
    release('b200', ['llama-b200-bin-win-cuda-13.3-x64.zip'], { published_at: '2026-09-02T00:00:00Z' }),
    release('b100', ['llama-b100-bin-win-cuda-13.3-x64.zip'], { published_at: T0 }),
  )
  assert.equal((await newestMatchingRelease(INSTALLED, undefined, gh.fetchImpl))?.tag, 'b200')
})

test('newestMatchingRelease: with nothing newer matching, the installed release itself comes back (no update)', async () => {
  const gh = listing(
    release('b200', ['llama-b200-bin-win-vulkan-x64.zip'], { published_at: '2026-09-02T00:00:00Z' }),
    release('b100', ['llama-b100-bin-win-cuda-13.3-x64.zip'], { published_at: T0 }),
  )
  assert.equal((await newestMatchingRelease(INSTALLED, undefined, gh.fetchImpl))?.tag, 'b100')
})

test('newestMatchingRelease: a version-less asset name keys the same under every tag, so the next release is found', async () => {
  const names = ['tool-win-cuda-12.4-x64.zip', 'tool-extras-win-cuda-12.4-x64.zip']
  const gh = listing(release('v5', names, { published_at: '2026-09-02T00:00:00Z' }), release('v4', names, { published_at: T0 }))
  const installed: ReleaseProvenance = {
    ...INSTALLED,
    tag: 'v4',
    asset: 'tool-win-cuda-12.4-x64.zip',
    assetKey: assetKey('tool-win-cuda-12.4-x64.zip', 'v4'),
  }
  assert.deepEqual(await newestMatchingRelease(installed, undefined, gh.fetchImpl), {
    tag: 'v5',
    asset: 'tool-win-cuda-12.4-x64.zip',
    publishedAt: '2026-09-02T00:00:00Z',
  })
})

const INSTALLED_V2: ReleaseProvenance = {
  ...INSTALLED,
  tag: 'v2.0.0',
  asset: 'app-v2.0.0-win-x64.zip',
  assetKey: 'app-win-x64.zip',
}

test('newestMatchingRelease: a backport on an older version line published later is not an update', async () => {
  const gh = listing(
    release('v1.9.5', ['app-v1.9.5-win-x64.zip'], { published_at: '2026-09-03T00:00:00Z' }),
    release('v2.0.0', ['app-v2.0.0-win-x64.zip'], { published_at: T0 }),
  )
  assert.equal((await newestMatchingRelease(INSTALLED_V2, undefined, gh.fetchImpl))?.tag, 'v2.0.0')
})

test('newestMatchingRelease: a newer version is still found behind a later backport', async () => {
  const gh = listing(
    release('v1.9.5', ['app-v1.9.5-win-x64.zip'], { published_at: '2026-09-03T00:00:00Z' }),
    release('v2.0.1', ['app-v2.0.1-win-x64.zip'], { published_at: '2026-09-02T00:00:00Z' }),
    release('v2.0.0', ['app-v2.0.0-win-x64.zip'], { published_at: T0 }),
  )
  assert.equal((await newestMatchingRelease(INSTALLED_V2, undefined, gh.fetchImpl))?.tag, 'v2.0.1')
})

test('newestMatchingRelease: a tag with no version order keeps the publish-time rule', async () => {
  const gh = listing(
    release('nightly', ['app-nightly-win-x64.zip'], { published_at: '2026-09-02T00:00:00Z' }),
    release('v2.0.0', ['app-v2.0.0-win-x64.zip'], { published_at: T0 }),
  )
  assert.equal((await newestMatchingRelease(INSTALLED_V2, undefined, gh.fetchImpl))?.tag, 'nightly')
})

test('newestMatchingRelease: commit-SHA tags keep the publish-time rule, not an order read from their leading digits', async () => {
  for (const [installedTag, newerTag] of [
    ['9f1e2d3', '1a2b3c4'],
    ['88123ab', '5c0ffee'],
  ]) {
    const gh = listing(
      release(newerTag, [`app-${newerTag}-win-x64.zip`], { published_at: '2026-09-02T00:00:00Z' }),
      release(installedTag, [`app-${installedTag}-win-x64.zip`], { published_at: T0 }),
    )
    const installed = { ...INSTALLED_V2, tag: installedTag, asset: `app-${installedTag}-win-x64.zip` }
    assert.equal((await newestMatchingRelease(installed, undefined, gh.fetchImpl))?.tag, newerTag, installedTag)
  }
})

test('newestMatchingRelease: refuses the classification fallback when two assets qualify', async () => {
  const gh = listing(
    release('b200', ['a-b200-win-x64-cuda-13.3.zip', 'b-b200-win-x64-cuda-13.3.zip'], {
      published_at: '2026-09-02T00:00:00Z',
    }),
  )
  assert.equal(await newestMatchingRelease(INSTALLED, undefined, gh.fetchImpl), null)
})

test('every request goes to api.github.com and none carries an Authorization header off-host', async () => {
  const gh = fakeGithub({ [`${API}/releases/latest`]: { status: 200, json: release('b1', [WIN_CPU]) } })
  await resolveInstallableRelease('o/r', WIN_HOST, undefined, gh.fetchImpl)
  for (const call of gh.calls) {
    const host = new URL(call.url).host
    assert.ok(host === 'api.github.com' || !call.headers.has('authorization'), `${host} got credentials`)
  }
})

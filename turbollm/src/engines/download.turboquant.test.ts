// TurboQuant release resolution: variant choice per machine, and release/asset matching
// against the fork's real release layout (one release per version tagged b<build>-<semver>
// carrying every platform, preceded by per-platform releases until mid-2026).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  compareTurboquantReleaseTags,
  detectTurboquantHw,
  needsTurboquantReprovision,
  provisionTurboquant,
  resetTurboquantHwCache,
  resolveTurboquantRelease,
  turboquantCandidates,
  turboquantInstallPlan,
  type GithubRelease,
  type ReleaseAsset,
  type TurboquantHw,
} from './download'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'

const REPO = 'AtomicBot-ai/atomic-llama-cpp-turboquant'

// Default: an Ada-generation NVIDIA GPU (RTX 40xx, compute 8.9) on a CUDA 13 driver.
const hw = (o: Partial<TurboquantHw>): TurboquantHw => ({
  platform: 'linux', arch: 'x64', vendor: 'nvidia', hasGpu: true, driverCuda: '13.4', computeCaps: [8.9], ...o,
})
const names = (o: Partial<TurboquantHw>) => turboquantCandidates(hw(o)).map((v) => v.name)

// The asset list of b10298-2.0.0, the fork's latest release at the time of writing.
const CURRENT_ASSETS = [
  'linux-arm64-cuda-13.3', 'linux-x64-cpu', 'linux-x64-cuda-12.4', 'linux-x64-cuda-13.3',
  'linux-x64-rocm', 'linux-x64-vulkan', 'macos-arm64',
].flatMap((n) => [`llama-turboquant-${n}.tar.gz`, `llama-turboquant-${n}.zip`])
  .concat(['cpu', 'cuda-12.4', 'cuda-13.3', 'rocm', 'vulkan'].map((b) => `llama-turboquant-windows-x64-${b}.zip`))

const rel = (tag: string, assetNames: string[], extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  assets: assetNames.map((name) => ({ name, browser_download_url: `https://dl.example/${tag}/${name}` })),
  ...extra,
})

// Newest first, as the GitHub API lists them.
const RELEASES: GithubRelease[] = [
  rel('b10298-2.0.0', CURRENT_ASSETS),
  rel('dev-latest', CURRENT_ASSETS, { prerelease: true }),
  rel('b10269-1.7.0', CURRENT_ASSETS),
  rel('turboquant-windows-x64-cuda-13.3-066cc29', ['llama-turboquant-windows-x64-cuda-13.3.zip']),
  rel('turboquant-macos-arm64-066cc29', ['llama-turboquant-macos-arm64.tar.gz', 'llama-turboquant-macos-arm64.zip']),
  rel('turboquant-linux-x64-vulkan-519f0c5', ['llama-turboquant-linux-x64-vulkan.tar.gz', 'llama-turboquant-linux-x64-vulkan.zip']),
]

// ─── turboquantCandidates ────────────────────────────────────────────────────

test('turboquantCandidates: NVIDIA gets CUDA 13.3 then 12.4 when the driver supports CUDA 13', () => {
  assert.deepEqual(names({}), ['linux-x64-cuda-13.3', 'linux-x64-cuda-12.4', 'linux-x64-vulkan'])
  assert.deepEqual(names({ platform: 'win32' }), ['windows-x64-cuda-13.3', 'windows-x64-cuda-12.4', 'windows-x64-vulkan'])
})

test('turboquantCandidates: an older NVIDIA driver gets CUDA 12.4; too old or unreadable gets Vulkan', () => {
  assert.deepEqual(names({ driverCuda: '12.8' }), ['linux-x64-cuda-12.4', 'linux-x64-vulkan'])
  assert.deepEqual(names({ driverCuda: '12.2' }), ['linux-x64-vulkan'])
  assert.deepEqual(names({ driverCuda: null }), ['linux-x64-vulkan'])
})

test('turboquantCandidates: Blackwell never gets the 12.4 build (it has no sm_100/sm_120 kernels)', () => {
  assert.deepEqual(names({ computeCaps: [12.0] }), ['linux-x64-cuda-13.3', 'linux-x64-vulkan'])
  // A 570/575-series driver (CUDA 12.8/12.9) can't run the 13.3 build either → Vulkan.
  assert.deepEqual(names({ computeCaps: [12.0], driverCuda: '12.9' }), ['linux-x64-vulkan'])
  assert.deepEqual(names({ computeCaps: [10.0], platform: 'win32' })[0], 'windows-x64-cuda-13.3')
})

test('turboquantCandidates: pre-Turing GPUs never get the 13.3 build (CUDA 13 dropped them)', () => {
  assert.deepEqual(names({ computeCaps: [6.1] }), ['linux-x64-cuda-12.4', 'linux-x64-vulkan'])
  assert.deepEqual(names({ computeCaps: [7.0] }), ['linux-x64-cuda-12.4', 'linux-x64-vulkan'])
  assert.deepEqual(names({ computeCaps: [7.5] })[0], 'linux-x64-cuda-13.3')
})

test('turboquantCandidates: a mix of pre-Turing and Blackwell GPUs has no CUDA build that runs on both', () => {
  assert.deepEqual(names({ computeCaps: [6.1, 12.0] }), ['linux-x64-vulkan'])
})

test('turboquantCandidates: unknown compute capability gates on the driver alone', () => {
  assert.deepEqual(names({ computeCaps: [] }), ['linux-x64-cuda-13.3', 'linux-x64-cuda-12.4', 'linux-x64-vulkan'])
})

test('turboquantCandidates: only the Windows CUDA 13.3 build needs the separate runtime pack', () => {
  const win = turboquantCandidates(hw({ platform: 'win32' }))
  assert.equal(win[0].cudartPack, 'cudart-llama-bin-win-cuda-13.3-x64.zip')
  assert.equal(win[1].cudartPack, undefined, 'the 12.4 zip bundles its runtime')
  assert.ok(turboquantCandidates(hw({})).every((v) => !v.cudartPack), 'Linux CUDA archives bundle theirs')
})

test('turboquantCandidates: AMD/Intel get Vulkan, no GPU gets CPU, Apple Silicon gets the macOS build', () => {
  assert.deepEqual(names({ vendor: 'amd', driverCuda: null }), ['linux-x64-vulkan'])
  assert.deepEqual(names({ vendor: 'intel', platform: 'win32', driverCuda: null }), ['windows-x64-vulkan'])
  assert.deepEqual(names({ vendor: 'unknown', hasGpu: false, driverCuda: null }), ['linux-x64-cpu'])
  assert.deepEqual(names({ platform: 'darwin', arch: 'arm64', vendor: 'apple' }), ['macos-arm64'])
})

test('turboquantCandidates: no prebuilt for Intel Macs, non-NVIDIA arm64 Linux, or other platforms', () => {
  assert.deepEqual(names({ platform: 'darwin', arch: 'x64', vendor: 'amd' }), [])
  assert.deepEqual(names({ arch: 'arm64', vendor: 'arm', driverCuda: null }), [])
  assert.deepEqual(names({ arch: 'arm64' }), ['linux-arm64-cuda-13.3'])
  assert.deepEqual(names({ platform: 'freebsd' }), [])
})

// ─── resolveTurboquantRelease ────────────────────────────────────────────────

const resolve = (o: Partial<TurboquantHw>, releases = RELEASES) =>
  resolveTurboquantRelease(releases, turboquantCandidates(hw(o)), hw(o).platform)

test('resolveTurboquantRelease: picks the newest tagged release, not the old per-platform ones', () => {
  const r = resolve({})
  assert.equal(r?.tag, 'b10298-2.0.0')
  assert.equal(r?.assetName, 'llama-turboquant-linux-x64-cuda-13.3.tar.gz')
  assert.equal(resolve({ platform: 'darwin', arch: 'arm64', vendor: 'apple' })?.tag, 'b10298-2.0.0')
  assert.equal(resolve({ vendor: 'amd', driverCuda: null })?.assetName, 'llama-turboquant-linux-x64-vulkan.tar.gz')
})

test('resolveTurboquantRelease: Windows resolves a zip (the fork ships no Windows tarballs)', () => {
  const r = resolve({ platform: 'win32' })
  assert.equal(r?.assetName, 'llama-turboquant-windows-x64-cuda-13.3.zip')
  assert.equal(r?.variant.cudartPack, 'cudart-llama-bin-win-cuda-13.3-x64.zip')
})

test('resolveTurboquantRelease: skips the dev-latest prerelease and drafts', () => {
  const only = [rel('dev-latest', CURRENT_ASSETS, { prerelease: true }), rel('b1-0.0.1', CURRENT_ASSETS, { draft: true })]
  assert.equal(resolve({}, only), null)
})

test('resolveTurboquantRelease: falls back to the old per-platform releases when no tagged one fits', () => {
  const old = RELEASES.slice(3)
  assert.equal(resolve({ vendor: 'amd', driverCuda: null }, old)?.tag, 'turboquant-linux-x64-vulkan-519f0c5')
  // An NVIDIA box with no CUDA asset in reach falls through to Vulkan rather than nothing.
  assert.equal(resolve({}, old)?.assetName, 'llama-turboquant-linux-x64-vulkan.tar.gz')
})

test('resolveTurboquantRelease: within a release, the best candidate wins over a later one', () => {
  const no13 = [rel('b2-1.0.0', CURRENT_ASSETS.filter((n) => !n.includes('cuda-13.3')))]
  assert.equal(resolve({}, no13)?.assetName, 'llama-turboquant-linux-x64-cuda-12.4.tar.gz')
})

// ─── provisionTurboquant ─────────────────────────────────────────────────────

const unix = { skip: process.platform === 'win32' && 'tar-based extraction path' }

/** A tar.gz shaped like the fork's archives. Pass file names for its usual `build/bin/<name>`
 *  layout, or a path→content map when a test needs another shape (the CUDA runtime pack keeps
 *  its DLLs at the archive root) or a runnable fake binary (`#!/bin/sh` scripts get +x, so the
 *  extraction's mode survives and `--list-devices` can actually be executed). */
function makeArchive(dir: string, contents: string[] | Record<string, string>): Buffer {
  const files = Array.isArray(contents)
    ? Object.fromEntries(contents.map((f) => [join('build', 'bin', f), f]))
    : contents
  const src = join(dir, 'src')
  for (const [rel, body] of Object.entries(files)) {
    const path = join(src, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    if (body.startsWith('#!')) chmodSync(path, 0o755)
  }
  const out = join(dir, 'a.tar.gz')
  execFileSync('tar', ['-czf', out, '-C', src, '.'])
  return readFileSync(out)
}

/** Stub global fetch for a provisioning test: `/releases?…` answers with `releases`,
 *  `/releases/tags/<tag>` with `tagAssets` (default: none), and every other URL with the bytes
 *  from `archive` — a fixed buffer, or a function of the URL so one test can serve a different
 *  archive per asset. Records every URL requested. */
function fakeGithub(
  t: { after: (fn: () => void) => void },
  releases: GithubRelease[],
  archive: Buffer | ((url: string) => Buffer),
  tagAssets: ReleaseAsset[] = [],
): string[] {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/releases?')) return new Response(JSON.stringify(releases), { status: 200 })
    if (u.includes('/releases/tags/')) return new Response(JSON.stringify({ assets: tagAssets }), { status: 200 })
    return new Response(new Uint8Array(typeof archive === 'function' ? archive(u) : archive), { status: 200 })
  }) as typeof fetch
  return calls
}

/** A fake `llama-server` whose `--list-devices` output the test controls. */
const fakeServer = (...lines: string[]) => `#!/bin/sh\n${lines.map((l) => `echo "${l}"`).join('\n')}\n`

const win = { skip: process.platform !== 'win32' && 'Windows-only extraction path (PowerShell Expand-Archive)' }

/** A REAL .zip, built in memory by the repo's own zip fixture builder so it is a zip on every
 *  platform: PowerShell Expand-Archive reads it on Windows (what the win-gated tests cover),
 *  the pure-Node reader reads it elsewhere. `tar`-built bytes named .zip would let a zip path
 *  pass without any zip ever being read. On Windows the engine binary is `llama-server.exe`
 *  (what findServer looks for), so tests here name it that. */
function makeZip(contents: Record<string, string>): Buffer {
  return buildZipArchive(Object.entries(contents).map(([name, data]) => ({ name, data: Buffer.from(data) })))
}

test('provisionTurboquant: installs the CUDA build for an NVIDIA box and records the tag', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const archive = makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  CUDA0: Fake GPU (100 MiB, 90 MiB free)'),
    'build/bin/libggml-cuda.so': '',
    'build/bin/libcudart.so.13': '',
  })
  const calls = fakeGithub(t, RELEASES, archive)

  const bin = await provisionTurboquant(root, 'AtomicBot-ai/atomic-llama-cpp-turboquant', undefined, undefined, hw({}))
  assert.equal(bin, join(root, 'turboquant', 'build', 'bin', 'llama-server'))
  assert.ok(calls.includes('https://dl.example/b10298-2.0.0/llama-turboquant-linux-x64-cuda-13.3.tar.gz'))
  const marker = JSON.parse(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8'))
  assert.equal(marker.tag, 'b10298-2.0.0')
  assert.equal(marker.variant, 'linux-x64-cuda-13.3', 'the marker records which build was installed')
  assert.equal(existsSync(join(root, 'llama-turboquant-linux-x64-cuda-13.3.tar.gz')), false, 'temp archive removed')

  // Second call: fast path, no network.
  calls.length = 0
  assert.equal(await provisionTurboquant(root, 'AtomicBot-ai/atomic-llama-cpp-turboquant', undefined, undefined, hw({})), bin)
  assert.deepEqual(calls, [])
})

test('provisionTurboquant: a marker-less CUDA install missing its runtime is reinstalled, not reused', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const binDir = join(root, 'turboquant', 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'llama-server'), '')
  writeFileSync(join(binDir, 'libggml-cuda.so'), '') // no libcudart → would silently run on CPU
  const archive = makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  CUDA0: Fake GPU (100 MiB, 90 MiB free)'),
    'build/bin/libggml-cuda.so': '',
    'build/bin/libcudart.so.13': '',
  })
  const calls = fakeGithub(t, RELEASES, archive)

  await provisionTurboquant(root, 'AtomicBot-ai/atomic-llama-cpp-turboquant', undefined, undefined, hw({}))
  assert.ok(calls.some((u) => u.includes('/releases?')), 'resolved and downloaded again')
  assert.ok(existsSync(join(binDir, 'libcudart.so.13')))
})

test('provisionTurboquant: a marker-less legacy Vulkan install is kept (and backfilled)', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const binDir = join(root, 'turboquant', 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'llama-server'), '')
  const calls = fakeGithub(t, RELEASES, Buffer.alloc(0))

  assert.equal(await provisionTurboquant(root, 'AtomicBot-ai/atomic-llama-cpp-turboquant', undefined, undefined, hw({})), join(binDir, 'llama-server'))
  assert.deepEqual(calls, [])
  assert.ok(existsSync(join(root, 'turboquant', '.turbollm-provisioned')))
})

test('provisionTurboquant: no matching build → no_release_asset', async (t) => {
  fakeGithub(t, RELEASES, Buffer.alloc(0))
  await assert.rejects(
    provisionTurboquant(tmpDir('tllm-tq-'), 'AtomicBot-ai/atomic-llama-cpp-turboquant', undefined, undefined,
      hw({ platform: 'darwin', arch: 'x64', vendor: 'amd' })),
    /no_release_asset/,
  )
})

test('provisionTurboquant: a failed release lookup leaves the existing install alone', async (t) => {
  // Regression: the install dir used to be removed BEFORE the release lookup, so a network
  // blip uninstalled the engine and left nothing behind.
  const root = tmpDir('tllm-tq-')
  const binDir = join(root, 'turboquant', 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'llama-server'), '')
  writeFileSync(join(binDir, 'libggml-cuda.so'), '') // no runtime → incomplete, so it can't be reused as-is
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as typeof fetch

  await assert.rejects(provisionTurboquant(root, REPO, undefined, undefined, hw({})), /ENOTFOUND/)
  assert.ok(existsSync(join(binDir, 'llama-server')), 'the interrupted install survived the failed lookup')
})

test('provisionTurboquant: the update path re-installs over a complete install instead of reusing it', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const archive = makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  CUDA0: Fake GPU (100 MiB, 90 MiB free)'),
    'build/bin/libcudart.so.13': '',
  })
  const calls = fakeGithub(t, RELEASES, archive)
  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({}))

  calls.length = 0
  assert.equal(await provisionTurboquant(root, REPO, undefined, undefined, hw({})), bin, 'without force it is a no-op')
  assert.deepEqual([...calls], [])
  assert.equal(await provisionTurboquant(root, REPO, undefined, undefined, hw({}), true), bin, 'forced re-install')
  assert.ok(calls.some((u) => u.endsWith('llama-turboquant-linux-x64-cuda-13.3.tar.gz')), 'so the newest release is fetched again')
})

test('provisionTurboquant: a forced update whose release lookup fails keeps the working install', async (t) => {
  const root = tmpDir('tllm-tq-')
  const binDir = join(root, 'turboquant', 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'llama-server'), '')
  writeFileSync(join(root, 'turboquant', '.turbollm-provisioned'), JSON.stringify({ tag: 'b10269-1.7.0', variant: 'linux-x64-cuda-13.3' }))
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as typeof fetch

  await assert.rejects(provisionTurboquant(root, REPO, undefined, undefined, hw({}), true), /ENOTFOUND/)
  assert.ok(existsSync(join(binDir, 'llama-server')), 'the update failed, but the old build is still installed')
})

test('provisionTurboquant: a forced update that fails on EVERY candidate keeps the working install', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const archive = makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  CUDA0: Fake GPU (100 MiB, 90 MiB free)'),
    'build/bin/libcudart.so.13': '',
  })
  fakeGithub(t, RELEASES, archive)
  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({}))
  const marker = readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8')

  // Every candidate now serves bytes that are not an archive, so each one fails after the
  // download — the shape a truncated release, a bad mirror or a checksum mismatch takes.
  fakeGithub(t, RELEASES, Buffer.from('not an archive at all'))
  await assert.rejects(
    provisionTurboquant(root, REPO, undefined, undefined, hw({}), true),
    /no TurboQuant build for this machine worked/,
  )
  assert.ok(existsSync(bin), 'the registry still points here — the failed update must not have deleted it')
  assert.equal(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8'), marker, 'and the old marker is intact')
  assert.deepEqual(readdirSync(join(root, 'build')).filter((d) => d.startsWith('.turboquant-')), [], 'no staging dir is left behind')
  assert.equal(await provisionTurboquant(root, REPO, undefined, undefined, hw({})), bin, 'the intact install is still the fast path')
})

for (const [how, script] of [
  ['a backend that reports no device', fakeServer('Available devices:', '  (none)')],
  ['a binary that dies on --list-devices', '#!/bin/sh\nexit 1\n'],
] as const) {
  test(`provisionTurboquant: ${how} falls through to the next candidate`, unix, async (t) => {
    const root = tmpDir('tllm-tq-')
    const broken = makeArchive(tmpDir('tllm-tq-src-'), { 'build/bin/llama-server': script })
    const works = makeArchive(tmpDir('tllm-tq-src-'), {
      'build/bin/llama-server': fakeServer('Available devices:', '  CUDA0: Fake GPU (100 MiB, 90 MiB free)'),
    })
    const calls = fakeGithub(t, RELEASES, (u) => (u.includes('cuda-13.3') ? broken : works))

    const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({}))
    assert.ok(calls.some((u) => u.endsWith('llama-turboquant-linux-x64-cuda-13.3.tar.gz')), 'tried the preferred build first')
    assert.ok(calls.some((u) => u.endsWith('llama-turboquant-linux-x64-cuda-12.4.tar.gz')), 'fell through to the next candidate')
    assert.ok(!calls.some((u) => u.includes('vulkan')), 'and stopped at the first build that works')
    assert.equal(JSON.parse(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8')).variant, 'linux-x64-cuda-12.4')
    assert.equal(bin, join(root, 'turboquant', 'build', 'bin', 'llama-server'))
  })
}

test('provisionTurboquant: a single-candidate machine keeps its build even when the probe sees no device', unix, async (t) => {
  // Apple Silicon has exactly one prebuilt. Failing it over an unverifiable probe could only
  // break a working install, so a failed backend check on the LAST candidate is a warning, not
  // a rejection — there is nothing else to try.
  const root = tmpDir('tllm-tq-')
  const archive = makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  (none)'),
  })
  fakeGithub(t, RELEASES, archive)

  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({ platform: 'darwin', arch: 'arm64', vendor: 'apple' }))
  assert.equal(bin, join(root, 'turboquant', 'build', 'bin', 'llama-server'))
})

test('provisionTurboquant: a machine whose every GPU build is dead ends on the CPU last resort', unix, async (t) => {
  // Every build installs but reports no device (the fork's silent CPU fallback), so CUDA 13.3,
  // CUDA 12.4 and Vulkan are each rejected and the walk must not stop at "nothing worked".
  const root = tmpDir('tllm-tq-')
  const archive = makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  (none)'),
  })
  const calls = fakeGithub(t, RELEASES, archive)

  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({}))
  for (const name of ['linux-x64-cuda-13.3', 'linux-x64-cuda-12.4', 'linux-x64-vulkan', 'linux-x64-cpu']) {
    assert.ok(calls.some((u) => u.endsWith(`llama-turboquant-${name}.tar.gz`)), `tried ${name}`)
  }
  assert.equal(
    JSON.parse(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8')).variant,
    'linux-x64-cpu',
    'the CPU build is what the machine ends up on, not a GPU build that never loaded',
  )
  assert.equal(bin, join(root, 'turboquant', 'build', 'bin', 'llama-server'))
})

test('provisionTurboquant: replaces a build this machine can no longer run', unix, async (t) => {
  // The marker records the variant, so a GPU vendor swap is detectable; without it a CUDA
  // install would sit on an AMD box forever.
  const root = tmpDir('tllm-tq-')
  const binDir = join(root, 'turboquant', 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'llama-server'), '')
  writeFileSync(join(binDir, 'libggml-cuda.so'), '')
  writeFileSync(join(binDir, 'libcudart.so.13'), '')
  writeFileSync(
    join(root, 'turboquant', '.turbollm-provisioned'),
    JSON.stringify({ tag: 'b10298-2.0.0', variant: 'linux-x64-cuda-13.3' }),
  )
  const calls = fakeGithub(t, RELEASES, makeArchive(tmpDir('tllm-tq-src-'), {
    'build/bin/llama-server': fakeServer('Available devices:', '  Vulkan0: Fake GPU (100 MiB, 90 MiB free)'),
  }))

  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({ vendor: 'amd', driverCuda: null }))
  assert.ok(calls.some((u) => u.includes('linux-x64-vulkan.tar.gz')), 'a CUDA install on an AMD box is replaced')
  assert.equal(JSON.parse(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8')).variant, 'linux-x64-vulkan')
  assert.equal(bin, join(binDir, 'llama-server'))
})

test('provisionTurboquant: the Windows CUDA 13.3 runtime pack is resolved from its own pinned tag, beside the binary', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const main = makeZip({
    'build/bin/llama-server': fakeServer('Available devices:', '  CUDA0: Fake GPU (100 MiB, 90 MiB free)'),
    'build/bin/ggml-cuda.dll': '',
  })
  const pack = makeZip({ 'cudart64_13.dll': 'runtime' })
  const asset: ReleaseAsset = {
    name: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
    browser_download_url: 'https://dl.example/llama.cpp/b9608/cudart-llama-bin-win-cuda-13.3-x64.zip',
    digest: `sha256:${createHash('sha256').update(pack).digest('hex')}`,
  }
  const calls = fakeGithub(t, RELEASES, (u) => (u.includes('cudart') ? pack : main), [asset])

  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({ platform: 'win32' }))
  // URL (and digest) come from the API for the pack's pinned tag — not from a hand-built path
  // hanging off LLAMA_BUILD, whose next bump would have 404'd this with nothing to catch it.
  assert.ok(calls.some((u) => u.includes('/releases/tags/b9608')), 'the pack is resolved from its pinned tag')
  assert.ok(calls.includes(asset.browser_download_url))
  // Its runtime DLLs land NEXT TO the server binary (where Windows looks), not under build/bin.
  assert.ok(existsSync(join(dirname(bin), 'cudart64_13.dll')))
  assert.ok(!existsSync(join(root, 'turboquant', 'cudart64_13.dll')))
})

test('provisionTurboquant: a release asset whose published sha256 does not match is refused', unix, async (t) => {
  const root = tmpDir('tllm-tq-')
  const archive = makeArchive(tmpDir('tllm-tq-src-'), { 'build/bin/llama-server': fakeServer('  Vulkan0: Fake') })
  // A CUDA 12.2 driver leaves Vulkan as the only candidate, so nothing masks the failure.
  fakeGithub(t, [{
    tag_name: 'b10298-2.0.0',
    assets: [{
      name: 'llama-turboquant-linux-x64-vulkan.tar.gz',
      browser_download_url: 'https://dl.example/b10298-2.0.0/llama-turboquant-linux-x64-vulkan.tar.gz',
      digest: `sha256:${'0'.repeat(64)}`,
    }],
  }], archive)

  await assert.rejects(provisionTurboquant(root, REPO, undefined, undefined, hw({ driverCuda: '12.2' })), /checksum_failed/)
})

// ─── release ordering ────────────────────────────────────────────────────────

test('compareTurboquantReleaseTags: semver decides, then the upstream build; legacy tags sort below', () => {
  assert.ok(compareTurboquantReleaseTags('b10298-2.0.0', 'b10269-1.7.0') > 0)
  assert.ok(compareTurboquantReleaseTags('b10269-1.7.1', 'b10269-1.7.0') > 0) // same build, newer fork release
  assert.ok(compareTurboquantReleaseTags('b10298-1.7.0', 'b10269-2.0.0') < 0) // semver outranks the build number
  assert.equal(compareTurboquantReleaseTags('b10298-2.0.0', 'b10298-2.0.0'), 0)
  // The old per-platform releases carry no version at all, so they are always older.
  assert.ok(compareTurboquantReleaseTags('b1-0.0.1', 'turboquant-linux-x64-vulkan-519f0c5') > 0)
  assert.ok(compareTurboquantReleaseTags('turboquant-linux-x64-vulkan-519f0c5', 'b1-0.0.1') < 0)
  assert.equal(compareTurboquantReleaseTags('turboquant-a', 'turboquant-b'), 0)
})

test('turboquantInstallPlan: the highest tag wins, not the first the API lists', () => {
  // GitHub orders releases by creation time, so a patch cut for an OLDER line comes back first:
  // taking the first match silently downgraded both fresh installs and explicit updates.
  const late = [rel('b10269-1.7.1', CURRENT_ASSETS), rel('b10298-2.0.0', CURRENT_ASSETS)]
  assert.equal(resolve({}, late)?.tag, 'b10298-2.0.0')
  assert.equal(resolve({}, late)?.assetName, 'llama-turboquant-linux-x64-cuda-13.3.tar.gz')
})

test('turboquantInstallPlan: every candidate of that release, best first, all at one tag', () => {
  const plan = turboquantInstallPlan(RELEASES, turboquantCandidates(hw({})), 'linux')
  assert.deepEqual(
    plan.map((p) => p.variant.name),
    ['linux-x64-cuda-13.3', 'linux-x64-cuda-12.4', 'linux-x64-vulkan', 'linux-x64-cpu'],
    'the CPU build is the x64 last resort, appended after every GPU-capable one',
  )
  assert.ok(plan.every((p) => p.tag === 'b10298-2.0.0'))
  // A candidate the newest release simply doesn't ship is absent, not a hole in the plan.
  const noVulkan = [rel('b2-1.0.0', CURRENT_ASSETS.filter((n) => !n.includes('vulkan')))]
  assert.deepEqual(
    turboquantInstallPlan(noVulkan, turboquantCandidates(hw({})), 'linux').map((p) => p.variant.name),
    ['linux-x64-cuda-13.3', 'linux-x64-cuda-12.4', 'linux-x64-cpu'],
  )
  // Apple Silicon: the fork ships no CPU build, and x64-only since it would be the wrong arch.
  assert.deepEqual(
    turboquantInstallPlan(RELEASES, turboquantCandidates(hw({ platform: 'darwin', arch: 'arm64', vendor: 'apple' })), 'darwin')
      .map((p) => p.variant.name),
    ['macos-arm64'],
  )
})

test('needsTurboquantReprovision: only when no candidate shares the installed backend family', () => {
  const nvidia = turboquantCandidates(hw({}))
  const amd = turboquantCandidates(hw({ vendor: 'amd', driverCuda: null }))
  // A driver that moved on (12.4 installed, 13.3 available) keeps its install: still runnable.
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-cuda-12.4' }, nvidia), false)
  // A Vulkan install still runs on an NVIDIA card, so it isn't churned either — offering the
  // CUDA build is the update flow's job, not a silent re-download of 530 MB.
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-vulkan' }, nvidia), false)
  // The card was swapped for an AMD one: no CUDA build is on offer any more.
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-cuda-13.3' }, amd), true)
  // The GPU merely stopped being visible (candidates collapse to the CPU build): keep it —
  // an unreadable nvidia-smi must never delete a working CUDA install.
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-cuda-13.3' }, turboquantCandidates(hw({ vendor: 'unknown', hasGpu: false, driverCuda: null }))), false)
  // The other unreadable-probe shape: the GPU is still visible but the DRIVER VERSION probe
  // failed, so the candidates collapse to Vulkan. That is "cannot tell", not "no CUDA for this
  // machine" — replacing a working CUDA build on it costs the install and ~500 MB.
  const noDriver = hw({ driverCuda: null, computeCaps: [] })
  assert.deepEqual(names({ driverCuda: null }), ['linux-x64-vulkan'])
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-cuda-13.3' }, turboquantCandidates(noDriver), noDriver), false)
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-cuda-13.3' }, turboquantCandidates(noDriver)), true, 'without hw there is nothing to tell a failed probe from a machine with no CUDA build')
  // Pre-marker installs have nothing to compare against.
  assert.equal(needsTurboquantReprovision({ backfilled: true }, nvidia), false)
  assert.equal(needsTurboquantReprovision(null, nvidia), false)
  // A CPU build runs anywhere, so a GPU appearing later doesn't churn it — and the same goes
  // for a Vulkan build on an AMD box that gained an NVIDIA card.
  assert.equal(needsTurboquantReprovision({ variant: 'linux-x64-cpu' }, nvidia), false)
})

test('detectTurboquantHw: resolved once per process — repeat calls share one probe', async () => {
  resetTurboquantHwCache()
  const first = detectTurboquantHw()
  assert.equal(detectTurboquantHw(), first, 'an in-flight probe is reused, not re-spawned')
  await first
  assert.equal(detectTurboquantHw(), first, 'and so is a settled one')
  resetTurboquantHwCache()
  assert.notEqual(detectTurboquantHw(), first)
})

test('detectTurboquantHw: a probe that came back without the NVIDIA driver version is not memoized', async () => {
  resetTurboquantHwCache()
  // The shape a failed/timed-out nvidia-smi leaves: the GPU is there, the driver version isn't.
  const unknownDriver = hw({ driverCuda: null, computeCaps: [] })
  let probes = 0
  const probe = async () => { probes++; return unknownDriver }
  await detectTurboquantHw(probe)
  await detectTurboquantHw(probe)
  assert.equal(probes, 2, 'a failed driver probe is retried on the next call, not cached for the process')

  // A complete answer is still cached — the memo exists to spare two nvidia-smi spawns per call.
  resetTurboquantHwCache()
  let settled = 0
  const complete = async () => { settled++; return hw({}) }
  await detectTurboquantHw(complete)
  await detectTurboquantHw(complete)
  assert.equal(settled, 1, 'a settled probe with a known driver is reused')
  resetTurboquantHwCache()
})

// ─── Windows (PowerShell Expand-Archive) ─────────────────────────────────────
// Skipped on Linux, where `unix` tests above cover the same logic through `tar`. These run on
// the windows-latest CI job; the extraction itself and the .exe naming are Windows-only.

test('provisionTurboquant: extracts a real Windows .zip and finds llama-server.exe', win, async (t) => {
  const root = tmpDir('tllm-tq-')
  // A CUDA 12.2 driver leaves Vulkan plus the CPU last resort. The fixture's .exe can't run, so
  // the Vulkan build fails its backend check and the walk ends on the CPU build; what this test
  // is about is Expand-Archive producing both members and findServer reaching the .exe through
  // them — `existsSync` on the DLL pins the second member, not just the binary.
  const zip = makeZip({
    'build/bin/llama-server.exe': 'not a real exe',
    'build/bin/ggml-vulkan.dll': '',
  })
  fakeGithub(t, RELEASES, zip)

  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({ platform: 'win32', driverCuda: '12.2' }))
  assert.equal(bin, join(root, 'turboquant', 'build', 'bin', 'llama-server.exe'))
  assert.ok(existsSync(join(root, 'turboquant', 'build', 'bin', 'ggml-vulkan.dll')))
  assert.equal(
    JSON.parse(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8')).variant,
    'windows-x64-cpu',
    'the .exe never loads, so the last candidate is what is left installed',
  )
})

test('provisionTurboquant: a Windows build whose backend never loads falls through to the last candidate', win, async (t) => {
  // The reviewer's #1 scenario, on real Windows: the fork's CUDA 13.3 zip installs, but its
  // backend doesn't come up (here the fixture binary can't run at all — the same observable
  // outcome as the missing-runtime DLLs). Every candidate is tried, and since nothing follows
  // the CPU build, THAT one is kept with a warning rather than leaving the machine with no
  // engine at all.
  const root = tmpDir('tllm-tq-')
  const zip = makeZip({ 'build/bin/llama-server.exe': 'not a real exe' })
  const pack: ReleaseAsset = {
    name: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
    browser_download_url: 'https://dl.example/llama.cpp/b9608/cudart-llama-bin-win-cuda-13.3-x64.zip',
  }
  const calls = fakeGithub(t, RELEASES, zip, [pack])

  const bin = await provisionTurboquant(root, REPO, undefined, undefined, hw({ platform: 'win32' }))
  assert.ok(calls.includes(pack.browser_download_url), 'the separate CUDA runtime pack was fetched')
  for (const name of ['windows-x64-cuda-13.3', 'windows-x64-cuda-12.4', 'windows-x64-vulkan', 'windows-x64-cpu']) {
    assert.ok(calls.some((u) => u.endsWith(`llama-turboquant-${name}.zip`)), `tried ${name}`)
  }
  assert.equal(
    JSON.parse(readFileSync(join(root, 'turboquant', '.turbollm-provisioned'), 'utf8')).variant,
    'windows-x64-cpu',
    'the last candidate is kept — never the CUDA build that never loaded',
  )
  assert.equal(bin, join(root, 'turboquant', 'build', 'bin', 'llama-server.exe'))
  assert.deepEqual(readdirSync(join(root, 'build')).filter((d) => d.startsWith('.turboquant-')), [], 'no staging dir is left behind')
})

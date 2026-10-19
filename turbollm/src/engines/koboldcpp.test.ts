// Phase 4: KoboldCpp engine. Pure unit tests for the launch command, the profile →
// KoboldCpp arg-map, and the release-asset selection (asset names verified against the
// LostRuins/koboldcpp v1.115.x release: koboldcpp.exe / koboldcpp-nocuda.exe /
// koboldcpp-linux-x64[-nocuda] / koboldcpp-mac-arm64).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  ensureKoboldcpp,
  koboldcppAssetName,
  koboldcppBinPath,
  koboldcppProfileToArgs,
  koboldcppServerCommand,
  pickKoboldcppAsset,
} from './koboldcpp'
import type { ReleaseAsset } from './download'
import { tmpDir } from '../test-support/tmp'

test('koboldcppServerCommand passes model/host/port + skiplauncher and appends extraArgs', () => {
  const { cmd, args } = koboldcppServerCommand('/bin/koboldcpp', '/models/x.gguf', 8081, '127.0.0.1', [
    '--contextsize',
    '8192',
    '--usecuda',
  ])
  assert.equal(cmd, '/bin/koboldcpp')
  assert.deepEqual(args, [
    '--model',
    '/models/x.gguf',
    '--host',
    '127.0.0.1',
    '--port',
    '8081',
    '--skiplauncher',
    '--quiet',
    '--contextsize',
    '8192',
    '--usecuda',
  ])
})

// Without --quiet KoboldCpp prints each request's prompt (`Input: {...}`) and reply (`Output: ...`)
// to its console, which the manager writes into the engine log, and GET /api/v1/engine/logs serves
// that log to keyless open-LAN and Serve callers that the request log refuses captured bodies to.
test('koboldcppServerCommand launches KoboldCpp quiet, so prompts and replies stay out of the engine log', () => {
  const { args } = koboldcppServerCommand('/bin/koboldcpp', '/models/x.gguf', 8081, '127.0.0.1')
  assert.ok(args.includes('--quiet'), `--quiet missing from ${args.join(' ')}`)
  // With a model's own flags the fixed --quiet comes before them, so a user `--debugmode 1` still wins.
  const withExtra = koboldcppServerCommand('/bin/koboldcpp', '/models/x.gguf', 8081, '127.0.0.1', ['--debugmode', '1'])
  assert.ok(withExtra.args.indexOf('--quiet') < withExtra.args.indexOf('--debugmode'))
  assert.deepEqual(withExtra.args.slice(-2), ['--debugmode', '1'])
})

test('koboldcppProfileToArgs: NVIDIA GPU → contextsize + gpulayers + usecuda', () => {
  const args = koboldcppProfileToArgs({ ctx: 8192, ngl: 99 }, 'nvidia', true)
  assert.deepEqual(args, ['--contextsize', '8192', '--gpulayers', '99', '--usecuda'])
})

test('koboldcppProfileToArgs: non-NVIDIA GPU → usevulkan', () => {
  const args = koboldcppProfileToArgs({ ctx: 4096, ngl: 40 }, 'amd', true)
  assert.deepEqual(args, ['--contextsize', '4096', '--gpulayers', '40', '--usevulkan'])
})

test('koboldcppProfileToArgs: no GPU → nogpu, no gpulayers flag', () => {
  const args = koboldcppProfileToArgs({ ctx: 2048, ngl: 0 }, 'unknown', false)
  assert.deepEqual(args, ['--contextsize', '2048', '--nogpu'])
})

test('koboldcppProfileToArgs: ngl 0 on a GPU box still means CPU (nogpu, no gpulayers)', () => {
  const args = koboldcppProfileToArgs({ ctx: 2048, ngl: 0 }, 'nvidia', true)
  assert.deepEqual(args, ['--contextsize', '2048', '--nogpu'])
})

test('koboldcppProfileToArgs: user extraArgs pass through last', () => {
  const args = koboldcppProfileToArgs({ ctx: 4096, ngl: 10, extraArgs: ['--flashattention'] }, 'nvidia', true)
  assert.deepEqual(args.slice(-1), ['--flashattention'])
})

test('koboldcppAssetName: Windows x64 picks CUDA vs nocuda build by GPU', () => {
  assert.equal(koboldcppAssetName(true, 'win32', 'x64'), 'koboldcpp.exe')
  assert.equal(koboldcppAssetName(false, 'win32', 'x64'), 'koboldcpp-nocuda.exe')
  // No Windows-arm64 KoboldCpp asset.
  assert.equal(koboldcppAssetName(true, 'win32', 'arm64'), null)
})

test('koboldcppAssetName: Linux x64 picks CUDA vs nocuda build by GPU', () => {
  assert.equal(koboldcppAssetName(true, 'linux', 'x64'), 'koboldcpp-linux-x64')
  assert.equal(koboldcppAssetName(false, 'linux', 'x64'), 'koboldcpp-linux-x64-nocuda')
  assert.equal(koboldcppAssetName(true, 'linux', 'arm64'), null)
})

test('koboldcppAssetName: macOS only Apple Silicon', () => {
  assert.equal(koboldcppAssetName(false, 'darwin', 'arm64'), 'koboldcpp-mac-arm64')
  assert.equal(koboldcppAssetName(true, 'darwin', 'x64'), null)
})

test('pickKoboldcppAsset matches the wanted asset by exact name', () => {
  const assets: ReleaseAsset[] = [
    { name: 'koboldcpp.exe', browser_download_url: 'u1' },
    { name: 'koboldcpp-nocuda.exe', browser_download_url: 'u2' },
    { name: 'koboldcpp-linux-x64', browser_download_url: 'u3' },
    { name: 'koboldcpp-mac-arm64', browser_download_url: 'u4' },
  ]
  assert.equal(pickKoboldcppAsset(assets, true, 'win32', 'x64')?.name, 'koboldcpp.exe')
  assert.equal(pickKoboldcppAsset(assets, false, 'win32', 'x64')?.name, 'koboldcpp-nocuda.exe')
  assert.equal(pickKoboldcppAsset(assets, true, 'linux', 'x64')?.name, 'koboldcpp-linux-x64')
  assert.equal(pickKoboldcppAsset(assets, false, 'darwin', 'arm64')?.name, 'koboldcpp-mac-arm64')
  // Unsupported OS/arch → null even when assets exist.
  assert.equal(pickKoboldcppAsset(assets, true, 'win32', 'arm64'), null)
})

test('pickKoboldcppAsset returns null when the wanted asset is missing', () => {
  const assets: ReleaseAsset[] = [{ name: 'koboldcpp-mac-arm64', browser_download_url: 'u' }]
  assert.equal(pickKoboldcppAsset(assets, true, 'win32', 'x64'), null)
})

// ── Provisioning (fetch stubbed: the GitHub API answers `tag`, the asset URL answers `download`) ──
// The binary used to be streamed straight to its final path, and an existing file counted as
// installed — so a dropped download was later registered as KoboldCpp, an older binary was
// labelled with the latest tag, and an Update had to delete the working binary before fetching.
const realFetch = globalThis.fetch
const ALL_ASSETS: ReleaseAsset[] = ['koboldcpp.exe', 'koboldcpp-nocuda.exe', 'koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda', 'koboldcpp-mac-arm64']
  .map((name) => ({ name, browser_download_url: `https://dl.test/${name}` }))
const noAsset = !koboldcppAssetName(false) && 'KoboldCpp publishes no asset for this OS/arch'

function stubRelease(t: { after: (fn: () => void) => void }, tag: string, download: () => Response): void {
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : String(url)
    if (u.includes('api.github.com')) return new Response(JSON.stringify({ tag_name: tag, assets: ALL_ASSETS }))
    return download()
  }) as typeof fetch
}

/** A response whose body dies part-way, like a connection reset mid-download. */
const droppedDownload = () =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('half a bin')); c.error(new Error('ECONNRESET')) } }))

test('ensureKoboldcpp: an interrupted download leaves nothing a later Install would register', { skip: noAsset }, async (t) => {
  const root = tmpDir('tllm-kobold-')
  stubRelease(t, 'v1.2.0', droppedDownload)
  await assert.rejects(ensureKoboldcpp(root, false))
  assert.equal(existsSync(koboldcppBinPath(root)), false)
  assert.equal(existsSync(`${koboldcppBinPath(root)}.part`), false)
})

test('ensureKoboldcpp: an installed binary reports the release it was downloaded as, not the latest', { skip: noAsset }, async (t) => {
  const root = tmpDir('tllm-kobold-')
  stubRelease(t, 'v1.0.0', () => new Response('kobold v1'))
  assert.equal((await ensureKoboldcpp(root, false)).version, 'v1.0.0')
  stubRelease(t, 'v2.0.0', () => { throw new Error('an installed binary must not be re-downloaded') })
  assert.equal((await ensureKoboldcpp(root, false)).version, 'v1.0.0')
})

test('ensureKoboldcpp replace: a failed update keeps the working binary; a complete one replaces it', { skip: noAsset }, async (t) => {
  const root = tmpDir('tllm-kobold-')
  const bin = koboldcppBinPath(root)
  stubRelease(t, 'v1.0.0', () => new Response('kobold v1'))
  await ensureKoboldcpp(root, false)
  stubRelease(t, 'v2.0.0', droppedDownload)
  await assert.rejects(ensureKoboldcpp(root, false, undefined, undefined, { replace: true }))
  assert.equal(readFileSync(bin, 'utf8'), 'kobold v1')
  stubRelease(t, 'v2.0.0', () => new Response('kobold v2'))
  assert.equal((await ensureKoboldcpp(root, false, undefined, undefined, { replace: true })).version, 'v2.0.0')
  assert.equal(readFileSync(bin, 'utf8'), 'kobold v2')
})

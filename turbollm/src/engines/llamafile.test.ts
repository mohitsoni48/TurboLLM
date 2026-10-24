// Phase 4: llamafile engine. Pure unit tests for the server launch command (it must
// switch the multi-mode binary into server mode with --server --no-webui, then pass the
// standard llama.cpp flags through) and the release-asset selection (the portable
// `llamafile-<version>` APE, excluding `-thin`/`.zip`/sibling tools — verified against the
// Mozilla-Ocho/llamafile v0.10.3 release assets).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ensureLlamafile, llamafileBinPath, llamafileServerCommand, pickLlamafileAsset } from './llamafile'
import type { ReleaseAsset } from './download'
import { tmpDir } from '../test-support/tmp'

test('llamafileServerCommand switches to server mode and passes llama.cpp flags through', () => {
  const { cmd, args } = llamafileServerCommand('/bin/llamafile', '/models/x.gguf', 8081, '127.0.0.1', [
    '-c',
    '8192',
    '-ngl',
    '99',
  ])
  assert.equal(cmd, '/bin/llamafile')
  assert.deepEqual(args, [
    '--server',
    '--no-webui',
    '-m',
    '/models/x.gguf',
    '--host',
    '127.0.0.1',
    '--port',
    '8081',
    '-c',
    '8192',
    '-ngl',
    '99',
  ])
})

test('llamafileServerCommand with no extraArgs still launches in server mode', () => {
  const { args } = llamafileServerCommand('/bin/llamafile', '/m.gguf', 8000, '127.0.0.1')
  assert.ok(args.includes('--server'))
  assert.ok(args.includes('--no-webui'))
  assert.deepEqual(args.slice(-2), ['--port', '8000'])
})

test('pickLlamafileAsset selects the portable llamafile-<version> binary', () => {
  const assets: ReleaseAsset[] = [
    { name: 'diffusionfile-0.10.3', browser_download_url: 'u1' },
    { name: 'llamafile-0.10.3', browser_download_url: 'u2' },
    { name: 'llamafile-0.10.3-thin', browser_download_url: 'u3' },
    { name: 'llamafile-0.10.3.zip', browser_download_url: 'u4' },
    { name: 'whisperfile-0.10.3', browser_download_url: 'u5' },
    { name: 'zipalign-0.10.3', browser_download_url: 'u6' },
  ]
  assert.equal(pickLlamafileAsset(assets)?.name, 'llamafile-0.10.3')
})

test('pickLlamafileAsset excludes -thin and .zip, returns null when none match', () => {
  assert.equal(pickLlamafileAsset([{ name: 'llamafile-0.10.3-thin', browser_download_url: 'u' }]), null)
  assert.equal(pickLlamafileAsset([{ name: 'llamafile-0.10.3.zip', browser_download_url: 'u' }]), null)
  assert.equal(pickLlamafileAsset([{ name: 'whisperfile-0.10.3', browser_download_url: 'u' }]), null)
  assert.equal(pickLlamafileAsset([]), null)
})

// ── Provisioning (fetch stubbed) — same guarantees as KoboldCpp's, see koboldcpp.test.ts ──
const realFetch = globalThis.fetch

function stubRelease(t: { after: (fn: () => void) => void }, tag: string, download: () => Response): void {
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : String(url)
    if (u.includes('api.github.com'))
      return new Response(JSON.stringify({ tag_name: tag, assets: [{ name: `llamafile-${tag}`, browser_download_url: 'https://dl.test/llamafile' }] }))
    return download()
  }) as typeof fetch
}

const droppedDownload = () =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('half a bin')); c.error(new Error('ECONNRESET')) } }))

test('ensureLlamafile: a dropped download is never installed; an installed binary keeps its own release tag', async (t) => {
  const root = tmpDir('tllm-llamafile-')
  stubRelease(t, '0.10.2', droppedDownload)
  await assert.rejects(ensureLlamafile(root))
  assert.equal(existsSync(llamafileBinPath(root)), false)
  stubRelease(t, '0.10.2', () => new Response('llamafile 0.10.2'))
  await ensureLlamafile(root)
  stubRelease(t, '0.10.3', () => { throw new Error('an installed binary must not be re-downloaded') })
  assert.equal((await ensureLlamafile(root)).version, '0.10.2')
})

test('ensureLlamafile replace: a failed update keeps the working binary', async (t) => {
  const root = tmpDir('tllm-llamafile-')
  stubRelease(t, '0.10.2', () => new Response('llamafile 0.10.2'))
  await ensureLlamafile(root)
  stubRelease(t, '0.10.3', droppedDownload)
  await assert.rejects(ensureLlamafile(root, undefined, undefined, { replace: true }))
  assert.equal(readFileSync(llamafileBinPath(root), 'utf8'), 'llamafile 0.10.2')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpDir } from '../../test-support/tmp'
import { NgrokProvider, NGROK_URL_RE, ngrokAssetUrl } from './ngrok'
import { ensureNgrok, ngrokBinPath } from './ngrok-provision'

const cfg = { authtoken: '2abcDEF', domain: '' }

test('ngrok: is a child-process provider', () => {
  const p = new NgrokProvider('/tmp/data', cfg)
  assert.equal(p.id, 'ngrok')
  assert.equal(p.lifecycle, 'child-process')
})

test('ngrok: preflight needs an authtoken', async () => {
  const s = await new NgrokProvider('/tmp/data', { authtoken: '', domain: '' }).preflight()
  assert.equal(s.kind, 'needs-setup')
  assert.equal(s.kind === 'needs-setup' && s.reason.includes('authtoken'), true)
})

test('ngrok: preflight is ready with an authtoken', async () => {
  assert.equal((await new NgrokProvider('/tmp/data', cfg).preflight()).kind, 'off')
})

test('ngrok: argv targets the ingress port and never carries the authtoken', () => {
  const p = new NgrokProvider('/tmp/data', cfg)
  assert.deepEqual(p.argv(6997), ['http', '6997', '--log', 'stdout'])
})

test('ngrok: a reserved domain is passed through when set, still with no authtoken in argv', () => {
  const p = new NgrokProvider('/tmp/data', { authtoken: '2abcDEF', domain: 'llm.ngrok.app' })
  assert.deepEqual(p.argv(6997), ['http', '6997', '--log', 'stdout', '--domain', 'llm.ngrok.app'])
})

test('ngrok: the authtoken travels as NGROK_AUTHTOKEN, not argv — readable via /proc/*/cmdline otherwise', () => {
  const p = new NgrokProvider('/tmp/data', cfg)
  assert.deepEqual(p.env(), { NGROK_AUTHTOKEN: '2abcDEF' })
  assert.equal(JSON.stringify(p.argv(6997)).includes('2abcDEF'), false)
})

test('ngrok: parses the assigned URL out of its log line', () => {
  const line = 't=2026-09-10T10:00:00+0000 lvl=info msg="started tunnel" url=https://a1b2-c3d4.ngrok-free.app'
  assert.equal(NGROK_URL_RE.exec(line)?.[0], 'https://a1b2-c3d4.ngrok-free.app')
})

test('ngrok: an unpublished platform/arch has no asset URL', () => {
  assert.equal(ngrokAssetUrl('sunos', 'sparc'), null)
  assert.equal(ngrokAssetUrl('win32', 'ia32'), null)
})

// Fixture: verified live against https://dl.equinox.io/ngrok/ngrok-v3/stable (the "Latest"
// page, NOT /stable/archive — the archive page's links are per-version and carry a distinct
// random equinox hash PER FILE, e.g. .../a/6nG16rF52TE/ngrok-v3-3.39.11-darwin-arm64.tar.gz,
// which would go stale the moment ngrok cuts a new release. The /stable "Latest" page instead
// publishes a fixed "channel" URL — base https://bin.equinox.io/c/bNyj1mQVY4c/ — that equinox
// itself keeps pointed at whatever the current stable build is, the same way cloudflared's
// GitHub "latest release" tag does. `curl -sL https://dl.equinox.io/ngrok/ngrok-v3/stable`
// listed, and a follow-up `curl -sI` on each confirmed HTTP 200 + a real octet-stream body,
// exactly these assets for win32-x64/darwin-x64/darwin-arm64/linux-x64/linux-arm64:
//   ngrok-v3-stable-windows-amd64.zip   (Windows: .zip only, no .tgz offered)
//   ngrok-v3-stable-darwin-amd64.tgz    (macOS also offers a .zip variant; .tgz picked for
//   ngrok-v3-stable-darwin-arm64.tgz     consistency with Linux and because extractArchive's
//                                         non-Windows path already shells out to `tar -xzf`)
//   ngrok-v3-stable-linux-amd64.tgz     (Linux: .tgz only, no .zip offered)
//   ngrok-v3-stable-linux-arm64.tgz
// This is NOT the "raw exe on Win/Linux, .tgz on macOS" split ADR-153 found for cloudflared —
// ngrok archives EVERY platform (including Windows) rather than shipping any raw executable.
test('ngrok: the asset URL matches what the live archive publishes', () => {
  assert.equal(
    ngrokAssetUrl('win32', 'x64'),
    'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip',
  )
  assert.equal(
    ngrokAssetUrl('darwin', 'x64'),
    'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-amd64.tgz',
  )
  assert.equal(
    ngrokAssetUrl('darwin', 'arm64'),
    'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.tgz',
  )
  assert.equal(
    ngrokAssetUrl('linux', 'x64'),
    'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz',
  )
  assert.equal(
    ngrokAssetUrl('linux', 'arm64'),
    'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz',
  )
})

// --- ensureNgrok: a provision still extracting (stubbed download and tar, real temp dir) ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A Stop then a Start while the first provision is still extracting. tar writes the archive's
// `ngrok` straight to its final path, so the binary exists, half-written, before the provision
// ends: the second call took it as installed and spawned it (ETXTBSY on Linux). It must join the
// running provision instead. The extraction is a stand-in `tar` first on PATH, invoked as
// `tar -xzf <archive> -C <dir>`: it writes part of the binary, waits for the test, then the rest.
test('ensureNgrok: a call while the archive is still being extracted waits for the extraction', async (t) => {
  if (process.platform === 'win32' || !ngrokAssetUrl()) {
    t.skip('needs the tar extraction (Linux, macOS)')
    return
  }
  const dataDir = tmpDir('ngrok-provision-')
  const toolDir = tmpDir('ngrok-fake-tar-')
  const finish = join(toolDir, 'finish')
  writeFileSync(join(toolDir, 'tar'), [
    '#!/bin/sh',
    'printf "partial" > "$4/ngrok"',
    `i=0; while [ ! -e '${finish}' ] && [ $i -lt 1000 ]; do sleep 0.02; i=$((i+1)); done`,
    'printf "complete ngrok" > "$4/ngrok"',
    '',
  ].join('\n'), { mode: 0o755 })
  const realPath = process.env.PATH
  const realFetch = globalThis.fetch
  let downloads = 0
  process.env.PATH = `${toolDir}${delimiter}${realPath ?? ''}`
  globalThis.fetch = (async () => {
    downloads++
    return new Response(new Uint8Array([0x1f, 0x8b, 0x08]), { status: 200 })
  }) as typeof fetch
  t.after(() => {
    if (realPath === undefined) delete process.env.PATH
    else process.env.PATH = realPath
    globalThis.fetch = realFetch
  })

  const binPath = ngrokBinPath(dataDir)
  const first = ensureNgrok(dataDir)
  try {
    for (let waited = 0; !existsSync(binPath); waited += 10) {
      assert.ok(waited < 10_000, 'the extraction never started')
      await sleep(10)
    }
    let secondSettled = false
    const second = ensureNgrok(dataDir).finally(() => { secondSettled = true })
    await sleep(100)
    assert.equal(secondSettled, false, 'a half-written binary must not be returned as installed')
    writeFileSync(finish, '')
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.binPath, binPath)
    assert.equal(b.binPath, binPath)
    assert.equal(readFileSync(binPath, 'utf8'), 'complete ngrok')
    assert.equal(downloads, 1, 'the second call joined the first provision')
  } finally {
    // On a failure too: let the stand-in tar finish and the provision end inside the test.
    writeFileSync(finish, '')
    await first.catch(() => {})
  }
})

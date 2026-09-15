import test from 'node:test'
import assert from 'node:assert/strict'
import { NgrokProvider, NGROK_URL_RE, ngrokAssetUrl } from './ngrok'

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

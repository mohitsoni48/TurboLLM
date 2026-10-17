import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareQuickProvider, QUICK_URL_RE } from './cloudflare-quick'
import { ChildTunnel } from '../child-process'
import { tmpDir } from '../../test-support/tmp'

test('cloudflare-quick: declares a child-process lifecycle', () => {
  const p = new CloudflareQuickProvider('/tmp/data')
  assert.equal(p.id, 'cloudflare-quick')
  assert.equal(p.lifecycle, 'child-process')
})

test('cloudflare-quick: preflight is always ready — no account, no token', async () => {
  const p = new CloudflareQuickProvider('/tmp/data')
  const state = await p.preflight()
  assert.equal(state.kind, 'off')
})

test('cloudflare-quick: parses the assigned URL out of cloudflared stderr', () => {
  const stderr = [
    '2026-09-10T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-09-10T10:00:01Z INF |  https://mellow-brook-1234.trycloudflare.com  |',
  ].join('\n')
  assert.equal(QUICK_URL_RE.exec(stderr)?.[0], 'https://mellow-brook-1234.trycloudflare.com')
})

// Captured from cloudflared 2025.8.1 (`cloudflared tunnel --url http://127.0.0.1:1`), run once
// with no network at all and once online. The offline run prints its request URL and exits 1.
const OFFLINE_OUTPUT = [
  '2026-10-17T09:12:15Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps',
  '2026-10-17T09:12:15Z INF Requesting new quick Tunnel on trycloudflare.com...',
  'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com on 8.8.4.4:53: dial udp 8.8.4.4:53: connect: network is unreachable',
  '',
].join('\n')
const ONLINE_OUTPUT = [
  '2026-10-17T09:11:31Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-10-17T09:11:34Z INF +--------------------------------------------------------------------------------------------+',
  '2026-10-17T09:11:34Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  '2026-10-17T09:11:34Z INF |  https://quality-property-touring-with.trycloudflare.com                                   |',
  '2026-10-17T09:11:34Z INF +--------------------------------------------------------------------------------------------+',
  '',
].join('\n')

test('cloudflare-quick: the api.trycloudflare.com URL in an offline cloudflared\'s error is not the tunnel URL', () => {
  assert.equal(QUICK_URL_RE.exec(OFFLINE_OUTPUT), null)
  // Nor in an error line of another shape: an ERR line, or the URL with no path after it.
  assert.equal(QUICK_URL_RE.exec('2026-10-17T09:12:15Z ERR failed to reach https://api.trycloudflare.com \n'), null)
  assert.equal(QUICK_URL_RE.exec('2026-10-17T09:12:15Z ERR edge down for https://mellow-brook-1234.trycloudflare.com \n'), null)
  // The real success output still gives the tunnel's own URL, after that error text too.
  assert.equal(QUICK_URL_RE.exec(ONLINE_OUTPUT)?.[0], 'https://quality-property-touring-with.trycloudflare.com')
  assert.equal(
    QUICK_URL_RE.exec(OFFLINE_OUTPUT + ONLINE_OUTPUT)?.[0],
    'https://quality-property-touring-with.trycloudflare.com',
  )
})

test('cloudflare-quick: an offline cloudflared fails the start instead of reporting a URL', async () => {
  // The same bytes on stderr, then exit 1, as the real binary does. Before, this resolved with
  // https://api.trycloudflare.com: 'connected', then a restart a second later, forever.
  const t = new ChildTunnel(tmpDir('cf-quick-offline-'))
  const script = `process.stderr.write(${JSON.stringify(OFFLINE_OUTPUT)}); setTimeout(() => process.exit(1), 50)`
  await assert.rejects(
    t.spawnAndWait(process.execPath, ['-e', script], QUICK_URL_RE, 10_000),
    /provider exited before a URL appeared \(code 1\)/,
  )
  assert.equal(t.alive(), false)
})

test('cloudflare-quick: does not match a non-trycloudflare host', () => {
  assert.equal(QUICK_URL_RE.exec('https://example.com/trycloudflare.com'), null)
})

test('cloudflare-quick: builds the argv against the ingress port', () => {
  const p = new CloudflareQuickProvider('/tmp/data')
  assert.deepEqual(p.argv(6997), ['tunnel', '--url', 'http://127.0.0.1:6997'])
})

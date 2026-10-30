import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerSpaFallback } from './server'
import { tmpDir } from './test-support/tmp'

// TurboLLM-Android's WebView port block can't see redirect hops, so with TURBOLLM_APP_SECRET set
// the UI's HTML carries a CSP that stops an image/media redirect to another loopback port (see
// APP_SECRET_CSP in server.ts). Without the env var the HTML carries only the frame rule below.
// Plain-http images are allowed only on port 80 (a port-less `http://*`), which an Android app
// cannot bind — never `http:`, which would admit every loopback port again.
//
// On every platform no other site may frame the UI (NO_FRAMING_CSP in server.ts): a framed UI's
// requests are same-origin to the daemon, so clickjacking got past the Origin, Fetch Metadata and
// Host checks, and on the default loopback bind they carry full keyless host trust.

const FRAME_ANCESTORS = "frame-ancestors 'none'"
const CSP = `img-src 'self' http://* https: data: blob:; media-src 'self' http://* https: data: blob:; ${FRAME_ANCESTORS}`

function spaApp(): Hono {
  const root = tmpDir('spa-csp-')
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>')
  writeFileSync(join(root, 'app.js'), 'console.log(1)')
  const app = new Hono()
  registerSpaFallback(app, root)
  return app
}

async function withAppSecret(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.TURBOLLM_APP_SECRET
  if (value === undefined) delete process.env.TURBOLLM_APP_SECRET
  else process.env.TURBOLLM_APP_SECRET = value
  try {
    await fn()
  } finally {
    if (saved === undefined) delete process.env.TURBOLLM_APP_SECRET
    else process.env.TURBOLLM_APP_SECRET = saved
  }
}

test('with TURBOLLM_APP_SECRET set, the UI HTML (direct and SPA fallback) carries the img/media CSP', async () => {
  await withAppSecret('s3cret', async () => {
    const app = spaApp()
    for (const path of ['/', '/index.html', '/chat/some-id']) {
      const res = await app.request(path)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(res.headers.get('content-security-policy'), CSP, path)
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path)
    }
    // Static assets aren't documents; a CSP there would do nothing for the page.
    const js = await app.request('/app.js')
    assert.equal(js.headers.get('content-security-policy'), null)
  })
})

test('without TURBOLLM_APP_SECRET (desktop, npm, Docker) the SPA HTML carries only the frame rule, no img/media CSP', async () => {
  for (const value of [undefined, '']) {
    await withAppSecret(value, async () => {
      const app = spaApp()
      for (const path of ['/', '/chat/some-id']) {
        const res = await app.request(path)
        assert.equal(res.status, 200)
        assert.deepEqual([...res.headers.keys()], ['content-security-policy', 'content-type', 'x-frame-options'], path)
        assert.equal(res.headers.get('content-security-policy'), FRAME_ANCESTORS, path)
      }
      const js = await app.request('/app.js')
      assert.equal(js.status, 200)
      assert.deepEqual([...js.headers.keys()], ['content-type'])
    })
  }
})

// The navigation a hostile page's <iframe src="http://127.0.0.1:6996/settings"> makes. Its HTML
// had no X-Frame-Options and no frame-ancestors, so the browser rendered the UI inside the other
// site's page, where lured clicks became the UI's own same-origin requests (LAN on, "Require an
// API key" off). Both headers, on every HTML path, with or without the Android app secret.
test('the UI HTML refuses to be framed by any site: X-Frame-Options DENY and frame-ancestors none, desktop and Android', async () => {
  for (const value of [undefined, 's3cret']) {
    await withAppSecret(value, async () => {
      const app = spaApp()
      for (const path of ['/', '/index.html', '/settings', '/chat/some-id']) {
        const res = await app.request(`http://127.0.0.1:6996${path}`, {
          headers: {
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
            Referer: 'http://evil.example/',
          },
        })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('x-frame-options'), 'DENY', `${path} (secret: ${value ?? 'none'})`)
        const csp = res.headers.get('content-security-policy') ?? ''
        // One policy: the frame rule is a directive of it, never a second header.
        assert.ok(csp.split(';').map((d) => d.trim()).includes(FRAME_ANCESTORS), `${path}: ${csp}`)
      }
    })
  }
})

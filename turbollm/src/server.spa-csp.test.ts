import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerSpaFallback } from './server'
import { tmpDir } from './test-support/tmp'

// TurboLLM-Android's WebView port block can't see redirect hops, so with TURBOLLM_APP_SECRET set
// the UI's HTML carries a CSP that stops an image/media redirect to another loopback port (see
// APP_SECRET_CSP in server.ts). Without the env var the response must be exactly what it was.
// Plain-http images are allowed only on port 80 (a port-less `http://*`), which an Android app
// cannot bind — never `http:`, which would admit every loopback port again.

const CSP = "img-src 'self' http://* https: data: blob:; media-src 'self' http://* https: data: blob:"

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
    }
    // Static assets aren't documents; a CSP there would do nothing for the page.
    const js = await app.request('/app.js')
    assert.equal(js.headers.get('content-security-policy'), null)
  })
})

test('without TURBOLLM_APP_SECRET (desktop, npm, Docker) the SPA responses are unchanged: no CSP', async () => {
  for (const value of [undefined, '']) {
    await withAppSecret(value, async () => {
      const app = spaApp()
      for (const path of ['/', '/chat/some-id', '/app.js']) {
        const res = await app.request(path)
        assert.equal(res.status, 200)
        assert.deepEqual([...res.headers.keys()], ['content-type'], path)
      }
    })
  }
})

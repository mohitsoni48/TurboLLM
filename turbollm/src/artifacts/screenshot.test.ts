// The server-side artifact render runs model-generated HTML/JS in headless Chrome. Request
// interception there only sees HTTP(S), so the page must also carry the on-screen iframe's CSP —
// and as the FIRST thing parsed, since a meta CSP does not cover anything before it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createServer, type AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { findChrome, screenshotArtifact, withArtifactCsp } from './screenshot'

const CSP_START = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';'

test('withArtifactCsp: the CSP is the very first thing in a document without a doctype', () => {
  const out = withArtifactCsp('<script>new WebSocket("wss://x")</script><html><head></head><body>hi</body></html>')
  assert.ok(out.startsWith(CSP_START), out.slice(0, 80))
})

test('withArtifactCsp: it goes right after a leading doctype, so standards mode is kept', () => {
  const out = withArtifactCsp('\n<!DOCTYPE html>\n<html><head><script>1</script></head></html>')
  assert.ok(out.startsWith(`\n<!DOCTYPE html>${CSP_START}`), out.slice(0, 80))
  assert.ok(out.indexOf(CSP_START) < out.indexOf('<script>'))
})

test('withArtifactCsp: it precedes any script, wherever the artifact put its <head>', () => {
  for (const html of [
    '<script>evil()</script><head></head>',
    '<html><script>evil()</script><head><title>x</title></head></html>',
    '<!-- <head> --><script>evil()</script>',
    ' <!doctype html><script>evil()</script>', // not HTML whitespace: no doctype skip
  ]) {
    const out = withArtifactCsp(html)
    assert.ok(out.indexOf(CSP_START) >= 0 && out.indexOf(CSP_START) < out.indexOf('<script>'), html)
  }
  assert.ok(withArtifactCsp(' <!doctype html>').startsWith(CSP_START))
})

test('withArtifactCsp: the policy matches the on-screen iframe (connect-src falls back to none)', () => {
  const out = withArtifactCsp('<p>x</p>')
  assert.match(out, /content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;"/)
})

// A real export of an artifact that tries the ways out that request interception and the CSP
// don't cover: popups (window.open, a target=_blank form and link) and WebRTC (STUN over UDP,
// TURN over TCP), aimed at listeners on loopback and on this machine's LAN address. Only the
// browser's launch flags stop them. Needs an installed Chrome/Chromium/Edge (or CHROME_PATH).
test('screenshotArtifact: neither the artifact nor a popup it opens reaches loopback or the LAN', {
  skip: findChrome() ? false : 'no Chrome/Chromium/Edge found',
  timeout: 60_000,
}, async () => {
  const hits: string[] = []
  const closers: Array<() => void> = []
  try {
    const lan = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address
    let page = '<!doctype html><body><h1>export</h1>'
    let script = ''
    for (const [i, host] of ['127.0.0.1', ...(lan ? [lan] : [])].entries()) {
      const tcp = createServer((sock) => { hits.push(`tcp ${host}`); sock.destroy() })
      await new Promise<void>((resolve) => tcp.listen(0, host, resolve))
      closers.push(() => tcp.close())
      const udp = createSocket('udp4').on('message', () => hits.push(`udp ${host}`))
      await new Promise<void>((resolve) => udp.bind(0, host, resolve))
      closers.push(() => udp.close())
      const url = `http://${host}:${(tcp.address() as AddressInfo).port}`
      page += `<form id="f${i}" action="${url}/form" method="post" target="_blank"></form><a id="a${i}" href="${url}/link" target="_blank">x</a>`
      script += `window.open('${url}/popup'); document.getElementById('f${i}').submit(); document.getElementById('a${i}').click()
        { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${host}:${udp.address().port}' },
            { urls: 'turn:${host}:${(tcp.address() as AddressInfo).port}?transport=tcp', username: 'u', credential: 'c' }] })
          pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)) }
`
      if (host === '127.0.0.1') script += `window.open('${url.replace('127.0.0.1', 'localhost')}/localhost')\n`
    }
    const png = await screenshotArtifact(`${page}<script>${script}</script></body>`, { width: 800, height: 600 })
    assert.ok(png && png.subarray(1, 4).toString() === 'PNG', 'the export still renders')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(hits, [])
  } finally {
    for (const close of closers) close()
  }
})

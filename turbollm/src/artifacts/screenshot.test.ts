// The server-side artifact render runs model-generated HTML/JS in headless Chrome. Request
// interception there only sees HTTP(S), so the page must also carry the on-screen iframe's CSP —
// and as the FIRST thing parsed, since a meta CSP does not cover anything before it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withArtifactCsp } from './screenshot'

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

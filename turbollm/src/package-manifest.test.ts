// Regression guard for GitHub #226 — `npm i -g turbollm@latest` failed on Windows with
// "'patch-package' is not recognized as an internal or external command".
//
// Cause: package.json declared `"postinstall": "patch-package"`. npm runs `postinstall`
// for a consumer installing the published tarball, but does NOT install devDependencies
// for them — and patch-package lives in devDependencies, so the binary was never there.
// Every global install hard-failed (shipped in v1.12.5, a7a85c2).
//
// The patch itself (patches/typebox+1.1.38.patch) is a build-time concern only: it is not
// in `files`, so it is never even published, and it exists purely so nodejs-mobile's Node
// 18 can parse typebox's `\p{...}` literals — the Android bundle inlines the patched copy
// at build time (tsup.android.config.ts, noExternal), while the desktop bundle keeps
// typebox external and desktop Node 22 parses that syntax natively.
//
// Fix: `prepare` instead. It runs on a local `npm install`/`npm ci` in this repo and on
// git-URL installs (both of which DO install devDependencies), but never for a registry
// tarball install. This test fails if `postinstall` is ever reintroduced.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts?: Record<string, string> }

test('#226: package.json declares no postinstall script (it runs without devDependencies)', () => {
  assert.equal(
    manifest.scripts?.postinstall,
    undefined,
    'postinstall runs on a consumer `npm i -g turbollm` but devDependencies are not installed ' +
      'there — a devDependency binary here breaks every install. Use `prepare` instead.',
  )
})

test('#226: patch-package is wired through `prepare`, so the dev repo still gets patched', () => {
  assert.equal(manifest.scripts?.prepare, 'patch-package')
})

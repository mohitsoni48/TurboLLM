// TurboLLM Android's `--require` preload for the embedded (nodejs-mobile) Node 18.20.4
// runtime (see NodeRuntimeLauncher.android.kt's startScript, which passes this via
// `--require` BEFORE the entry script path).
//
// Why a --require preload and not a normal import/require inside cli.ts: confirmed live that
// a plain top-level ESM import at the very top of cli.ts's own source does NOT reliably run
// before every other module in its import graph. Node's ESM linker executes CommonJS
// dependencies' top-level code as part of resolving their NAMED EXPORTS during the LINK
// phase, which covers the whole import graph before ANY module (including the entry module's
// own body) reaches evaluation — so "first import in the source" does not mean "runs first".
// A `--require` preload runs via Node's own CLI bootstrap strictly before it even begins
// loading the entry module, which is the only mechanism confirmed to reliably beat that phase.
//
// The actual bug this works around: this embedded Node build does not expose the WHATWG
// `File` global that `undici` (an npm dependency, used transitively for fetch) reads at its
// own module-load time (`node_modules/undici/lib/web/webidl/index.js` does
// `webidl.is.File = webidl.util.MakeTypeAssertion(File)`), which throws
// `ReferenceError: File is not defined` and crashes the whole daemon before any of its own
// code runs. Desktop Node exposes `File` as a global; this build's own `node:buffer` module
// does NOT re-export `File` either (confirmed live — re-exporting it as the global had zero
// effect), so this builds a minimal polyfill on `Blob` instead, which is stable since Node 15
// and far more likely to have survived a size-stripped mobile build.
'use strict'

if (typeof globalThis.File === 'undefined') {
  const { Blob } = require('node:buffer')
  class PolyfillFile extends Blob {
    constructor(fileBits, fileName, options = {}) {
      super(fileBits, options)
      this.name = fileName
      this.lastModified = options.lastModified ?? Date.now()
    }
  }
  globalThis.File = PolyfillFile
}

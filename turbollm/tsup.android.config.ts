import { defineConfig } from 'tsup'

// A SEPARATE build pass whose only consumer is the Android APK. It exists because the npm
// package and the Android app have opposite packaging needs, and trying to serve both from
// one output is what left the app broken:
//
//   - npm: `dependencies` must stay EXTERNAL, because npm installs them for the user. That
//     is what tsup does by default and what `tsup.config.ts` relies on.
//   - Android: there is no `npm install` on a phone. Anything external has to be physically
//     present in the APK. Shipping the production tree instead is not an option — it is
//     **362 MB**, of which ~220 MB is `@earendil-works/pi-*` plus its `@mistralai`/`@google`/
//     `openai`/`@opentelemetry` transitives: the Code feature, which is cut from the Android
//     build entirely (see web/src/lib/platform.ts). Bundling the handful of modules the
//     daemon actually reaches is dramatically smaller than shipping a tree that is mostly
//     dead weight on this platform.
//
// Symptom this fixes, for the record: a fresh install crashed at boot with
// `Cannot find package '@hono/node-server' imported from .../dist/cli.js`. The app only ever
// appeared to work because earlier dev sessions had pushed extra files onto the device by
// hand — exactly the injected state a Play Store download will not have.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  clean: true,
  outDir: 'dist-android',
  // nodejs-mobile embeds Node **18.20.4**, not the 22 the desktop package targets. Building
  // this pass for node22 would emit syntax the phone's runtime cannot parse.
  target: 'node18',
  // Bundle everything by default — the whole point of this pass.
  noExternal: [/.*/],
  // Bundling CommonJS packages into an ESM output leaves esbuild's `__require` shim in place,
  // and that shim THROWS for any require it could not resolve statically. undici does
  // `require('assert')` at load time, which crashed the app on first boot with:
  //     Error: Dynamic require of "assert" is not supported
  //         at node_modules/undici/lib/dispatcher/client.js
  // Defining a genuine `require` from `import.meta.url` gives those calls something real to
  // land on. Node builtins stay external (platform: node), so this resolves them natively.
  //
  // `__dirname`/`__filename` are defined for the same reason: they simply do not exist in an
  // ES module, and bundled CommonJS reaches for them. sql.js locates its own .wasm with
  // `__dirname + "/"`, which failed as:
  //     ReferenceError: __dirname is not defined in ES module scope
  // Here `__dirname` resolves to the extracted dist/ directory, so `sql-wasm.wasm` is staged
  // alongside the bundle rather than left in node_modules (scripts/stage-daemon-assets.mjs).
  banner: {
    js: [
      "import { createRequire as __tllmCreateRequire } from 'node:module';",
      "import { fileURLToPath as __tllmFileURLToPath } from 'node:url';",
      "import { dirname as __tllmDirname } from 'node:path';",
      'const require = __tllmCreateRequire(import.meta.url);',
      'const __filename = __tllmFileURLToPath(import.meta.url);',
      'const __dirname = __tllmDirname(__filename);',
    ].join('\n'),
  },
  external: [
    // Built into Node 22 but ABSENT from the phone's Node 18 — sqlite-adapter.ts already
    // falls back to sql.js there. Left external so the `node:` specifier survives for the
    // desktop path and simply never resolves on Android.
    'node:sqlite',
    // sql.js finds its own .wasm relative to its OWN package directory at runtime, so
    // inlining it into cli.js breaks that lookup. It stays a real folder shipped beside the
    // bundle (see the Android asset staging script).
    'sql.js',
    // The Code feature's engine. Cut from Android, and its dependency chain uses regex
    // syntax the embedded runtime cannot even parse (see tsup.config.ts's header) — so it
    // must not be dragged in here even accidentally.
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
  ],
})

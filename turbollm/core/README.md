# TurboLLM core (Rust)

The native core of TurboLLM: one Rust code base that the Node daemon, the Android SDK and the nodejs-mobile Android
app all call. Phase 1 holds the GGUF header parser (`turbollm-gguf`), ported from `src/gguf/gguf.ts`.

The end state has three layers (see `docs/plans/rust-core/ROADMAP.md` in the docs repo, section "Three layers"):

- **Frontends** (React web UI, Android and iOS shells, third-party apps) talk to the backend over HTTP or through
  bindings.
- **Backend: the Rust core** (this folder). Domain crates, a runtime crate, and entry points: the napi addon for Node,
  UniFFI for Kotlin, later an HTTP server and a CLI.
- **Engines** (llama.cpp, vLLM, MLX, ...) are linked in-process or spawned and supervised by the core.

## Layout

```
core/
  Cargo.toml, Cargo.lock      the workspace; version is kept equal to turbollm/package.json
  rust-toolchain.toml         Rust 1.100.0 + the 3 targets used locally
  .cargo/config.toml          `cargo xtask` alias; 16 KB page alignment for Android; dynamic musl
  deny.toml                   cargo-deny license and advisory policy (run in CI)
  crates/turbollm-gguf/       pure domain crate: the GGUF header parser
  crates/turbollm-core/       runtime crate: core_info, re-exports `gguf`
  bindings/node/              napi-rs addon (crate turbollm-node); npm/<target>/ = the 9 platform package templates
  bindings/uniffi/            UniFFI crate turbollm-ffi -> Kotlin (library turbollm_core_ffi)
  bindings/android/           standalone Gradle build of the Android library (AAR) `turbollm-core`
  fixtures/gguf/              crafted files, goldens, corpus manifest, divergences (see its README.md)
  scripts/                    build, stage, publish and golden scripts (Node), with their tests
  xtask/                      repo tasks in Rust (`cargo xtask <command>`)
```

## Prerequisites

- **Rust 1.100.0 through rustup.** `rust-toolchain.toml` pins it; the first `cargo` command in `core/` installs that
  toolchain with `rustfmt`, `clippy` and the targets `x86_64-pc-windows-msvc`, `aarch64-linux-android`,
  `x86_64-linux-android`. On Windows you also need the MSVC build tools. Other hosts add their own target, for
  example `rustup target add x86_64-unknown-linux-gnu`.
- **Node 22** for the addon and the scripts (`turbollm/` dependencies installed).
- **Android only:** an Android SDK (`sdk.dir` in `bindings/android/local.properties`, which is gitignored), NDK
  `27.0.12077973` (the Gradle default; override with `-Pturbollm.ndkVersion=...`), `cargo install cargo-ndk --version
  4.1.2 --locked`, and a JDK 17 (CI uses Temurin 17).

## Build and test

Rust commands run from `turbollm/core/`. Every change must pass all three:

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo test --workspace` includes the golden suite (`crates/turbollm-gguf/tests/golden.rs`), budget and position
tests, property tests (2,000 seeded cases each, slowest part in a debug build) and the quant-name golden.

**Node addon** (from `turbollm/`):

```
npm run build:core                                   # = node core/scripts/build-node.mjs --release
npx tsx --test --test-timeout=60000 src/native/load.test.ts src/native/gguf.golden.test.ts
npx tsx --test --test-timeout=60000 "core/scripts/*.test.ts"
```

`build:core` builds the host target and writes `core/bindings/node/turbollm-core.<target>.node` and
`src/native/binding.generated.d.ts` (committed; CI fails if a build changes it). Rebuild after any Rust change, or
TS tests load the old binary. `npm run build` copies the host binary into `dist/native/` (a warning, not a failure,
when there is none). Other targets: `node core/scripts/build-node.mjs --target <suffix> --release`; the Linux targets
need `--cross-compile` (cargo-zigbuild and zig) when not built on Linux.

The loader (`src/native/load.ts`) looks for the binary in this order: `TURBOLLM_CORE_PATH` (if set, the only place it
looks), the `native/` folder next to the bundled daemon (`dist/native/`), the platform package `@turbollm/core-<target>`, then `core/bindings/node/` in a source checkout.

**Android library** (from `turbollm/core/bindings/android/`, Git Bash or any POSIX shell; `gradlew.bat` on cmd):

```
./gradlew :turbollm-core:testDebugUnitTest        # JVM golden test against the host library (built by cargoHostBuild)
./gradlew :turbollm-core:assembleRelease          # AAR with arm64-v8a and x86_64
./gradlew :r8-consumer:assembleRelease            # minified consumer: proves the AAR's R8 rules keep the bindings
```

The instrumented tests (`connectedDebugAndroidTest`, `:r8-consumer:connectedReleaseAndroidTest`) need an emulator or
device; CI runs them on an API 34 x86_64 emulator.

**nodejs-mobile flavour.** The Android app runs the daemon inside nodejs-mobile, which loads the addon as
`libturbollm_core_node.so` linked against its `libnode.so` (no dynamic symbol lookup):

```
./gradlew :turbollm-core:assembleNodejsMobileAddon -Pturbollm.libnodeDir=<dir holding <abi>/libnode.so>
```

or directly `node core/scripts/build-node.mjs --flavour nodejs-mobile --libnode-dir <dir> --out <dir>
[--target android-arm64|android-x64] [--release]`. Each output is checked with `cargo xtask check-android-elf <file>
--needs libnode.so` (16 KB `PT_LOAD` alignment and the `libnode.so` dependency). This is a different binary from the
npm `android-arm64` target, which is for Termux.

## Goldens and the corpus

`fixtures/gguf/README.md` describes the formats. The rules:

- **Never hand-edit a golden.** They are written by `npx tsx core/scripts/gguf-goldens.ts --write` (from `turbollm/`)
  while the TypeScript parser exists, and re-blessed only from Rust, in review, after it is deleted.
  `npx tsx core/scripts/gguf-goldens.ts --check` and `cargo xtask goldens-check` check the folder.
- The real-header corpus (15 pinned prefixes of public GGUF files, about 115 MB) is fetched into the gitignored
  `fixtures/gguf/.corpus-cache/` with `node core/scripts/fetch-gguf-corpus.mjs` (from `turbollm/`). A missing slice is
  skipped with a notice locally and fails on CI.
- **Declared divergences** from the TypeScript parser (architecture 3.3; `divergences.json` maps fixture ids to them):
  - D-1: a numeric field that is not a non-negative integer in range is truncated and clamped in Rust.
  - D-2: `dataEnd` and offsets are exact integers in Rust; TS doubles round above 2^53.
  - D-3: the cut-short check keeps the 256 MiB read budget; TS's sync path has none.
  - D-4: I/O errors carry the Rust `io::Error` text, not Node's `ENOENT: ...`.
  - D-5: a read starting above 2^53 - 1 is an `io` error "position out of range" (TS throws a `RangeError`).
  Any other difference is a bug. `src/native/gguf.parity.test.ts` (5,000 seeded mutations, 20,000 file names) fails on
  an undeclared one while the TS parser still exists.

## Version

The workspace version must equal `turbollm/package.json`'s:

```
cargo xtask check-version     # exit 1 with the two versions if they differ
cargo xtask sync-version      # rewrite core/Cargo.toml from package.json
```

`scripts/release.mjs` runs `sync-version` (and `cargo update --workspace --offline` for `Cargo.lock`) when it bumps a
release, and CI runs `check-version`. The binary embeds `TURBOLLM_CORE_VERSION=<version>`; the loader refuses a binary
whose version differs from the package.

## Supported platforms

The 9 npm targets (`scripts/targets.mjs` is the one list): `win32-x64-msvc`, `win32-arm64-msvc`, `darwin-x64`,
`darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu` (glibc 2.28 or newer), `linux-x64-musl`, `linux-arm64-musl`,
`android-arm64` (Termux). The Android library ships arm64-v8a and x86_64. On any other system the daemon does not
start; it prints:

```
TurboLLM's native core is not available for this system (<system>, Node <version>).
It ships for: Windows x64 and arm64, macOS x64 and arm64, Linux x64 and arm64 (glibc 2.28 or newer, or
musl), Android arm64 (Termux).
```

followed by what to do and the list of places it tried.

## Releases

CI (`.github/workflows/core-build.yml`, called from `ci.yml`) builds and tests all 9 targets, the nodejs-mobile addon
and the Android library. On a GitHub release, `npm-publish.yml` builds the core with no cache, publishes the 9
platform packages `@turbollm/core-<target>` (`scripts/publish-platform-packages.mjs` checks every binary's version
first), waits until all 9 are visible on npm, adds them to `turbollm`'s `optionalDependencies` at the exact version, and
only then publishes `turbollm`. Nobody publishes platform packages by hand; the token fallback in `release.mjs`
refuses a core release whose 9 packages are not on the registry.

## Adding a module

Follow `turbollm-gguf`: a new domain gets its own crate under `crates/` with no binding dependencies, is re-exported
from `turbollm-core` (as `turbollm_core::gguf` is), and reaches Node and Kotlin through thin wrappers in
`bindings/node` and `bindings/uniffi`. Write its tests first in the crate (`#[cfg(test)]` or `tests/*.rs`); behaviour
shared with another runtime gets language-neutral fixtures the way `fixtures/gguf/` has them. The crate list for later
phases is in the ROADMAP.
